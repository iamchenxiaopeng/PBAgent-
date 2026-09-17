import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Playbook, Step } from '../playbook/schema.js';
import type { AgentResult, AgentStep } from '../agent/loop.js';
import { selectorFromElement } from './distill.js';
import { playbookToYaml } from './versioning.js';
import { chat, extractJson, type LlmConfig } from '../agent/llm.js';

/**
 * F-10：独立蒸馏（从零创建 Playbook，不依赖已有 Playbook）。
 *
 * 与 `distillFromTakeover` 的区别：
 *   - 后者是「原位替换」已有 Playbook 的失败步骤，必须先有 Playbook（on-failure 档）
 *   - 本模块是「从 Agent 成功轨迹生成全新 Playbook」（on-success 档），
 *     产物自带 meta.baseUrl / allowDomains / 起始 goto / 成功断言，可直接独立执行
 *
 * 成功断言（安全补丁）：末尾追加 assert 步骤，记录本次跑通的终态 URL path。
 * 下次执行若终态不符 → assert 失败 → Playbook 整体失败 → 已有机制自动回退 Agent 兜底。
 * 这把「意图误命中 → 静默执行错流程」变成「误命中 → 断言失败 → 兜底」。
 */

export interface DraftOptions {
  /** 用户任务描述（用作生成描述与参数化分析的依据） */
  task: string;
  /** 任务起始 URL（写成 meta.baseUrl，并在首步 goto） */
  url: string;
  /** 自定义流程名（缺省自动生成） */
  name?: string;
  runId?: string;
  /** LLM 请求级覆盖（Web 端用户自带 key） */
  llmOverrides?: Partial<LlmConfig>;
}

export interface DraftResult {
  playbook: Playbook;
  /** 写盘路径 */
  file: string;
  /** 蒸馏出的业务步骤数（不含首尾 goto/assert） */
  stepCount: number;
  /** 是否追加了成功断言 */
  assertAdded: boolean;
  /** 参数化后的 params 键 */
  paramKeys: string[];
}

/** 任务描述 → 文件名友好的 slug（中文 fallback 到 hash） */
function slugify(task: string, host: string): string {
  const hostPart = host.replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'site';
  const ascii = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join('-');
  const base = ascii || `t${Date.now().toString(36).slice(-5)}`;
  return `auto-${hostPart}-${base}`.slice(0, 48);
}

/** URL → origin + host（失败返回 null） */
function parseUrl(url: string): { origin: string; host: string; path: string } | null {
  try {
    const u = new URL(url);
    return { origin: u.origin, host: u.hostname, path: u.pathname };
  } catch {
    return null;
  }
}

/** 单个 Agent 动作 → 草稿步骤（保留 goto；跳过密码框/drag/press/wait） */
function draftAction(step: AgentStep): Step | null {
  if (!step.ok || !step.target) {
    // goto 没有 target，单独处理
    const act = step.action;
    if (step.ok && act.action === 'goto') {
      return { action: 'goto', name: '打开页面', url: act.url };
    }
    return null;
  }
  const act = step.action;
  // 密码框：原位替换模式（distill.ts）会直接跳过——那里登录由 include 子流程 + session 复用负责。
  // 但从零创建（draft）没有任何登录流程承载，不填密码根本登不进去（实测第二次执行必失败）。
  // 所以这里保留步骤，值走 ${env.*} 插值——既可执行，又不把明文写进 Playbook（playbooks/ 是入库的）。
  if (act.action === 'fill' && step.target.type === 'password') {
    return {
      action: 'fill',
      name: '填密码（环境变量注入，不明文落库）',
      selector: selectorFromElement(step.target),
      value: '${env.DEMO_PASSWORD}',
    };
  }
  // drag 是反爬对抗动作，不是业务流程
  if (act.action === 'drag') return null;

  if (act.action === 'click') {
    return {
      action: 'click',
      name: `点击${step.target.text ? `「${step.target.text.slice(0, 12)}」` : '元素'}`,
      selector: selectorFromElement(step.target),
      ...(step.sawDialog ? { dialog: 'accept' as const } : {}),
    };
  }
  if (act.action === 'fill') {
    return {
      action: 'fill',
      name: `填${step.target.name ? step.target.name.slice(0, 12) : step.target.placeholder ?? '值'}`,
      selector: selectorFromElement(step.target),
      value: act.value,
    };
  }
  if (act.action === 'goto') {
    return { action: 'goto', name: '打开页面', url: act.url };
  }
  return null; // press/wait 不单独沉淀
}

/**
 * 参数化分析（一次 LLM 调用，同时产出描述 + 哪些 fill 值该变成参数）。
 * LLM 不可用/解析失败 → 降级：描述取前 3 步名，不做参数化（值写死）。
 */
