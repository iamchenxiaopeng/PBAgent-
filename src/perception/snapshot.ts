import type { Page } from 'playwright';

/**
 * 感知器（DESIGN F-04/W5-2）：
 * 把 Playwright 页面压缩成 VLM 可消费的快照——
 *   1. 截图（base64，视觉通道）
 *   2. DOM 压缩序列化（结构通道）：只留可见/可交互元素，带 ref 编号
 * ref 编号是 Agent 动作执行的定位锚点（click ref=3 / fill ref=3 value=...）
 */

export interface ElementInfo {
  /** 感知器分配的引用编号（Agent 动作用 ref 指代元素） */
  ref: number;
  tag: string;
  role?: string;
  /** 可交互语义名（aria-label / label 关联 / 占位符 / 按钮文本） */
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  /** 文本内容前 80 字符（可交互元素才带） */
  text?: string;
  href?: string;
  /** 简单 css 锚点（#id 优先，否则 tag.class）——learner 蒸馏 selector 用 */
  css?: string;
  /** 是否表单控件 */
  isForm: boolean;
  /** 所属 form 的 action（有 form 上下文时） */
  formAction?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** 截图 base64（PNG，无 data: 前缀） */
  screenshotBase64: string;
  /** 压缩 DOM：可交互元素清单 */
  elements: ElementInfo[];
  /** 页面可见文本摘要（前 N 字符，帮 VLM 理解页面语境） */
  bodyText: string;
  /** 感知耗时 ms */
  ms: number;
}

/** 单页元素数量上限（防 token 爆炸；超出按 DOM 顺序截断） */
const MAX_ELEMENTS = 120;
const BODY_TEXT_LIMIT = 1200;

/** 可交互元素选择器（与 executor/selector.ts 的 text 层口径一致） */
const INTERACTIVE_SELECTOR = [
  'button', 'a', 'input', 'select', 'textarea', 'label',
  '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="checkbox"]',
  '[onclick]', '[contenteditable="true"]',
].join(', ');

interface RawElement {
  tag: string;
  role?: string;
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  text?: string;
  href?: string;
  css?: string;
  isForm: boolean;
  formAction?: string;
}

/**
 * 导航导致的报错特征：点击触发跳转后，旧页面的执行上下文被销毁，
 * 此时 evaluate/screenshot 会抛 "Execution context was destroyed"。
 */
const NAV_ERROR =
  /Execution context was destroyed|Execution context was not found|Page was closed|Cannot read property|navigation/i;

/**
 * 带导航重试的采集：撞上页面跳转时等页面沉降后重试，拿到的是跳转后的新页面。
 * 真实站点（搜索页提交、表单跳转）普遍存在，不加重试会直接把整个任务判失败。
 */
async function collectWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const nav = NAV_ERROR.test((e as Error).message);
      if (!nav || i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1))); // 递增退避：等导航落地
    }
  }
  throw lastErr;
}

/** 单次截图超时（普通截图会等外部字体就绪，真实站点常卡死在这） */
const SCREENSHOT_TIMEOUT_MS = 6_000;

/**
 * 截图三级降级：
 *   1. 普通 screenshot（等字体，画质正常）
 *   2. 卡在 "waiting for fonts to load" → 用 CDP 直接截图（不等 document.fonts.ready）
 *   3. 仍失败 → 返回空串，由调用方退化为纯 DOM 决策（结构通道仍可用）
 * 真实站点（外部字体 CDN 慢/被墙）第 1 步超时很常见，不降级会拖垮整个任务。
 */
async function takeScreenshot(page: Page): Promise<string> {
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: false, timeout: SCREENSHOT_TIMEOUT_MS });
    return buf.toString('base64');
  } catch {
    try {
      const cdp = await page.context().newCDPSession(page);
      const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
      await cdp.detach().catch(() => {});
      return data;
    } catch {
      return ''; // 截图彻底不可用——退化为纯 DOM 决策
    }
  }
}

/**
 * 采集页面快照：截图 + DOM 压缩。
 * DOM 压缩在页面上下文里执行（page.evaluate 传自包含内联函数，
 * 不能引用模块作用域——函数体会被序列化到页面里跑）。
 */
