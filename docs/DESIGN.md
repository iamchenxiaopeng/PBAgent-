# 开发文档：PBAgent — Playbook + LLM 混合式浏览器操作 Agent

- 版本：v1.1（对齐实现修订版）
- 日期：2026-09-16（初版 2026-09-08）
- 配套文档：`docs/PRD.md`（需求文档，功能编号 F-01 ~ F-10 与本文对应）
- 技术栈：Node.js ≥ 20 + TypeScript + Playwright + OpenAI 兼容 LLM（纯提示词工程，原生 fetch）+ js-yaml + zod
- **实现说明**：初版设计曾计划用 LangGraph.js 编排 Agent，实际实现为**纯提示词工程 + 手写决策循环**（`src/agent/loop.ts`，无任何 Agent 框架依赖）。本文已按实际实现修订表述，架构语义不变（observe → think → act → check 对应 loop 内的感知 → 决策 → 执行 → 恢复点检查）。

---

## 1. 总体架构

### 1.1 分层架构图

```
┌─────────────────────────────────────────────────────────────────┐
│  CLI 层（commander）                                             │
│  pbagent run / validate / chat / versions / auth                 │
├─────────────────────────────────────────────────────────────────┤
│  编排层（Orchestrator）—— 三态运行模型的核心                      │
│  ┌───────────┐   失败    ┌──────────────┐   完成   ┌──────────┐ │
│  │ Playbook  │ ───────→ │ LLM Agent    │ ───────→ │ 沉淀器   │ │
│  │ 执行引擎  │ ←─────── │ 决策循环      │          │ Learning │ │
│  │ (STATE A) │  恢复点  │ (STATE B)    │          │ (STATE C)│ │
│  └───────────┘          └──────────────┘          └──────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  Web 层（src/server + web/）                                     │
│  会话式控制台 V2 · SSE 实时推送 · 智能路由 · 版本链查询           │
├─────────────────────────────────────────────────────────────────┤
│  能力层                                                          │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ │
│  │Playbook │ │浏览器   │ │感知器     │ │凭证     │ │报告生成器│ │
│  │解析/校验│ │驱动器   │ │截图+DOM  │ │管理器   │ │JSON+HTML │ │
│  └─────────┘ └─────────┘ └──────────┘ └─────────┘ └──────────┘ │
├─────────────────────────────────────────────────────────────────┤
│  基础层                                                          │
│  Playwright(Chromium+stealth) │ LLM API │ 本地文件系统(runs/)    │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 模块职责

| 模块 | 职责 | 对应需求 |
|------|------|----------|
| cli | 命令解析、参数注入、全局配置 | F-07 |
| orchestrator（agent/takeover.ts） | 三态调度（A→B→A→C）、run 生命周期、恢复点回归 | F-04/F-05 |
| playbook | YAML 加载、Schema 校验、include 展开、版本管理 | F-01/F-06 |
| executor | Playwright 确定性执行、步骤结果写上下文 | F-02 |
| detector | 4 类失败检测与分类 | F-03 |
| perception | 截图采集、DOM 压缩序列化 | F-04 |
| agent | 决策循环兜底 Agent（纯提示词工程，截图+DOM 双通道） | F-04 |
| recovery | 恢复点 fingerprint 计算与匹配 | F-05 |
| learner | Agent 轨迹 → YAML 沉淀、diff 生成 | F-06 |
| credentials | 凭证加密存储、storageState 复用、脱敏 | F-09 |
| reporter | 运行报告（JSON+HTML）、成本统计 | F-08 |
| recorder | 自然语言→Playbook 草稿（录制模式，F-10 待实现） | F-10 |
| router | 智能路由：自然语言 → 沉淀流程匹配（域名过滤 + LLM 选择） | V2 |
| server | Web 后端：任务 API + SSE + 会话存储 | V2 |
| browser | stealth 反检测（UA/WebDriver 指纹擦除） | W10 |

### 1.3 一次失败自愈的完整时序

```
Playbook step#7 (click "提交订单") 执行
  → locator.waitFor 超时 → detector 判定 E1
  → 归档失败产物（截图+DOM+stepId）→ 进入 STATE B
  → perception 采集（截图 + DOM 摘要）
  → agent 决策循环：
      thought: "提交按钮改名为'确认下单'，位于原位置下方"
      action: click(text="确认下单")
      → 执行 → recovery.check() → 未命中恢复点 → 继续
      thought: "已点击，等待订单确认页"
      action: wait(url_pattern="/order/done")
      → recovery.check() → 命中 step#9 的恢复点
  → 回到 STATE A，从 step#9 续跑（step#8 的效果已达成，标记 skipped-by-agent）
  → Playbook 跑完 → STATE C：轨迹转 YAML → 生成 v2 → diff 落盘
  → 退出码 0，报告标注 A(6步)→B(2步)→A(11步)→C
