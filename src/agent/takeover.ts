import type { Page } from 'playwright';
import type { Playbook, Step } from '../playbook/schema.js';
import { runPlaybookSteps, type RunTrace, type StepTrace } from '../executor/engine.js';
import { StepFailure } from '../detector/failure.js';
import { snapshot } from '../perception/snapshot.js';
import { runAgent, type AgentResult } from './loop.js';
import { buildRecoveryPoints, checkRecovery, matchContextOf } from '../recovery/fingerprint.js';
import { distillFromTakeover, type DistillResult } from '../learner/distill.js';

/**
 * STATE A → B → A 完整编排（DESIGN §1.3 / F-04+F-05+F-06）：
 * 1. STATE A：Playbook 确定性执行
 * 2. 步骤失败（E1/E2/E4，非 EX）→ 归档失败现场 → STATE B：Agent 兜底接管
 *    任务目标 = 失败步骤语义 + Playbook 整体意图；
 *    Agent 每个动作后做恢复点匹配（500ms 预算，复用感知数据）
 * 3. 命中恢复点 → STATE A：从命中步骤断点续跑（被 Agent 达成的步骤标记 skipped-by-agent）
 * 4. Agent 步数耗尽仍未命中 → 失败退出（保留完整轨迹）
 * 5. STATE C（可选）：兜底成功 → 轨迹蒸馏为新版本（默认只落草稿，不自动生效）
 */

export interface TakeoverOptions {
  /** 域名白名单（meta.allowDomains；空 = 不限制） */
  allowDomains: string[];
  /** Agent 兜底步数上限（默认 15） */
  agentMaxSteps?: number;
  /** 是否携带截图给 VLM */
  withScreenshot?: boolean;
  /** STATE C：兜底成功后蒸馏为新版本 Playbook（写入 .versions/ 草稿；主文件不动） */
  learn?: {
    /** 沉淀写入的目标主文件路径（.versions 目录在其旁边生成） */
    mainFile: string;
    runId?: string;
  };
  /** 日志 */
  log?: (msg: string) => void;
}

/** 混合运行结果：Playbook trace + Agent 轨迹 + 模式切换时间线 */
export interface HybridResult {
  trace: RunTrace;
  agent: AgentResult | null;
  /** 失败步骤下标（触发接管的位置） */
  failedIndex: number;
  /** 恢复点命中的步骤下标（续跑位置） */
  resumedIndex: number | null;
  /** A→B→A 时间线（报告用） */
  timeline: Array<{ phase: 'A' | 'B'; from: number; to: number; note?: string }>;
  /** 兜底后重试整体是否成功 */
  success: boolean;
  /** STATE C 蒸馏产物（learn 开启且兜底成功时有值） */
  learned?: DistillResult;
}

/** 从失败步骤推导 Agent 任务目标（给 LLM 的任务描述） */
function buildTaskFromStep(pb: Playbook, failedStep: Step, failure: StepFailure): string {
  const intent = pb.description ? `（整体流程：${pb.description}）` : '';
  const stepDesc = describeStepForAgent(failedStep);
  return `Playbook 步骤「${failedStep.name}」失败了：${failure.message}。${stepDesc}。请观察当前页面，用等价的方式完成这一步的意图，直到页面出现该步骤应有的结果。${intent}`;
}

function describeStepForAgent(step: Step): string {
  switch (step.action) {
    case 'click': return `原动作：点击元素 ${JSON.stringify(step.selector)}`;
    case 'fill': return `原动作：在 ${JSON.stringify(step.selector)} 填入「${step.value}」`;
    case 'goto': return `原动作：打开 ${step.url}`;
    case 'assert': return `原动作：断言 ${step.urlPattern ?? ''} ${step.textContains ?? ''} ${step.selector ? JSON.stringify(step.selector) : ''}`.trim();
    case 'select': return `原动作：选择 ${step.value}`;
    case 'press': return `原动作：按键 ${step.key}`;
    default: return `原动作：${step.action}`;
  }
}

const emptyTrace = (name: string): RunTrace => ({
  playbook: name,
  startedAt: new Date().toISOString(),
  steps: [],
  ctxStore: {},
});

