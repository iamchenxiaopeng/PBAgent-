import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 配置加载：.env（项目根）+ 环境变量（优先）。
 * .env 不存在时只依赖环境变量（CI 场景）。
 */
function loadEnvFile(): void {
  const file = join(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value; // 环境变量优先
  }
}
loadEnvFile();

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LlmConfigError extends Error {
  constructor(missing: string) {
    super(`LLM 配置缺失：${missing}（在 .env 或环境变量中提供）`);
    this.name = 'LlmConfigError';
  }
}

export function getLlmConfig(): LlmConfig {
  const baseUrl = process.env.PBA_LLM_BASE_URL;
  const apiKey = process.env.PBA_LLM_API_KEY;
  const model = process.env.PBA_LLM_MODEL;
  if (!baseUrl) throw new LlmConfigError('PBA_LLM_BASE_URL');
  if (!apiKey) throw new LlmConfigError('PBA_LLM_API_KEY');
  if (!model) throw new LlmConfigError('PBA_LLM_MODEL');
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey, model };
}

/** 消息类型（OpenAI 兼容多模态） */
export type MessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 请求超时 ms（默认 120s——思考型模型截图推理较慢） */
  timeoutMs?: number;
  /**
   * 强制 JSON 输出（`response_format: {type:'json_object'}`）——决策类调用务必开启：
   * 部分模型（如 DeepSeek 思考模式）会输出 DSML 工具调用标记而非纯 JSON。
   * 若网关不支持该字段（400），chat() 会自动去掉后重试一次。
   */
  jsonMode?: boolean;
  /** 请求级配置覆盖（Web 端用户自带 key；不落盘、不污染环境变量） */
  overrides?: Partial<LlmConfig>;
}