```

---

## 2. 工程结构

```
pbagent/
├── src/
│   ├── cli/                    # CLI 入口与子命令
│   │   ├── index.ts            # 命令注册
│   │   ├── run.ts              # pbagent run（--takeover/--learn/--headed）
│   │   ├── validate.ts         # pbagent validate
│   │   ├── chat.ts             # pbagent chat（自然语言任务）
│   │   ├── auth.ts             # pbagent auth（凭证管理）
│   │   └── versions.ts         # versions/promote/rollback/diff 四合一
│   ├── agent/                  # STATE B：Agent 决策与编排
│   │   ├── loop.ts             # 感知→决策→执行主循环（纯提示词工程）
│   │   ├── llm.ts              # LLM 调用层（原生 fetch + CostTracker + extractJson）
│   │   └── takeover.ts         # A→B→A 混合编排（恢复点回归）
│   ├── perception/
│   │   └── snapshot.ts         # 截图 + DOM 压缩序列化（ref 短 ID）
│   ├── recovery/
│   │   └── fingerprint.ts      # 恢复点指纹计算与评分匹配
│   ├── router/
│   │   └── select.ts           # 智能路由（域名硬过滤 + LLM 选择 + 参数提取）
│   ├── server/                 # Web 后端
│   │   ├── index.ts            # 任务/会话/历史/版本链 API + SSE
│   │   ├── sessions.ts         # 会话存储（web-sessions.json 落盘）
│   │   ├── history.ts          # 任务历史（web-history.json 落盘）
│   │   └── playbook-history.ts # 版本链查询 API 支撑
│   ├── playbook/
│   │   ├── schema.ts           # zod Schema 定义（14 种步骤）
│   │   ├── loader.ts           # YAML 加载 + include 展开 + 插值校验
│   │   └── examples/           # 示例 Playbook
│   ├── executor/
│   │   ├── engine.ts           # 步骤执行循环（loop 嵌套展开）
│   │   ├── steps.ts            # 14 种步骤执行器（单文件集中分发）
│   │   ├── context.ts          # 上下文对象 + 四作用域插值
│   │   ├── selector.ts         # 多层 fallback 选择器解析
│   │   └── relogin.ts          # 被踢自动重登
│   ├── detector/
│   │   └── failure.ts          # E1-E4+EX 分类
│   ├── learner/
│   │   ├── distill.ts          # 轨迹 → YAML 步骤（蒸馏规则）
│   │   ├── differ.ts           # 步骤级 diff（LCS）
│   │   └── versioning.ts       # 版本链管理（.versions/）
│   ├── credentials/
│   │   ├── store.ts            # AES-256-GCM 加密读写
│   │   └── session.ts          # storageState 持久化复用
│   ├── browser/
│   │   └── stealth.ts          # 反检测（UA 动态生成/WebDriver 指纹擦除）
│   ├── reporter/
│   │   └── report.ts           # run.json + report.html 单文件生成
│   └── shared/
│       └── redact.ts           # 全链路脱敏
├── test-site/                  # 本地演示站点（改版模拟/踢下线）
│   └── server.ts
├── tests/                      # 单测 + E2E（21 文件 114 用例）
├── web/                        # Vue3 控制台 V2（会话式交互）
│   └── src/components/         # Sidebar/HomeView/SessionView/MessageTask/SettingsPanel
├── playbooks/                  # 用户 Playbook 库 + .versions/ 版本链（运行时目录）
├── runs/                       # 运行产物 + web-sessions.json + web-history.json（运行时目录）
├── credentials/                # 加密凭证（运行时目录）
└── package.json
```

约束：**单文件 ≤ 500 行**，超过必须拆模块（步骤执行器天然一文件一步，符合该约束）。

---

## 3. Playbook YAML Schema 设计

### 3.1 完整 Schema（zod 定义）

```typescript
// src/playbook/schema.ts
import { z } from 'zod';

