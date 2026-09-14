import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import yaml from 'js-yaml';
import { PlaybookSchema, type Playbook, type Step } from '../playbook/schema.js';
import { loadPlaybook } from '../playbook/loader.js';
import { chat, extractJson, getLlmConfig, type LlmConfig } from '../agent/llm.js';

/**
 * Playbook 智能路由（Web 端自然语言 → 已沉淀流程的自动检索）。
 *
 * 候选来源：playbooks/ 下的主文件（含 .versions/ 版本链里 promote 过的版本）。
 * 匹配策略分两层：
 *   1. 域名硬过滤——任务起始 URL 的 host 必须命中 Playbook 的 meta.allowDomains
 *   2. LLM 语义选择——把候选清单（name + description）给 LLM 挑最匹配的或判无
 *
 * 预留扩展：候选量大时（>200）在域名过滤后接入向量召回再 LLM 精排，
 * 接口不变（selectPlaybook），调用方无感。
 */

export interface PlaybookCandidate {
  /** 主文件路径 */
  file: string;
  name: string;
  description: string;
  /** 允许的域名（meta.allowDomains） */
  allowDomains: string[];
  /** 步骤数 */
  stepCount: number;
  /** 版本链当前版本（有 .versions/ 时） */
  currentVersion?: number;
  /** 声明的参数（步骤里 ${params.x} 引用的变量名；命中后前端要用户提供值） */
  params: string[];
}

