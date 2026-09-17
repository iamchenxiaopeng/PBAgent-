# PBAgent 项目分享：Playbook + LLM 混合式浏览器操作 Agent

- 项目：PBAgent（Playbook-First Browser Agent）
- 周期：W1–W8（2026-09-08 ~ 2026-09-11），单人四周从 PRD 到 v1.0
- 配套：`docs/PRD.md`（需求定义）、`docs/DESIGN.md`（技术设计）、`docs/RETRO.md`（技术复盘）、`docs/MVP-ACCEPTANCE.md`（验收记录）
- 本文性质：**完整项目分享**——需求背景、方案取舍、技术细节、真实战绩、踩坑实录。适合正在做（或准备做）浏览器自动化 + LLM 混合架构的同学。

---

# 一、项目是做什么的

## 1.1 一句话定位

**已知流程用 Playbook 确定性执行（$0 成本），页面改版失败时 LLM Agent 兜底自愈，自愈路径沉淀为新版本 Playbook——LLM 的钱只花在页面变化的那一次。**

## 1.2 要解决的问题

浏览器自动化（RPA / 爬虫 / E2E）的两个极端都有痛点：

| 方案 | 成本 | 稳定性 | 页面改版后 |
|------|------|--------|-----------|
| 传统 RPA 脚本 | $0 | 高（确定性） | **直接挂，人工修** |
| 纯 LLM Agent | 高（每步推理） | 低（随机性） | 天然适应 |
| **PBAgent（混合）** | **脉冲式** | **高（确定性为主）** | **自愈 + 沉淀，越跑越稳** |

真实业务里 90% 的运行是稳定流程（改价、对账、报表），10% 是页面改版后的异常。纯 LLM 方案为 10% 的场景付出 100% 的持续成本——PBAgent 把成本结构反转过来。

## 1.3 功能清单（v1.0 全量交付）

- **YAML Playbook**：14 种步骤（goto/click/fill/select/check/hover/press/wait/extract/scroll/download/screenshot/assert/loop），`include` 子流程复用，四作用域插值（`${params.*}/${vars.*}/${ctx.*}/${env.*}`）
- **确定性执行引擎**：多层选择器 fallback（css → xpath → text → role/label），每层独立超时
- **失败四分类**：E1 元素定位 / E2 页面状态 / E3 超时 / E4 断言 + EX 配置错误（不触发兜底）
- **凭证与 session**：AES-256-GCM 加密存储；storageState 复用；被踢下线自动重登
- **STATE B LLM Agent**：自然语言任务 → 截图+DOM 双通道感知 → 逐步决策（7 种原子动作）
- **自愈 + 沉淀闭环（A→B→A→C）**：失败兜底 → 恢复点断点续跑 → 轨迹蒸馏为新版本 + diff + 版本链
- **成本统计**：每次调用 tokens 记账、按模型单价折算 USD、run.json 落盘
- **CLI 11 命令** + **Vue3 Web 控制台**（SSE 实时截图流、自带 LLM Key、有头模式、引擎标注）

---

# 二、核心需求与解决方案

## 2.1 需求来源（PRD F-01 ~ F-10）

按优先级排：

| 编号 | 需求 | 解决方案 |
|------|------|---------|
| F-01/02 | Playbook 可定义、可校验、可复用 | zod Schema + 行号定位 + include 递归展开 + 插值静态校验 |
| F-03 | 页面改版后自动自愈 | E1-E4 失败分类路由到 STATE B（LLM 兜底） |
| F-04 | 自然语言直接下任务 | 感知器（截图+DOM 压缩）+ 决策循环（每步一个原子动作） |
| F-05 | 自愈不破坏流程连续性 | 恢复点指纹（评分制）+ 断点续跑 |
| F-06 | 自愈经验可沉淀 | 轨迹蒸馏 → v2 Playbook 草稿 + LCS diff + 版本链 |
| F-07 | 凭证安全 | AES-256-GCM + 一次性环境变量注入 + 全链路脱敏 |
| F-08 | session 复用 | storageState 持久化 + 登录页跳转检测自动重登 |
| F-09 | 运行可观测 | run.json + 单文件 report.html + 失败自动归档截图/DOM |
| F-10 | 成本可控 | 防失控三闸（接管 ≤3 次 / ≤15 步 / $0.10）+ CostTracker |

## 2.2 三态运行模型（架构的脊柱）

```
        ┌─────────── 稳定运行（90%+ 的时间，$0）───────────┐
        │                                                    │
        ▼                                                    │
  ┌──────────┐    失败(E1-E4)    ┌──────────┐   恢复点命中   ┌──────────┐
  │ STATE A  │ ───────────────▶ │ STATE B  │ ───────────▶ │ STATE A  │
  │ Playbook │                  │ LLM 兜底 │              │ 断点续跑 │
  │ 确定性执行│ ◀─────────────── │ 自愈探索 │              │ 收尾完成 │
  └──────────┘   续跑成功        └──────────┘              └──────────┘
        │                                                        │
        │              自愈路径蒸馏为 v2 草稿                      │
        └──────────────▶ ┌──────────┐ ── promote ──▶ 主文件替换    │
                        │ STATE C  │    （v2 零 LLM 通关）         │
                        │ 沉淀版本 │ ◀── rollback ── 一键回滚      │
                        └──────────┘                              │
```

三个状态各自的关键设计：

- **STATE A（确定性）**：多层选择器 fallback + 自动重登。text 层可交互元素优先（详见问题 3）
- **STATE B（LLM 兜底）**：感知→决策→执行循环。防失控三闸防烧钱。confirm 弹窗自动 accept（详见 3.4）
- **STATE C（沉淀）**：不是把 Agent 轨迹原样转 YAML，而是**蒸馏**——失败步骤原位替换、密码框不沉淀、fill 值命中 params 保留插值

## 2.3 关键方案取舍

| 决策点 | 选择 | 放弃 | 理由 |
|--------|------|------|------|
| 感知通道 | DOM 压缩 + 截图双通道 | 纯视觉坐标（CUA 式） | DOM ref 短 ID 定位准、token 省一个量级；截图留作语义校验。CUA 作为 DOM 失效时的 v2 备选 |
| LLM 输出 | 单步单 JSON 动作 | 长链路 ReAct 轨迹 | 单步可审计、失败可隔离；上下文滚动只带最近 8 步历史 |
| 沉淀形态 | 人审后 promote | 自动生效 | LLM 自愈路径可能有迂回，diff 人可读、一键回滚是安全底线 |
| Playbook 格式 | YAML | JSON/代码 | 运营可读可改；行号定位让报错可定位到具体步骤 |
| 失败分类 | E1-E4 + EX 五类 | 二分类（成败） | 分类决定路由：E1-E4 触发兜底、EX 直接终止（配置错误让 AI 修是烧钱） |

---

# 三、技术细节（值得抄走的实现）

## 3.1 Playbook 加载链：从 YAML 到可执行

```
YAML 文本 → js-yaml parse → zod safeParse（类型/格式）→ include 递归展开（前插语义）
        → 插值静态校验（四作用域 + 循环变量栈）→ 语义校验（跨字段约束）
        → 行号定位（trackLines：按 key 扫描源文本估算）
```

四个坑占了本文档问题清单的四个坑（#1 #2 #6 #7 #8），核心教训：**校验层产出的 parse 后数据才是唯一可信数据源**，原始 YAML 对象上 zod 的 `.default()` 根本不存在。

