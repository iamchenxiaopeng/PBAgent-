#!/usr/bin/env bash
# PBAgent 一键演示准备脚本
# 用法（在 Git Bash 中执行）：
#   bash scripts/demo.sh            起三服务（存活则跳过）→ 重置演示数据 → 健康校验 → 打印演示操作清单
#   bash scripts/demo.sh use-v1     主 playbook 切到 v1（旧选择器——Demo 2 触发失败用）
#   bash scripts/demo.sh use-v2     主 playbook 切到 v2（全绿——Demo 1 零 LLM 演示用）
#   bash scripts/demo.sh status     查看三服务状态 + 主 playbook 当前版本
#   bash scripts/demo.sh restart    杀掉三服务进程并重启（改代码后必须重启才生效）
set -euo pipefail
cd "$(dirname "$0")/.."

# 本地服务一律直连，拒绝被系统代理劫持（curl 走代理对 localhost 转发不稳定）
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy 2>/dev/null || true
export no_proxy='*'
export NO_PROXY='*'

ROOT="$(pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

TEST_SITE_PORT=3456
API_PORT=4567
WEB_PORT=5173
PB="$ROOT/playbooks/demo-reprice.yaml"
V1="$ROOT/playbooks/.versions/demo-reprice/v1.yaml"
V2="$ROOT/playbooks/.versions/demo-reprice/v2.yaml"

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; OFF='\033[0m'
info() { echo -e "${GREEN}[OK]${OFF} $1"; }
warn() { echo -e "${YELLOW}[!!]${OFF} $1"; }
fail() { echo -e "${RED}[XX]${OFF} $1"; }

alive() { # $1=port  $2=path
  # 注意：Windows Git Bash 下 curl -o /dev/null 会返回 23（写错误），必须用 shell 重定向
  curl -s -m 3 "http://localhost:$1$2" > /dev/null && return 0
  sleep 1
  curl -s -m 3 "http://localhost:$1$2" > /dev/null && return 0 || return 1
}

wait_for() { # $1=port  $2=path  $3=name
  local i ok
  for i in $(seq 1 30); do
    ok=1
    if ! curl -s -m 3 "http://localhost:$1$2" > /dev/null; then ok=0; sleep 1; continue; fi
    # 双保险：成功后再确认一次，规避偶发超时误判
    curl -s -m 3 "http://localhost:$1$2" > /dev/null || { sleep 1; continue; }
    return 0
  done
  fail "$3($1) 30 秒内未就绪，日志：logs/$(echo "$3" | tr ' ' '-').log"
  return 1
}

kill_port() { # $1=port
  # taskkill 的 /F /PID 在 Git Bash 下参数会被错误转换，改用 PowerShell
  local pids
  pids=$(netstat -ano | awk -v p=":$1" '$2 ~ p"$" && $4 == "LISTENING" {print $5}' | sort -u)
  if [ -n "$pids" ]; then
    powershell -NoProfile -Command "Stop-Process -Id @($(echo $pids | tr ' ' ',')) -Force -ErrorAction SilentlyContinue"
    sleep 1
    if netstat -ano | awk -v p=":$1" '$2 ~ p"$" && $4 == "LISTENING"' | grep -q .; then
      warn "端口 $1 仍有进程监听，请手动处理（PID: $pids）"
    else
      info "端口 $1 进程($pids)已停止"
    fi
  else
    info "端口 $1 无监听进程"
  fi
}

pb_version() { # 判断主 playbook 当前处于哪个版本
  if diff -q "$PB" "$V1" >/dev/null 2>&1; then echo "v1"
  elif diff -q "$PB" "$V2" >/dev/null 2>&1; then echo "v2"
  else echo "自定义（与 v1/v2 存档均不同）"; fi
}

start_services() {
  echo "==> 启动服务（已存活的跳过）"
  if alive $TEST_SITE_PORT /; then
    info "test-site($TEST_SITE_PORT) 已在运行，跳过"
  else
    nohup npm run dev:site > "$LOG_DIR/test-site.log" 2>&1 &
    wait_for $TEST_SITE_PORT / "test-site" || exit 1
    info "test-site($TEST_SITE_PORT) 已启动"
  fi

  if alive $API_PORT /api/health; then
    info "后端 API($API_PORT) 已在运行，跳过"
    warn "若刚改过代码，请执行 bash scripts/demo.sh restart 让新代码生效"
  else
    nohup npm run server > "$LOG_DIR/api.log" 2>&1 &
    wait_for $API_PORT /api/health "api" || exit 1
    info "后端 API($API_PORT) 已启动"
  fi

  if alive $WEB_PORT /; then
    info "Web 控制台($WEB_PORT) 已在运行，跳过"
  else
    (cd "$ROOT/web" && nohup node ../node_modules/vite/bin/vite.js > ../logs/vite.log 2>&1 &)
    wait_for $WEB_PORT / "vite" || exit 1
    info "Web 控制台($WEB_PORT) 已启动"
  fi
}

reset_demo_data() {
  echo "==> 重置 test-site 演示数据（SKU 价格恢复初值）"
  local code
  code=$(curl -s -X POST -w "%{http_code}" "http://localhost:$TEST_SITE_PORT/api/reset" | tail -c 3)
  if [ "$code" = "200" ]; then
    info "演示数据已重置"
  else
    warn "/api/reset 返回 $code（test-site 版本过旧？重启后重试）"
  fi
}

