# PBAgent MVP（v0.1.0）验收报告

> 验收日期：2026-09-08 · 对照 `docs/PRD.md` F-01 ~ F-10 逐条核验
> MVP 范围：F-01/02/03/07/08/09（F-04/05/06/10 属 v1.0，见排期）

## 验收总表

| 功能 | 验收标准 | 结果 | 证据 |
|------|---------|------|------|
| F-01 Playbook 解析与校验 | 合法 YAML 100% 解析 | ✅ | loader.test.ts 21 用例 |
| | 非法 YAML 带行号报错 | ✅ | 同上（缺字段/类型错/选择器错均有定位） |
| | include 循环引用检测 | ✅ | loader.test.ts「循环引用」用例 |
| | 500 次加载平均 < 100ms | ✅ **3.03ms** | 本次基准测试（reprice.yaml，含 include 展开+插值校验） |
| F-02 确定性执行引擎 | 12 种步骤全部实现+单测 | ✅ | steps.ts 12 执行器；E2E 6 用例 |
| | 连续 10 次结果 100% 一致 | ✅ | 本次基准测试（签名逐字段比对） |
| | 100 步无内存泄漏（<50MB） | ✅ **25.0MB** | 本次基准测试（heapUsed） |
| F-03 失败检测 | E1-E4 100% 正确分类 | ✅ | detector.test.ts 9 用例 + E2E（variant=b→E1、超时→E3、跳转→E4） |
| | E2 快速检测不等满超时 | ✅ | goto 响应监听（≥400 即抛），assert 300ms 轮询 |
| | 失败自动归档（截图+DOM+步骤 ID） | ✅ | runs/<runId>/screenshots/failure.png + dom/failure.html |
| F-07 参数化 | --params / --params-file | ✅ | run.ts + E2E |
| | loop 批量 50 SKU 改价 | ✅ **22.6s** | W3 压测记录 |
| | 缺参/类型错明确报错 | ✅ | InterpolationError → EX 分类，带步骤定位 |
| | 敏感参数自动脱敏 | ✅ | redact.test.ts 7 用例；报告/日志全 `***` |
| F-08 运行报告 | HTML/JSON 双格式 | ✅ | report.test.ts + 产物 |
| | 步骤明细+模式+成本（$0） | ✅ | HTML 报告含 LLM 调用 0 次标注 |
| | 机器可读字段稳定 | ✅ | RunSummary 结构定义 |
| F-09 凭证管理 | session 复用 10 次免重登 | ✅ | 本次基准测试（10/10 跳过登录） |
| | 凭证加密 AES-256-GCM | ✅ | credentials.test.ts 10 用例（密文无明文） |
| | 过期自动重登 | ✅ | relogin.e2e.test.ts：踢下线→自动重登→recovered；CLI 三连验证 |
| | 凭证文件权限检查 | ✅ | checkPermission（Unix 600 校验；Windows 下大小+存在性校验） |

## 超出 MVP 验收线的项

- **自动重登完整闭环**（PRD 要求"触发 Agent 重新登录或重新跑登录 Playbook"，MVP 用后者实现）：踢下线 → 检测登录页 → 凭证注入重跑登录子流程 → session 刷新 → 业务重试 → `recovered` 状态。CLI 实跑三次（无 session/复用/踢线）全通
- **报告三态**：success / **recovered**（新增强，session 自愈成功）/ failed
- **dev:site 命令**：一键起演示站点

## 已知限制（MVP 范围内不修，记录在案）

1. 重登后业务重试是**整段重跑**（非失败步骤断点续跑）——断点续跑依赖 v1.0 恢复点机制
2. `withCredentials` 的敏感字段判断是字段名正则（/password|secret|token/i），未覆盖自定义命名的敏感字段——Playbook 可用 `meta.sensitive` 显式补充
3. Windows 下凭证文件权限只能做存在性+大小校验（ACL 校验留 v1.0）
4. trace 中 `re-` 前缀的 stepId 在多次重试叠加时可能重复（当前只重试一次，无实际冲突）

## 验收结论

**MVP（STATE A）通过验收。** 69 个测试全绿（单测 63 + E2E 含自动重登 6 个场景）；PRD 划入 MVP 的 6 项功能 22 条验收标准全部达成，其中 4 条性能指标显著优于标准线。

下一步（v1.0，W5-W8）：感知器 + LLM Agent 兜底（STATE B）→ 恢复点续跑（F-05）→ 轨迹沉淀与版本管理（F-06）。
