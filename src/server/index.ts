import type { Request, Response } from 'express';
import express from 'express';
import { type Browser } from 'playwright';
import { launchBrowser, newStealthContext } from '../browser/stealth.js';
import { randomUUID } from 'node:crypto';
import { runAgent, type AgentStep, type AgentResult } from '../agent/loop.js';
import { getLlmConfig } from '../agent/llm.js';
import { appendHistory, listHistory } from './history.js';
import {
  listSessions, getSession, createSession, appendUserMessage, appendTaskMessage,
  completeTaskMessage, renameSession, deleteSession, buildMemoryContext,
} from './sessions.js';
import { listAllPlaybookVersions, readVersionDiff } from './playbook-history.js';
import { selectPlaybook, llmReady } from '../router/select.js';
import { runPlaybookSteps, type StepTrace, type RunTrace } from '../executor/engine.js';
import { loadPlaybook } from '../playbook/loader.js';
import { resumeWithTakeover } from '../agent/takeover.js';
import { parseIntent, clearIntentCache, CONFIDENCE_THRESHOLD } from '../router/intent.js';
import { distillToNewPlaybook, saveDraftPlaybook } from '../learner/draft.js';
import { StepFailure } from '../detector/failure.js';
import { join, resolve, sep } from 'node:path';

/**
 * PBAgent Web 控制台后端（端口 4567）：
 *   POST /api/tasks        提交自然语言任务 { url, task, llm?, maxSteps? }
 *   GET  /api/tasks/:id/events  SSE 实时事件流（log/step/done/error）
 *   GET  /api/health       健康检查 + 默认 LLM 配置探测
 *
 * 每个任务：独立 browser context（互不污染）→ runAgent（onStep 推 SSE）→ 结束清理。
 * 用户自带 LLM key 只在请求内存里存活（不落盘、不写环境变量）。
 */

interface TaskOptions {
  url: string;
  task: string;
  llm?: { baseUrl?: string; apiKey?: string; model?: string };
  /** 最大步数：数字=上限；null/缺省空=不设上限（前端留空时传 null） */
  maxSteps?: number | null;
  /** 有头模式：弹出真实浏览器窗口，肉眼观看 Agent 操作 */
  headed?: boolean;
  /** 命中沉淀流程时直接执行（Playbook 确定性模式）；缺省 = Agent 模式 */
  playbookFile?: string;
  /** Playbook 执行的参数（命中流程时由前端传，如 {price: "200"}） */
  params?: Record<string, unknown>;
  /** 会话 ID（对话式控制台 V2）：任务归属会话，多轮追问时继承上轮上下文 */
  sessionId?: string;
  /** @deprecated 用 learnMode 代替；保留只为兼容旧前端（true = on-failure） */
  learn?: boolean;
  /**
   * 沉淀档位：
   * - off         不沉淀
   * - on-failure  仅 Playbook 失败兜底成功后沉淀版本草稿（写入 .versions/，不动主文件）
   * - on-success  Agent 跑成功即蒸馏成一个全新 Playbook（F-10；写入 playbooks/ 立即可用）
   */
  learnMode?: 'off' | 'on-failure' | 'on-success';
  /**
   * 路由模式：
   * - deterministic  按域名匹配（单候选直选，不花 LLM）——CLI/显式指定场景
   * - intent         每次 LLM 解析意图（选流程 + 提取参数 + 置信度）——自然语言入口
   */
  routeMode?: 'deterministic' | 'intent';
  /** 用户原始任务描述（会话模式会往 task 里注入记忆上下文，沉淀时需要原始文本） */
  originalTask?: string;
}

/** 解析沉淀档位（旧字段 learn:boolean 兼容 → on-failure） */
function resolveLearnMode(o: TaskOptions): 'off' | 'on-failure' | 'on-success' {
  if (o.learnMode) return o.learnMode;
  return o.learn === false ? 'off' : 'on-failure';
}

interface QueuedEvent {
  type: 'log' | 'step' | 'screenshot' | 'done' | 'error';
  data: unknown;
  at: number;
}