## 3.2 选择器 4 层 fallback（改版存活的关键）

```
css（#id / .class）→ xpath → text（可交互元素优先，button/a/input/[onclick]）→ role/label
```

text 层的两级设计直接来自问题 3 的教训：`getByText('登录')` 按 DOM 顺序命中 `<h1>` 标题而不是按钮。可交互元素优先匹配是 text 层的语义约束，没有它 text 层就是误命中重灾区。

## 3.3 恢复点指纹：Agent 兜底后怎么接回 Playbook

评分制：URL 相等 +30 / selector 弱匹配 +50 / text 命中 +20，失败步后 5 步窗口内逐步检查，过阈值即恢复。开发中发现设计缺口：assert-only 步骤（只有 textContains）上限 20 分永远过不了阈值——补了「候选文本命中即 50 分」。**评分阈值这种设计必须用边界用例验算**，纸面设计推不出来。

## 3.4 STATE B 决策循环

每轮：感知（截图 base64 + DOM 压缩内联 evaluate 采集，ref 编号，120 元素上限）→ LLM 决策一个 JSON 动作 → 执行 → onAfterAction 钩子查恢复点。

三个关键实现细节：

- **page.evaluate 必须自包含**：函数体被序列化到页面执行，模块作用域变量全是 undefined（问题源头见第四章 #16 相关调试记录）
- **confirm() 默认 dismiss**：Playwright 对原生弹窗默认点取消——Agent 反复点"确认下单"看似成功实际被取消。`page.on('dialog', accept)` 一行解决，但排查了一小时
- **click 三级降级链**（真实站点踩出来的）：正常点击 → `force:true`（跳过 hit-test）→ `dispatchEvent('click')`。遮罩层场景 visible/enabled/stable 全绿但指针事件被拦（详见问题 20）

## 3.5 轨迹蒸馏（STATE C）

蒸馏规则：click/fill 生成 `selector: { css, text }` 双保险；Agent 处理过弹窗的步骤带 `dialog: accept`；fill 值命中 params 时保留 `${params.x}` 插值；密码框不沉淀；**include 剥离**（v2 是展开后的 steps，保留 include 会导致登录二次展开）。版本链 `.versions/<name>/v{n}.yaml` + 步骤级 LCS diff + promote/rollback。

## 3.6 成本统计

LLM 响应的 usage 字段逐次记账（CostTracker），按模型单价表折算 USD，未知模型只报 tokens 不报价。每步 AgentStep 带 usage 字段（Web 控制台步骤时间线实时显示 in+out tokens）。

## 3.7 Web 控制台（Vue3 + SSE）

- **后端**（Express 4567）：POST /api/tasks 提交 → 每任务独立 browser context → onStep 钩子推 SSE（log/step/screenshot/done/error 五类事件，缓冲支持迟到订阅回放）
- **前端**（Vite 5273）：EventSource 消费；步骤时间线每步标注执行引擎（Playwright/CUA 徽章）+ 每步 token 消耗
- **安全**：用户自带 LLM Key 走请求级 overrides，只在任务内存存活，不落盘不污染环境变量
- **有头模式**：headless 共享实例 + headed 独立实例（slowMo 300ms 放慢便于观看）双轨

---

# 四、真实战绩

## 4.1 关键场景实测（qwen3.8-max）

| 场景 | 结果 |
|------|------|
| 50 SKU 压测 | 209 步 22.6s **$0**（纯 Playbook） |
| variant=b 改版自愈 | E1 → Agent 1 步发现等价按钮 → 恢复点续跑，全程 23.2s |
| 沉淀闭环 | v1 失败 → 自愈 → 蒸馏 v2 → promote → **v2 零 LLM 2.6s 通关** |
| 纯 Agent 全链路 | 登录+导航+改价 8 步 18.7s，事实校验通过 |
| Web 控制台 E2E | 浏览器提交任务 → SSE 实时截图流 → S050=200 事实校验通过 |

## 4.2 成本结构（实测验证）

| 场景 | LLM 调用 | Tokens | 成本 |
|------|---------|--------|------|
| STATE A 稳定运行 | 0 | 0 | **$0** |
| 自愈一次（A→B→A） | 2 | 8,744 | **$0.0417** |
| 纯 Agent 任务 | 8 | 15,438 | $0.0276 |

**结论**：LLM 成本是脉冲式的——页面改版那一次花 $0.04，之后沉淀版本回到 $0。设计目标「90% 零调用」被实测验证。

## 4.3 真实站点首试（W8，tagent-web UAT）

探索型任务（登录 SSO → 遍历模块 → 理解项目）15 步上限耗尽未完成——暴露三个问题（#20 遮罩拦截、#21 步数预算、#22 网关 302），全部修复并沉淀为本文档第四章的增量记录。真实站点和 test-site 的差距是量级的：**模拟环境验证的是架构，真实环境验证的是工程细节**。

## 4.4 Web 端沉淀闭环检索（W8，selectPlaybook 路由层）

自然语言任务提交时先过 `/api/match`：域名硬过滤 → 单候选直接命中（零 LLM）/ 多候选 LLM 语义选择 → 命中弹卡让用户选「⚡ 零 LLM 执行」或「🤖 Agent 模式重跑」。Playbook 声明的 `${params.*}` 参数自动渲染成输入框并从任务描述预填。实测 v2 版本链 10/10 步全绿、3.4s、零 LLM 通关——**Web 端完整复现了 CLI 的 A→C 收益**。联调暴露 #23（解构丢字段致静默降级）与 #24（参数名截字），已修复。

## 4.5 工程质量

- 114/114 测试全绿（单元 + 真实浏览器 E2E，15 文件）
- F-01 加载 3.03ms/次（标准 <100ms）；F-02 十次一致率 100%、heap 25MB
- MVP 22 条验收标准逐条核验通过

---

# 五、开发节奏（四周怎么走的）

| 周 | 交付 | 测试 | 关键点 |
|----|------|------|--------|
| W1 | Schema + Loader + validate | 21 | zod discriminatedUnion 坑 |
| W2 | 执行引擎 + 失败分类 + test-site | 43 | variant=b 改版开关——后续一切演示的基石 |
| W3 | 报告 + run 命令 + 压测 | 47 | trace 为状态判定唯一事实来源 |
| W4 | **MVP v0.1.0**：凭证 + session + 自动重登 | 69 | recovered 三态报告 |
| W5 | **STATE B**：感知器 + Agent 循环 + chat | 75 | VLM 选型实测 |
| W6 | **A→B→A**：恢复点 + takeover | 83 | confirm 弹窗教训 |
| W7 | **STATE C**：蒸馏 + diff + 版本链 | 107 | v2 零 LLM 通关 |
| W8 | 成本统计 + Web 控制台 + 真实站点首试 | 114 | 真实环境工程细节修正 |

节奏是"每步即时验证"：每个模块做完立即真实浏览器跑通再进下一个。test-site 的 variant=b 改版模拟开关是 W2 投入的一次性基建，W5-W8 全部演示和 E2E 都靠它。

---

# 六、踩坑实录（29 个问题全量）

> 每个问题按「现象 → 定位 → 根因 → 修复 → 通用教训」展开。按层面分组，编号即修复顺序。

## 一览表

