import type { Locator, Page } from 'playwright';
import type { Selector } from '../playbook/schema.js';

/** 各策略独立等待时长（毫秒），合计受步骤 timeout 约束 */
const PER_LAYER_TIMEOUT = 3_000;

export class ElementNotFoundError extends Error {
  readonly kind = 'E1' as const;
  constructor(
    message: string,
    public readonly triedStrategies: string[],
  ) {
    super(message);
    this.name = 'ElementNotFoundError';
  }
}

/**
 * 多层 fallback 选择器解析：css → xpath → text → role → label。
 * 每层独立等待可见，命中即返回；全部失败抛 E1（附已尝试策略）。
 */
export async function resolveLocator(
  page: Page,
  selector: Selector,
  timeoutMs?: number,
): Promise<Locator> {
  const layers: Array<{ strategy: string; build: () => Locator }> = [];
  if (selector.css) {
    layers.push({ strategy: `css=${selector.css}`, build: () => page.locator(selector.css!) });
  }
  if (selector.xpath) {
    layers.push({ strategy: `xpath=${selector.xpath}`, build: () => page.locator(`xpath=${selector.xpath}`) });
  }
  if (selector.text) {
    layers.push({
      strategy: `text=${selector.text}`,
      // 优先匹配可交互元素（button/a/input/label 等），避免命中标题等纯文本
      build: () =>
        page.locator('button, a, input, select, label, [role="button"], [onclick]', { hasText: selector.text! }).first(),
    });
    layers.push({
      strategy: `text-any=${selector.text}`,
      // 兜底：任意可见文本节点（写在最后，改版后按钮可能换成非标准元素）
      build: () => page.getByText(selector.text!, { exact: false }).first(),
    });
  }
  if (selector.role) {
    layers.push({
      strategy: `role=${selector.role}${selector.label ? `(${selector.label})` : ''}`,
      build: () => (selector.label
        ? page.getByRole(selector.role as never, { name: selector.label })
        : page.getByRole(selector.role as never)),
    });
  }
  if (!selector.role && selector.label) {
    layers.push({
      strategy: `label=${selector.label}`,
      build: () => page.getByLabel(selector.label!),
    });
  }
  // nth 默认 0：所有 build 已返回 first/唯一匹配；nth>0 的场景用 .nth() 选取
  const applyNth = (loc: Locator): Locator => (selector.nth ? loc.nth(selector.nth) : loc);

  const tried: string[] = [];
  const deadline = Date.now() + (timeoutMs ?? PER_LAYER_TIMEOUT * Math.max(layers.length, 1));
  for (const layer of layers) {
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    const budget = Math.min(PER_LAYER_TIMEOUT, remain);
    const locator = layer.build();
    if (selector.nth && selector.nth > 0) {
      // nth>0 时先取全部匹配再选第 n 个（first 之外的语义）
    }
    try {
      await locator.waitFor({ state: 'visible', timeout: budget });
      return applyNth(locator);
    } catch {
      tried.push(layer.strategy);
    }
  }
  throw new ElementNotFoundError(
    `元素定位失败，已尝试策略: ${tried.join(' | ') || '（无可用策略）'}`,
    tried,
  );
}

/** 恢复点/断言用的非抛错探测：任一层命中返回 true */
export async function probeLocator(page: Page, selector: Selector, timeoutMs = 1_000): Promise<boolean> {
  try {
    await resolveLocator(page, selector, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