interface TaskRecord {
  id: string;
  options: TaskOptions;
  status: 'queued' | 'running' | 'done' | 'error';
  /** 任务提交时间（历史记录用） */
  createdAt: number;
  /** 用户请求停止（Agent 循环每轮 LLM 调用前轮询；停止后不再产生新 token） */
  stopRequested: boolean;
  events: QueuedEvent[]; // 事件缓冲（SSE 连接前发生的事件也能回放）
  subscribers: Set<Response>;
  result?: {
    success: boolean;
    summary: string;
    steps: Array<Omit<AgentStep, 'screenshotBase64'>>;
    totalMs: number;
    llmCalls: number;
    cost?: AgentResult['cost'];
  };
}

const tasks = new Map<string, TaskRecord>();
let browser: Browser | null = null;      // headless 共享实例
let headedBrowser: Browser | null = null; // headed 独立实例（弹窗模式）

const getBrowser = async (headed = false): Promise<Browser> => {
  if (headed) {
    if (!headedBrowser || !headedBrowser.isConnected()) {
      headedBrowser = await launchBrowser({ headed: true, slowMo: 300 });
    }
    return headedBrowser;
  }
  if (!browser || !browser.isConnected()) {
    // 断连后重建——否则复用死实例会抛 Target closed
    browser = await launchBrowser();
  }
  return browser;
};

/** 从起始 URL 提取域名（Agent 白名单；用户给的 URL 即信任域） */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    throw new Error(`非法起始 URL: ${url}`);
  }
};

/** 事件入缓冲 + 广播给所有 SSE 订阅者 */
const emit = (task: TaskRecord, type: QueuedEvent['type'], data: unknown): void => {
  const evt = { type, data, at: Date.now() };
  task.events.push(evt);
  // done/error 是终态事件——即使 status 已不再是 running 也要广播（订阅者靠它收尾）
  const terminal = type === 'done' || type === 'error';
  if (terminal || task.status === 'running' || task.status === 'queued') {
    for (const res of task.subscribers) {
      res.write(`event: ${type}\ndata: ${JSON.stringify(evt)}\n\n`);
    }
  }
};

/** AgentStep 瘦身（截图单独事件通道，避免 step 事件体过大） */
const slimStep = (s: AgentStep): Omit<AgentStep, 'screenshotBase64'> => {
  const { screenshotBase64: _drop, ...rest } = s;
  return rest;
};