| # | 问题 | 层面 | 严重度 |
|---|------|------|--------|
| 1 | zod `.default()` 在 include 展开后丢失 | 数据流 | 高（静默数据错误） |
| 2 | include 子流程执行顺序颠倒 | 加载器 | 高（流程跑错） |
| 3 | `getByText('登录')` 命中 `<h1>` 而非按钮 | 选择器 | 高（点击无效） |
| 4 | 测试站点路由重复注册 | 测试设施 | 中 |
| 5 | redirect URL 拼接 `?`/`&` 错误 | 测试设施 | 中 |
| 6 | discriminatedUnion 不接受 refine 成员 | Schema | 中 |
| 7 | z.lazy 递归类型显式注解后进不了 union | Schema | 中 |
| 8 | 循环内插值在外层作用域被误判 | 校验器 | 中 |
| 9 | 失败分类把配置错误算成页面异常 | 失败检测 | 低 |
| 10 | 报告状态判定依赖单一参数而非 trace | 报告 | 低 |
| 11 | Vitest 断言撞上 `<style>` 里的类名 | 测试 | 低 |
| 12 | Playwright 浏览器下载走官方源超慢 | 环境 | 低 |
| 13 | 本机 curl 代理劫持 localhost | 环境 | 低 |
| 14 | Git Bash 的 printf/heredoc/`/tmp` 三连坑 | 环境 | 低 |
| 15 | 并行 Edit 同一文件产生写覆盖 | 工具链 | 高（文档损坏） |
| 16 | ESM 项目里混入 require 调用 | 工程规范 | 高（运行时炸） |
| 17 | 凭证字段名与 Playbook 插值不对应 | 跨层契约 | 高 |
| 18 | 各模块单测全绿，链路仍挂 | 测试策略 | 高 |
| 19 | Git Bash（mintty）交互式 stdin 读不到输入 | CLI | 中 |
| 20 | Playwright 点击被遮罩层拦截，23 次重试全失败 | 执行器 | 高（真实站点） |
| 21 | 探索型任务的步数预算错配 | 产品设计 | 中 |
| 22 | LLM 网关 302 伪装成 JSON 解析错 | 网络层 | 中（误导排查） |
| 23 | POST /api/tasks 解构丢字段，Playbook 模式静默降级为 Agent 模式 | Web 后端 | 高（功能失效+烧钱） |
| 24 | Playbook 参数名提取截字（"username"→"sername"） | 字符串处理 | 中 |
| 25 | 点击触发导航后 `Execution context was destroyed`，任务被判失败 | 感知器 | 高（真实站点） |
| 26 | 模型不吐 JSON 改吐 DSML 工具调用标记 | LLM 接口 | 高（任务终止） |
| 27 | 截图卡在 `waiting for fonts to load` 超时 30s | 感知器 | 高（真实站点） |
| 28 | Agent 操作百度必被拦到验证码页（指纹暴露 + 首页 cookie 风控） | 反爬对抗 | 高（真实站点） |
| 29 | LLM 返回空 content → 整个任务判 error，前 4 步白跑（重试未覆盖调用失败） | LLM 接口 | 高（任务终止） |

## 问题 1：zod `.default()` 在 include 展开后静默丢失（最值得分享）

**现象**：`extract` 步骤提取页面文本，返回值是 `undefined`。单独跑同样的页面 + 同样的选择器，能拿到正确文本。最诡异的是：**步骤显示成功**（`every ok` 通过），只有 store 里是空。

**定位过程**：
1. 先怀疑页面状态——用 Playwright 裸写一遍登录+导航+取值，拿到正确文本。排除页面问题
2. 再怀疑选择器 fallback——单独调用 `resolveLocator`，命中。排除定位问题
3. 加了一行调试日志打印步骤对象：`{"name":"提取结果条数","into":"doneCount","selector":{...}}` ——**`attr` 字段不见了！**
4. 用 `PlaybookSchema.safeParse` 直接解析同结构数据：`attr = "text"`，default 正常生效

**根因**：加载链路分了两步——`safeParse` 用来**校验**，但 include 展开时用的是 **YAML 解析出的原始对象**（`parsed.doc as unknown as Playbook`）。zod 的 `.default()` 只发生在 parse 的**输出**里；原始 YAML 对象上 `attr` 字段根本不存在。也就是说：**校验归校验，执行归执行，两边消费的是不同对象**。

```typescript
// 错误：校验用 parse 结果，执行用原始 doc
const docErrors = validatePlaybookDoc(parsed.doc, ...); // 内部 safeParse 后丢弃了 data
const pb = parsed.doc as unknown as Playbook;           // ← 原始对象，attr === undefined

// 正确：让校验函数把 parse 后的数据带出来，两边消费同一个对象
const { errors, playbook: parsedPb } = validatePlaybookDoc(parsed.doc, ...);
```

**通用教训**：
- **zod 不是"校验完就扔"的工具，parse 后的 data 才是唯一可信数据源**。任何带 `.default()` / `.transform()` / `.preprocess()` 的 schema，下游消费原始输入 = 丢失这些加工
- 这类 bug 的杀伤力在于**静默**：没有报错、没有异常，只是值悄悄变成 undefined。如果 extract 的值后续被用于断言或兜底决策，会引发连锁误判
- 定位技巧：当"单独跑对、串起来错"时，第一反应应该是**打印中间数据的实际形态**，而不是怀疑逻辑

## 问题 2：include 子流程执行顺序颠倒

**现象**：主 Playbook include 了登录子流程（`_login.yaml`），预期登录步骤在主流程之前执行。实际 validate 输出显示：**主流程的步骤在前，登录步骤在后**——跑起来直接在未登录状态访问受保护页面，被 302 踢回登录页。

**定位**：看 validate 命令打印的展开顺序，一目了然。

**根因**：用 BFS 队列展开 include——入口文件先出队，它的 `steps` 先 push 进 `mergedSteps`，然后才轮到 include 的子文件。**BFS 的"同层先完成"语义和"include 前置"的需求天然相反**。

**修复**：改为递归下降，返回 `{ pre, own }` 结构，拼接为 `[...pre, ...own]`：

```typescript
const loadFile = (file, depth) => {
  const pre = [];
  for (const inc of pb.include ?? []) {
    const child = loadFile(incPath, depth + 1);  // 递归
    pre.push(...child.pre, ...child.own);
  }
  return { pre, own: pb.steps };
};
// 最终：steps = [...pre, ...own]
```

**通用教训**：**include 的语义是"前置插入"，不是"并列展开"**。写加载器之前先想清楚语义再选数据结构；用命令行工具（validate 打印展开结果）做顺序的可视化验证，比单测断言更直观。

## 问题 3：`getByText('登录')` 命中标题而非按钮

**现象**：登录 Playbook 的"点登录"步骤成功执行（无报错），但表单没提交——断言 `/dashboard` 失败，页面还停在 `/login`。**点击动作"成功"地点了个寂寞**。

**定位**：用 Playwright 裸脚本逐步排查。`getByText('登录', { exact: false }).first()` 命中的是 `<h1>演示后台登录</h1>`——页面上第一个包含"登录"的元素是标题，不是按钮。

**根因**：`getByText` 是纯文本匹配，**不感知元素的可交互性**。页面上"登录"两个字出现在 `<h1>`、`<title>`、`<button>` 三处，`.first()` 按 DOM 顺序取了标题。点击标题元素在 Playwright 里是合法操作（不报错），但没有任何业务效果。

**修复**：选择器的 text 层拆成两级——**优先匹配可交互元素**（button/a/input/label/`[role="button"]`/`[onclick]`），找不到再退化到任意文本节点：