export const SelectorSchema = z.object({
  css: z.string().optional(),          // 第一优先：CSS
  xpath: z.string().optional(),        // 第二优先：XPath
  text: z.string().optional(),         // 第三优先：可见文本（精确/包含）
  role: z.string().optional(),         // 第四优先：ARIA role
  label: z.string().optional(),        // ARIA label / 关联 label
  nth: z.number().int().min(0).optional(), // 命中多个时取第几个
}).refine(s => s.css || s.xpath || s.text || s.role || s.label, {
  message: 'selector 至少需要 css/xpath/text/role/label 中的一项',
});

export const BaseStep = z.object({
  id: z.string().optional(),           // 缺省自动生成 s1,s2...
  name: z.string(),                    // 人类可读步骤名
  timeout: z.number().int().positive().optional(),  // 毫秒，覆盖全局
  screenshot: z.enum(['always', 'on-fail', 'never']).optional(), // 默认 on-fail
  onFailure: z.enum(['takeover', 'fail', 'skip']).optional(),    // 默认 takeover
});

export const StepSchema = z.discriminatedUnion('action', [
  BaseStep.extend({ action: z.literal('goto'), url: z.string() }),
  BaseStep.extend({ action: z.literal('click'), selector: SelectorSchema }),
  BaseStep.extend({ action: z.literal('fill'), selector: SelectorSchema,
                    value: z.string() }),                       // 支持 ${params.x} 插值
  BaseStep.extend({ action: z.literal('select'), selector: SelectorSchema,
                    value: z.string() }),
  BaseStep.extend({ action: z.literal('check'), selector: SelectorSchema,
                    checked: z.boolean().default(true) }),
  BaseStep.extend({ action: z.literal('hover'), selector: SelectorSchema }),
  BaseStep.extend({ action: z.literal('press'), key: z.string() }), // 如 Enter/Escape
  BaseStep.extend({ action: z.literal('wait'),
                    ms: z.number().optional(),
                    urlPattern: z.string().optional(),
                    selector: SelectorSchema.optional() }),
  BaseStep.extend({ action: z.literal('extract'), selector: SelectorSchema,
                    attr: z.enum(['text', 'value', 'href', 'src']).default('text'),
                    into: z.string() }),                        // 存入 ctx.<into>
  BaseStep.extend({ action: z.literal('scroll'), to: z.enum(['top', 'bottom']),
                    selector: SelectorSchema.optional() }),
  BaseStep.extend({ action: z.literal('download'),   // 等待下载并落盘
                    urlPattern: z.string().optional(),
                    saveTo: z.string() }),
  BaseStep.extend({ action: z.literal('screenshot'),
                    fullPage: z.boolean().default(false),
                    saveTo: z.string().optional() }),
  BaseStep.extend({ action: z.literal('assert'),     // E4 断言来源
                    selector: SelectorSchema.optional(),
                    urlPattern: z.string().optional(),
                    textContains: z.string().optional() }),
  // v1.0 追加（P1）
  BaseStep.extend({ action: z.literal('loop'), over: z.string(),  // ctx/params 中的数组
                    var: z.string(),                               // 循环变量名
                    steps: z.array(z.lazy(() => StepSchema)) }),
]);

export const PlaybookSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  description: z.string().optional(),
  vars: z.record(z.string()).optional(),          // 静态变量
  include: z.array(z.string()).optional(),        // 复用的子 Playbook 路径
  meta: z.object({
    baseUrl: z.string().optional(),               // 相对 URL 的前缀
    allowDomains: z.array(z.string()).optional(), // Agent 接管时的域名白名单（继承目标站点）
    sensitive: z.array(z.string()).optional(),    // 脱敏字段名列表
  }).optional(),
  steps: z.array(StepSchema).min(1),
});
```

### 3.2 示例：改价 Playbook（对应 PRD 场景 1）

```yaml
# playbooks/reprice.yaml
version: 1
name: sku-reprice
description: 后台批量改价：进入 SKU 编辑页 → 改价 → 保存
include:
  - ./_login.yaml            # 复用登录子流程
vars:
  adminHost: https://admin.internal.example.com
meta:
  baseUrl: ${vars.adminHost}
  allowDomains:
    - admin.internal.example.com
  sensitive: [password]
