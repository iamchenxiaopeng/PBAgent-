import type { Page } from 'playwright';
import type { Playbook, Step } from '../playbook/schema.js';
import { RunContext } from './context.js';
import { executeStep, type StepOutput } from './steps.js';
import { classifyError, stepFailure, type StepFailure } from '../detector/failure.js';

export interface StepTrace {
  stepId: string;
  name: string;
  action: Step['action'];
  status: 'ok' | 'failed';
  ms: number;
  note?: string;
  extracted?: Record<string, unknown>;
  failure?: { kind: string; kindLabel: string; message: string };
}

export interface RunTrace {
  playbook: string;
  startedAt: string;
  steps: StepTrace[];
  ctxStore: Record<string, unknown>;
  /** 自动重登后重试成功（trace 含首次失败+重登+重试完整历史） */
  recovered?: boolean;
}

export interface EngineOptions {
  /** 单步默认超时（毫秒） */
  defaultStepTimeout?: number;
  /** 每步截图策略（默认 on-fail 由失败归档处理） */
  onStepStart?: (trace: StepTrace, step: Step) => void;
}

/**
 * STATE A 执行主循环：
 * 顺序 + loop 展开，每步结果写 trace；失败抛 StepFailure（含分类），
 * 由上层 orchestrator 决定接管（v1.0）或终止（MVP）。
 */
export async function runPlaybookSteps(
  page: Page,
  playbook: Playbook,
  params: Record<string, unknown>,
  options: EngineOptions = {},
): Promise<RunTrace> {
  const ctx = new RunContext(playbook, params);
  // baseUrl 注入：meta.baseUrl 支持 ${vars.*} 插值
  (playbook as Playbook & { vars?: Record<string, string> }).vars = {
    ...playbook.vars,
    __baseUrl: playbook.meta?.baseUrl
      ? ctx.resolve(playbook.meta.baseUrl as string)
      : playbook.meta?.baseUrl ?? '',
  };

  const trace: RunTrace = {
    playbook: playbook.name,
    startedAt: new Date().toISOString(),
    steps: [],
    ctxStore: ctx.store,
  };

  let stepCounter = 0;
  const runSteps = async (steps: Step[]): Promise<void> => {
    for (const step of steps) {
      if (step.action === 'loop') {
        const items = ctx.resolve<unknown[]>(step.over);
        if (!Array.isArray(items)) {
          throw stepFailure('E4', step, `loop.over 不是数组: ${step.over}`);
        }
        for (const item of items) {
          ctx.pushLoopScope({ [step.var]: item });
          try {
            await runSteps(step.steps);
          } finally {
            ctx.popLoopScope();
          }
        }
        trace.steps.push({
          stepId: `s${++stepCounter}`,
          name: step.name,
          action: 'loop',
          status: 'ok',
          ms: 0,
          note: `${items.length} 轮循环`,
        });
        continue;
      }

      const stepId = step.id ?? `s${++stepCounter}`;
      const started = Date.now();
      try {
        const output: StepOutput = await executeStep(page, step, ctx);
        // extract 产物写入 ctx.store（后续步骤 ${ctx.x} 可引用）
        if (output.extracted) Object.assign(ctx.store, output.extracted);
        const t: StepTrace = {
          stepId, name: step.name, action: step.action,
          status: 'ok', ms: Date.now() - started,
          note: output.note, extracted: output.extracted,
        };
        trace.steps.push(t);
        options.onStepStart?.(t, step);
      } catch (err) {
        const failure: StepFailure = classifyError(err, step);
        trace.steps.push({
          stepId, name: step.name, action: step.action,
          status: 'failed', ms: Date.now() - started,
          failure: { kind: failure.kind, kindLabel: failure.kindLabel, message: failure.message },
        });
        // 失败也把已执行的 trace 带出去（报告要用）
        (failure as StepFailure & { __trace?: RunTrace }).__trace = trace;
        throw failure;
      }
    }
  };

  await runSteps(playbook.steps);
  return trace;
}