async function analyze(
  task: string,
  steps: Step[],
  overrides?: Partial<LlmConfig>,
): Promise<{ description: string; paramMap: Array<{ index: number; name: string }> }> {
  const fallback = {
    description: steps.slice(0, 3).map((s) => s.name).join(' → ') || '自动沉淀流程',
    paramMap: [] as Array<{ index: number; name: string }>,
  };
  const fillList = steps
    .map((s, i) => (s.action === 'fill' ? `${i}: ${s.name} = ${String(s.value ?? '')}` : null))
    .filter(Boolean)
    .join('\n');
  if (!fillList) {
    // 没有 fill 步骤 → 只需描述
    return fallback;
  }
  const prompt = `用户任务：${task}

自动沉淀出的步骤里有以下填值动作：
${fillList}

判断哪些填的是"每次运行时会变的具体数值"（如商品价格、数量、搜索关键词、日期），
这些应参数化；哪些是固定不变的流程内容（如固定分类、固定选项），不应参数化。
参数名要语义化（英文小写，如 price / qty / keyword），不要用 value1 这种无意义名字。

同时为这个流程写一句中文功能描述（不超过 30 字）。

只输出 JSON：
{"description":"...","params":[{"index":<步骤下标数字>,"name":"<语义化参数名>"}]}`;
  try {
    const raw = await chat(
      [
        { role: 'system', content: '你是流程分析器，只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      // maxTokens 是 reasoning + content 的**总**上限。思考型模型（deepseek-flash）实测
      // reasoning 可达 1300+ tokens，给 300 会 finish_reason=length、content 被推理吃光 → 空输出。
      // 留 2000 给推理（#29 的同款坑，本调用不走 decideAction 的重试阶梯，必须一次给够）
      { maxTokens: 2000, overrides, jsonMode: true },
    );
    const parsed = extractJson<{
      description?: string;
      params?: Array<{ index?: number; name?: string }>;
    }>(raw.text);
    return {
      description: parsed.description?.trim().slice(0, 60) || fallback.description,
      paramMap: (parsed.params ?? [])
        .filter((p) => typeof p.index === 'number' && p.name && steps[p.index!]?.action === 'fill')
        .map((p) => ({ index: p.index as number, name: String(p.name) })),
    };
  } catch {
    return fallback;
  }
}

/**
 * Agent 成功轨迹 → 全新 Playbook（未写盘）。
 * 结构：goto 起始页 → 业务步骤 → 成功断言（终态 URL path，仅当发生过跳转时追加）
 */
export async function distillToNewPlaybook(
  agent: AgentResult,
  options: DraftOptions,
): Promise<DraftResult> {
  const parsed = parseUrl(options.url);
  if (!parsed) throw new Error(`非法起始 URL: ${options.url}`);

  const business: Step[] = [];
  for (const s of agent.steps) {
    const step = draftAction(s);
    if (step) business.push(step);
  }
  if (business.length === 0) {
    throw new Error('轨迹无可沉淀步骤（纯 press/wait/凭证类）');
  }

  // 首步：若轨迹没有 goto，补一个打开起始页
  const hasGoto = business[0]?.action === 'goto';
  const head: Step[] = hasGoto ? [] : [{ action: 'goto', name: '打开起始页', url: options.url }];

  // 参数化：把"每次会变的值"替换成 ${params.<语义化名>}
  const { description, paramMap } = await analyze(options.task, business, options.llmOverrides);
  const paramKeys: string[] = [];
  const paramSteps = business.map((s, i) => {
    const p = paramMap.find((x) => x.index === i);
    if (s.action === 'fill' && p) {
      paramKeys.push(p.name);
      return { ...s, value: `\${params.${p.name}}` };
    }
    return s;
  });

  // 成功断言：终态 URL path（仅在发生过跳转时追加，避免无意义断言）
  const finalUrl = [...agent.steps].reverse().find((s) => s.afterUrl)?.afterUrl ?? '';
  const finalParsed = parseUrl(finalUrl);
  const assertAdded = Boolean(
    finalParsed && finalParsed.host === parsed.host && finalParsed.path !== parsed.path,
  );
  const tail: Step[] = assertAdded
    ? [
        {
          action: 'assert',
          name: '成功断言（终态校验，失败则回退 Agent）',
          urlPattern: finalParsed!.path,
          timeout: 5000,
        } as Step,
      ]
    : [];

  const name = options.name ?? slugify(options.task, parsed.host);
  const playbook: Playbook = {
    version: 1,
    name,
    description: `${description}（自动沉淀，待人工确认）`,
    meta: {
      baseUrl: parsed.origin,
      allowDomains: [parsed.host],
      sensitive: ['password'],
    },
    steps: [...head, ...paramSteps, ...tail],
  };

  return {
    playbook,
    file: `${name}.yaml`,
    stepCount: paramSteps.length,
    assertAdded,
    paramKeys,
  };
}

/** 草稿写盘到 playbooks/ 主目录（立即可被意图层检索到；文件名冲突自动加序号） */
export function saveDraftPlaybook(
  playbooksDir: string,
  draft: DraftResult,
  ctx: { runId?: string; reason: string },
): { file: string; name: string } {
  if (!existsSync(playbooksDir)) mkdirSync(playbooksDir, { recursive: true });
  let name = draft.playbook.name;
  let file = join(playbooksDir, `${name}.yaml`);
  let n = 2;
  while (existsSync(file)) {
    name = `${draft.playbook.name}-${n++}`;
    file = join(playbooksDir, `${name}.yaml`);
  }
  // 文件名与 name 必须同步：否则重名时 listCandidates 会返回两条同名候选，
  // LLM 选择时无法区分（实测同任务连续沉淀两次就撞了）
  const playbook = name === draft.playbook.name ? draft.playbook : { ...draft.playbook, name };
  const header = `自动沉淀自 Agent 成功轨迹（${ctx.reason}）${ctx.runId ? ` runId=${ctx.runId}` : ''} · ${new Date().toISOString()}`;
  writeFileSync(file, playbookToYaml(playbook, header), 'utf-8');
  return { file, name };
}