steps:
  - action: goto
    name: 打开 SKU 列表
    url: /sku/list
  - action: loop
    name: 逐个改价
    over: ${params.items}          # CLI 传入 [{id:'S001',price:99}, ...]
    var: item
    steps:
      - action: goto
        name: 进入 SKU 编辑页
        url: /sku/${item.id}/edit
      - action: fill
        name: 填新价格
        selector: { css: '#price' }
        value: '${item.price}'
      - action: click
        name: 点保存
        selector: { text: 保存 }
      - action: assert
        name: 确认保存成功
        textContains: 保存成功
        timeout: 5000
```

### 3.3 选择器多层 fallback（对应 PRD「避坑」）

执行顺序：**CSS → XPath → text → role/label**，每层独立超时（合计受步骤 timeout 约束）：

```
resolve(selector):
  for strategy in [css, xpath, text, role, label]:
    if strategy 提供:
      locator = build(strategy)
      if locator.waitFor(visible, perLayerTimeout):
        return locator        # 命中即返回
  throw E1(元素定位失败, 已尝试策略列表)
```

设计理由：
- CSS 挂了大概率是改版（类名变了），XPath 次之；text 是人类语义，改版存活率最高
- text 命中多个元素时按 `nth`（默认 0）+ 可见性过滤
- Agent 沉淀新步骤时**必须带 text 兜底**：`{ css: ..., text: ... }` 双保险，下次改版还能活

### 3.4 变量插值

- 作用域：`${params.*}`（CLI 注入）、`${vars.*}`（Playbook 静态）、`${ctx.*}`（前序 extract 写入）、`${env.*}`（环境变量，敏感）
- 实现：递归遍历步骤对象做字符串模板替换（`\$\{(\w+(?:\.\w+)*)\}`），替换失败在 validate 阶段就报错（哪个步骤哪个变量没定义），不留到运行时

---

## 4. 确定性执行引擎

### 4.1 执行主循环（伪代码）

```typescript
async function runPlaybook(pb, params, opts): Promise<RunResult> {
  const ctx = createContext(pb, params);        // vars/params/env 三层作用域
  const trace: StepTrace[] = [];
  let cursor = 0;
  while (cursor < pb.steps.length) {
    const step = pb.steps[cursor];
    const started = now();
    try {
      const result = await executeStep(step, ctx);   // 分发到 steps/*.ts
      trace.push(ok(step, result, now() - started));
      ctx.apply(result);                             // extract 的值写入 ctx
      cursor = next(cursor, step);                   // loop/if 跳转，否则 +1
    } catch (err) {
      const classified = detector.classify(err, step);  // → E1/E2/E3/E4
      await archive(step, classified);                  // 截图+DOM+错误 落盘 runs/<runId>/
      trace.push(fail(step, classified, now() - started));
      if (step.onFailure === 'fail' || !opts.agentEnabled) throw classified;
      // —— STATE B：兜底接管 ——
      const outcome = await agent.takeover({ step, classified, ctx, pb, cursor });
      if (outcome.type === 'recovered') {
        cursor = outcome.resumeCursor;               // 从恢复点续跑
        trace.push(takeoverSegment(outcome));        // 记录 B 段轨迹
      } else {
        throw new RunFailure('agent-exhausted', outcome);
      }
    }
  }
  return finish(trace, ctx);
}
```

### 4.2 上下文对象（RunContext）

```typescript
interface RunContext {
  vars: Record<string, string>;            // Playbook 静态变量（只读）
  params: Record<string, unknown>;         // CLI 注入（只读）
  store: Record<string, unknown>;          // extract 写入区
  get(path: string): unknown;              // 'params.items' / 'store.orderId'
  interpolate(input: string): string;      // 模板替换
}
```

- `store` 是 Agent 回归时唯一需要无损传递的状态——takeover 前后用同一个 ctx 实例即可满足「回归时变量不丢失」（PRD F-05 验收）

### 4.3 失败分类（E1-E4）实现要点

| 类型 | 判定来源 | 关键实现 |
|------|----------|----------|
| E1 元素定位 | selector.resolve 全层超时 | 每层 3s（可配），错误附「已尝试策略」 |
| E2 页面状态 | 每步执行前的前置检查（pre-flight） | URL 与步骤期望比对（goto/wait 有 urlPattern 时）；监听 page 的 response，404/500/302→登录页 即刻失败，**不等超时**（满足 3s 内检出） |
| E3 超时 | goto/load/下载整体超时 | page.goto timeout、download timeout、run 级总超时（默认 30min） |
| E4 断言 | assert 步骤 | locator 可见 + 文本包含 + URL 匹配，三者按声明组合 |

E2 的 pre-flight 是「不等满超时」的关键：在 `waitFor` 的同时并发监听 URL/response 变化，命中异常模式立即短路抛出。

---

## 5. 兜底 Agent 设计（纯提示词工程）

> 实现说明：初版设计为 LangGraph 状态图，实际落地为**手写决策循环**（`src/agent/loop.ts`，~530 行，无框架依赖）。
> 循环节点语义与下图一一对应：observe=snapshot()、think=chat() 单轮决策、act=动作执行器、check=onAfterAction 恢复点钩子。

### 5.1 决策循环

```
            ┌──────────┐
            │  START   │ takeover 失败上下文注入
            └────┬─────┘
                 ▼
          ┌─────────────┐   恢复点命中？──是──→ END(recovered, resumeCursor)
          │   observe   │ ──────────────┐
          └──────┬──────┘               │
                 ▼                      │
          ┌─────────────┐  否           │
          │    think    │ (LLM 推理)    │
          └──────┬──────┘               │
                 ▼                      │
          ┌─────────────┐  动作被 guard 拒 ─→ think 重试(计入步数)
          │     act     │
          └──────┬──────┘
                 ▼
          ┌─────────────┐
          │   check     │ 步数超上限(15)?──→ END(exhausted)
          └─────────────┘
