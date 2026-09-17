import type { Locator, Page } from 'playwright';
import { snapshot, renderDomDigest, type PageSnapshot, type ElementInfo } from '../perception/snapshot.js';
import { chat, extractJson, CostTracker, getLlmConfig, LlmError, type ChatMessage, type ChatResult } from './llm.js';

/**
 * STATE B：LLM Agent 决策循环（DESIGN F-04）。
 * 每轮：感知（截图+DOM 摘要）→ LLM 决策一个原子动作 → 执行 → 再感知。
 * 动作集：click / fill / press / goto / wait / done / fail。
 * 安全约束：域名白名单、步数上限、表单提交类动作前的保护。
 */

export type AgentAction =
  | { action: 'click'; ref: number; reason: string }
  | { action: 'drag'; ref: number; dx: number; dy: number; reason: string }
  | { action: 'fill'; ref: number; value: string; reason: string }
  | { action: 'press'; key: string; reason: string }
  | { action: 'goto'; url: string; reason: string }
  | { action: 'wait'; ms: number; reason: string }
  | { action: 'done'; summary: string; reason: string }
  | { action: 'fail'; summary: string; reason: string };

/** 轨迹步（审计 + 沉淀原料） */
export interface AgentStep {
  step: number;
  /** 决策前的页面 URL */
  url: string;
  action: AgentAction;
  /** 动作执行后的页面 URL */
  afterUrl?: string;
  ok: boolean;
  error?: string;
  /** 每步截图 base64（供报告回放） */
  screenshotBase64: string;
  /** 被操作元素的感知信息（ref 解析结果；蒸馏 selector 用） */
  target?: ElementInfo;
  /** 该步执行期间是否出现原生弹窗（confirm/alert）且被自动接受 */
  sawDialog?: boolean;
  perceptionMs: number;
  llmMs?: number;
  execMs?: number;
  /** 执行引擎标注：DOM 通道（Playwright）还是视觉通道（CUA 坐标） */
  engine: 'playwright' | 'cua';
  /** 该步 LLM 用量（决策调用的 tokens） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface AgentResult {
  success: boolean;
  steps: AgentStep[];
  /** 任务完成/失败的总结（done/fail 动作携带） */
  summary: string;
  totalMs: number;
  llmCalls: number;
  /** LLM 成本（tokens + USD 折算；纯 Playbook 模式无此字段） */
  cost?: {
    llmCalls: number; tokensIn: number; tokensOut: number;
    usd: number | null; model: string;
  };
}

export interface AgentOptions {
  /** 任务目标（自然语言） */
  task: string;
  /** 域名白名单（Agent 只能导航/提交到这些域） */
  allowDomains: string[];
  /** 步数上限（默认 15；null/undefined 显式传 null 表示不设上限） */
  maxSteps?: number | null;
  /** 是否携带截图给 VLM（双通道）；false = 仅 DOM 文本 */
  withScreenshot?: boolean;
  /** 每步动作后的回调（恢复点检查钩子；返回 true 提前终止循环） */
  onAfterAction?: (page: Page, step: AgentStep) => Promise<boolean> | boolean;
  /** 每步完成后的回调（Web 实时推送/进度上报用） */
  onStep?: (step: AgentStep) => void;
  /** 外部停止请求（返回 true 终止循环；在每轮 LLM 调用前轮询——停止后不再花下一次决策的钱） */
  shouldStop?: () => boolean;
  /** 日志输出 */
  log?: (msg: string) => void;
  /** LLM 请求级覆盖（Web 端用户自带 key） */
  llmOverrides?: Partial<{ baseUrl: string; apiKey: string; model: string }>;
}