```typescript
// text 层（第一优先：可交互元素）
page.locator('button, a, input, select, label, [role="button"], [onclick]', { hasText: text }).first()
// text-any 层（兜底：任意文本，应对非标准实现）
page.getByText(text, { exact: false }).first()
```

**通用教训**：
- **"点击成功"≠"点击了正确的东西"**。Playwright 的 click 只保证"点到了一个元素"，不保证业务语义。这就是为什么 Playbook 里的关键操作后面必须跟 assert（提交后断言跳转/成功提示），而不是信任 click 本身
- 文本选择器必须做**可交互性过滤**——这条经验直接来自真实页面，纯文档读 Playwright API 想不到
- 选择器多层 fallback 的分层顺序（css → xpath → text → role/label）里，text 层是"改版存活率最高"的语义层，但也是最容易误命中的一层，必须加约束

## 问题 4：Express 路由重复注册，第二个永不执行

**现象**：保存 SKU 后跳转的列表页应显示"保存成功"toast（`.toast` 元素），断言却始终找不到该文本。手动 curl 保存后的 URL，返回的 HTML 里确实没有 toast。

**定位**：grep `app.get('/sku/list'` 发现注册了**两次**——一次不带 `req.query.saved` 处理（无 toast），一次带（有 toast）。Express 按注册顺序匹配，第一个命中后直接响应，**第二个路由是死代码**。

**根因**：迭代开发时复制粘贴了列表路由，忘了删旧版本。Express 对重复路由**不报错、不警告**。

**修复**：删除重复注册，只保留带 toast 逻辑的那个。

**通用教训**：写演示站点（test-site）这类"测试基础设施"时，重复路由是高频事故——**用 grep 做一次路由清单盘点**应该是每次改完的固定动作。基础设施的 bug 会伪装成业务系统的 bug，浪费排查时间（这次先怀疑的是引擎的页面等待逻辑）。

## 问题 5：redirect URL 拼接 `?`/`&` 错误

**现象**：保存后浏览器地址是 `/sku/list&saved=S001`（**缺 `?`**），服务器把它当未知路径返回 404，断言"保存成功"失败。

**根因**：模板拼接 `${back}&saved=${id}` 写死了 `&`。当 `back` 本身不带 query（`/sku/list`）时，拼出来的是 `list&saved=x`；variant=b 场景下 `back` 带 query（`/sku/list?variant=b`）时反而是对的。**两种场景只测了一种**。

**修复**：

```typescript
const sep = base.includes('?') ? '&' : '?';
res.redirect(302, `${base}${sep}saved=${id}`);
```

**通用教训**：URL 拼接永远写 `sep` 判断，不要手写 `&`。测试要覆盖"带 query 的 base"和"不带 query 的 base"两种情况——这次正是 variant=b 路径对了、默认路径错了，说明测试矩阵不完整。

## 问题 6：zod discriminatedUnion 不接受任何 refine 包装的成员

**现象**：TypeScript 编译报一大串 `ZodEffects is missing the following properties from type 'ZodObject': _cached, _getCached, shape...`。

**根因**：给 `AssertStepSchema` 加了 `.refine()` 做"至少一项"的跨字段校验。`.refine()` 的返回值是 `ZodEffects`（包装器），而 `z.discriminatedUnion()` 要求成员必须是**纯 ZodObject**（它需要直接读取每个成员的 shape 来构建判别索引）。`superRefine` 同理也不行。

**修复**：把跨字段约束从 Schema 层挪到**语义后置校验层**（loader 的 `validateSemanticRules`），Schema 只管字段类型。附带收益：语义校验函数可以处理"Schema 失败后对可解析部分继续校验"，一次报出全部问题而不是修一个见一个。

**通用教训**：
- zod 的 `discriminatedUnion` 是性能优化的特化 API，**能力换性能**：快（判别索引 O(1) 定位成员）但限制多（成员必须裸 ZodObject）
- Schema 层 vs 语义层的分界：**字段类型/格式约束放 Schema，跨字段依赖放语义层**。这不只是 workaround，是正确的分层
- 好的报错体验需要"尽力多报"：第一个错误就短路会逼用户玩打地鼠

## 问题 7：z.lazy 递归 schema 的类型注解陷阱

**现象**：loop 步骤要递归引用 `StepSchema`（steps 里嵌 steps），用 `z.lazy(() => StepSchema)` 实现。为了给 LoopStepSchema 显式类型，写了 `const LoopStepSchema: z.ZodType<LoopStep> = ...`——结果它进了 discriminatedUnion 又报类型不兼容。

**根因**：`z.ZodType<T>` 注解会把推断类型**泛化降级**，丢失 ZodObject 的结构信息（shape/describe/extend 等方法），于是又不满足 discriminatedUnion 的成员约束。**问题 6 的孪生兄弟**：一个是不小心包了 ZodEffects，一个是主动注解成了宽类型。

**修复**：不注解，让 TS 自推断；类型用 `Extract<Step, { action: 'loop' }>` 从联合类型中派生。z.lazy 内部加 `(): z.ZodTypeAny =>` 显式返回注解打断循环推断。

**通用教训**：递归 schema 的类型表达，**"运行时用 z.lazy、类型用 Extract 派生"** 是安全组合；不要试图给递归 schema 的值定义写显式注解。

## 问题 8：循环体内的插值在外层作用域被误判

**现象**：静态插值校验对嵌套 loop 报错——明明 `loop var: item` 声明了循环变量，内层步骤用 `${item.id}` 却提示"引用了未定义的作用域"。同一 Playbook 报 2-3 个错误，全是误报。

**根因**：校验实现里 `JSON.stringify(step)` 把 **loop 步骤连同嵌套 steps 整体序列化**，正则把内层的 `${item.id}` 也扫出来了——但此时扫描发生在**外层作用域**（loop 变量还没"压栈"）。内层插值被外层规则审判。

**修复**：loop 步骤只序列化自身字段（`{ ...step, steps: undefined }`），嵌套交给递归 walk 在正确的作用域（含循环变量）下校验。

**通用教训**：**递归数据结构（嵌套 loop）的校验必须递归处理，不能在任一层做"整体序列化"**。作用域类校验（变量可见性）尤其如此——每层有自己的上下文。这个 bug 的信号很明显：误报数量与嵌套引用数一致，看到"报错数 == 内层引用数"就该想到是层级穿透了。

## 问题 9：配置错误被分类为"页面状态异常"

**现象**：环境变量 `DEMO_PASSWORD` 未设置时，失败分类显示 `[E2 页面状态异常]`。但这是**配置问题**（变量缺失），跟页面八竿子打不着。更严重的是：按设计 E1-E4 会触发 LLM 兜底接管——让 AI 去"修复"一个缺环境变量的问题，纯烧钱。

**根因**：`classifyError` 的兜底分支把所有未知错误都归 E2。插值错误（`InterpolationError`）没有专属分类路径。

**修复**：新增 `EX 配置错误` 分类——变量缺失、参数未注入、环境变量不存在。EX 类**不触发兜底**，直接终止（修配置才是正解）。

**通用教训**：失败分类体系的**兜底分支要慎用**。"未知 → 页面异常"这种懒惰映射会把配置错误、代码 bug 都伪装成页面问题。分类的本质是决定**后续路由**（要不要调 LLM），宁可精确分类失败进"未知"，也不要错误地路由到昂贵路径。

## 问题 10：报告状态判定依赖单一参数