/** 用户自带 LLM key → chat 的 overrides（三处重复逻辑提取；无自带 key 返回 undefined） */
function llmOverridesOf(options: TaskOptions):
  | { baseUrl?: string; apiKey?: string; model?: string }
  | undefined {
  if (!options.llm) return undefined;
  const { baseUrl, apiKey, model } = options.llm;
  if (!baseUrl && !apiKey && !model) return undefined;
  return {
    ...(baseUrl ? { baseUrl: baseUrl.replace(/\/$/, '') } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
  };
}

/**
 * intent 路由模式：LLM 解析意图（选流程 + 提取参数 + 置信度）。
 * 命中 → 把 playbookFile/params 写回 options，后续走确定性执行；
 * 未命中（含置信度低于阈值）→ 保持 Agent 模式。
 */
async function resolveIntentAndMaybeRun(task: TaskRecord): Promise<void> {
  const { options } = task;
  const dir = join(process.cwd(), 'playbooks');
  emit(task, 'log', '🧭 意图解析模式：调用大模型解析任务意图…');
  const intent = await parseIntent(options.task, options.url, dir, {
    llmOverrides: llmOverridesOf(options),
  });
  if (intent.fromCache) {
    emit(task, 'log', `🧭 命中意图缓存（零调用）：${intent.reason}`);
  } else {
    emit(
      task,
      'log',
      `🧭 解析完成：候选 ${intent.candidateCount} 条，置信度 ${intent.confidence.toFixed(2)}（阈值 ${CONFIDENCE_THRESHOLD}）`,
    );
  }
  if (!intent.matched || !intent.playbookFile) {
    emit(task, 'log', `🧭 ${intent.reason} → 走 Agent 感知模式`);
    return;
  }
  const keys = Object.keys(intent.params);
  emit(
    task,
    'log',
    `🎯 命中沉淀流程《${intent.playbookName}》置信度 ${intent.confidence.toFixed(2)}` +
      (keys.length ? `，参数 ${keys.map((k) => `${k}=${String(intent.params[k])}`).join('、')}` : ''),
  );
  options.playbookFile = intent.playbookFile;
  options.params = intent.params;
}

/** on-success 档：Agent 跑成功 → 蒸馏成全新 Playbook（F-10）。失败不影响本次结果 */
async function maybeAutoDraft(
  task: TaskRecord,
  agent: AgentResult,
  overrides?: { baseUrl?: string; apiKey?: string; model?: string },
): Promise<void> {
  if (resolveLearnMode(task.options) !== 'on-success') return;
  try {
    const draft = await distillToNewPlaybook(agent, {
      task: task.options.originalTask ?? task.options.task,
      url: task.options.url,
      llmOverrides: overrides,
      runId: task.id,
    });
    const saved = saveDraftPlaybook(join(process.cwd(), 'playbooks'), draft, {
      runId: task.id,
      reason: `Agent ${agent.steps.length} 步成功`,
    });
    clearIntentCache(); // 新沉淀要能被后续任务立刻检索到
    emit(
      task,
      'log',
      `📝 自动沉淀《${saved.name}》${draft.stepCount} 步` +
        `${draft.assertAdded ? ' + 成功断言' : ''}` +
        `${draft.paramKeys.length ? `，参数 ${draft.paramKeys.join('、')}` : ''}`,
    );
    emit(task, 'log', `   → ${saved.file}（下次同任务可直接命中，零 LLM 执行）`);
  } catch (e) {
    emit(task, 'log', `⚠ 自动沉淀失败（不影响本次结果）：${(e as Error).message.slice(0, 80)}`);
  }
}

async function executeTask(task: TaskRecord): Promise<void> {
  const { options } = task;
  const browserInstance = await getBrowser(Boolean(options.headed));
  const context = await newStealthContext(browserInstance);
  const page = await context.newPage();
  try {
    // intent 模式：先解析意图（未显式指定 playbookFile 时生效）
    if (options.routeMode === 'intent' && !options.playbookFile) {
      await resolveIntentAndMaybeRun(task);
    }
    // 命中沉淀流程：Playbook 确定性执行（零 LLM）
    if (options.playbookFile) {
      await executePlaybookTask(task, page);
      return;
    }
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    emit(task, 'log', `已打开起始页面：${options.url}${options.headed ? '（有头模式——可在弹出的浏览器窗口中观看）' : ''}`);

    const overrides = llmOverridesOf(options);

    const result = await runAgent(page, {
      task: options.task,
      allowDomains: [hostOf(options.url)],
      maxSteps: options.maxSteps ?? null, // 前端留空 → null → 不设上限
      llmOverrides: overrides,
      shouldStop: () => task.stopRequested, // 用户停止：下一轮 LLM 调用前生效
      onStep: (step) => {
        emit(task, 'step', slimStep(step));
        emit(task, 'screenshot', { step: step.step, base64: step.screenshotBase64 });
      },
      log: (msg) => emit(task, 'log', msg.replace(/^\s+/, '')),
    });

    // 自动沉淀（on-success 档）——放在 done 事件之前，保证前端日志能看到
    if (result.success) await maybeAutoDraft(task, result, overrides);

    task.result = {
      success: result.success,
      summary: result.summary,
      steps: result.steps.map(slimStep),
      totalMs: result.totalMs,
      llmCalls: result.llmCalls,
      cost: result.cost,
    };
    task.status = 'done';
    emit(task, 'done', { ...task.result, stopped: task.stopRequested });
    writeHistory(task, result.steps.map(slimStep));
  } catch (e) {
    task.status = 'error';
    emit(task, 'error', { message: (e as Error).message });
    writeHistory(task, []);
  } finally {
    await context.close().catch(() => {});
  }
}

/** 命中沉淀流程的确定性执行（STATE A，零 LLM）——失败时 LLM 已配置则 Agent 兜底（A→B→A） */
async function executePlaybookTask(task: TaskRecord, page: import('playwright').Page): Promise<void> {
  const { options } = task;
  emit(task, 'log', `⚡ 沉淀流程模式：${options.playbookFile}（确定性执行，零 LLM 成本）`);
  const startedAt = Date.now();
  /** 已推送 SSE 的步骤数（失败回放时跳过重复） */
  let emitted = 0;
  /** StepTrace → AgentStep 形状（前端时间线复用；engine 固定 playwright） */
  const toStep = (st: StepTrace, i: number): AgentStep => ({
    step: i + 1,
    url: page.url(),
    afterUrl: page.url(),
    ok: st.status === 'ok',
    action: { action: 'log', reason: `${st.name}（${st.action}）` } as unknown as AgentStep['action'],
    screenshotBase64: '',
    engine: 'playwright',
    perceptionMs: st.ms,
    execMs: st.ms,
  });
  const llmOverrides = options.llm && (options.llm.baseUrl || options.llm.apiKey || options.llm.model)
    ? {
        ...(options.llm.baseUrl ? { baseUrl: options.llm.baseUrl.replace(/\/$/, '') } : {}),
        ...(options.llm.apiKey ? { apiKey: options.llm.apiKey } : {}),
        ...(options.llm.model ? { model: options.llm.model } : {}),
      }
    : undefined;
  try {
    const r = loadPlaybook(resolve(options.playbookFile ?? ''));
    if (!r.ok || !r.playbook) {
      throw new Error(`Playbook 加载失败: ${r.errors[0]?.message ?? '未知错误'}`);
    }
    const pb = r.playbook;
    emit(task, 'log', `《${pb.name}》 ${pb.steps.length} 步 · ${pb.description ?? ''}`);

    const trace = await runPlaybookSteps(page, pb, options.params ?? {}, {
      onStepStart: (st: StepTrace) => {
        emit(task, 'step', slimStep(toStep(st, emitted++)));
      },
    });

    const okSteps = trace.steps.filter((s) => s.status === 'ok').length;
    const success = trace.steps.every((s) => s.status === 'ok');
    const stepsOut = trace.steps.map((st, i) => slimStep(toStep(st, i)));
    task.result = {
      success,
      summary: success
        ? `沉淀流程《${pb.name}》确定性执行完成（${okSteps}/${trace.steps.length} 步，零 LLM）`
        : `沉淀流程执行失败（${okSteps}/${trace.steps.length} 步）`,
      steps: stepsOut,
      totalMs: Date.now() - startedAt,
      llmCalls: 0,
      cost: undefined,
    };
    task.status = 'done';
    emit(task, 'done', task.result);
    writeHistory(task, stepsOut);
  } catch (e) {
    const err = e as StepFailure & { __trace?: RunTrace };
    const partial = err.__trace;
    if (partial) {
      partial.steps.forEach((st, i) => {
        if (i >= emitted) emit(task, 'step', slimStep(toStep(st, i)));
      });
      emitted = partial.steps.length;
    }
    // LLM 已配置且非 EX 配置错误 → Agent 兜底（A→B→A 闭环）
    const takeoverOk = err instanceof StepFailure && err.kind !== 'EX' && (llmReady() || Boolean(llmOverrides));
    if (takeoverOk && partial) {
      await takeoverFailedPlaybook(task, page, partial, err, { emitted, toStep, startedAt, llmOverrides });
      return;
    }
    task.status = 'error';
    emit(task, 'error', { message: `沉淀流程执行出错: ${err.message}` });
    writeHistory(task, partial ? partial.steps.map((st, i) => slimStep(toStep(st, i))) : []);
  }
}

/**
 * Playbook 失败后的 Agent 兜底（STATE B）+ 恢复点续跑（STATE A）。
 * B 段 Agent 步骤与 A 段续跑步骤实时推 SSE，前端时间线完整呈现 A→B→A。
 */
async function takeoverFailedPlaybook(
  task: TaskRecord,
  page: import('playwright').Page,
  firstTrace: RunTrace,
  failure: StepFailure,
  ctx: {
    emitted: number;
    toStep: (st: StepTrace, i: number) => AgentStep;
    startedAt: number;
    llmOverrides?: { baseUrl?: string; apiKey?: string; model?: string };
  },
): Promise<void> {
  const { options } = task;
  const r = loadPlaybook(resolve(options.playbookFile ?? ''));
  const pb = r.ok && r.playbook ? r.playbook : null;
  if (!pb) {
    task.status = 'error';
    emit(task, 'error', { message: `兜底前 Playbook 重新加载失败: ${failure.message}` });
    writeHistory(task, firstTrace.steps.map((st, i) => slimStep(ctx.toStep(st, i))));
    return;
  }
  emit(task, 'log', `⚠ [${failure.kind} ${failure.kindLabel}] 触发 Agent 兜底接管（A→B→A）`);

  let agentStepBase = ctx.emitted; // B 段步骤编号接在 A 段之后
  const hybrid = await resumeWithTakeover(page, pb, options.params ?? {}, firstTrace, failure, {
    allowDomains: pb.meta?.allowDomains ?? [],
    log: (msg) => emit(task, 'log', msg),
    llmOverrides: ctx.llmOverrides,
    shouldStop: () => task.stopRequested,
    // STATE C：沉淀档位非 off → 兜底成功后蒸馏为新版本草稿（.versions/，不动主文件）
    ...(resolveLearnMode(options) !== 'off'
      ? { learn: { mainFile: resolve(options.playbookFile ?? ''), runId: task.id } }
      : {}),
    onAgentStep: (st) => {
      emit(task, 'step', slimStep({ ...st, step: ++agentStepBase }));
      if (st.screenshotBase64) emit(task, 'screenshot', { step: agentStepBase, base64: st.screenshotBase64 });
    },
    onRetryStep: (tr) => {
      emit(task, 'step', slimStep(ctx.toStep(tr, agentStepBase++)));
    },
  });

  const aSteps = firstTrace.steps.map((st, i) => slimStep(ctx.toStep(st, i)));
  const agentSteps = (hybrid.agent?.steps ?? []).map((st) => slimStep({ ...st, step: 0 }));
  if (hybrid.success) {
    const retrySteps = hybrid.trace.steps
      .slice(firstTrace.steps.length + 2) // 跳过首跑 + skipped/agent 标记步
      .map((st, i) => slimStep(ctx.toStep(st, i)));
    task.result = {
      success: true,
      summary: `Playbook 失败后 Agent 兜底自愈成功（${hybrid.timeline.map((t) => t.phase).join('→')}，Agent ${hybrid.agent?.steps.length ?? 0} 步${hybrid.learnedVersion ? `；已沉淀 v${hybrid.learnedVersion} 草稿` : ''}）`,
      steps: [...aSteps, ...agentSteps, ...retrySteps],
      totalMs: Date.now() - ctx.startedAt,
      llmCalls: hybrid.agent?.llmCalls ?? 0,
      cost: hybrid.agent?.cost,
    };
    task.status = 'done';
    emit(task, 'done', task.result);
    writeHistory(task, task.result.steps);
  } else {
    task.result = {
      success: false,
      summary: hybrid.agent
        ? `Agent 兜底后仍未恢复：${hybrid.agent.summary}`
        : `Playbook 执行失败：${failure.message}`,
      steps: [...aSteps, ...agentSteps],
      totalMs: Date.now() - ctx.startedAt,
      llmCalls: hybrid.agent?.llmCalls ?? 0,
      cost: hybrid.agent?.cost,
    };
    task.status = 'error';
    emit(task, 'error', { message: task.result.summary, result: task.result });
    writeHistory(task, task.result.steps);
  }
}

/** 任务结束时落盘历史（失败不影响主流程） */
function writeHistory(task: TaskRecord, steps: Array<ReturnType<typeof slimStep>>): void {  try {
    appendHistory({
      id: task.id,
      startedAt: new Date(task.createdAt).toISOString(),
      endedAt: new Date().toISOString(),
      options: {
        url: task.options.url,
        task: task.options.task,
        maxSteps: task.options.maxSteps ?? null,
        headed: Boolean(task.options.headed),
        llmOverride: Boolean(task.options.llm?.apiKey || task.options.llm?.baseUrl),
        model: task.options.llm?.model || task.result?.cost?.model,
        /** 命中的沉淀流程（历史页区分 ⚡Playbook 模式 / 🤖Agent 模式） */
        playbookFile: task.options.playbookFile,
        playbookName: task.options.playbookFile
          ? task.options.playbookFile.replace(/\.ya?ml$/, '').split(/[\\/]/).pop()
          : undefined,
      },
      status: task.status === 'error' ? 'error' : 'done',
      success: Boolean(task.result?.success),
      summary: task.result?.summary ?? '执行出错',
      totalMs: task.result?.totalMs ?? 0,
      llmCalls: task.result?.llmCalls ?? 0,
      cost: task.result?.cost,
      steps,
    });
  } catch (e) {
    console.error('历史落盘失败（不影响任务）:', (e as Error).message);
  }
  // 会话模式：回填任务结果摘要（assistant 消息 running → done/error）
  if (task.options.sessionId) {
    try {
      completeTaskMessage(task.options.sessionId, task.id, {
        status: task.status === 'error' ? 'error' : 'done',
        success: Boolean(task.result?.success),
        summary: task.result?.summary ?? '执行出错',
        totalMs: task.result?.totalMs ?? 0,
        llmCalls: task.result?.llmCalls ?? 0,
      });
    } catch { /* 会话回填失败不影响任务 */ }
  }
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req: unknown, res: Response) => {
  let llm = { configured: false, model: '' };
  try {
    const cfg = getLlmConfig();
    llm = { configured: true, model: cfg.model };
  } catch { /* .env 未配置——用户可在表单里自带 key */ }
  res.json({ ok: true, llm });
});