```

- 循环节点：`observe → think → act → check` 循环，`check` 内做恢复点匹配 + 步数/预算检查
- 每步状态即 `AgentStep` 对象（step/url/action/ok/screenshot/engine），轨迹天然可回放；无跨 run checkpoint（run 结束即弃，简化 v1）

### 5.2 感知输入（perception）

**截图通道**：
- 视口截图（非全页，控制 token）JPEG quality=70，分辨率 1280×800
- 若 think 判定「目标元素可能在视口外」，act 可先 scroll 再触发下一轮 observe

**DOM 通道**（截图喂不全的信息，也是省 token 的关键）：
- 只序列化**可见**元素：`display/visibility/opacity` 过滤
- 每个候选元素输出一行：`[k23] button "确认下单" (可见, 可点击, 坐标~(640,512))`
- 上限 300 个元素 / 8KB 文本，超限按「可交互优先 + 视口内优先」截断
- 元素带短 ID（k23），think 输出动作时直接引用 ID，act 映射回真实 locator——**避免视觉模型输出坐标漂移问题**

### 5.3 think 节点 Prompt 骨架

```
你是浏览器自动化兜底 Agent。原定脚本步骤执行失败，需要你接管完成剩余任务。

## 任务目标
{playbook.description}
当前应完成: {失败步骤.name} —— {失败步骤 YAML}
失败原因: {E1: css:'#price' 等全部策略未命中}

## 页面现状
[截图] [DOM 摘要(带元素ID)]

## 已执行动作（本接管段）
1. click(k23 "确认下单") —— 已完成

## 输出格式(JSON)
{"thought": "一句话推理",
 "action": "click|fill|press|drag|goto|wait|done|fail",
 "target": "元素ref 或 URL", "value": "fill 时的值", "dx/dy": "drag 位移"}