export class LlmError extends Error {
  /**
   * @param retryable 是否值得重试（网络/超时/空输出/5xx/429 可重试；400/401/403 重试无意义）
   * @param usage 失败调用已消耗的 tokens（网关对 finish_reason=length 的截断输出照样计费，
   *              不记账会让成本统计失真——失败越多次，漏记越多）
   */
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
    public readonly usage?: ChatResult['usage'],
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 单次调用的用量与文本 */
export interface ChatResult {
  text: string;
  /** OpenAI 兼容 usage（tokens；网关不返回时缺省） */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** 调用 LLM（OpenAI 兼容 chat/completions），返回 assistant 文本 + usage */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
  const cfg = { ...getLlmConfig(), ...options.overrides };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);
  try {
    // jsonMode 不被网关支持时（400）自动降级为普通请求重试一次
    const send = (jsonMode: boolean): Promise<Response> =>
      fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: options.temperature ?? 0.1, // 决策场景要稳定
          max_tokens: options.maxTokens ?? 2000,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

    let resp = await send(Boolean(options.jsonMode));
    if (!resp.ok && options.jsonMode && resp.status === 400) resp = await send(false);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      // 429/5xx 值得重试（网关抖动）；4xx 参数/鉴权类重试无意义，直接抛
      const retryable = resp.status === 429 || resp.status >= 500;
      throw new LlmError(`LLM 请求失败 ${resp.status}: ${body.slice(0, 200)}`, resp.status, retryable);
    }
    const data = (await resp.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const message = data.choices?.[0]?.message;
    const content = message?.content;

    // 空 content（含纯空白）是可重试的偶发故障，且必须带诊断信息：
    // 思考型模型（如 deepseek-flash，带 reasoning_content）可能把 max_tokens 烧在推理上，
    // 导致 finish_reason=length 而 content 为空——此时加大 max_tokens 重试即可恢复。
    if (typeof content !== 'string' || content.trim() === '') {
      const finish = data.choices?.[0]?.finish_reason ?? 'unknown';
      const out = data.usage?.completion_tokens ?? 0;
      const reasoningLen = message?.reasoning_content?.length ?? 0;
      throw new LlmError(
        `LLM 返回空 content（finish_reason=${finish}，completion_tokens=${out}，reasoning长度=${reasoningLen}）`,
        undefined,
        true, // 可重试
        data.usage, // 截断的输出已计费，必须记账
      );
    }
    return { text: content, usage: data.usage };
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if ((e as Error).name === 'AbortError') throw new LlmError('LLM 请求超时', undefined, true);
    throw new LlmError(`LLM 请求异常: ${(e as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 模型单价表（USD / 1M tokens；config 可更新——未知模型不计价，只计 tokens）
 *
 * 口径：官方 CNY 价 ÷ 汇率换算，取「空闲时段 + 缓存未命中」（PBAgent 每轮都带新截图，
 * 输入基本走未命中档）。高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00）价格翻倍，
 * 缓存命中档极低（Flash 命中仅 0.02 元/M，≈未命中的 1/50），故实际花费通常低于本估值。
 *
 * deepseek 官方价（api-docs.deepseek.com/zh-cn/quick_start/pricing，2026-09-14 核对）：
 *   flash：输入 命中 0.02 / 未命中 1 元，输出 4 元（每百万，空闲时段）
 *   pro  ：输入 命中 0.15 / 未命中 4.5 元，输出 13.5 元
 * 汇率：USD/CNY 6.7698（2026-09-14 中国货币网中间价）
 */
const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  'qwen3.8-max': { in: 1.6, out: 6.4 },
  'qwen3.7-plus': { in: 0.8, out: 2 },
  'glm-5.2': { in: 1.1, out: 4.3 },
  // 官方推荐名（V4.1-Flash）；旧名 deepseek-v4-flash 是别名，同模型同价
  'deepseek-flash': { in: 0.148, out: 0.591 },
  'deepseek-v4-flash': { in: 0.148, out: 0.591 },
  'deepseek-v4-pro': { in: 0.665, out: 1.994 },
};

/** LLM 成本累计器（一次运行的生命周期内使用） */
export class CostTracker {
  calls = 0;
  tokensIn = 0;
  tokensOut = 0;

  add(usage: ChatResult['usage']): void {
    this.calls++;
    if (!usage) return;
    this.tokensIn += usage.prompt_tokens ?? 0;
    this.tokensOut += usage.completion_tokens ?? 0;
  }

  /** 折算 USD（未知模型返回 null——只报 tokens 不报价） */
  usd(model: string): number | null {
    const price = MODEL_PRICES[model];
    if (!price) return null;
    return (this.tokensIn * price.in + this.tokensOut * price.out) / 1_000_000;
  }

  /** run.json 的 cost 字段结构（DESIGN §10.2） */
  toJSON(model: string): {
    llmCalls: number; tokensIn: number; tokensOut: number;
    usd: number | null; model: string;
  } {
    return {
      llmCalls: this.calls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      usd: this.usd(model),
      model,
    };
  }
}

/** DSML 里需要转成数字的字段（工具调用标记里值一律带 string 标志，需还原类型） */
const DSML_NUMERIC_KEYS = new Set(['ref', 'ms']);

/**
 * 解析 DSML 工具调用格式（DeepSeek 思考模式偶发输出，而非纯 JSON）：
 *   <｜DSML｜invoke name="click">
 *   <｜DSML｜parameter name="ref" string="true">12</｜DSML｜parameter>
 * 分隔符是全角字符，故按 "含 DSML 的尖括号标签" 宽松匹配，不写死具体符号。
 * 返回 null 表示不是 DSML 格式（交给原 JSON 解析逻辑）。
 */
function parseDsml(raw: string): Record<string, unknown> | null {
  // 注意：parameter/invoke 都在尖括号标签内部（<｜DSML｜invoke name="x">），不是标签后的文本
  const invoke = /<[^>]*DSML[^>]*\binvoke\s+name="([^"]+)"/.exec(raw);
  if (!invoke) return null;
  const out: Record<string, unknown> = { action: invoke[1] };
  const paramRe =
    /<[^>]*DSML[^>]*\bparameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*\s*parameter\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(raw)) !== null) {
    const [, name, value] = m;
    if (DSML_NUMERIC_KEYS.has(name)) {
      const n = Number(value.trim());
      if (Number.isFinite(n)) out[name] = n;
    } else {
      out[name] = value.trim();
    }
  }
  return Object.keys(out).length > 1 ? out : null; // 只有 action 没有参数 = 解析失败
}

/** 从模型输出中提取 JSON（容忍 ```json 围栏、前后噪声、多个 JSON 连排、DSML 工具调用标记） */
export function extractJson<T>(raw: string): T {
  // 0. DSML 工具调用格式（DeepSeek 偶发）：优先按其结构还原
  const dsml = parseDsml(raw);
  if (dsml) return dsml as T;

  let text = raw.trim();
  // 去 markdown 围栏
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    // 括号配对提取首个完整 JSON 对象（模型偶尔连排输出多个对象时只取第一个）
    const start = text.indexOf('{');
    if (start < 0) throw new LlmError(`无法从模型输出解析 JSON: ${raw.slice(0, 200)}`);
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          return JSON.parse(text.slice(start, i + 1)) as T;
        }
      }
    }
    throw new LlmError(`模型输出 JSON 不完整: ${raw.slice(0, 200)}`);
  }
}