app.post('/api/tasks', (req: Request, res: Response) => {
  const { url, task, llm, maxSteps, headed, playbookFile, params, sessionId, learn, learnMode, routeMode } = (req.body ?? {}) as TaskOptions;
  if (!task) {
    res.status(400).json({ error: '缺少必填字段：task' });
    return;
  }
  // 会话模式：URL 缺省时继承会话内最后一个任务的起始 URL（多轮追问不重填）
  let effectiveUrl = url;
  if (!effectiveUrl && sessionId) {
    const session = getSession(sessionId);
    const lastTask = session
      ? [...session.messages].reverse().find((m) => m.task?.options?.url)
      : undefined;
    const inherited = lastTask?.task?.options?.url;
    if (!inherited) {
      res.status(400).json({ error: '会话内没有可继承的起始 URL，请先指定 URL' });
      return;
    }
    effectiveUrl = inherited;
  }
  if (!effectiveUrl) {
    res.status(400).json({ error: '缺少必填字段：url' });
    return;
  }
  // playbookFile 只允许 playbooks/ 目录内的相对路径（防路径穿越）
  if (playbookFile) {
    const abs = resolve(playbookFile);
    const root = resolve(process.cwd(), 'playbooks');
    if (abs !== root && !abs.startsWith(root + sep)) {
      res.status(400).json({ error: `非法 playbookFile（必须是 playbooks/ 内的文件）: ${playbookFile}` });
      return;
    }
  }
  try {
    hostOf(effectiveUrl);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  // 会话模式：记忆注入——会话历史 + 上轮任务摘要拼进任务描述（Agent 知道之前干了什么）
  let effectiveTask = task;
  if (sessionId && getSession(sessionId)) {
    const memory = buildMemoryContext(sessionId);
    if (memory) {
      effectiveTask = `${memory}\n${task}\n（注意：以上"会话内之前的指令"和"上一个任务"是背景上下文，你只需要执行"本次新指令"之后的最新要求。）`;
    }
    appendUserMessage(sessionId, task);
  }
  const id = randomUUID().slice(0, 8);
  const record: TaskRecord = {
    id,
    options: {
      url: effectiveUrl,
      task: effectiveTask,
      llm,
      maxSteps,
      headed,
      playbookFile,
      params,
      sessionId,
      learn,
      learnMode,
      routeMode,
      originalTask: task,
    },
    status: 'queued',
    createdAt: Date.now(),
    stopRequested: false,
    events: [],
    subscribers: new Set(),
  };
  tasks.set(id, record);
  if (sessionId && getSession(sessionId)) {
    appendTaskMessage(sessionId, {
      id,
      status: 'running',
      options: { url: effectiveUrl, task, playbookFile, params },
    });
  }
  res.json({ id });
  void executeTask(record); // 异步执行，SSE 拿进度
});

app.post('/api/match', (req: Request, res: Response) => {
  const { task, url, llm, mode } = (req.body ?? {}) as {
    task?: string;
    url?: string;
    llm?: TaskOptions['llm'];
    /** intent = 走意图解析层（含参数提取与置信度）；缺省 = 旧的选择器 */
    mode?: 'deterministic' | 'intent';
  };
  if (!task || !url) {
    res.status(400).json({ error: '缺少必填字段：url / task' });
    return;
  }
  const overrides = llm && (llm.baseUrl || llm.apiKey || llm.model)
    ? {
        ...(llm.baseUrl ? { baseUrl: llm.baseUrl.replace(/\/$/, '') } : {}),
        ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
        ...(llm.model ? { model: llm.model } : {}),
      }
    : undefined;
  void (async () => {
    try {
      const dir = join(process.cwd(), 'playbooks');
      if (mode === 'intent') {
        const r = await parseIntent(task, url, dir, { llmOverrides: overrides });
        res.json({
          matched: r.matched,
          reason: r.reason,
          candidateCount: r.candidateCount,
          confidence: r.confidence,
          params: r.params,
          fromCache: r.fromCache,
          playbook: r.playbookFile ? { name: r.playbookName, file: r.playbookFile } : null,
          usage: r.usage,
        });
        return;
      }
      const result = await selectPlaybook(task, url, dir, { llmOverrides: overrides });
      res.json({
        matched: Boolean(result.playbook),
        reason: result.reason,
        candidateCount: result.candidateCount,
        playbook: result.candidate
          ? {
              name: result.candidate.name,
              file: result.candidate.file,
              description: result.candidate.description,
              stepCount: result.candidate.stepCount,
              currentVersion: result.candidate.currentVersion,
              params: result.candidate.params,
            }
          : null,
        usage: result.usage,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  })();
});

app.post('/api/tasks/:id/stop', (req: Request<{ id: string }>, res: Response) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  if (task.status === 'done' || task.status === 'error') {
    res.json({ ok: true, alreadyFinished: true });
    return;
  }
  task.stopRequested = true;
  emit(task, 'log', '⏹ 收到停止请求——当前步骤完成后终止，不再发起新的 LLM 调用');
  res.json({ ok: true });
});

app.get('/api/playbooks', (_req: unknown, res: Response) => {
  const dir = join(process.cwd(), 'playbooks');
  res.json({ items: listAllPlaybookVersions(dir) });
});

app.get('/api/playbooks/:name/diff/:v', (req: Request<{ name: string; v: string }>, res: Response) => {
  const diff = readVersionDiff(join(process.cwd(), 'playbooks'), req.params.name, Number(req.params.v));
  if (diff === null) {
    res.status(404).json({ error: '该版本无 diff 记录' });
    return;
  }
  res.type('text/markdown; charset=utf-8').send(diff);
});

app.get('/api/history', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ items: listHistory(limit) });
});