```

约束：temperature=0；请求侧 jsonMode + 解析侧兼容（DSML/双 JSON/围栏）+ 失败带坏输出纠错重试（最多 3 次）；`done` 表示任务已达成、`fail` 表示判断无法完成。

### 5.4 act → Playwright 映射与 guard

| Agent 动作 | Playwright 调用 | guard 规则 |
|-----------|-----------------|-----------|
| click(ref) | locator.click() | 目标元素所在 frame 的 URL 域名必须在 allowDomains |
| fill(ref, v) | locator.fill(v) | 同上；值经脱敏管道 |
| press(key) | page.keyboard.press() | key 白名单（Enter/Escape/Tab/Arrow*） |
| drag(ref, dx, dy) | mouse.move+down+up（ease-out 曲线+抖动） | 域名白名单；不进蒸馏（反爬对抗非业务流程） |
| goto(url) | page.goto() | url 域名必须在 allowDomains |
| wait(ms) | page.waitForTimeout | 无 |
| done / fail | 结束接管 | 无 |

guard 三条硬规则（PRD F-04 安全约束）：
1. **域名白名单**：任何导航/提交动作目标域名 ∉ allowDomains → 拒绝，记入轨迹
2. **危险动作拒绝**：click 目标元素匹配危险特征（文本含 删除/支付/清空/deactivate，或 button[type=submit] 且上下文为删除确认）→ 无人值守模式直接拒绝
3. **步数与预算双上限**：默认 15 步 / 单次接管 LLM 花费上限 $0.10，任一超限 → END(exhausted)

### 5.5 LLM 配置（OpenAI 兼容）

```typescript
// .env：PBA_LLM_BASE_URL / PBA_LLM_API_KEY / PBA_LLM_MODEL
// 实现见 src/agent/llm.ts：原生 fetch 调 OpenAI 兼容 /chat/completions，
// CostTracker 按模型单价表折算 USD，请求级 overrides 支持 Web 端用户自带 Key（不落盘）。
// 选型硬约束：所选模型必须支持图像输入（截图双通道决策依赖）——
// 实测 deepseek-flash 可用；deepseek-v4-pro 纯文本模型不可用。
// 模型自动降级链（qwen → glm → deepseek）为 v1.x 候选，当前单模型。
```

---

## 6. 恢复点判定与回归

### 6.1 恢复点 fingerprint

对 Playbook 中失败步骤之后的每个候选步骤 k（k = cursor+1 .. end），预计算 fingerprint：

```typescript
interface RecoveryPoint {
  stepIndex: number;             // 命中后从该步骤续跑
  urlPattern?: RegExp;           // 步骤声明的期望 URL（goto/wait 的 urlPattern）
  selector?: Selector;           // 步骤操作的目标元素
  assertText?: string;           // assert 的 textContains
  score: number;                 // 匹配强度
}
```

匹配算法（每轮 Agent 动作后执行，预算 500ms）：

1. 取当前 page.url + 首屏可见元素集合（复用 perception 已有数据，**零额外采集**）
2. 对每个候选点：URL 命中 +30 分，selector 命中 +50 分，assertText 命中 +20 分
3. score ≥ 50 且为**最高分唯一** → 判定命中；并列取 stepIndex 更小者
4. 只检查失败步骤之后的 5 个步骤（窗口），避免误匹配到已过页面

### 6.2 回归语义

- 命中步骤 k → Playbook cursor 直接跳到 k（步骤 cursor..k-1 标记 `skipped-by-agent`，报告中可见）
- 回归后 onFailure 计数不清零：同一 run 内 Agent 接管次数上限 3 次（防死循环 A→B→A→B），超限整体失败
- Agent 段内 fill 过的值若对应后续 extract 步骤，正常执行不冲突（extract 重新读取页面真值）

---

## 7. Playbook 自动沉淀（STATE C）

### 7.1 轨迹 → YAML 转换规则

Agent 轨迹中每个成功动作 → 等价步骤：

| Agent 动作 | 生成步骤 |
|-----------|----------|
| click(k) | `action: click, selector: {css: 真实css, text: 元素可见文本}`（双保险） |
| fill(k, v) | `action: fill, selector: {...}, value: v`；若 v 来自 params → 保留插值形式 |
| press(key) | `action: press, key` |
| scroll/wait | 合并进相邻步骤的 timeout，不单独生成（减少噪音） |
| goto(url) | `action: goto, url`；URL 中的动态段（如订单号）替换回 `${ctx.*}` |

### 7.2 版本管理

```
playbooks/
  reprice.yaml              ← 当前生效版本（v2）
  .versions/
    reprice/
      v1.yaml               # 原版
      v2.yaml               # 沉淀版
      v2.diff.md            # 人可读 diff（步骤级：新增/替换/跳过标注）
      meta.json             # {current: 2, history: [{v, runId, date, reason}]}
```

- 沉淀流程：新版本写入 `.versions/` → 生成 diff → 默认**不生效**，`pbagent promote reprice --to v2` 确认后替换主文件（`--auto-promote` 运行参数可跳过确认）
- 回滚：`pbagent rollback reprice --to v1`（把 v1.yaml 拷回主文件，meta.current 回退）
- diff 粒度：步骤级（不是行级 YAML diff），标注 `+ 新增步骤 / ~ 替换步骤(原 stepId) / - 删除步骤`

---

## 8. 录制生成（F-10，v1.0 后期）

### 8.1 draft 模式流程

```
pbagent draft "在演示后台把 SKU S001 的价格改成 99"
  → LLM-1（纯文本规划）：生成 Playbook 草稿（含猜测的 selector）
  → 试跑草稿（onFailure=takeover，Agent 边修边记）
  → 全程记录成功路径
  → learner 沉淀为正式 Playbook
  → 参数抽取：LLM-1 后处理——把"S001/99"这类值改写为 ${params.id}/${params.price}
