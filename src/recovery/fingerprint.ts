import type { Page } from 'playwright';
import type { Playbook, Step, Selector } from '../playbook/schema.js';
import type { PageSnapshot } from '../perception/snapshot.js';

/**
 * 恢复点判定（DESIGN §6.1 / F-05）：
 * Playbook 步骤失败后，Agent 每完成一个动作，检查当前页面是否命中
 * 后续某个步骤的「页面特征」（URL pattern + 关键元素 + 关键文本）。
 * 命中 → 跳回 Playbook 从该步骤续跑（STATE B → STATE A）。
 *
 * 评分制：URL 命中 +30，selector 命中 +50，assertText 命中 +20；
 * score ≥ 50 且为唯一最高分 → 命中（并列取 stepIndex 更小者）。
 * 只检查失败步骤之后的 5 个步骤（窗口），避免误匹配已过页面。
 */

export interface RecoveryPoint {
  /** 展开后步骤数组中的下标（命中后从这里续跑） */
  stepIndex: number;
  /** 步骤声明的期望 URL（goto.url / wait.urlPattern / assert.urlPattern） */
  urlPattern?: string;
  /** 步骤操作的目标元素（click/fill/select/extract/hover 的 selector） */
  selector?: Selector;
  /** assert 的 textContains */
  assertText?: string;
  /** 匹配强度（预计算时给基础分，匹配时动态计算） */
  score: number;
  /** 来源步骤名（日志用） */
  stepName: string;
}

/** 从步骤提取恢复点特征（静态分析，无页面依赖） */
function extractFromStep(step: Step, stepIndex: number): RecoveryPoint | null {
  const base = { stepIndex, score: 0, stepName: step.name };
  switch (step.action) {
    case 'goto':
      // goto 的 url 是"将要打开的地址"——特征即 URL
      return { ...base, urlPattern: step.url };
    case 'wait':
      return step.urlPattern
        ? { ...base, urlPattern: step.urlPattern }
        : step.selector
          ? { ...base, selector: step.selector }
          : null;
    case 'assert':
      return {
        ...base,
        urlPattern: step.urlPattern,
        selector: step.selector,
        assertText: step.textContains,
        // assert 特征最少也要 URL 或文本之一，否则无法匹配
        score: step.urlPattern || step.textContains ? 0 : -1,
      };
    case 'click':
    case 'fill':
    case 'select':
    case 'check':
    case 'hover':
    case 'extract':
      return { ...base, selector: step.selector };
    default:
      return null; // press/scroll/download/screenshot/loop 特征弱，不作为恢复点
  }
}

/** 候选窗口：失败步骤之后的 5 个步骤 */
const WINDOW = 5;

/**
 * 预计算候选恢复点（失败后调用一次）。
 * @param playbook 展开后的 Playbook
 * @param failedIndex 失败步骤下标
 */
export function buildRecoveryPoints(playbook: Playbook, failedIndex: number): RecoveryPoint[] {
  const points: RecoveryPoint[] = [];
  const end = Math.min(failedIndex + WINDOW, playbook.steps.length);
  for (let i = failedIndex + 1; i < end; i++) {
    const p = extractFromStep(playbook.steps[i], i);
    if (p && p.score >= 0) points.push(p);
  }
  return points;
}

export interface MatchContext {
  url: string;
  /** 感知器采集的元素集合（复用，零额外采集） */
  elements: Array<{ tag: string; name?: string; text?: string; placeholder?: string; href?: string }>;
  bodyText: string;
}

/** 从 PageSnapshot 构造匹配上下文 */
export function matchContextOf(snap: PageSnapshot): MatchContext {
  return { url: snap.url, elements: snap.elements, bodyText: snap.bodyText };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** selector 与页面元素集的宽松匹配（改版后类名/结构可能变，用语义特征） */
function selectorMatches(selector: Selector, ctx: MatchContext): boolean {
  for (const el of ctx.elements) {
    // text 匹配（最可靠的语义特征）
    if (selector.text) {
      const t = el.text ?? el.name ?? '';
      if (t && t.includes(selector.text)) return true;
      if (ctx.bodyText.includes(selector.text) && (el.tag === 'button' || el.tag === 'a')) {
        // 文本在页面上且存在可交互载体
        if (t.includes(selector.text)) return true;
      }
    }
    if (selector.css && el.tag) {
      // css 取 id/class 语义段做弱匹配（#price → 元素 name/id 语义）
      const idOrClass = selector.css.replace(/^[.#]/, '').split(/[.\s>#:\[]/)[0];
      if (idOrClass && (el.name?.includes(idOrClass) || el.placeholder?.includes(idOrClass))) return true;
    }
    if (selector.role && el.tag === selector.role) return true;
    if (selector.label && (el.name === selector.label || el.placeholder === selector.label)) return true;
  }
  return false;
}

/** URL 匹配：把步骤声明的 url/pattern 当子串或正则用（容忍相对/绝对差异） */
function urlMatches(pattern: string, currentUrl: string): boolean {
  const p = pattern.trim();
  // ${...} 插值未解析的（预计算阶段没跑上下文）——退化成路径段匹配
  const resolved = p.replace(/\$\{[^}]+\}/g, '[^/]+');
  try {
    return new RegExp(escapeRegExp(resolved).replace(/\\\$\{[^}]*\}/g, '.+')).test(currentUrl)
      || currentUrl.includes(p);
  } catch {
    return currentUrl.includes(p);
  }
}

export interface MatchResult {
  hit: RecoveryPoint | null;
  /** 各候选打分明细（调试用） */
  scores: Array<{ stepIndex: number; stepName: string; score: number }>;
}

/**
 * 恢复点匹配（每轮 Agent 动作后执行，预算 500ms）。
 * 复用感知器已采集的数据，纯计算无 IO。
 */
export function checkRecovery(
  points: RecoveryPoint[],
  ctx: MatchContext,
): MatchResult {
  const scores = points.map((p) => {
    let score = 0;
    if (p.urlPattern && urlMatches(p.urlPattern, ctx.url)) score += 30;
    if (p.selector && selectorMatches(p.selector, ctx)) score += 50;
    if (p.assertText && ctx.bodyText.includes(p.assertText)) {
      // 唯一特征时文本命中即完整匹配（否则 assert-only 步骤永远 <50）
      score += p.urlPattern || p.selector ? 20 : 50;
    }
    return { stepIndex: p.stepIndex, stepName: p.stepName, score };
  });

  // score ≥ 50 的最高分；并列取 stepIndex 更小者
  const eligible = scores.filter((s) => s.score >= 50);
  if (eligible.length === 0) return { hit: null, scores };
  const best = eligible.reduce((a, b) => (b.score > a.score || (b.score === a.score && b.stepIndex < a.stepIndex) ? b : a));
  // 找回完整 RecoveryPoint
  const hit = points.find((p) => p.stepIndex === best.stepIndex) ?? null;
  return { hit, scores };
}

/** 便捷入口：从页面实时采集做一次匹配（不依赖外部快照时用） */
export async function checkRecoveryFromPage(
  points: RecoveryPoint[],
  page: Page,
): Promise<MatchResult> {
  const [url, bodyText] = await Promise.all([
    page.url(),
    page.evaluate(() => (document.body?.innerText ?? '').slice(0, 1500)),
  ]);
  return checkRecovery(points, { url, elements: [], bodyText });
}