const SYSTEM_PROMPT = `你是一个浏览器操作 Agent。用户给你一个任务目标，你观察当前页面（截图 + DOM 摘要），每轮只决策一个原子动作。

## 可用动作（只输出一个 JSON 对象）
{"action":"click","ref":<元素编号>,"reason":"<一句话理由>"}
{"action":"drag","ref":<元素编号>,"dx":<水平像素位移>,"dy":<垂直像素位移>,"reason":"<一句话理由>"}
{"action":"fill","ref":<元素编号>,"value":"<填入值>","reason":"<一句话理由>"}
{"action":"press","key":"<键名，如 Enter>","reason":"..."}
{"action":"goto","url":"<完整URL>","reason":"..."}
{"action":"wait","ms":<毫秒>,"reason":"..."}
{"action":"done","summary":"<任务完成总结>","reason":"..."}
{"action":"fail","summary":"<无法完成的原因>","reason":"..."}

## 规则
1. ref 必须来自 DOM 摘要里的 [编号]，不能凭空编造
2. 表单填写顺序：先 fill 所有字段，最后 click 提交按钮
3. 密码字段 fill 时直接填值（系统已注入，不会泄露）
4. 任务完成（目标状态已出现）→ done；确认无法完成（页面缺失/无权限/死循环）→ fail
5. 页面看起来没加载完 → wait 1000 后再观察
6. 只输出 JSON，不要输出任何其他内容
7. 搜索类站点（百度/必应/谷歌等）**优先直接 goto 结果页 URL**（如 https://www.baidu.com/s?wd=关键词），
   不要去点首页搜索框——首页交互风控极严，实测一交互就被拦到验证码页，
   而冷启动直接访问结果页是正常的。这一条是预防，别等被拦了再补救

## 遇到验证码 / 安全校验
- 滑块类：用 drag 拖动手柄——看截图估算滑块需要移动的距离，填进 dx（正数向右），dy 通常填 0
- 如果反复触发验证、始终无法通过，优先换路径而不是硬刚：
  用 goto 直接访问目标页 URL（例如搜索站直接用 https://host/s?wd=关键词），
  很多站点对首页交互风控极严、但直接访问结果页正常
- 确实无法完成时再 fail，并在 summary 里说明是验证码拦截`;

const REF_INDEX_IN_SNAPSHOT = 'snapshot';

/** 单轮决策的最大尝试次数（解析失败时带纠错提示重试） */
const DECIDE_MAX_ATTEMPTS = 3;
/**
 * 决策调用的 token 上限基数（实际按 attempt 递增：base、2×base、3×base）。
 * 思考型模型（deepseek-flash 带 reasoning_content）会把额度烧在推理上——
 * 实测单步推理约 15-70 tokens，但复杂页面可更长；一旦烧满 max_tokens，
 * finish_reason=length 而 content 为空。递增上限是这类空输出最直接的对策。
 */
const DECIDE_BASE_TOKENS = 1000;

/**
 * 空输出后的追加提示（system 角色，避免连续 user 消息）。
 * 思考型模型偶发"只在 reasoning 里想、content 里什么都不写"，
 * 明确要求它跳过推理直接给结论——实测能把二次成功率拉起来。
 */
const EMPTY_OUTPUT_HINT =
  '【重要】上一次响应内容为空（可能把输出额度消耗在思考过程里了）。' +
  '请跳过思考过程，直接输出一个 JSON 动作对象，不要输出任何其他内容。';

/** 解析失败后的纠错提示（把模型上一次的坏输出一并回传，让它自我纠正） */
const CORRECTION_PROMPT =
  '你上一次的输出无法解析为 JSON（可能是工具调用标记、Markdown 围栏或多余文字）。' +
  '请严格只输出一个 JSON 对象：不要围栏、不要工具调用标记、不要任何前后缀说明。';

/**
 * 一轮决策：输出解析失败时带上模型自己的坏输出重试，让它自我纠正。
 * 用尽次数才抛错终止任务——模型偶发吐 DSML/围栏不应让整个任务失败。
 */