```

要点：
- 草稿阶段就允许失败率高（本来就是要跑一遍让 Agent 修），预算上限单独放宽（$0.30/次 draft）
- 参数抽取规则：值出现在 fill/value 位置且与用户输入语义对应 → 提取为参数；出现在 URL 路径 → 同样提取
- codegen 导入（P2）：解析 codegen 的 JS 输出中 `page.click('...')` 等调用链 → 直接映射为步骤（纯语法转换，无 LLM）

---

## 9. 凭证与安全

### 9.1 凭证存储

```
credentials/
  admin.internal.example.com.enc      # AES-256-GCM(json {username, password})
```

- 密钥来源优先级：`PBAGENT_KEY` 环境变量 > Windows Credential Manager / macOS Keychain > 拒绝运行并提示
- 文件权限：创建后立即 chmod 600（Windows 下校验 ACL 仅当前用户可读）
- 写入接口：`pbagent auth set admin.internal.example.com`（交互式输入，不回显、不进 shell 历史）

### 9.2 session 复用

```
runs/
  .sessions/
    admin.internal.example.com.json   # Playwright storageState（cookies+localStorage）
```

- Playbook 声明 `auth: admin.internal.example.com` → 启动时加载 storageState
- E2 检测到跳登录页：优先重跑 `include` 的登录子 Playbook（用存储的凭证）→ 成功后刷新 storageState → 从失败步骤重试一次；仍失败才走 Agent

### 9.3 脱敏管道

- logger/reporter 序列化任何对象前过一遍 redact：key ∈ `sensitive` 列表或匹配 /(password|token|secret|cookie)/i → 值替换 `***`
- Agent 的 think 输入中 fill 值同样脱敏（LLM 不需要看到真实密码，只需要知道「此处填入了凭证」）

---

## 10. 运行产物与报告

### 10.1 runs 目录结构

```
runs/
  2026-09-08_11-30-52_reprice_a1b2/
    run.json                # 结构化报告（见 §10.2）
    report.html             # 人可读报告（单文件，内联截图缩略图 base64）
    screenshots/
      s01_goto.png
      s07_fail.png
      takeover_t01.png      # Agent 段截图
    dom/
      s07_fail.html         # 失败时 DOM 快照
    downloads/              # download 步骤落盘