/** Agent 动作后的恢复点检查（挂在感知数据上，纯计算） */
async function agentLoopWithRecovery(
  page: Page,
  points: ReturnType<typeof buildRecoveryPoints>,
  options: TakeoverOptions,
  task: string,
): Promise<{ agent: AgentResult; resumedIndex: number | null }> {
  const log = options.log ?? (() => {});
  let resumedIndex: number | null = null;

  const agent = await runAgent(page, {
    task,
    allowDomains: options.allowDomains,
    maxSteps: options.agentMaxSteps ?? 15,
    withScreenshot: options.withScreenshot ?? true,
    log,
    // 每步动作后检查恢复点（复用该步已感知的数据不精确——重新快照 <200ms）
    onAfterAction: async (p) => {
      const snap = await snapshot(p);
      const { hit } = checkRecovery(points, matchContextOf(snap));
      if (hit) {
        resumedIndex = hit.stepIndex;
        log(`  ✓ 恢复点命中：「${hit.stepName}」（步骤 ${hit.stepIndex + 1}）`);
        return true; // 终止 Agent 循环
      }
      return false;
    },
  });

  const summary = resumedIndex !== null
    ? `Agent 兜底完成，命中恢复点「${points.find((p) => p.stepIndex === resumedIndex)?.stepName}」`
    : agent.summary;
  return { agent: { ...agent, summary }, resumedIndex };
}

/**
 * 混合执行入口：STATE A 执行，失败触发 STATE B 接管，恢复点命中后回 A 续跑。
 */
export async function runWithTakeover(
  page: Page,
  playbook: Playbook,
  params: Record<string, unknown>,
  options: TakeoverOptions,
): Promise<HybridResult> {
  const log = options.log ?? (() => {});
  const timeline: HybridResult['timeline'] = [];

  // STATE A：首跑
  let firstTrace: RunTrace;
  let failure: StepFailure | undefined;
  let failedIndex = -1;
  try {
    firstTrace = await runPlaybookSteps(page, playbook, params);
    timeline.push({ phase: 'A', from: 0, to: firstTrace.steps.length, note: 'Playbook 全程成功' });
    return {
      trace: firstTrace,
      agent: null,
      failedIndex: -1,
      resumedIndex: null,
      timeline,
      success: true,
    };
  } catch (err) {
    failure = err instanceof StepFailure ? err : undefined;
    firstTrace = (err as { __trace?: RunTrace }).__trace ?? emptyTrace(playbook.name);
    // 找失败步骤在展开数组中的下标（trace 的最后失败步）
    const failedStepId = [...firstTrace.steps].reverse().find((s) => s.status === 'failed')?.stepId;
    // loop 内步骤不在顶层数组——用步骤名匹配兜底
    failedIndex = playbook.steps.findIndex((s) => s.name === failure?.step?.name);
    if (failedIndex < 0 && failedStepId) {
      const n = Number(String(failedStepId).replace(/^s/, ''));
      if (!Number.isNaN(n)) failedIndex = n - 1;
    }
    timeline.push({ phase: 'A', from: 0, to: firstTrace.steps.length, note: `步骤失败：${failure?.message.slice(0, 80)}` });
    if (!failure) throw err;
  }

  // EX 配置错误不接管（与 relogin 同口径）
  if (failure.kind === 'EX') {
    return {
      trace: firstTrace,
      agent: null,
      failedIndex,
      resumedIndex: null,
      timeline,
      success: false,
    };
  }

  // STATE B：Agent 兜底
  log(`  ⚠ [${failure.kind} ${failure.kindLabel}] 触发 Agent 兜底接管`);
  const points = buildRecoveryPoints(playbook, failedIndex);
  if (points.length === 0) {
    log('  ⚠ 失败步骤后无可识别的恢复点，无法回归（直接失败）');
    return { trace: firstTrace, agent: null, failedIndex, resumedIndex: null, timeline, success: false };
  }
  const task = buildTaskFromStep(playbook, playbook.steps[failedIndex] ?? failure.step, failure);
  timeline.push({ phase: 'B', from: failedIndex + 1, to: failedIndex + 1, note: `目标：${playbook.steps[failedIndex]?.name}` });

  const { agent, resumedIndex } = await agentLoopWithRecovery(page, points, options, task);
  timeline.push({
    phase: 'B',
    from: failedIndex + 1,
    to: failedIndex + 1 + agent.steps.length,
    note: agent.summary.slice(0, 80),
  });

  if (resumedIndex === null) {
    // 未命中恢复点 → 失败（轨迹已含 Agent 步骤）
    return { trace: firstTrace, agent, failedIndex, resumedIndex: null, timeline, success: false };
  }

  // STATE A：断点续跑（从命中步骤到结尾；失败步骤本身标 skipped-by-agent）
  const skippedMark: StepTrace = {
    stepId: 'skipped-by-agent',
    name: playbook.steps[failedIndex]?.name ?? '(失败步骤)',
    action: 'wait',
    status: 'ok',
    ms: 0,
    note: '该步骤意图已由 Agent 兜底达成',
  };
  const rest = playbook.steps.slice(resumedIndex);
  let retryTrace: RunTrace;
  let hybridResult: HybridResult;
  try {
    retryTrace = await runPlaybookSteps(page, { ...playbook, steps: rest }, params);
    timeline.push({ phase: 'A', from: resumedIndex + 1, to: playbook.steps.length, note: '断点续跑成功' });
    // 合并 trace：首跑（含失败步）+ skipped 标记 + Agent 轨迹摘要 + 续跑
    const agentMark: StepTrace = {
      stepId: 'agent-takeover',
      name: `Agent 兜底（${agent.steps.length} 步，命中「${playbook.steps[resumedIndex]?.name}」）`,
      action: 'wait',
      status: 'ok',
      ms: agent.totalMs,
      note: agent.summary,
    };
    hybridResult = {
      trace: {
        ...firstTrace,
        steps: [...firstTrace.steps, skippedMark, agentMark, ...retryTrace.steps],
        ctxStore: { ...firstTrace.ctxStore, ...retryTrace.ctxStore },
        recovered: true,
      },
      agent,
      failedIndex,
      resumedIndex,
      timeline,
      success: true,
    };
  } catch (retryErr) {
    retryTrace = (retryErr as { __trace?: RunTrace }).__trace ?? emptyTrace(playbook.name);
    (retryErr as { __trace?: RunTrace }).__trace = {
      ...firstTrace,
      steps: [...firstTrace.steps, skippedMark, ...retryTrace.steps],
      ctxStore: { ...firstTrace.ctxStore, ...retryTrace.ctxStore },
    };
    timeline.push({ phase: 'A', from: resumedIndex + 1, to: playbook.steps.length, note: '续跑仍失败' });
    hybridResult = { trace: firstTrace, agent, failedIndex, resumedIndex, timeline, success: false };
  }

  // STATE C：兜底成功 → 沉淀版本草稿（默认不生效；失败不影响结果）
  if (options.learn && hybridResult.success) {
    hybridResult = await maybeLearn(hybridResult, playbook, params, options.learn, log);
  }
  return hybridResult;
}

