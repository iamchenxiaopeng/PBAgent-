import { listCandidates, type PlaybookCandidate } from './select.js';
import { chat, extractJson, type LlmConfig } from '../agent/llm.js';

/**
 * 意图解析层（intent 路由模式）。
 *
 * 与 selectPlaybook 的区别：
 *   - selectPlaybook：只「选流程」，且单候选时跳过 LLM（deterministic 模式）
 *   - parseIntent：**每次必调 LLM**，一次调用同时完成
 *       ① 选流程 ② 从自然语言提取参数 ③ 给出置信度
 *
 * 为什么单候选也必须解析（这是本模块存在的理由）：
 *   候选数量只影响解析成本，不影响是否需要语义理解。
 *   例：只有一条「改单个商品价格」的 Playbook，用户说「把三个商品价格都改成 188」，
 *   deterministic 模式会直接命中并只改一个；intent 模式能识别出参数规模不匹配 →
 *   confidence 低 → 走 Agent。
 *
 * 安全：confidence < 阈值时判为未命中（走 Agent 兜底）。
 * 因为本模式是「先判断再执行」，误判会静默执行错流程——宁可多花一次 Agent 的钱。
 */

/** 置信度阈值：低于此值判为未命中，走 Agent */
export const CONFIDENCE_THRESHOLD = 0.7;

export interface IntentResult {
  /** 是否命中（已过置信度阈值） */
  matched: boolean;
  /** 命中的 Playbook 文件路径（未命中为 null） */
  playbookFile: string | null;
  playbookName: string | null;
  /** 从自然语言提取的参数（未命中为空对象） */
  params: Record<string, unknown>;
  /** LLM 自评置信度 0~1 */
  confidence: number;
  reason: string;
  candidateCount: number;
  /** 是否命中缓存（true = 本次零 LLM 调用） */
  fromCache: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface IntentOptions {
  llmOverrides?: Partial<LlmConfig>;
  /** 是否启用缓存（默认 true） */
  cache?: boolean;
}

const INTENT_PROMPT = `你是浏览器任务意图解析器。用户用自然语言描述了一个任务，你要判断候选 Playbook 里有没有能直接完成它的流程，并把任务里的具体值提取成参数。

## 用户任务
{TASK}

## 起始 URL
{URL}

## 候选 Playbook 清单
{CANDIDATES}

## 判断规则
1. 流程的核心意图必须匹配，**且能力范围要覆盖用户任务**：
   - 任务要处理 3 个商品，而流程只能处理 1 个 → 不匹配
   - 任务要删除，而流程只能编辑 → 不匹配
2. 参数提取：流程声明了 params，就从任务里提取对应值；任务里没提到则留空字符串
3. 置信度自评：
   - 0.9+ 意图与能力完全吻合，参数齐备
   - 0.7~0.9 基本吻合，但有一处不确定（如参数需猜测）
   - <0.7 只有部分吻合、能力不匹配、或关键参数缺失
4. 都不合适就选 none

只输出 JSON：
{"selected":"<Playbook 的 name>" 或 "none","params":{"<参数名>":"<值>"},"confidence":<0~1 的数字>,"reason":"<一句话理由>"}`;

/** 缓存：key = host + 归一化任务；FIFO 淘汰 */
const cache = new Map<string, IntentResult>();
const CACHE_LIMIT = 200;

/** 任务描述归一化（去空白差异；不改变语义大小写不敏感） */
function normalizeTask(task: string): string {
  return task.trim().replace(/\s+/g, ' ').toLowerCase();
}

function cacheKey(task: string, url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = url;
  }
  return `${host}::${normalizeTask(task)}`;
}

function getCached(task: string, url: string): IntentResult | null {
  const hit = cache.get(cacheKey(task, url));
  return hit ? { ...hit, fromCache: true, usage: undefined } : null;
}