**现象**：单测里给 `summarizeRun(trace, ...)` 传了含失败步骤的 trace 但没传 `failure` 参数，报告状态显示 `success`——**与 trace 事实矛盾**。

**根因**：状态判定只看 `failure` 参数（`status: failure ? 'failed' : 'success'`）。trace 里有 failed 步骤但 failure 参数缺失时（比如调用方忘了传），状态就错。

**修复**：状态以 **trace 中的失败步骤为准**（`Boolean(failedStep) || Boolean(failure)`），failure 参数只补充分类详情。

**通用教训**：**单一事实来源（single source of truth）原则**——同一状态有两个表达（trace 里的步骤状态 + 异常对象）时，必须指定一个为权威，另一个是派生。这里 trace 是权威（它总是完整的），异常对象是补充（分类详情）。

## 问题 11：Vitest 断言撞上 `<style>` 里的类名

**现象**：断言"成功报告不含失败区块"：`expect(content).not.toContain('fail-card')` 失败——但报告明明是成功场景。

**根因**：HTML 模板的 `<style>` 里**永远**有 `.fail-card { ... }` 的 CSS 定义。类名在样式表里存在 ≠ 区块在 body 里渲染。

**修复**：断言改为 `not.toContain('class="card fail-card"')`（完整属性串，只有真实渲染才有）。

**通用教训**：对 HTML 做字符串断言时，**样式表/模板代码会污染内容断言**。要么断言完整属性串，要么用 DOM 解析后断言节点存在性。小问题，但在 CI 里随机出现的"灵异失败"多半属于这类。

## 问题 12-15：环境与工具链坑（快速记录）

### 12：Playwright 浏览器下载慢
官方 CDN 国内直连龟速。**解法**：`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium`，npmmirror 镜像几分钟搞定。

### 13：本机 curl 代理劫持 localhost
`curl http://localhost:3456` 返回 502——走了系统代理。**解法**：`curl --noproxy '*'`。测试 localhost 服务时这是高频拦路虎。

### 14：Git Bash 三连坑（Windows）
- `printf 'a\nb'` 的 `\n` 被吃掉 → 写多行文件用 **heredoc**（`cat <<'EOF'`）
- `/tmp` 映射到 `D:\tmp` 而非系统临时目录 → 临时文件放项目目录或用 `$TMP`
- 命令内联双引号字符串里的 `${...}` 会被 bash 展开 → 单引号包裹或转义

### 15：并行 Edit 同一文件产生写覆盖
对同一文件**并行提交多个 Edit**，后执行的编辑基于旧快照，**把同批次其他编辑的修改回滚了**（表现为：明明修过的错字又回来了）。**解法**：同一文件的修改必须串行；改动多时直接整文件重写（Write 覆盖）。这不是理论风险——本文档项目第一天就真实发生，部分修复被静默回滚，靠全文 grep 乱字才查出来。

### 16：ESM 项目里混入 require 调用（W4）
`pbagent auth list` 报 `require is not defined`——项目是 ESM（`"type": "module"`），`src/credentials/store.ts` 的 `listDomains()` 里还留着 `require('node:fs')`。CJS 习惯带入 TS 项目是高频事故：**模块内的 require 不会过 tsc 检查**（tsc 只查类型），运行时才炸。**解法**：`grep -rn "require(" src/` 全量盘点，全部改成顶部 ES import。教训：ESM 项目初始化时就该把 `require` 列为 grep 禁词。

### 17：凭证字段名与 Playbook 插值不对应（W4）
自动重登首测失败：`[EX 配置错误] env.DEMO_PASSWORD 环境变量不存在`。根因：登录 Playbook 写的是 `${env.DEMO_PASSWORD}`，但凭证存的字段名是 `password`，注入规则 `k.toUpperCase()` 产出的是 `env.PASSWORD`——**两侧命名约定没对齐**。这种"约定漂移"在跨层传递（存储层 → 注入层 → 模板层）时极易发生，且报错在最后一层才爆出来。**解法**：统一约定——凭证字段名即环境变量名的小写形式（`demo_password` ↔ `DEMO_PASSWORD`），并在 README 明示。

### 18：整合性 bug 的典型形态——各模块单测全绿，链路仍挂（W4）
重登 E2E 首跑 2/5 挂：凭证模块单测 10/10 绿、session 模块绿、engine 绿，但串起来就是 `env.DEMO_PASSWORD 不存在`。再次验证：**单测证明的是"零件合格"，不是"装配正确"**。跨层契约（字段名、环境变量、插值路径）必须有 E2E 用例兜底，且失败信息要带链路上下文（哪个步骤、引用的什么变量、去哪找）。

### 19：Git Bash（mintty）交互式 stdin 读不到输入（W4）
`pbagent auth set` 交互输入按回车无响应——程序卡死等 stdin。根因：Git Bash 的 mintty 是**伪终端**，Node 的 `process.stdin` 在 mintty 下默认不是行缓冲模式，`'data'` 事件的行为与原生终端不一致（管道正常、交互卡死，测试时用管道全过，用户一上手就翻车）。**解法**：① 加 `--pair k=v` 非交互参数（推荐日常/脚本用）；② 管道输入自动识别（`!process.stdin.isTTY` 分支）；③ 交互分支保留但文档标注 mintty 兼容性风险。教训：**CLI 的交互式输入必须在真实终端验证，管道测试通过 ≠ 交互可用**——这是 W4 auth 命令测试（全管道）漏掉的真实场景。

### 20：Playwright 点击被遮罩层拦截——「element is visible, enabled and stable」却 23 次重试全失败（W8，真实站点 tagent-web 首试）
**现象**：Agent 决策正确（点弹窗「取消」按钮关闭知识库选择弹窗），locator 也精确解析到了目标 `<button>`，Playwright 日志显示 `element is visible, enabled and stable`，但每轮重试都卡在同一行：`<main class="workspace">…</main> intercepts pointer events`，重试 23 次、10s 超时。两次点击（「取消」和「关闭 ×」）全挂，4 步预算白烧，最终 15 步上限耗尽任务失败。
**根因**：Playwright 点击前的 hit-test 检查——**点击落点坐标必须由目标元素接收指针事件**。该站点弹窗的关闭按钮视觉位置与实际可点击区域被 `<main class="workspace">` 容器的布局层级遮住（overlay/嵌套布局导致视觉位置与 hit-test 区域不重合）。元素本身可见、可用、稳定，但指针事件永远到不了它。test-site 的理想化弹窗从未暴露过这个层级问题。
**修复**：executeAction 的 click 加三级降级链：正常点击（5s 超时）→ 拦截/超时时 `force: true` 强制点击（跳过 hit-test，1s）→ 仍失败则 `dispatchEvent('click')` JS 派发。三级全部失败才判定该步失败。
**通用教训**：**Playwright 的"元素可用"三件套（visible/enabled/stable）不包含"可接收指针事件"**——第四项 hit-test 是独立检查，遮罩场景三者全绿它照样红。真实站点（复杂 UI 库、overlay 层叠）的点击必须预设降级链；「决策正确但执行挂死」消耗的步数预算比决策错误更冤——前者每次 10s 超时 + Agent 再决策，形成双重浪费。

