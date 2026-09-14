import type { Page } from 'playwright';
import type { Step } from '../playbook/schema.js';
import type { RunContext } from './context.js';
import { stepFailure } from '../detector/failure.js';
import { resolveLocator } from './selector.js';

/**
 * 步骤执行输出（extract 产物、download 路径等）。
 * 每步结束后由引擎读取 `sawDialog`（DOM 无该状态，需要执行器主动暴露）。
 */
export interface StepOutput {
  extracted?: Record<string, unknown>;
  savedTo?: string;
  note?: string;
  /** 本步是否出现原生弹窗（confirm/alert）并按策略处置了（蒸馏标记用） */
  sawDialog?: boolean;
}

const joinUrl = (base: string | undefined, path: string): string => {
  if (/^https?:\/\//.test(path)) return path;
  if (!base) return path;
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
};

/** 导航 + 主文档异常响应检测（E2） */
async function navigate(page: Page, url: string, timeoutMs?: number): Promise<void> {
  const badResponses: string[] = [];
  const listener = (resp: { url(): string; status(): number }): void => {
    if (resp.status() >= 400) badResponses.push(`${resp.status()} ${resp.url()}`);
  };
  page.on('response', listener);
  try {
    await page.goto(url, { timeout: timeoutMs ?? 30_000, waitUntil: 'domcontentloaded' });
    if (badResponses.length > 0) {
      throw new Error(`页面返回异常响应: ${badResponses[0]}`);
    }
  } finally {
    page.off('response', listener);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ExecContext {
  page: Page;
  ctx: RunContext;
  step: Step;
  stepTimeout: number | undefined;
}

const impl = {
  async goto({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'goto' }>;
    const base = ctx.resolve('${vars.__baseUrl}') as string;
    const url = joinUrl(base || undefined, ctx.resolve(s.url));
    await navigate(page, url, stepTimeout);
    return { note: url };
  },

  async click({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'click' }>;
    const locator = await resolveLocator(page, s.selector, stepTimeout);
    if (s.dialog === 'accept') {
      // 原生弹窗自动确认（Agent 沉淀的改版场景：confirm 后才提交表单）
      const handler = (d: { accept: () => Promise<void> }): void => { void d.accept(); };
      page.on('dialog', handler);
      try {
        await locator.click();
      } finally {
        page.off('dialog', handler);
      }
    } else {
      await locator.click();
    }
    return {};
  },

  async fill({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'fill' }>;
    const locator = await resolveLocator(page, s.selector, stepTimeout);
    await locator.fill(ctx.resolve(s.value));
    return {};
  },

  async select({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'select' }>;
    const locator = await resolveLocator(page, s.selector, stepTimeout);
    await locator.selectOption(ctx.resolve(s.value));
    return {};
  },

  async check({ page, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'check' }>;
    const locator = await resolveLocator(page, s.selector, stepTimeout);
    if (s.checked) await locator.check();
    else await locator.uncheck();
    return {};
  },

  async hover({ page, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'hover' }>;
    await (await resolveLocator(page, s.selector, stepTimeout)).hover();
    return {};
  },

  async press({ page, step }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'press' }>;
    await page.keyboard.press(s.key);
    return {};
  },

  async wait({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'wait' }>;
    if (s.ms) {
      await page.waitForTimeout(s.ms);
    } else if (s.urlPattern) {
      const pattern = new RegExp(escapeRegExp(ctx.resolve(s.urlPattern)));
      await page.waitForURL(pattern, { timeout: stepTimeout ?? 30_000 });
    } else if (s.selector) {
      await resolveLocator(page, s.selector, stepTimeout);
    } else {
      await page.waitForLoadState('domcontentloaded');
    }
    return {};
  },

  async extract({ page, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'extract' }>;
    const locator = await resolveLocator(page, s.selector, stepTimeout);
    const raw = await (async () => {
      switch (s.attr) {
        case 'text': return await locator.textContent();
        case 'value': return await locator.inputValue();
        case 'href': return await locator.getAttribute('href');
        case 'src': return await locator.getAttribute('src');
      }
    })();
    const value = raw === null || raw === undefined ? '' : String(raw).trim();
    return { extracted: { [s.into]: value }, note: `${s.into}=${value.slice(0, 40)}` };
  },

  async scroll({ page, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'scroll' }>;
    if (s.selector) {
      await (await resolveLocator(page, s.selector, stepTimeout)).scrollIntoViewIfNeeded();
    } else if (s.to === 'bottom') {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    } else {
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    return {};
  },

  async download({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'download' }>;
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: stepTimeout ?? 60_000 }),
      (async () => {
        if (s.urlPattern) {
          const pattern = ctx.resolve(s.urlPattern);
          const link = page.locator('a').filter({ hasText: '' }).locator(`[href*="${pattern}"]`).first();
          if ((await link.count()) > 0) await link.click();
        }
      })(),
    ]);
    const target = ctx.resolve(s.saveTo);
    await download.saveAs(target);
    return { savedTo: target };
  },

  async screenshot({ page, ctx, step }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'screenshot' }>;
    const target = s.saveTo ? ctx.resolve(s.saveTo) : `runs/screenshots/step-${Date.now()}.png`;
    await page.screenshot({ path: target, fullPage: s.fullPage });
    return { savedTo: target };
  },

  async assert({ page, ctx, step, stepTimeout }: ExecContext): Promise<StepOutput> {
    const s = step as Extract<Step, { action: 'assert' }>;
    const deadline = Date.now() + (stepTimeout ?? 10_000);
    let lastReason = '未知原因';
    while (Date.now() < deadline) {
      const problems: string[] = [];
      if (s.urlPattern) {
        const pattern = escapeRegExp(ctx.resolve(s.urlPattern));
        if (!new RegExp(pattern).test(page.url())) {
          problems.push(`URL 不匹配: 期望 ~${s.urlPattern}，实际 ${page.url()}`);
        }
      }
      if (s.selector) {
        try {
          await resolveLocator(page, s.selector, Math.min(1_000, deadline - Date.now()));
        } catch {
          problems.push(`元素未出现: ${JSON.stringify(s.selector)}`);
        }
      }
      if (s.textContains || s.textAbsent) {
        const body = (await page.textContent('body')) ?? '';
        if (s.textContains && !body.includes(ctx.resolve(s.textContains))) {
          problems.push(`页面缺少文本: "${s.textContains}"`);
        }
        if (s.textAbsent && body.includes(ctx.resolve(s.textAbsent))) {
          problems.push(`页面不应出现文本: "${s.textAbsent}"`);
        }
      }
      if (problems.length === 0) return { note: '断言通过' };
      lastReason = problems.join('; ');
      await page.waitForTimeout(300);
    }
    throw stepFailure('E4', step, `断言失败: ${lastReason}`);
  },
};

type Action = Exclude<Step['action'], 'loop'>;

/** 步骤分发入口（loop 由 engine 处理，不在此列） */
export async function executeStep(page: Page, step: Step, ctx: RunContext): Promise<StepOutput> {
  if (step.action === 'loop') {
    throw new Error('loop 步骤由 engine 直接处理，不应进入 executeStep');
  }
  const fn = impl[step.action as Action] as ((c: ExecContext) => Promise<StepOutput>) | undefined;
  if (!fn) throw new Error(`未实现的步骤类型: ${step.action}`);
  return fn({ page, ctx, step, stepTimeout: step.timeout });
}