export interface SelectResult {
  /** 命中的 Playbook（null = 无匹配，走 Agent 模式） */
  playbook: Playbook | null;
  candidate: PlaybookCandidate | null;
  /** LLM 给出的选择理由（提示用户时展示） */
  reason: string;
  /** 候选数量（域名过滤后） */
  candidateCount: number;
  /** 本次选择的 LLM 成本信息 */
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface SelectOptions {
  /** LLM 请求级覆盖（Web 端用户自带 key） */
  llmOverrides?: Partial<LlmConfig>;
}

/** 从起始 URL 提取 host */
const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/** 扫描 playbooks/ 目录构建候选清单（读取失败的单个文件跳过，不影响整体） */
export function listCandidates(playbooksDir: string): PlaybookCandidate[] {
  if (!existsSync(playbooksDir)) return [];
  const candidates: PlaybookCandidate[] = [];

  for (const entry of readdirSync(playbooksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = join(playbooksDir, entry.name);

    let pb: Playbook | null = null;
    // 优先走完整加载（include 展开 + 校验）；失败退化裸 YAML（只取描述性字段）
    try {
      const r = loadPlaybook(file);
      if (r.ok && r.playbook) pb = r.playbook;
    } catch { /* fallthrough */ }
    if (!pb) {
      try {
        const doc = yaml.load(readFileSync(file, 'utf-8')) as Record<string, unknown>;
        const parsed = PlaybookSchema.safeParse(doc);
        if (parsed.success) pb = parsed.data;
      } catch { /* skip */ }
    }
    if (!pb) continue;

    // 版本链当前版本
    let currentVersion: number | undefined;
    const vDir = join(dirname(resolve(file)), '.versions', basename(file).replace(/\.ya?ml$/, ''));
    if (existsSync(join(vDir, 'meta.json'))) {
      try {
        currentVersion = (JSON.parse(readFileSync(join(vDir, 'meta.json'), 'utf-8')) as { current: number }).current;
      } catch { /* 忽略 */ }
    }

    candidates.push({
      file,
      name: pb.name,
      description: pb.description ?? '',
      allowDomains: pb.meta?.allowDomains ?? [],
      stepCount: pb.steps.length,
      currentVersion,
      params: collectParams(pb.steps),
    });
  }
  return candidates;
}

/** 递归收集步骤里引用的 ${params.x} 变量名（loop 嵌套展开） */
function collectParams(steps: Step[]): string[] {
  const found = new Set<string>();
  const walk = (list: Step[]): void => {
    for (const s of list) {
      const refs = JSON.stringify(s).match(/\$\{params\.(\w+)\}/g) ?? [];
      for (const r of refs) {
        // "${params.username}" → "username"
        found.add(r.replace(/^\$\{params\./, '').replace(/\}$/, ''));
      }
      if (s.action === 'loop') walk(s.steps);
    }
  };
  walk(steps);
  return [...found];
}

const SELECT_PROMPT = `你是一个流程匹配器。用户给了一个浏览器任务和起始 URL，从候选 Playbook 清单里选出最匹配的一个。

## 用户任务
{TASK}

## 用户起始 URL
{URL}

## 候选 Playbook 清单
{CANDIDATES}

## 判断规则
1. Playbook 的功能要能覆盖用户任务的核心意图（同域名 + 同类操作）
2. 用户任务里的具体参数（商品号、价格等）不影响匹配——Playbook 用 ${'{params.*}'} 接收参数
3. 只有当某个候选确实能完成用户任务时才选它；都不合适就选 none

只输出一个 JSON：
{"selected":"<Playbook 的 name>" 或 "none","reason":"<一句话理由>"}`;

/**
 * 自然语言任务 → 已沉淀 Playbook 的智能路由。
 * 域名硬过滤 → 候选为空/单候选直接返回 → 多候选 LLM 选择。
 */
export async function selectPlaybook(
  task: string,
  url: string,
  playbooksDir: string,
  options: SelectOptions = {},
): Promise<SelectResult> {
  const all = listCandidates(playbooksDir);
  const host = hostOf(url);

  // 域名硬过滤：起始 URL 的 host 必须在 Playbook 的允许域内
  const filtered = host
    ? all.filter((c) =>
        c.allowDomains.length === 0
          ? false // 未声明 allowDomains 的不参与自动匹配（防跨站误跑）
          : c.allowDomains.some((d) => host === d || host.endsWith(`.${d}`)),
      )
    : [];

  const empty: SelectResult = { playbook: null, candidate: null, reason: '', candidateCount: filtered.length };

  if (filtered.length === 0) {
    return { ...empty, reason: '当前域名下没有已沉淀的流程' };
  }
  if (filtered.length === 1) {
    // 单候选：直接命中（不花 LLM 的钱）
    const c = filtered[0];
    const pb = loadCandidate(c.file);
    return { playbook: pb, candidate: c, reason: `当前域名下唯一已沉淀流程：${c.name}`, candidateCount: 1 };
  }

  // 多候选：LLM 从清单里选
  const candidatesText = filtered
    .map((c, i) => `${i + 1}. name: ${c.name}\n   description: ${c.description || '（无描述）'}\n   steps: ${c.stepCount}`)
    .join('\n');

  const prompt = SELECT_PROMPT.replace('{TASK}', task).replace('{URL}', url).replace('{CANDIDATES}', candidatesText);
  try {
    const raw = await chat(
      [
        { role: 'system', content: '你是流程匹配器，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 300, overrides: options.llmOverrides },
    );
    const picked = extractJson<{ selected: string; reason: string }>(raw.text);
    if (picked.selected === 'none' || !picked.selected) {
      return { ...empty, reason: picked.reason || '无匹配的沉淀流程' };
    }
    const hit = filtered.find((c) => c.name === picked.selected);
    if (!hit) {
      return { ...empty, reason: `LLM 选择的 ${picked.selected} 不在候选内（忽略）` };
    }
    return {
      playbook: loadCandidate(hit.file),
      candidate: hit,
      reason: picked.reason,
      candidateCount: filtered.length,
      usage: raw.usage,
    };
  } catch (e) {
    // LLM 失败不阻断——退化为无匹配走 Agent 模式
    return { ...empty, reason: `流程匹配调用失败（${(e as Error).message.slice(0, 80)}），降级 Agent 模式` };
  }
}

/** 加载候选的 Playbook（加载失败返回 null——调用方按未命中处理） */
function loadCandidate(file: string): Playbook | null {
  try {
    const r = loadPlaybook(file);
    if (r.ok && r.playbook) return r.playbook;
  } catch { /* fallthrough */ }
  try {
    const doc = yaml.load(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const parsed = PlaybookSchema.safeParse(doc);
    if (parsed.success) return parsed.data;
  } catch { /* skip */ }
  return null;
}

/** 沉淀时生成一句话功能描述（写入 Playbook description 字段） */
export async function generateDescription(
  playbookName: string,
  steps: Array<{ action: string; name: string }>,
  llmOverrides?: Partial<LlmConfig>,
): Promise<string> {
  const stepsText = steps.map((s, i) => `${i + 1}. [${s.action}] ${s.name}`).join('\n');
  try {
    const raw = await chat(
      [
        { role: 'system', content: '你为自动化流程写一句话功能描述，中文，不超过 40 字，直接输出描述文本。' },
        { role: 'user', content: `流程名：${playbookName}\n步骤：\n${stepsText}` },
      ],
      { maxTokens: 120, overrides: llmOverrides },
    );
    return raw.text.trim().replace(/^["「]|["」]$/g, '').slice(0, 60);
  } catch {
    return steps.slice(0, 3).map((s) => s.name).join(' → ');
  }
}

/** 当前 LLM 配置是否可用（Web 端判断能不能做智能路由） */
export function llmReady(): boolean {
  try {
    getLlmConfig();
    return true;
  } catch {
    return false;
  }
}