/** STATE C：兜底成功后蒸馏轨迹 + 写入版本草稿（learn 开启时调用；失败不影响主流程） */
export async function maybeLearn(
  hybrid: HybridResult,
  playbook: Playbook,
  params: Record<string, unknown>,
  learn: NonNullable<TakeoverOptions['learn']>,
  log: (msg: string) => void,
): Promise<HybridResult> {
  if (!hybrid.success || !hybrid.agent || hybrid.failedIndex < 0) return hybrid;
  try {
    const learned = distillFromTakeover(playbook, hybrid.agent, hybrid.failedIndex, params);
    if (learned.distilledCount === 0) {
      log('  ⚠ 轨迹无可沉淀步骤（纯 press/wait/凭证类），跳过版本生成');
      return hybrid;
    }
    log(`  📝 STATE C：蒸馏完成 — 步骤 ${learned.replacedIndex + 1} 替换为 ${learned.distilledCount} 个新步骤`);
    const { saveLearnedVersion } = await import('../learner/versioning.js');
    const saved = saveLearnedVersion(learn.mainFile, learned.playbook, {
      runId: learn.runId,
      reason: `步骤「${playbook.steps[hybrid.failedIndex]?.name ?? '?'}」自愈路径沉淀（Agent ${hybrid.agent.steps.length} 步）`,
    });
    log(`  📝 版本草稿已写入：v${saved.newVersion}（未生效；pbagent promote 确认后替换主文件）`);
    log(`     diff: ${saved.diffFile}`);
    return { ...hybrid, learned };
  } catch (e) {
    log(`  ⚠ 沉淀失败（不影响运行结果）: ${(e as Error).message}`);
    return hybrid;
  }
}