### 21：探索型任务的步数预算错配（W8）
**现象**：同一个 15 步上限：test-site 改价任务 8 步完成，真实站点「遍历功能模块 + 理解项目」15 步只够走完登录 + 两三个页面——其中还有 4 步被问题 20 的点击超时吃掉。
**根因**：15 步默认值是按「单一目标闭环」（登录+改价+确认）校准的；探索型任务（枚举模块、逐个进入、归纳功能）的步数量级是目标数的倍数。且步数上限是 AgentOptions 的防失控闸门（设计初衷是防死循环烧钱），被顺手用成了任务预算。
**修复**：Web 表单最大步数支持留空 = 不设上限（后端 null → Infinity）；数值上限提升到 200。CLI 场景保持显式传参。
**通用教训**：**"防失控上限"和"任务预算"是两个概念**——前者是安全阀（防 3 类失控：死循环、漂移、烧钱），后者应该按任务类型给。探索类任务要么放开步数靠 done/fail 语义收敛，要么把上限设为目标模块数的 3-5 倍。上线给用户配额时同理：防失控硬限（比如 200）+ 任务预算软限（用户可调）分层。

### 22：LLM 网关偶发 302 重定向，fetch 跟随后拿到 HTML 当 JSON 解析（W8，真实站点任务）
**现象**：Web 控制台提交任务后 agent 立即报错 `LLM 请求异常: Unexpected token '<'`——响应体是 HTML。
**根因**：企业内网网关（newapi-hk.transsion.com）会话过期或鉴权失效时返回 302 重定向到 SSO 登录页。Node fetch 默认跟随重定向，最终拿到登录页 HTML，`resp.json()` 解析炸出语法错误——报错信息完全没提示"其实是鉴权问题"。
**修复**：chat() 里对 resp.ok 为 false 的分支已经能兜住非 2xx，但 302→200（SSO 页）场景需要显式处理：json 解析失败时检查 content-type，非 application/json 报 `LLM 网关返回了非 JSON 响应（可能是网关鉴权失效，请检查 API Key / BASE_URL）`。
**通用教训**：**fetch 的 redirect: 'follow' 默认值会把"认证失败"伪装成"响应格式错误"**。对内部网关的 API 调用，永远检查最终响应的 content-type；错误信息要还原真实原因，别让上层拿着 `Unexpected token '<'` 猜半天。

### 23：POST /api/tasks 解构丢字段，Playbook 零 LLM 模式静默降级为 Agent 模式（W8，selectPlaybook 联调）
**现象**：Web 端命中沉淀流程后提交（请求体明确带 `"playbookFile": "playbooks/demo-reprice.yaml"`），任务却实际走了 Agent 模式——SSE 里出现「感知/决策 fill ref=2」等 LLM 步骤，烧了本不该花的 token，最后还报 error。
**根因**：路由入口 `const { url, task, llm, maxSteps, headed } = req.body` 解构**漏了新增的 playbookFile/params 两个键**，随后重组 options 时这两个字段被静默丢弃 → `executeTask` 里 `if (options.playbookFile)` 永远为假 → 全部任务走 LLM 分支。TypeScript 对"解构少拿一个键"零告警——`req.body as TaskOptions` 的类型断言只是声明，不校验运行时结构。
**修复**：解构补全 + playbookFile 路径穿越校验（resolve 后必须在 playbooks/ 目录内）。
**通用教训**：**给请求体加字段时，"接口层解构 + 重组"的写法是隐式白名单——新增字段必须两端同步，且无任何编译期保护**。防回归手段：要么直接透传 body（配合 zod 校验），要么给关键字段加路由级冒烟测试（提交带 playbookFile 的任务断言 SSE 首条 log 是 ⚡ 而非 Agent 感知日志）。

### 24：Playbook 参数名提取截字——"username" 变 "sername"（W8）
**现象**：/api/match 返回的参数声明是 `["sername", "rice"]`，首字母各被截掉一个。
**根因**：从 `${params.username}` 提取变量名时写了 `r.slice('$${params.'.length, -1)`——模板串里误写了两个 `$`，长度从 10 变 12，正好多切掉首字符。"魔法字符串长度"和"复制粘贴时的转义"叠加的经典翻车。
**修复**：改用显式正则替换 `r.replace(/^\$\{params\./, '').replace(/\}$/, '')`，可读且不依赖长度计算。
**通用教训**：**字符串切别用偏移量算长度，用正则/前后缀剥离**——前者对转义、隐字符零容错，一个 `$` 之差结果错位且不报错（参数名静默错误 → 前端渲染错误输入框 → 用户填了也不生效）。验证时打印中间产物一眼可辨，这正是调试方法论第 1 条的又一次应验。

### 25：点击触发导航后 `Execution context was destroyed`，整个任务被判失败（W9，真实站点百度）
**现象**：真实站点跑 Agent，第 2 步 click「百度一下」后报错 `page.evaluate: Execution context was destroyed, most likely because of a navigation`，任务直接 error 终止——而本地 test-site 全流程一直全绿。
**根因**：`snapshot()` 里 `Promise.all([screenshot, evaluate, evaluate, title])` 跑在旧页面上下文上；点击触发跳转的瞬间上下文被销毁，四个子任务任一抛错就冒泡到 `runAgent`。本地 test-site 几乎不跳转，所以这个路径从未被激活过。
**修复**（两处）：① `snapshot.ts` 新增 `collectWithRetry()`——整批采集包一层重试，识别 `Execution context was destroyed / not found / Page was closed / navigation` 后递增退避（300/600ms）最多 3 次，重试拿到的是跳转后的新页面；② `loop.ts` 动作执行后补 250ms 沉降窗口，降低撞车概率。
**通用教训**：**本地跑通 ≠ 真实站点跑通——凡是跨"页面跳转边界"的感知/执行调用，都要假设执行上下文会销毁**。这类崩溃属于"竞态"而非"错误"，靠断言测不出来，只能靠重试兜底；放在 `snapshot()` 内部而非调用方，所有入口（Agent 主循环 / 兜底接管）一并受益。

### 26：模型不吐 JSON，改吐 DSML 工具调用标记（W9，DeepSeek 思考模式）
**现象**：任务报错 `无法从模型输出解析 JSON: <｜｜DSML｜｜ invoke name="click"><｜｜DSML｜｜ parameter name="ref" string="true">12...`。同一套 prompt 在别的模型上一直正常。
**根因**：DeepSeek 思考模式偶发不输出纯 JSON，而是输出自家的 **DSML 工具调用标记**（全角竖线 `｜` 分隔符）。原 `extractJson` 只认 JSON 和 Markdown 围栏 → 抛错 → 整个任务失败。
**修复**（三层防御）：① **请求侧**：`chat()` 新增 `jsonMode`，带 `response_format:{type:'json_object'}` 从源头压掉工具调用输出，网关不认该字段（400）时自动去掉重试一次；② **解析侧**：新增 `parseDsml()` 还原 action/参数，`ref`/`ms` 按白名单转 number（工具标记里值一律带 `string="true"`，不转会被告警 `parseAction` 拒）；③ **重试**：`loop.ts` 新增 `decideAction()`，解析失败时把模型**自己那条坏输出**回传 + 纠错提示，最多 3 次，每次计入 cost。
**踩坑**：正则第一版写成 `<[^>]*DSML[^>]*>\s*parameter\s+name=` —— 错，`parameter` 在**尖括号标签内部**（`<｜DSML｜parameter name="ref">值</｜DSML｜parameter>`），不是标签后的文本。这个错误只有拿真实样本跑才能发现。
**通用教训**：**模型输出格式不可信，"解析模型输出"这个环节必须三件套：请求侧约束 + 解析侧兼容 + 失败重试**。只做解析兼容不够（下次换个格式又挂），只做重试不够（浪费一轮才知道格式错）。另外：把模型的坏输出原样回传让它自我纠正，比单纯重复请求有效得多。