export async function snapshot(page: Page): Promise<PageSnapshot> {
  const started = Date.now();

  // 并行：截图 + DOM 采集（整体包一层导航重试——任一子任务撞上跳转就整批重来）
  const [screenshotBase64, raws, bodyText, title] = await collectWithRetry(() =>
    Promise.all([
      takeScreenshot(page),
      page.evaluate(
      ({ selector, max }) => {
        const out: Array<Record<string, unknown>> = [];
        const nodes = Array.from(document.querySelectorAll(selector));
        for (const el of nodes) {
          if (out.length >= max) break;
          const html = el as HTMLElement;
          // 可见过滤：有尺寸且不在 display:none 祖先下
          const rect = html.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const style = window.getComputedStyle(html);
          if (style.display === 'none' || style.visibility === 'hidden') continue;

          const tag = html.tagName.toLowerCase();
          const role = html.getAttribute('role') ?? undefined;
          const ariaLabel = html.getAttribute('aria-label') ?? undefined;
          // 简单 css 锚点：#id 优先（改版下最稳），否则 tag.class（首个类名）
          const firstClass = html.classList.length > 0 ? html.classList[0] : null;
          const css = html.id ? `#${html.id}` : firstClass ? `${tag}.${firstClass}` : undefined;
          // label 关联：label[for=id] 的文本
          let labelText: string | undefined;
          if (html.id) {
            const label = document.querySelector(`label[for="${CSS.escape(html.id)}"]`);
            labelText = label?.textContent?.trim() || undefined;
          }
          // input 的 name/value/placeholder
          const input = html as HTMLInputElement;
          const isInput = tag === 'input' || tag === 'select' || tag === 'textarea';
          const name = ariaLabel ?? labelText ?? (isInput ? input.placeholder || undefined : undefined);
          const text = (html.textContent ?? '').trim().slice(0, 80) || undefined;

          out.push({
            tag,
            role,
            name,
            type: isInput ? input.type : undefined,
            value: isInput && input.type !== 'password' ? String(input.value).slice(0, 60) : undefined,
            placeholder: isInput ? input.placeholder || undefined : undefined,
            text: tag === 'a' || tag === 'button' || tag === 'label' || role ? text : undefined,
            href: tag === 'a' ? (html as HTMLAnchorElement).getAttribute('href') ?? undefined : undefined,
            css,
            isForm: isInput || tag === 'button' || role === 'button',
            formAction: html.closest('form')?.getAttribute('action') ?? undefined,
          });
        }
        return out;
      },
      { selector: INTERACTIVE_SELECTOR, max: MAX_ELEMENTS },
    ),
    page.evaluate(({ limit }) => (document.body?.innerText ?? '').slice(0, limit), { limit: BODY_TEXT_LIMIT }),
      page.title(),
    ]),
  );

  const elements: ElementInfo[] = (raws as unknown as RawElement[]).map((r, i) => ({ ...r, ref: i + 1 }));
  return {
    url: page.url(),
    title,
    screenshotBase64,
    elements,
    bodyText,
    ms: Date.now() - started,
  };
}

/** DOM 摘要渲染成 VLM 提示词片段（视觉通道之外的结构通道） */
export function renderDomDigest(snap: PageSnapshot): string {
  const lines: string[] = [];
  for (const e of snap.elements) {
    const parts: string[] = [`[${e.ref}] <${e.tag}`];
    if (e.type) parts.push(`type="${e.type}"`);
    if (e.name) parts.push(`name="${e.name}"`);
    if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`);
    if (e.value !== undefined && e.value !== '') parts.push(`value="${e.value}"`);
    if (e.href) parts.push(`href="${e.href}"`);
    parts.push('>');
    if (e.text) parts.push(e.text);
    if (e.isForm && e.formAction) parts.push(`(form→${e.formAction})`);
    lines.push(parts.join(' '));
  }
  return [
    `# 页面: ${snap.title}`,
    `# URL: ${snap.url}`,
    `# 可交互元素（ref 编号是动作定位锚点）:`,
    ...lines,
    '',
    '# 页面文本摘要:',
    snap.bodyText,
  ].join('\n');
}