function setCached(task: string, url: string, result: IntentResult): void {
  if (cache.size >= CACHE_LIMIT) {
    // FIFO：淘汰最早写入的一条
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(cacheKey(task, url), { ...result, fromCache: false });
}

/** 清空缓存（测试用 / 用户手动刷新） */
export function clearIntentCache(): void {
  cache.clear();
}

/** 候选清单文本（带上 params 声明，供 LLM 提取参数） */
function renderCandidates(list: PlaybookCandidate[]): string {
  return list
    .map((c, i) => {
      const params = c.params.length > 0 ? `\n   params: ${c.params.join(', ')}` : '\n   params: （无）';
      return `${i + 1}. name: ${c.name}\n   description: ${c.description || '（无描述）'}\n   steps: ${c.stepCount}${params}`;
    })
    .join('\n');
}

/** 空结果构造 */
const miss = (reason: string, count: number, confidence = 0): IntentResult => ({
  matched: false,
  playbookFile: null,
  playbookName: null,
  params: {},
  confidence,
  reason,
  candidateCount: count,
  fromCache: false,
});

/**
 * 自然语言任务 → {流程, 参数, 置信度}。
 * 域名硬过滤 → 缓存命中直接返回 → 无候选直接未命中 → LLM 解析（含置信度判定）。
 */
export async function parseIntent(
  task: string,
  url: string,
  playbooksDir: string,
  options: IntentOptions = {},
): Promise<IntentResult> {
  const useCache = options.cache !== false;
  if (useCache) {
    const cached = getCached(task, url);
    if (cached) return cached;
  }

  const all = listCandidates(playbooksDir);
  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    return miss(`非法起始 URL: ${url}`, 0);
  }

  const filtered = host
    ? all.filter((c) =>
        c.allowDomains.length === 0
          ? false
          : c.allowDomains.some((d) => host === d || host.endsWith(`.${d}`)),
      )
    : [];

  if (filtered.length === 0) {
    const r = miss('当前域名下没有已沉淀的流程', 0);
    if (useCache) setCached(task, url, r);
    return r;
  }

  const prompt = INTENT_PROMPT.replace('{TASK}', task)
    .replace('{URL}', url)
    .replace('{CANDIDATES}', renderCandidates(filtered));

  let result: IntentResult;
  try {
    const raw = await chat(
      [
        { role: 'system', content: '你是意图解析器，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      // 同 draft.ts：思考型模型要留足 reasoning 预算，否则 content 被推理吃光导致解析失败
      { maxTokens: 2000, overrides: options.llmOverrides, jsonMode: true },
    );
    const picked = extractJson<{
      selected?: string;
      params?: Record<string, unknown>;
      confidence?: number;
      reason?: string;
    }>(raw.text);

    const confidence = typeof picked.confidence === 'number' ? Math.max(0, Math.min(1, picked.confidence)) : 0;
    const hit = picked.selected && picked.selected !== 'none' ? filtered.find((c) => c.name === picked.selected) : undefined;

    if (!hit) {
      result = miss(picked.reason || '无匹配的沉淀流程', filtered.length, confidence);
    } else if (confidence < CONFIDENCE_THRESHOLD) {
      // 置信度不足：宁可走 Agent，不冒险执行
      result = miss(
        `匹配置信度 ${confidence.toFixed(2)} 低于阈值 ${CONFIDENCE_THRESHOLD}（${picked.reason ?? ''}）→ 走 Agent 兜底`,
        filtered.length,
        confidence,
      );
    } else {
      result = {
        matched: true,
        playbookFile: hit.file,
        playbookName: hit.name,
        params: picked.params ?? {},
        confidence,
        reason: picked.reason ?? '',
        candidateCount: filtered.length,
        fromCache: false,
        usage: raw.usage,
      };
    }
  } catch (e) {
    // LLM 失败不阻断——退化为未命中走 Agent
    result = miss(`意图解析调用失败（${(e as Error).message.slice(0, 80)}），降级 Agent 模式`, filtered.length);
  }

  if (useCache) setCached(task, url, result);
  return result;
}