/** 决策上下文（重试时按降级策略重新组装请求，而不是原地重试同一份） */
interface DecideContext {
  task: string;
  snap: PageSnapshot;
  history: string[];
  /** 是否允许携带截图（Web 端可关闭；false = 纯 DOM 通道） */
  withScreenshot: boolean;
}

/**
 * 单次决策：感知 → LLM → 解析动作。
 *
 * 失败重试分两类，都要覆盖：
 * 1. **调用失败**（空 content / 超时 / 429 / 5xx）——以前 chat() 在 try 之外，
 *    一抛错就直接冒泡，整个任务被判 error，前几步全白跑（#29 的根因）。
 * 2. **解析失败**（模型吐 DSML 或非 JSON）——把坏输出回传要求纠正。
 *
 * 降级阶梯（每次重试都换一种请求形态，不是原地重复）：
 *   attempt 1: jsonMode + 截图 + 1×tokens
 *   attempt 2: jsonMode + 截图 + 2×tokens
 *   attempt 3: 无 json 约束 + 纯 DOM（去图）+ 3×tokens
 * json_object 约束与图像输入都是已知的偶发空输出诱因，最后一次两个都去掉。
 */
async function decideAction(
  ctx: DecideContext,
  overrides: AgentOptions['llmOverrides'],
  tracker: CostTracker,
  log: (msg: string) => void,
): Promise<{ act: AgentAction; usage?: ChatResult['usage'] }> {
  let lastErr: unknown;
  let usage: ChatResult['usage'] | undefined;
  const corrections: ChatMessage[] = [];

  for (let attempt = 1; attempt <= DECIDE_MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === DECIDE_MAX_ATTEMPTS;
    const useShot = !isLast && ctx.withScreenshot && ctx.snap.screenshotBase64.length > 0;
    const userContent: ChatMessage['content'] = [
      { type: 'text', text: buildUserPrompt(ctx.task, ctx.snap, ctx.history, useShot) },
      ...(useShot
        ? [{ type: 'image_url' as const, image_url: { url: `data:image/png;base64,${ctx.snap.screenshotBase64}` } }]
        : []),
    ];

    let raw: ChatResult;
    try {
      raw = await chat(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
          ...corrections,
        ],
        {
          maxTokens: DECIDE_BASE_TOKENS * attempt,
          overrides,
          jsonMode: !isLast,
        },
      );
    } catch (e) {
      lastErr = e;
      const err = e as LlmError;
      const retryable = err instanceof LlmError ? err.retryable : false;
      if (err.usage) tracker.add(err.usage); // 失败调用也烧了钱（截断输出照计费），必须记账
      const tail = !retryable ? '—不可重试，放弃' : isLast ? '—已用尽重试' : '—将重试';
      log(`      决策调用失败（第 ${attempt}/${DECIDE_MAX_ATTEMPTS} 次）：${err.message.slice(0, 80)}${tail}`);
      if (!retryable || isLast) throw err;
      // 没拿到模型输出，无法构造 correction；追加提示压制"只思考不输出"
      corrections.push({ role: 'system', content: EMPTY_OUTPUT_HINT });
      continue;
    }

    tracker.add(raw.usage); // 重试同样烧钱，全部计入成本
    usage = raw.usage;
    try {
      return { act: parseAction(raw.text), usage };
    } catch (e) {
      lastErr = e;
      log(`      输出解析失败（第 ${attempt}/${DECIDE_MAX_ATTEMPTS} 次）：${(e as Error).message.slice(0, 50)}—要求重输出`);
      corrections.push(
        { role: 'assistant', content: raw.text.slice(0, 400) },
        { role: 'user', content: CORRECTION_PROMPT },
      );
    }
  }
  throw lastErr;
}