### 27：截图卡在 `waiting for fonts to load` 超时 30s（W9，真实站点）
**现象**：`page.screenshot: Timeout 30000ms exceeded · waiting for fonts to load...`，一步卡死 30 秒，任务体验极差。
**根因**：Playwright 的 `page.screenshot()` 会等 `document.fonts.ready`；真实站点的外部字体 CDN 慢/被墙时加载不完，就一直挂到默认 30s 超时。**该字体等待没有参数可以关闭**。本地 test-site 无外部字体，永不触发。
**修复**：`snapshot.ts` 新增 `takeScreenshot()` 三级降级——① 普通截图，超时从 30s 压到 **6s**；② 超时后用 **CDP `Page.captureScreenshot`** 直取（不等 fonts.ready，实测 50ms）；③ 仍失败返回空串，调用方退化为**纯 DOM 决策**（截图为空时不发 `image_url`，并在 prompt 里告知模型"仅依据 DOM 摘要决策"）。
**验证方式**：用 `page.route` 挂起所有 woff/woff2/ttf 请求 + 注入一个永远 pending 的 `FontFace`，人为复现字体卡死——对照组普通截图 6012ms 如期超时，实验组 `snapshot()` 6048ms 拿到截图（base64 长度 85104），降级确认生效。
**通用教训**：**涉及外部资源或页面跳转的 Playwright 调用，一律显式设超时（别用默认 30s）+ 准备降级路径**。#25 和 #27 是同一类病根的两面：一个崩在跳转、一个崩在资源等待，都是"相信了默认行为"。

### 28：Agent 操作百度必被拦到验证码页（W10，反爬对抗）

**现象**：Agent 跑"百度搜索 XXX"，无论怎么操作都跳 `wappass.baidu.com/static/captcha/tuxing_v2.html`，最终只能 `fail`。

**根因是三层叠加，逐一挖出来的**：

1. **无头指纹暴露**。探测结果：裸 headless 下 `navigator.webdriver === true`、UA 里带 `HeadlessChrome`、`window.chrome` 为 `undefined`——三条都是"我是机器人"的自白
2. **首页交互会种下风控 cookie**。这是关键，也是最反直觉的一条：
   | 路径 | 结果 |
   |---|---|
   | 冷启动直接访问 `/s?wd=xxx` | ✅ 7 条结果 |
   | 先访问首页 → 再访问 `/s?wd=xxx` | ❌ 验证码 |
   | （复测）冷启动直接访问 | ✅ 7 条结果 |
   三次一致，说明**一旦访问过首页，同一 context 后续怎么走都被拦**
3. **百度新版首页改版**（附带发现）：`#kw` 被 `.smart_input_superman .virtual-form { display: none }` 隐藏，唯一可见输入框变成 AI 聊天框 `#chat-textarea`。这是独立的"页面改版"问题，agent 用 DOM 感知能自己找到新元素

**修复（四层，按"先预防再自愈"排序）**：

| 层 | 改动 | 位置 |
|---|---|---|
| 预防 | `src/browser/stealth.ts` 反爬指纹擦除：`webdriver`、`languages`、`plugins`、`hardwareConcurrency`、`window.chrome`、Permissions、WebGL vendor；UA 按 `browser.version()` 动态生成（避免写死版本号与内核不符）；launch 加 `--disable-blink-features=AutomationControlled` | 新增文件 + 三处 launch 统一接入 |
| 预防 | 提示词规则 7：**搜索类站点优先直接 goto 结果页 URL，别点首页搜索框** | `loop.ts` SYSTEM_PROMPT |
| 自愈 | 感知到验证码页 → **自动 `clearCookies()`**（确定性兜底，不烧 token）+ 给 LLM 注入"已重置风控，请重新 goto"，单任务上限 2 次防死循环 | `loop.ts` 主循环 |
| 能力 | 新增 **drag 动作**（`{action:'drag', ref, dx, dy}`）：先快后慢的 ease-out 曲线 + y 轴抖动 + 8~20ms 随机停顿，模拟真人拖动；drag 不进蒸馏（反爬对抗不是业务流程） | `loop.ts` / `distill.ts` |

顺带修的白名单缺口：`m.baidu.com` 被 `www.baidu.com` 白名单拒绝（移动版是常见绕验证码手段），新增同主域放行（取域名最后两段比较）。

**验证**：端到端 `chat "在百度搜索 Playwright…" --url https://www.baidu.com`
```
[1] goto 搜索结果页（规则 7 生效）
[2] 撞验证码 → ⚠ 自动清空 cookie 自愈 → 重新 goto
[3] 正常结果页 → done
✓ 3 步 / 10.3s / $0.0038，正确读出首条结果标题
```

**一个反直觉的结论**：**清 cookie 比换 UA 更管用**。被拦后 `clearCookies()` 再访问同一 URL 就恢复正常（实测 7 条结果）——风控标记主要挂在 cookie 上，而不是 IP 或指纹。所以"自愈"这一步放在感知之后，用零成本手段解决，不消耗 LLM。

**通用教训**：
- **反爬对抗要分"预防"和"自愈"两层做，且自愈优先用确定性手段**（清 cookie），别一上来就让 LLM 猜
- **诊断反爬问题时，先做路径对照实验**（哪个入口被拦、哪个不拦），比直接改指纹有效得多——这次三组对照实验一次定位到"首页 cookie"这个真凶，否则会在指纹上白耗时间
- **本地 test-site 永远测不到反爬**。这类问题只能靠真实站点暴露，且**结论易过期**（站点改版/风控升级），代码里要把实测日期和结论写进注释，方便后人判断是否需要重新验证

---

### 29：LLM 返回空 content → 整个任务被判 error，前 4 步白跑（重试机制形同虚设）

**现象**：Web 控制台跑本地改价任务，前 4 步（登录 → 进 SKU 列表）全部正常，第 5 步感知完 50 个元素的页面后任务**无声停止**——没有失败日志、没有重试记录、时间线停在第 4 步。报错只有一句 `LLM 返回空 content`。

**排查**：先确认是不是稳态故障。写探测脚本，用真实页面（登录 → `/sku/list`，50 元素 + 截图）复刻决策请求，交叉 `jsonMode` × `maxTokens` 共 6 组——**6 次全部正常返回**，所以是偶发。但探测抓到两条关键情报：

```
usage.completion_tokens_details: {"reasoning_tokens": 15}   ← 是思考型模型，带 reasoning_content
content: "{\"action\":\"click\",\"ref\":1,...}\n\nWait, I need to output only JSON. Let me output the JSON object.<｜end▁of▁thinking｜>{...}"
                                                            ↑ 思考残留混进 content，两个 JSON 连排（靠 extractJson 括号配对救回）
```

**根因（真正的 bug 不在模型，在代码）**：

```ts
for (let attempt = 1; attempt <= 3; attempt++) {
  const raw = await chat(...);   // ← 在 try 之外！
  try { return parseAction(raw.text); } catch { /* 只有解析失败才重试 */ }
}
```

