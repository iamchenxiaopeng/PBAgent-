# PBAgent

**Playbook + LLM 混合式浏览器操作 Agent** —— 已知流程用 Playbook 确定性执行（零 LLM 调用、$0 成本），失败时 LLM Agent 兜底，完成自愈后沉淀新版本 Playbook。

> 当前版本：**v0.1.0（MVP）** —— STATE A（Playbook 确定性执行）全链路完成，含凭证加密、session 复用与过期自动重登。LLM 兜底（STATE B/C）属 v1.0 范围，见 [路线图](#路线图)。

## 为什么做

浏览器自动化（RPA/爬虫/E2E）的两个极端都有痛点：

| 方案 | 成本 | 稳定性 | 页面改版后 |
|------|------|--------|-----------|
| 传统 RPA 脚本 | $0 | 高（确定性） | 直接挂，人工修 |
| 纯 LLM Agent | 高（每步推理） | 低（随机性） | 天然适应 |

PBAgent 的答案：**Playbook 优先**。已知流程走确定性执行，只有失败时才唤起 LLM——把 LLM 用在刀刃上。目标成本结构：90% 运行零 LLM 调用，10% 边缘情况调用 LLM 自愈。

## 核心特性（MVP）

- **YAML Playbook**：14 种步骤（goto/click/fill/select/check/hover/press/wait/extract/scroll/download/screenshot/assert/loop），支持 `include` 子流程复用、`${params.*}/${vars.*}/${ctx.*}/${env.*}` 四作用域插值
- **确定性执行引擎**：多层选择器 fallback（css → xpath → text → role/label，text 层可交互元素优先），每层独立超时
- **失败四分类**：E1 元素定位 / E2 页面状态 / E3 超时 / E4 断言 + EX 配置错误（不触发兜底）
- **凭证加密存储**：AES-256-GCM，密钥来自 `PBAGENT_KEY` 或 `~/.pbagent/.key`（自动生成）
- **session 复用 + 自动重登**：storageState 持久化；被踢到登录页时自动重登并重试业务，一次跑通
- **全链路脱敏**：password/token/secret 等字段在报告、日志、存储中一律 `***`
- **运行报告**：单文件 HTML + 结构化 JSON，失败自动归档截图 + DOM 快照

## 快速开始

```bash
# 1. 安装依赖（Chromium 走 npmmirror 镜像）
npm install
npx playwright install chromium

# 2. 起演示站点（含改版模拟开关）
npm run cli -- dev:site   # 或: tsx test-site/server.ts

# 3. 校验示例 Playbook
npm run cli -- validate src/playbook/examples/reprice.yaml

# 4. 跑起来（首次登录走全流程）
npm run cli -- run src/playbook/examples/reprice.yaml \
  --params '{"items":[{"id":"S001","price":"188"}]}' \
  --baseUrl http://localhost:3456
```

第二次运行会自动复用登录态（跳过登录子流程）；服务端踢下线后会自动重登（报告状态 `recovered`）。

## CLI 一览

```bash
pbagent validate <playbook.yaml>          # Schema + 语义 + 插值静态校验（带 YAML 行号定位）
pbagent run <playbook.yaml>               # 确定性执行（--params/--params-file/--baseUrl/--headed/--out）
                                          #   --takeover 失败时 LLM Agent 兜底接管（STATE B）
                                          #   --learn 配合 --takeover：自愈轨迹沉淀为新版本草稿（STATE C）
pbagent chat "任务描述" --url <起始URL>    # 自然语言任务：LLM Agent 自主探索页面完成（STATE B）
                                          #   --auth <domain> 凭证+session 自动加载
                                          #   --headed 观看操作 / --max-steps 15 步数上限
pbagent versions <playbook.yaml>          # 查看版本链（当前生效版本 + 沉淀历史）
pbagent promote <playbook.yaml> --to 2    # 沉淀版本生效（v2 替换主文件）
pbagent rollback <playbook.yaml> --to 1   # 回滚到旧版本
pbagent diff <playbook.yaml> [--to 2]     # 查看版本间的步骤级 diff
pbagent auth set <domain> --pair username=alice --pair demo_password=s3cret   # 非交互存储（推荐）
pbagent auth set <domain>                 # 交互式输入（key=value，空行结束；mintty 终端建议用 --pair）
pbagent auth list                         # 列出已存域名 + 健康检查
pbagent auth rm <domain>                  # 删除
pbagent dev:site                          # 启动演示站点（端口 3456）
```

### 自然语言模式示例（v1.0 预览，W5 已可用）

```bash
pbagent chat "用户名 demo 密码 demo123 登录，然后给商品 S001 把价格改成 188，保存并确认成功" \
  --url http://localhost:3456/login --auth localhost
```

Agent 全程自主：看截图+DOM 摘要 → 找表单 → 填值 → 提交 → 确认结果，每步截图与轨迹报告归档在 `runs/<id>_chat/`。LLM 配置在 `.env`（`PBA_LLM_BASE_URL/PBA_LLM_API_KEY/PBA_LLM_MODEL`，OpenAI 兼容网关均可）。

### Web 控制台（Vue3）

```bash
npm run server    # 后端 API + SSE（端口 4567）
npm run web       # 前端开发服务器（端口 5173，/api 代理到 4567）
```

打开 http://localhost:5173 ：输入起始 URL + 一句话任务 → 浏览器里实时看 Agent 操作——左侧步骤时间线（动作/理由/耗时），右侧当前页面截图实时刷新，任务结束展示总结与 LLM 成本。高级设置支持**用户自带 LLM Key**（Base URL / API Key / 模型名，只在任务内存中生效，不落盘）。

### 自愈 + 沉淀闭环（W7 已可用）

```bash
# 一条命令走完 A → B → A → C 全链路：
pbagent run reprice.yaml --takeover --learn --baseUrl http://localhost:3456
#   STATE A：Playbook 确定性执行，失败在"点保存"（改版后按钮改名）
#   STATE B：Agent 看页面找到等价按钮"确认下单"，处理 confirm 弹窗
#   STATE A：恢复点命中，断点续跑到结尾
#   STATE C：自愈路径蒸馏为 v2 草稿（.versions/reprice/v2.yaml + diff），主文件不动

pbagent diff reprice.yaml            # 看 v2 相对 v1 改了什么（步骤级，人可读）
pbagent promote reprice.yaml --to 2  # 确认后 v2 生效——下次直接零 LLM 通关
pbagent rollback reprice.yaml --to 1 # 出问题一键回滚
```

沉淀规则（DESIGN §7.1）：click/fill 生成 `selector: { css, text }` 双保险；Agent 处理过弹窗的步骤自动带 `dialog: accept`；fill 值命中 params 时保留 `${params.x}` 插值；密码框不沉淀；include 被剥离（登录由 session/relogin 机制负责，避免二次展开）。

## Playbook 示例

```yaml
version: 1
name: sku-reprice
include:
  - ./_login.yaml        # 登录子流程前插复用
auth: localhost          # 声明凭证/session 归属域
vars:
  adminHost: 'https://admin.demo.internal'
meta:
  baseUrl: ${vars.adminHost}
  sensitive: [password]
steps:
  - action: goto
    name: 打开 SKU 列表
    url: /sku/list
  - action: loop
    name: 逐个改价
    over: ${params.items}     # 数组参数整串引用（保留类型）
    var: item
    steps:
      - action: goto
        name: 进入编辑页
        url: '/sku/${item.id}/edit'
      - action: fill
        name: 填新价格
        selector: { css: '#price', text: 价格 }   # 多层 fallback
        value: '${item.price}'
      - action: click
        name: 点保存
        selector: { text: 保存 }
      - action: assert
        name: 确认保存成功
        textContains: 保存成功
```

更多见 `src/playbook/examples/`。字段完整定义见 [docs/DESIGN.md](docs/DESIGN.md) 第 3 章。

## 凭证与安全

```
pbagent auth set admin.example.com
# > username=alice
# > demo_password=s3cret        # 字段名与登录 Playbook 的 ${env.X} 对应（→ DEMO_PASSWORD）
```

- 密码类字段（/password|secret|token/i）注入为**一次性环境变量**，不进 params、不进报告
- 凭证文件 AES-256-GCM 加密（`credentials/<domain>.enc`），权限 600
- session 存 `runs/.sessions/<domain>.json`，gitignore 掉整个 runs/ 目录

## 项目结构

```
src/
├── cli/           # 命令入口（validate/run/auth）
├── playbook/      # zod Schema、loader（行号定位/include 展开/插值校验）
├── executor/      # 执行引擎、选择器 fallback、上下文、自动重登
├── detector/      # E1-E4+EX 失败分类
├── credentials/   # AES-256-GCM 凭证存储、storageState session
├── reporter/      # run.json + report.html
└── shared/        # 脱敏工具
test-site/         # Express 演示站点（50 SKU、variant=b 改版模拟、/api/kick 踢下线）
tests/             # 69 个用例（单测 + 真实浏览器 E2E）
docs/              # PRD.md / DESIGN.md / SHARING.md / RETRO.md
docs/assets/       # 演示资产（abac-timeline.html：A→B→A→C 自愈闭环交互时间线）
```

## 开发

```bash
npm run typecheck          # tsc --noEmit
npm test                   # 全量（含 E2E，需先起 test-site）
npx vitest run tests/loader.test.ts   # 单文件
```

## 路线图

- **v0.1（当前，MVP）**：STATE A 全链路——Schema/Loader/执行引擎/失败分类/报告/凭证/session 复用与自动重登
- **v1.0**：STATE B（LLM Agent 兜底：感知器截图+DOM 压缩 → LangGraph 决策）、STATE C（恢复点 + 轨迹沉淀为新 Playbook 版本 + diff 管理）

三态运行模型与完整设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

MIT