/** ref → Playwright locator（用感知器同款选择器定位第 N 个可交互元素） */
async function locatorByRef(page: Page, ref: number): Promise<ReturnType<Page['locator']>> {
  // 与感知器一致的可交互元素序列，ref 从 1 开始
  const selector = [
    'button', 'a', 'input', 'select', 'textarea', 'label',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
    '[onclick]', '[contenteditable="true"]',
  ].join(', ');
  const count = await page.locator(selector).count();
  if (ref < 1 || ref > count) {
    throw new Error(`ref ${ref} 超出范围（当前页面可交互元素 1-${count}）`);
  }
  // 感知器跳过了不可见元素，这里也要跳过保持对齐
  const elements = page.locator(selector);
  let visibleIdx = 0;
  for (let i = 0; i < count; i++) {
    const el = elements.nth(i);
    const box = await el.boundingBox();
    if (box && box.width > 0 && box.height > 0) {
      visibleIdx++;
      if (visibleIdx === ref) return el;
    }
  }
  throw new Error(`ref ${ref} 定位失败（可见元素只有 ${visibleIdx} 个）`);
}

/**
 * 同主域判断：取域名最后两段比较（www.baidu.com ↔ m.baidu.com 视为同主域）。
 * 移动版/桌面版切换是常见的绕验证码手段，白名单只放行主域级别。
 * 注意：不是完整的 public suffix 匹配（如 .co.uk 会偏松），
 * 当前白名单来源是"用户给的起始 URL"，即用户已信任该站点，主域级别放行可接受。
 */
function sameRootDomain(host: string, domain: string): boolean {
  const last2 = (h: string): string => h.split('.').slice(-2).join('.');
  return last2(host) === last2(domain);
}

/** 验证码自愈（清 cookie）的单次任务上限——超过就不再尝试，交给 LLM 判 fail */
const CAPTCHA_RESET_LIMIT = 2;

/** 验证码页特征：URL 域名或页面文案命中即判定 */
const CAPTCHA_URL_RE = /\/(captcha|verify|security|wappass)/i;
const CAPTCHA_TEXT_RE = /安全验证|滑块验证|请完成安全验证|拖动滑块|captcha/i;

function isCaptchaPage(url: string, bodyText: string): boolean {
  return CAPTCHA_URL_RE.test(url) || CAPTCHA_TEXT_RE.test(bodyText.slice(0, 500));
}

/** 域名白名单校验 */
function assertDomainAllowed(url: string, allowDomains: string[]): void {
  if (allowDomains.length === 0) return; // 空白名单 = 不限制（测试场景）
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`非法 URL: ${url}`);
  }
  // 精确匹配 / 子域 / 同主域（含兄弟子域，如 m.baidu.com）
  const ok = allowDomains.some(
    (d) => host === d || host.endsWith(`.${d}`) || sameRootDomain(host, d),
  );
  if (!ok) throw new Error(`目标域名 ${host} 不在白名单内（${allowDomains.join(', ')}）`);
}

/**
 * 类人拖拽（滑块验证码用）。
 *
 * 直线匀速拖动会被风控秒拒，所以模拟真人：
 *   - 先加速后减速（ease-out 曲线）
 *   - 带轻微的 y 轴抖动与随机停顿
 *   - 分段移动，每段之间 8~20ms 间隔
 *
 * @param dx 水平位移（正=向右）。滑块场景由 LLM 看截图估算缺口距离后给出
 * @param dy 垂直位移（通常 0；需要纵向滑块时用）
 */
async function humanDrag(page: Page, el: Locator, dx: number, dy: number): Promise<void> {
  const box = await el.boundingBox();
  if (!box) throw new Error('拖拽目标无 boundingBox（元素不可见？）');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.waitForTimeout(60 + Math.random() * 80); // 按下后的人类停顿

  const segments = 24 + Math.floor(Math.random() * 12);
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const eased = 1 - Math.pow(1 - t, 2); // 先快后慢
    const jitter = Math.sin(t * Math.PI * 3) * 1.8 + (Math.random() - 0.5) * 1.2;
    await page.mouse.move(startX + dx * eased, startY + dy * eased + jitter);
    await page.waitForTimeout(8 + Math.random() * 12);
  }

  await page.waitForTimeout(50);
  await page.mouse.up();
}

