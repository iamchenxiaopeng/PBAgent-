import type { Step } from '../playbook/schema.js';

/** 失败四分类（PRD F-03）+ EX 配置类错误（不触发兜底，直接终止） */
export type FailureKind = 'E1' | 'E2' | 'E3' | 'E4' | 'EX';

export class StepFailure extends Error {
  constructor(
    message: string,
    public readonly kind: FailureKind,
    /** 人类可读的失败类型名 */
    public readonly kindLabel: string,
    /** 失败步骤信息 */
    public readonly step: Step,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

export const KIND_LABELS: Record<FailureKind, string> = {
  E1: '元素定位失败',
  E2: '页面状态异常',
  E3: '超时',
  E4: '断言失败',
  EX: '配置错误',
};

export function stepFailure(
  kind: FailureKind,
  step: Step,
  message: string,
  detail?: Record<string, unknown>,
): StepFailure {
  return new StepFailure(`[${kind} ${KIND_LABELS[kind]}] ${message}`, kind, KIND_LABELS[kind], step, detail);
}

/** 页面状态异常（E2）的检测模式 */
export interface PageStateSignal {
  /** 当前 URL 命中的异常模式（如被踢到登录页） */
  urlPattern?: RegExp;
  /** 命中的 HTTP 状态码异常 */
  badStatus?: { url: string; status: number };
  /** 匹配到的遮挡弹窗文本 */
  overlayText?: string;
}

/** 已知「异常页面」特征：登录页跳转（session 过期的典型表现） */
export const LOGIN_REDIRECT_PATTERN = /\/login(\?|$)/;

/**
 * E2 快速检测：不等超时，立即判定当前页面是否处于异常状态。
 * @returns 命中的异常信号（null 表示页面正常）
 */
export function detectPageState(
  currentUrl: string,
  expectedUrlPattern: string | null,
  recentBadResponse?: { url: string; status: number },
): PageStateSignal | null {
  // 1. 期望 URL 与实际不符且被重定向到登录页 → session 过期
  if (
    expectedUrlPattern &&
    !new RegExp(escapeRegExp(expectedUrlPattern)).test(currentUrl) &&
    LOGIN_REDIRECT_PATTERN.test(currentUrl)
  ) {
    return { urlPattern: LOGIN_REDIRECT_PATTERN };
  }
  // 2. 页面主文档 404/500
  if (recentBadResponse && (recentBadResponse.status >= 400)) {
    return { badStatus: recentBadResponse };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把底层 Playwright/自定义错误转成 StepFailure（E1-E4 分类入口） */
export function classifyError(err: unknown, step: Step): StepFailure {
  if (err instanceof StepFailure) return err;

  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  if (name === 'ElementNotFoundError') {
    return stepFailure('E1', step, msg, { triedStrategies: (err as { triedStrategies?: string[] }).triedStrategies });
  }
  // 插值/配置类错误：变量缺失、类型不对——与页面无关，不触发兜底
  if (name === 'InterpolationError' || /未注入|未定义|环境变量不存在|无法解析/.test(msg)) {
    return stepFailure('EX', step, msg);
  }
  if (name === 'TimeoutError' || /timeout/i.test(msg)) {
    return stepFailure('E3', step, msg);
  }
  // Playwright 的 waiting for locator 报错也归 E1
  if (/waiting for|locator\./i.test(msg)) {
    return stepFailure('E1', step, msg);
  }
  return stepFailure('E2', step, msg);
}
