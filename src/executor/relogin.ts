import type { Page } from 'playwright';
import type { Playbook } from '../playbook/schema.js';
import { runPlaybookSteps, type RunTrace, type StepTrace } from './engine.js';
import { StepFailure, LOGIN_REDIRECT_PATTERN } from '../detector/failure.js';
import { withCredentials, saveSession } from '../credentials/session.js';
import { getCredentials } from '../credentials/store.js';

export type { RunTrace } from './engine.js';

/** 当前页面是否停在登录页（session 过期的典型信号） */
export function isOnLoginPage(url: string): boolean {
  return LOGIN_REDIRECT_PATTERN.test(url);
}

export interface AutoReloginOptions {
  /** include 前插的登录子流程步骤数（有 session 时跳过） */
  includedSteps: number;
  /** Playbook 声明的 auth 域名（凭证与 session 归属） */
  authDomain?: string;
  /** 是否已加载 storageState（true 时首跑跳过登录子流程） */
  hasSession?: boolean;
  /** 日志输出（默认静默，CLI 传 console.log） */
  log?: (msg: string) => void;
}

const emptyTrace = (name: string): RunTrace => ({
  playbook: name,
  startedAt: new Date().toISOString(),
  steps: [],
  ctxStore: {},
});

/** 合并多轮 trace：首轮 + 重登标记 + 登录轮 + 业务重试轮（重试轮 stepId 加 re- 前缀防撞） */
function combine(
  first: RunTrace,
  login: RunTrace | undefined,
  retry: RunTrace | undefined,
  recovered: boolean,
): RunTrace {
  const reloginMark: StepTrace = {
    stepId: 'relogin',
    name: '自动重登（session 过期恢复）',
    action: 'wait',
    status: 'ok',
    ms: 0,
    note: '检测到登录页跳转，重跑登录子流程后重试业务步骤',
  };
  return {
    playbook: first.playbook,
    startedAt: first.startedAt,
    steps: [
      ...first.steps,
      reloginMark,
      ...(login?.steps ?? []).map((s) => ({ ...s, stepId: `re-${s.stepId}` })),
      ...(retry?.steps ?? []).map((s) => ({ ...s, stepId: `re-${s.stepId}` })),
    ],
    ctxStore: { ...first.ctxStore, ...login?.ctxStore, ...retry?.ctxStore },
    recovered: recovered || undefined,
  };
}

/** 敏感凭证注入：params 合并用户名字段、密码类字段临时进 process.env（用完即恢复） */
function injectCredentials(
  params: Record<string, unknown>,
  domain: string,
): { params: Record<string, unknown>; restore: () => void } {
  const creds = getCredentials(domain);
  const { params: merged, env } = withCredentials(params, domain);
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  return {
    params: merged,
    restore: () => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/**
 * STATE A 执行 + session 过期自动重登（DESIGN 9.2）：
 * 1. 入口统一注入存储凭证（用户名进 params、密码进临时环境变量）——有凭证时 CLI 无需 --params 传登录参数
 * 2. 有 storageState 时首跑跳过登录子流程（省时 + 避免每次重复登录）
 * 3. 业务步骤被踢到登录页 → 重跑登录子流程 → 立即刷新 session → 业务整段重试一次
 * 4. 仍失败则抛出最后一轮的 StepFailure（__trace 挂完整历史，报告可见全过程）
 */
export async function runWithAutoRelogin(
  page: Page,
  playbook: Playbook,
  params: Record<string, unknown>,
  options: AutoReloginOptions,
): Promise<RunTrace> {
  const log = options.log ?? (() => {});
  const skipLogin = Boolean(options.hasSession) && options.includedSteps > 0;

  // 凭证统一注入（有存储凭证才生效；敏感字段只进临时 env，退出前恢复）
  const { params: runParams, restore } = options.authDomain
    ? injectCredentials(params, options.authDomain)
    : { params, restore: () => {} };

  const sessionMark: StepTrace | null = skipLogin
    ? {
        stepId: 'session',
        name: '复用已存登录态，跳过登录子流程',
        action: 'wait',
        status: 'ok',
        ms: 0,
        note: 'storageState 已加载',
      }
    : null;

  // 首跑：有 session 时跳过登录子流程
  const firstSteps = skipLogin ? playbook.steps.slice(options.includedSteps) : playbook.steps;

  let first: RunTrace;
  try {
    first = await runPlaybookSteps(page, { ...playbook, steps: firstSteps }, runParams);
    if (sessionMark) first = { ...first, steps: [sessionMark, ...first.steps] };
    restore();
    return first;
  } catch (err) {
    first = (err as { __trace?: RunTrace }).__trace ?? emptyTrace(playbook.name);
    if (sessionMark) first = { ...first, steps: [sessionMark, ...first.steps] };
    const failure = err instanceof StepFailure ? err : undefined;
    // 重登条件：声明 auth + 登录步骤实际可重跑（含首跑就跑登录子流程失败的场景）+ 非配置错误 + 当前在登录页
    const hasStoredCreds = options.authDomain && Object.keys(getCredentials(options.authDomain)).length > 0;
    const canRelogin =
      Boolean(failure && options.authDomain && hasStoredCreds) &&
      failure!.kind !== 'EX' &&
      isOnLoginPage(page.url());
    restore();
    if (!canRelogin) throw err;
    log(`  ⚠ 检测到登录页跳转（${page.url()}），自动重登中…`);
  }

  // 自动重登：重跑登录子流程（凭证已在 runParams 里，env 已注入）
  const { params: credParams, restore: restore2 } = options.authDomain
    ? injectCredentials(params, options.authDomain)
    : { params, restore: () => {} };

  let loginTrace: RunTrace | undefined;
  try {
    const loginPb: Playbook = {
      ...playbook,
      name: `${playbook.name}（重登）`,
      steps: playbook.steps.slice(0, options.includedSteps),
    };
    loginTrace = await runPlaybookSteps(page, loginPb, credParams);
    restore2();
  } catch (loginErr) {
    loginTrace = (loginErr as { __trace?: RunTrace }).__trace ?? emptyTrace(`${playbook.name}（重登）`);
    (loginErr as { __trace?: RunTrace }).__trace = combine(first, loginTrace, undefined, false);
    restore2();
    log('  ✗ 自动重登失败（凭证可能已变更），保留失败现场');
    throw loginErr;
  }

  // 重登成功：立即刷新 session（业务重试即使再失败，新登录态也已持久化）
  saveSession(options.authDomain!, await page.context().storageState());
  log('  ✓ 自动重登成功，重试业务步骤');

  // 业务整段重试一次（MVP 简化：从头重跑业务段；按失败步骤断点续跑属 v1.0 恢复点）
  const bizPb: Playbook = { ...playbook, steps: playbook.steps.slice(options.includedSteps) };
  try {
    const retry = await runPlaybookSteps(page, bizPb, runParams);
    return combine(first, loginTrace, retry, true);
  } catch (retryErr) {
    const retryTrace = (retryErr as { __trace?: RunTrace }).__trace ?? emptyTrace(playbook.name);
    (retryErr as { __trace?: RunTrace }).__trace = combine(first, loginTrace, retryTrace, false);
    log('  ✗ 业务步骤重试仍失败');
    throw retryErr;
  }
}