/** 执行一个原子动作（返回执行后的页面 URL） */
async function executeAction(page: Page, act: AgentAction): Promise<void> {
  switch (act.action) {
    case 'click': {
      const el = await locatorByRef(page, act.ref);
      // 降级链：正常点击 → force 强制 → JS 派发。
      // 遮罩层/复杂布局下点击落点 hit-test 被容器拦截（intercepts pointer events），
      // 目标元素本身可见可用，只是接收不到指针事件——force 跳过 hit-test，JS 派发兜底。
      try {
        await el.click({ timeout: 5_000 });
      } catch (e) {
        const msg = (e as Error).message;
        const blocked = msg.includes('intercepts pointer events') || msg.includes('Timeout');
        if (!blocked) throw e;
        try {
          await el.click({ timeout: 1_000, force: true });
        } catch {
          await el.dispatchEvent('click');
        }
      }
      return;
    }
    case 'drag': {
      const el = await locatorByRef(page, act.ref);
      await humanDrag(page, el, act.dx, act.dy);
      return;
    }
    case 'fill': {
      const el = await locatorByRef(page, act.ref);
      await el.fill(act.value, { timeout: 10_000 });
      return;
    }
    case 'press':
      await page.keyboard.press(act.key);
      return;
    case 'goto':
      assertDomainAllowed(act.url, allowDomainsRef!);
      await page.goto(act.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return;
    case 'wait':
      await page.waitForTimeout(Math.min(act.ms, 10_000));
      return;
    case 'done':
    case 'fail':
      return; // 终止动作不执行页面操作
  }
}

/** Agent 循环内共享的白名单引用（executeAction 闭包用） */
let allowDomainsRef: string[] | null = null;

/** Agent 主循环 */
export async function runAgent(page: Page, options: AgentOptions): Promise<AgentResult> {
  const { task, allowDomains } = options;
  const maxSteps = options.maxSteps ?? 15; // null → Infinity（不设上限）
  const stepsLimit = options.maxSteps === null ? Infinity : maxSteps;
  const withScreenshot = options.withScreenshot ?? true;
  const log = options.log ?? (() => {});
  allowDomainsRef = allowDomains;

  // 原生对话框自动接受（confirm/alert——表单提交场景点击确认弹窗是常规操作）
  // stepDialog: 本步执行期间是否出现弹窗（蒸馏 dialog:accept 标记用）
  let stepDialog = false;
  const dialogHandler = (d: { accept: () => Promise<void> }): void => {
    stepDialog = true;
    void d.accept();
  };
  page.on('dialog', dialogHandler);

  const steps: AgentStep[] = [];
  const started = Date.now();
  const tracker = new CostTracker();
  let summary = '';
  let success = false;

  // 历史动作摘要（给 LLM 的短期记忆，防重复循环）
  const history: string[] = [];
  let captchaResets = 0; // 已执行的验证码自愈次数（清 cookie）

  for (let i = 1; i <= stepsLimit; i++) {
    // 0. 外部停止检查（在感知与 LLM 调用前——停止时不烧任何 token）
    if (options.shouldStop?.()) {
      summary = `用户手动停止（已完成 ${steps.length} 步）`;
      log(`  ⏹ ${summary}`);
      break;
    }

    // 1. 感知
    const snap: PageSnapshot = await snapshot(page);
    log(`  [${i}${stepsLimit === Infinity ? '' : `/${stepsLimit}`}] 感知 ${snap.url}（${snap.elements.length} 元素，${snap.ms}ms）`);

    // 1.5 验证码自愈（确定性兜底，不烧 token）：
    // 实测百度——风控标记种在 cookie 里，被拦后清空 cookie 再访问同一 URL 就恢复正常
    // （首页→搜索页必被拦，清 cookie 后重搜拿到 7 条结果）。
    // 只做有限次，避免陷入"清了又被拦"的死循环。
    if (isCaptchaPage(snap.url, snap.bodyText) && captchaResets < CAPTCHA_RESET_LIMIT) {
      captchaResets++;
      await page.context().clearCookies().catch(() => {});
      log(`      ⚠ 检测到验证码页，已清空站点 cookie 尝试自愈（第 ${captchaResets}/${CAPTCHA_RESET_LIMIT} 次）`);
      history.push(
        `【系统】上一步撞上验证码页。已自动清空该站点 cookie 并重置风控标记。` +
          `请重新 goto 目标 URL（搜索类站点直接用结果页地址），不要再去操作首页。`,
      );
    }

    // 2. 决策（LLM）
    // 请求组装与降级策略都在 decideAction 内部（重试时逐层去 json 约束 / 去截图 / 加 token 上限）
    const llmStarted = Date.now();
    let decision: { act: AgentAction; usage?: ChatResult['usage'] };
    try {
      decision = await decideAction(
        { task, snap, history, withScreenshot },
        options.llmOverrides,
        tracker,
        log,
      );
    } catch (e) {
      // 单步决策失败不该毁掉整个任务：已执行的步骤、截图、成本都要保留下来出报告，
      // 否则一次网关抖动就让前面几步的 token 全白烧（#29）。
      const msg = (e as Error).message;
      summary = `LLM 决策失败，任务中止于第 ${i} 步（已完成 ${steps.length} 步）：${msg.slice(0, 160)}`;
      log(`  ✗ ${summary}`);
      break;
    }
    const { act, usage } = decision;
    const llmMs = Date.now() - llmStarted;
    log(`      决策 ${act.action}${'ref' in act ? ` ref=${act.ref}` : ''}（${llmMs}ms）— ${act.reason.slice(0, 60)}`);

    // 3. 执行
    const execStarted = Date.now();
    let ok = true;
    let error: string | undefined;
    let afterUrl: string | undefined;
    let target: ElementInfo | undefined;
    stepDialog = false; // 每步重置
    if (act.action === 'click' || act.action === 'fill') {
      target = snap.elements.find((e) => e.ref === act.ref); // 被操作元素（蒸馏原料）
    }
    try {
      if (act.action !== 'done' && act.action !== 'fail') {
        await executeAction(page, act);
        await page.waitForLoadState('domcontentloaded').catch(() => {}); // 导航类动作等渲染
        // 点击/提交常触发导航，留一个沉降窗口再感知，降低撞上"执行上下文销毁"的概率
        // （真正的兜底在 snapshot() 内部的导航重试）
        await page.waitForTimeout(250);
        afterUrl = page.url();
      }
    } catch (e) {
      ok = false;
      error = (e as Error).message;
      log(`      执行失败: ${error}`);
    }
    const execMs = Date.now() - execStarted;

    const stepRecord: AgentStep = {
      step: i,
      url: snap.url,
      action: act,
      afterUrl,
      ok,
      error,
      screenshotBase64: snap.screenshotBase64,
      target,
      sawDialog: stepDialog || undefined,
      perceptionMs: snap.ms,
      llmMs,
      execMs,
      engine: 'playwright', // 当前 DOM 通道执行；CUA 视觉通道接入后此处分流
      usage,
    };
    steps.push(stepRecord);
    history.push(describeAction(act, ok, error));
    options.onStep?.(stepRecord); // Web 实时推送钩子

    // 4. 终止判断
    if (act.action === 'done') {
      success = true;
      summary = act.summary;
      log(`  ✓ 任务完成：${summary}`);
      break;
    }
    if (act.action === 'fail') {
      summary = act.summary;
      log(`  ✗ Agent 判定无法完成：${summary}`);
      break;
    }

    // 5. 外部钩子（恢复点检查等；返回 true 提前终止）
    if (options.onAfterAction) {
      const stop = await options.onAfterAction(page, stepRecord);
      if (stop) {
        summary = summary || '外部终止（恢复点命中）';
        break;
      }
    }
  }

  if (!success && steps.length >= stepsLimit && !summary) {
    summary = `达到步数上限 ${maxSteps}，任务未完成`;
    log(`  ✗ ${summary}`);
  }
  if (!summary) summary = success ? '任务完成' : '任务未完成';

  page.off('dialog', dialogHandler);
  const model = options.llmOverrides?.model ?? getLlmConfig().model;
  return {
    success, steps, summary,
    totalMs: Date.now() - started,
    llmCalls: tracker.calls,
    cost: tracker.toJSON(model),
  };
}

function buildUserPrompt(task: string, snap: PageSnapshot, history: string[], withScreenshot: boolean): string {
  const parts = [
    `## 任务目标\n${task}`,
    `\n## 已执行动作（最近 8 步）\n${history.slice(-8).join('\n') || '（尚未开始）'}`,
    ...(withScreenshot ? [] : ['\n（注意：本次截图不可用，请仅依据下方 DOM 摘要决策）']),
    `\n## 当前页面\n${renderDomDigest(snap)}`,
    '\n决策下一个动作（只输出 JSON）：',
  ];
  return parts.join('\n');
}

function describeAction(act: AgentAction, ok: boolean, error?: string): string {
  const status = ok ? '' : `（失败: ${error?.slice(0, 50)}）`;
  switch (act.action) {
    case 'click': return `click ref=${act.ref} ${status}`;
    case 'drag': return `drag ref=${act.ref} dx=${act.dx} dy=${act.dy} ${status}`.trim();
    case 'fill': return `fill ref=${act.ref} value="${act.value.slice(0, 30)}" ${status}`.trim();
    case 'press': return `press ${act.key} ${status}`.trim();
    case 'goto': return `goto ${act.url.slice(0, 60)} ${status}`.trim();
    case 'wait': return `wait ${act.ms}ms`;
    case 'done': return `done: ${act.summary}`;
    case 'fail': return `fail: ${act.summary}`;
  }
}

function parseAction(raw: string): AgentAction {
  const parsed = extractJson<Partial<AgentAction>>(raw);
  const action = parsed.action;
  if (action === 'click' && typeof parsed.ref === 'number') {
    return { action, ref: parsed.ref, reason: String(parsed.reason ?? '') };
  }
  if (
    action === 'drag' &&
    typeof parsed.ref === 'number' &&
    typeof parsed.dx === 'number'
  ) {
    return {
      action,
      ref: parsed.ref,
      dx: parsed.dx,
      dy: typeof parsed.dy === 'number' ? parsed.dy : 0,
      reason: String(parsed.reason ?? ''),
    };
  }
  if (action === 'fill' && typeof parsed.ref === 'number' && typeof parsed.value === 'string') {
    return { action, ref: parsed.ref, value: parsed.value, reason: String(parsed.reason ?? '') };
  }
  if (action === 'press' && typeof parsed.key === 'string') {
    return { action, key: parsed.key, reason: String(parsed.reason ?? '') };
  }
  if (action === 'goto' && typeof parsed.url === 'string') {
    return { action, url: parsed.url, reason: String(parsed.reason ?? '') };
  }
  if (action === 'wait' && typeof parsed.ms === 'number') {
    return { action, ms: parsed.ms, reason: String(parsed.reason ?? '') };
  }
  if (action === 'done' && typeof parsed.summary === 'string') {
    return { action, summary: parsed.summary, reason: String(parsed.reason ?? '') };
  }
  if (action === 'fail' && typeof parsed.summary === 'string') {
    return { action, summary: parsed.summary, reason: String(parsed.reason ?? '') };
  }
  throw new Error(`LLM 输出的动作不合法: ${raw.slice(0, 150)}`);
}

export { REF_INDEX_IN_SNAPSHOT };