`chat()` 抛的 `LlmError`（空 content / 超时 / 429 / 5xx）**完全绕过了重试循环**，直接冒泡到 `runAgent` → 服务端 catch → 整个任务判 error。**已执行的 4 步截图、轨迹、花掉的 token 全部丢弃**。所谓"三层防御"（#26 那次加的）只对"模型吐了坏格式"生效，对"模型什么都没吐"完全无效。

空 content 本身的成因：思考型模型把 `max_tokens`（决策固定 1000）烧在 `reasoning_content` 上，`finish_reason=length` 而 `content` 为空。

**修复（四层）**：

| 层 | 做法 |
|---|---|
| 诊断 | `chat()` 空 content 时抛错附带 `finish_reason` / `completion_tokens` / reasoning 长度；`LlmError` 新增 `retryable`（空输出/超时/429/5xx 可重试，400/401/403 不可重试）和 `usage` |
| 重试 | `chat()` 调用**移进 try**，调用失败与解析失败走同一套重试；重试前追加 system 提示「跳过思考过程，直接输出 JSON」 |
| 降级 | 每次重试**换一种请求形态**而非原地重复：<br>① jsonMode + 截图 + 1×tokens → ② jsonMode + 截图 + 2×tokens → ③ **无 json 约束 + 纯 DOM（去图）** + 3×tokens<br>（`response_format:json_object` 和图像输入都是已知的偶发空输出诱因，最后一次两个都去掉） |
| 兜底 | `runAgent` 里决策彻底失败时**不再抛异常**：保留已完成的 steps，输出 `summary = "LLM 决策失败，任务中止于第 N 步（已完成 M 步）：原因"`，报告照常生成 |
| 记账 | 失败调用也 `tracker.add(err.usage)` —— 网关对 `finish_reason=length` 的截断输出**照样收费**，不记账会让成本统计失真（实测：3 次失败烧了 1000+2000+3000 tokens 却显示 `llmCalls=0`） |

**验证**：起 mock 网关**必然**返回空 content（可控复现，不靠偶发）：

```
Case A（第 1 次空、第 2 次恢复）：
  决策调用失败（第 1/3 次）：LLM 返回空 content（finish_reason=length，completion_tokens=1000，reasoning长度=32）—将重试
  决策 wait（22ms）— mock 决策          ← 恢复，任务继续跑完 3 步，不再中止

Case B（连续 3 次空）：
  第 1/3 次（1000 tokens, json, 有图）—将重试
  第 2/3 次（2000 tokens, json, 有图）—将重试
  第 3/3 次（3000 tokens, 无 json, 无图）—已用尽重试
  ✗ LLM 决策失败，任务中止于第 1 步（已完成 0 步）：…   ← 结构化退出，不抛异常
  请求序列确认降级阶梯生效：maxTokens 1000→2000→3000，jsonMode true→true→false，hasImage true→true→false
```

真实模型端到端：8 步任务全部完成，8 次 LLM 调用无一空 content。

**通用教训**：
- **写完重试先问一句"它覆盖了所有失败路径吗"**：#26 加的重试只包了 `parseAction`，把 `chat()` 留在 try 外面——防御写了等于没写。**重试循环必须把"调用"和"解析"一起包进去**
- **重试要换形态，不要原地重复**：同样的请求再发一次，模型很可能以同样方式再失败一次。加大 token 上限、去掉 JSON 约束、去掉图片，每次都消除一个可能的诱因
- **单步失败不该毁掉整条任务**：已执行的步骤、截图、花掉的钱都是资产。宁可输出"中止于第 N 步 + 原因"，也别抛异常让 everything 归零
- **失败调用也要记账**：`finish_reason=length` 的截断输出网关照样按 completion_tokens 收费，只统计成功调用会让成本报表严重偏低
- **偶发故障要靠 mock 验证**：真实 API 6 次全正常，根本复现不了。起一个能**必然**产生该故障的 mock 服务（HTTP 层拦截），才能确定性地验证容错逻辑真的生效

---

# 附 A：调试方法论小结

这轮开发沉淀的排查套路，按效率排序：

1. **打印中间数据的实际形态**（问题 1 的转折点）：当"单独跑对、串起来错"，打印链路中间产物，一步锁定数据在哪一跳变形
2. **最小复现脚本**（问题 3 的定位方式）：把失败链路抽成 20 行裸 Playwright 脚本，剥离自己的代码层，二分定位是基础设施问题还是业务代码问题
3. **可视化验证优于断言**（问题 2）：validate 命令打印展开顺序，肉眼一秒看出顺序颠倒——比写断言快得多
4. **grep 清单盘点**（问题 4/16）：改完配置类文件，grep 关键注册/绑定做一次盘点
5. **疑罪从有**（问题 9/10）：兜底逻辑和默认值都是潜在 bug 源，review 时重点盯 `?? / || 兜底` 和 `catch 后忽略`

# 附 B：测试策略的实战验证

- **test-site 改版模拟开关（variant=b）**被证明是全套设施里最值钱的一个：按钮改文本、类名重命名、确认弹窗三个改版因子一次注入，E1 检测/选择器 fallback 的用例全部围绕它展开
- **先跑真实场景再补断言**：本轮 E2E 全部先手工跑通（调试脚本）再固化成测试，没有一个是"先写断言再碰运气"
- 单测 + E2E 的组合里，**真正抓住集成 bug 的全是 E2E**——单测覆盖的是纯函数逻辑，集成问题（顺序、状态、页面）只有 E2E 能暴露。但对纯逻辑（插值作用域、失败分类），单测的定位效率远高于 E2E
- **真实站点是最后一公里**：test-site 验证架构（三态闭环全绿），真实站点验证工程细节（遮罩、网关、预算）——W8 的 #20-22 全部来自真实站点首试，一个都没能在模拟环境预演；**W9 的 #25-27 再次印证，且三个的共同病根是"相信了默认行为"**（默认无重试、默认输出 JSON、默认 30s 超时）。结论已固化为编码约定：**凡跨外部资源或页面跳转的调用，显式设超时 + 备好降级路径**
- **#28 补一条方法论**：排查反爬/风控类问题，**先做入口路径对照实验**（哪条路被拦、哪条不拦），再动手改代码。本次三组对照（冷启动直连 / 首页→搜索页 / 复测）一次就锁定"首页 cookie"这个真凶，避免了在指纹伪装里瞎试。另外**自愈手段优先选确定性的**（清 cookie）而非让 LLM 猜——零成本且可预测

# 附 C：下一步（v1.x 候选）

1. 真实业务站点双周试点——统计真实自愈率（当前只有模拟数据）
2. LLM 自动降级链 + 网关健康探测（单网关依赖是 STATE B 的可用性风险）
3. **Agent 动作集补拖拽/鼠标轨迹**——真实站点撞上滑块验证码（百度安全验证）时，7 种动作无拖拽能力只能判 fail；配套还需无头浏览器的 UA/指纹策略
4. 蒸馏轨迹最短化（迂回路径去重/合并——当前 v2 是原位替换，Agent 绕路会让 v2 变长）
5. CUA 视觉通道（DOM 失效时的兜底执行引擎；AgentStep.engine 字段已预留分流位）
6. Web 控制台任务历史持久化 + Playbook 版本管理界面化

---

*相关文档：[PRD](PRD.md)｜[DESIGN](DESIGN.md)｜[RETRO（技术复盘）](RETRO.md)｜[MVP-ACCEPTANCE](MVP-ACCEPTANCE.md)｜[演示：A→B→A→C 时间线](assets/abac-timeline.html)｜[README](../README.md)*