check_health() {
  echo "==> 健康校验"
  local health llm_ok model
  health=$(curl -s "http://localhost:$API_PORT/api/health")
  llm_ok=$(node -e "const r=JSON.parse(process.argv[1]); console.log(r.llm?.configured ?? false)" "$health" 2>/dev/null || echo false)
  model=$(node -e "const r=JSON.parse(process.argv[1]); console.log(r.llm?.model ?? '')" "$health" 2>/dev/null || echo "")
  if [ "$llm_ok" = "true" ]; then
    info "LLM 网关已配置（model: $model）——Demo 2 兜底可用"
  else
    warn "LLM 未配置（.env 缺 PBA_LLM_*）——Demo 2 的 Agent 兜底不会触发！"
  fi
}

check_match() {
  echo "==> 智能路由校验（零 LLM 命中）"
  # 注意：Windows curl 的 --data @file 读文件路径有兼容问题，用 stdin 管道代替
  local resp
  resp=$(printf '%s' '{"task":"把 S050 的价格改成 199","url":"http://localhost:3456/login"}' \
    | curl -s -X POST -H 'Content-Type: application/json' --data-binary @- "http://localhost:$API_PORT/api/match")
  node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (r.matched && r.playbook) {
      console.log(`[OK] 命中 ${r.playbook.name}（${r.playbook.stepCount} 步，参数：${(r.playbook.params ?? []).join(", ")}，候选 ${r.candidateCount} 个）`);
    } else {
      console.log(`[XX] 未命中 playbook：${r.reason ?? JSON.stringify(r)}`);
      process.exit(1);
    }
  ' <<< "$resp" || fail "智能路由校验未通过"
}

print_guide() {
  local ver
  ver=$(pb_version)
  echo ""
  echo "=============================================================="
  echo "                演示环境就绪 · 操作清单"
  echo "=============================================================="
  echo "Web 控制台: http://localhost:$WEB_PORT   演示站点: http://localhost:$TEST_SITE_PORT/login"
  echo "主 playbook 当前版本: $ver"
  [ "$ver" != "v2" ] && warn "Demo 1 前建议执行: bash scripts/demo.sh use-v2"
  echo ""
  echo "[Demo 1] 零 LLM 确定性执行（约 2 分钟）"
  echo "  前置: bash scripts/demo.sh use-v2"
  echo "  1. 浏览器打开 Web 控制台，主页 URL 框填 http://localhost:$TEST_SITE_PORT/login"
  echo "  2. 任务框输入: 把 S050 的价格改成 199"
  echo "  3. 匹配卡弹出 ⚡demo-reprice → 参数 username=demo / price=199 → 确认执行"
  echo "  看点句: 注意 LLM 调用数——全程 0，10 步约 3.4 秒，成本 \$0"
  echo ""
  echo "[Demo 2] A→B→A→C 完整闭环（约 3 分钟）"
  echo "  前置: bash scripts/demo.sh use-v1（主文件切旧选择器版，第 8 步必挂）"
  echo "  1. 同 Demo 1 提交（price 换 222 与上轮区分）"
  echo "  2. 第 8 步「点保存」E1 失败 → 界面出现 Agent 兜底步骤 → 恢复点命中续跑 → 完成"
  echo "  3. 收尾讲沉淀（二选一）:"
  echo "     - 看历史沉淀: npx tsx src/cli/index.ts diff playbooks/demo-reprice.yaml"
  echo "     - 当场沉淀(CLI): npx tsx src/cli/index.ts run playbooks/demo-reprice.yaml --takeover --learn --params '{\"username\":\"demo\",\"price\":\"222\"}' --baseUrl http://localhost:$TEST_SITE_PORT"
  echo "  看点句: 保存按钮改名叫「确认下单」了——看 Agent 怎么找到它、怎么接回主流程"
  echo ""
  echo "[Demo 3] 会话式多轮追问（约 2 分钟）"
  echo "  1. 不新建会话，直接输入: 再把 S050 改成 333（不填 URL）"
  echo "  看点句: 我没填 URL——它记得这个会话在哪个站点干活"
  echo ""
  echo "提示:"
  echo "  - 演示前重置数据: bash scripts/demo.sh（自动调 /api/reset）"
  echo "  - 改代码后: bash scripts/demo.sh restart（后端改代码必须重启才生效）"
  echo "  - 服务日志: logs/test-site.log | logs/api.log | logs/vite.log"
  echo "=============================================================="
}

cmd_use() { # $1=源文件  $2=版本说明
  [ -f "$1" ] || { fail "找不到 $1"; exit 1; }
  cp "$1" "$PB"
  info "主 playbook 已切换为 $2"
  info "当前版本: $(pb_version)"
}

cmd_status() {
  echo "==> 服务状态"
  alive $TEST_SITE_PORT / && info "test-site($TEST_SITE_PORT) 运行中" || warn "test-site($TEST_SITE_PORT) 未启动"
  alive $API_PORT /api/health && info "后端 API($API_PORT) 运行中" || warn "后端 API($API_PORT) 未启动"
  alive $WEB_PORT / && info "Web 控制台($WEB_PORT) 运行中" || warn "Web 控制台($WEB_PORT) 未启动"
  echo "==> 主 playbook 版本: $(pb_version)"
}

cmd_restart() {
  echo "==> 停止三服务"
  kill_port $WEB_PORT
  kill_port $API_PORT
  kill_port $TEST_SITE_PORT
  start_services
}

case "${1:-start}" in
  use-v1) cmd_use "$V1" "v1（旧选择器——Demo 2 触发失败用）" ;;
  use-v2) cmd_use "$V2" "v2（全绿——Demo 1 零 LLM 演示用）" ;;
  status) cmd_status ;;
  restart) cmd_restart ;;
  start|"")
    start_services
    reset_demo_data
    check_health
    check_match
    print_guide
    ;;
  *)
    echo "用法: bash scripts/demo.sh [start|use-v1|use-v2|status|restart]"
    exit 1
    ;;
esac