/* ===== 会话 API（对话式控制台 V2）===== */

app.get('/api/sessions', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 200);
  res.json({ items: listSessions(limit) });
});

app.post('/api/sessions', (req: Request, res: Response) => {
  const { title } = (req.body ?? {}) as { title?: string };
  const s = createSession(title);
  res.json({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt });
});

app.get('/api/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
  const s = getSession(req.params.id);
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json(s);
});

app.patch('/api/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
  const { title } = (req.body ?? {}) as { title?: string };
  if (!title || !title.trim()) {
    res.status(400).json({ error: '标题不能为空' });
    return;
  }
  const s = renameSession(req.params.id, title.trim());
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ id: s.id, title: s.title });
});

app.delete('/api/sessions/:id', (req: Request<{ id: string }>, res: Response) => {
  const ok = deleteSession(req.params.id);
  if (!ok) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/tasks/:id/events', (req: Request<{ id: string }>, res: Response) => {
  const task = tasks.get(req.params.id);
  if (!task) {
    res.status(404).json({ error: '任务不存在' });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // 先回放缓冲事件（订阅前发生的），再进实时通道
  for (const evt of task.events) {
    res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);
  }
  task.subscribers.add(res);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepalive);
    task.subscribers.delete(res);
  });
});

const PORT = 4567;
app.listen(PORT, () => {
  console.log(`PBAgent Web 控制台后端: http://localhost:${PORT}`);
  console.log('前端开发服务器（若已启动）自动代理 /api 到本服务');
});