```

### 10.2 run.json 核心结构

```json
{
  "runId": "2026-09-08_11-30-52_reprice_a1b2",
  "playbook": "reprice@v1",
  "status": "success",
  "mode": { "playbookSteps": 16, "agentSteps": 2, "segments": ["A", "B", "A"] },
  "steps": [
    { "id": "s01", "name": "打开 SKU 列表", "status": "ok", "ms": 812, "screenshot": "screenshots/s01_goto.png" },
    { "id": "s07", "name": "点保存", "status": "recovered", "failure": "E1", "takeoverMs": 14300 }
  ],
  "cost": { "llmCalls": 3, "tokensIn": 18400, "tokensOut": 620, "usd": 0.021 },
  "learned": { "newVersion": "v2", "diff": ".versions/reprice/v2.diff.md", "promoted": false }
}
```

成本统计：每次 LLM 调用记录 tokens → 按模型单价表（config 可更新）折算 USD；Playbook 模式自然为 0 调用 $0。

---

## 11. CLI 命令设计

```
pbagent run <playbook.yaml> [--params JSON] [--params-file f] [--headless] [--no-agent] [--auto-promote]
pbagent validate <playbook.yaml>            # Schema 校验 + 摘要打印
pbagent draft "<自然语言任务>" [--budget 0.3]
pbagent report <runId> [--open]             # 打开 HTML 报告
pbagent promote <name> --to <v>             # 沉淀版本生效
pbagent rollback <name> --to <v>
pbagent auth set <domain>                   # 存凭证
pbagent cost <runId>                        # 打印成本明细
```

---

## 12. 测试策略

### 12.1 本地演示站点（test-site）

自研 Express 静态站点，**内置「改版模拟」开关**——这是测自愈能力的核心设施：

| 页面 | 用途 | 可模拟改版 |
|------|------|-----------|
| /login | 登录（session cookie） | — |
| /sku/list → /sku/:id/edit | 改价主流程 | 按钮改文本、加确认弹窗、类名重命名、插入步骤 |
| /form/long | 30 字段长表单 | 字段增删 |
| /report/export | 下载导出（E3 超时模拟） | 下载延迟注入 |
| /flaky | 限流弹窗（E2 模拟） | 随机弹「操作频繁」遮罩 |

改版通过 `?variant=b` query 或环境变量切换，E2E 用例固定为：v1 跑通 → 切 variant=b → 断言 E1 检出 + Agent 接管 + 回归 + v2 沉淀。

### 12.2 用例分层

| 层 | 范围 | 关键用例 |
|----|------|----------|
| 单测 | schema/loader/selector/context/fingerprint/cost | 10 类非法 YAML 报错、include 循环引用、插值缺变量、fallback 全层失败、fingerprint 并列取小 |
| 集成 | executor × test-site（无 LLM） | 12 步骤类型逐个跑通、E1-E4 分类正确性、连续 10 次结果一致 |
| E2E（mock LLM） | orchestrator × test-site × Agent | mock think 返回固定动作序列：接管→恢复→回归全链路（CI 不烧钱） |
| E2E（真 LLM） | 同上 + deepseek-flash | 每晚定时跑 3 个改版场景，统计自愈率（打真实指标） |

---

## 13. 排期

| 周 | 里程碑 | 交付 |
|----|--------|------|
| W1 | 工程脚手架 + Schema + loader | zod Schema、YAML 校验、include 展开、validate 命令 |
| W2 | 执行引擎 + 失败检测 | 12 步骤执行器、E1-E4 分类、上下文插值、test-site v1 |
| W3 | 报告 + 参数化 + 循环 | run.json/report.html、--params、loop 步骤、50 SKU 批量用例 |
| W4 | **MVP**：CLI 完整可用 | 凭证管理（脱敏+加密）、session 复用、内部试用开始 |
| W5 | 感知器 + Agent 骨架 | perception（截图+DOM 压缩）、决策循环、guard |
| W6 | 恢复点 + 回归 | fingerprint 匹配、回归续跑、E2E(mock LLM) 全链路 |
| W7 | 沉淀 + 版本管理 | 轨迹→YAML、diff、promote/rollback |
| W8 | **v1.0**：真 LLM 联调 + 演示资产 | 自愈率达标、成本统计、演示站点改版脚本、分享素材 |

W4 与 W8 是两个可对外演示的检查点。

---

## 14. 风险与避坑清单

| # | 风险 | 影响 | 对策 |
|---|------|------|------|
| 1 | DOM 压缩后信息不足，Agent 找不到目标 | 自愈率掉 | 双通道兜底：DOM 给 ID + 截图给视觉；元素上限 300 可调；think 可主动请求 scroll |
| 2 | LLM 输出格式漂移（非 JSON） | 动作解析失败 | temperature=0 + JSON Schema 约束 + 一次重试 + 换 fallback 模型 |
| 3 | 恢复点误匹配（提前回归到错误步骤） | 静默数据错误 | score 阈值 50 + 唯一最高分才回归 + 窗口 5 步限制 |
| 4 | A↔B 死循环（回归后马上又失败） | 成本失控 | 单 run 接管次数上限 3 + 单次接管预算 $0.10 |
| 5 | 沉淀的 YAML 把动态值写死 | v2 二次运行失败 | 沉淀时动态段（订单号/时间戳/ID）强制替换回 `${ctx.*}` 插值 |
| 6 | 敏感信息进 LLM 上下文 | 泄露风险 | 脱敏管道前置：fill 值进 prompt 前替换占位符 |
| 7 | Playwright 元素自动等待与自定义超时打架 | 误报超时 | 统一在 selector.resolve 收口，禁止裸 locator 调用 |
| 8 | 真实网站反爬（验证码/风控） | 场景受限 | v1 明确不支持验证码场景，文档声明边界；P2 评估打码服务 |

---

## 15. 附录：对外分享素材清单（对应 PRD 分享亮点）

1. **三方案对比表**：PRD §3.1（成本/速度/稳定性/可审计五维对比）
2. **失败切换演示 GIF**：改价流程 variant a→b，展示 s07 失败→接管→回归→v2 diff（W8 录制）
3. **成本对比图**：纯 CUA $0.50 vs 混合首跑 $0.02 vs 复跑 $0（数据来自 run.json 真实统计）
4. **避坑清单**：本文 §14（选择器多层 fallback、参数化强制插值两条必须讲）
