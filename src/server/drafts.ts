import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import yaml from 'js-yaml';
import { loadPlaybook } from '../playbook/loader.js';
import type { Playbook, Step } from '../playbook/schema.js';
import { listAllPlaybookVersions, type VersionInfo } from './playbook-history.js';

/**
 * 沉淀库（Web 控制台「沉淀列表」数据源）。
 *
 * 与 playbook-history.ts 的区别：
 *   - playbook-history 只列出**有过版本链**（.versions/ 存在）的 Playbook
 *   - 本模块列出 playbooks/ 下**所有** Playbook，包括 F-10 自动沉淀出来的全新草稿
 *     （自动草稿没有版本链，但已经能被意图层检索命中，必须能在界面上看见、可删）
 *
 * 只读为主，唯一写操作是删除（用户显式触发）。
 */

export interface StepDetail {
  index: number;
  action: string;
  name: string;
  /** goto.url / assert.urlPattern / wait.urlPattern */
  url?: string;
  /** 选择器摘要（css > text > label > role > xpath） */
  selector?: string;
  /** fill/select 的填值（可能是 ${params.x} 插值原文） */
  value?: string;
  /** 其他动作的关键字段（press.key / extract.into / wait.ms …） */
  extra?: string;
  timeout?: number;
}

export interface DistilledItem {
  /** Playbook 名（= 文件名去后缀） */
  name: string;
  /** 主文件绝对路径 */
  file: string;
  description: string;
  stepCount: number;
  /** 步骤里引用的 ${params.*} 参数名（去重） */
  params: string[];
  baseUrl: string;
  allowDomains: string[];
  /** 文件修改时间（ISO）——自动沉淀 ≈ 沉淀时间 */
  updatedAt: string;
  /** auto = Agent 轨迹自动沉淀；manual = 手写/人工确认过的 */
  origin: 'auto' | 'manual';
  /** 版本链里的版本数（0 = 纯草稿，从未沉淀过新版本） */
  versionCount: number;
  currentVersion: number;
  /** Schema + 插值校验是否通过（不通过的流程执行时会直接报错） */
  valid: boolean;
  error?: string;
}

export interface DistilledDetail extends DistilledItem {
  steps: StepDetail[];
  /** 原始 YAML（前端「查看源码」用） */
  yaml: string;
  /** 版本链（可能为空） */
  versions: VersionInfo[];
}

/** 名称白名单（防路径穿越：只允许 playbooks/ 内的单级文件名） */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** 选择 playbooks/ 下某个 Playbook 的主文件（.yaml 优先，其次 .yml）；不存在返回 null */
function mainFileOf(playbooksDir: string, name: string): string | null {
  for (const ext of ['.yaml', '.yml']) {
    const p = join(playbooksDir, `${name}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 从步骤树里抽出 ${params.xxx} 的参数名（去重、保序） */
function collectParams(steps: Step[]): string[] {
  const out = new Set<string>();
  const re = /\$\{params\.(\w+)\}/g;
  const walk = (list: Step[]): void => {
    for (const s of list) {
      const serialized = JSON.stringify(s);
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(serialized)) !== null) out.add(m[1]);
      if (s.action === 'loop') walk(s.steps);
    }
  };
  walk(steps);
  return [...out];
}

/** 选择器 → 一行字符串摘要 */
function selectorBrief(sel?: {
  css?: string; xpath?: string; text?: string; role?: string; label?: string; nth?: number;
}): string | undefined {
  if (!sel) return undefined;
  const s = sel.css ?? sel.text ?? sel.label ?? sel.role ?? sel.xpath;
  if (!s) return undefined;
  return sel.nth !== undefined ? `${s}[${sel.nth}]` : s;
}

/** 步骤 → 明细（前端只渲染这几个字段，其余折进 extra） */
function toStepDetail(s: Step, i: number): StepDetail {
  const d: StepDetail = { index: i + 1, action: s.action, name: s.name, timeout: s.timeout };
  switch (s.action) {
    case 'goto':
      d.url = s.url;
      break;
    case 'click':
      d.selector = selectorBrief(s.selector);
      if (s.dialog) d.extra = `dialog=${s.dialog}`;
      break;
    case 'fill':
    case 'select':
      d.selector = selectorBrief(s.selector);
      d.value = String(s.value);
      break;
    case 'check':
      d.selector = selectorBrief(s.selector);
      d.extra = `checked=${s.checked}`;
      break;
    case 'hover':
      d.selector = selectorBrief(s.selector);
      break;
    case 'press':
      d.extra = s.key;
      break;
    case 'wait':
      d.url = s.urlPattern;
      d.extra = s.ms ? `${s.ms}ms` : selectorBrief(s.selector);
      break;
    case 'extract':
      d.selector = selectorBrief(s.selector);
      d.extra = `${s.attr} → ctx.${s.into}`;
      break;
    case 'scroll':
      d.extra = s.to;
      break;
    case 'download':
      d.extra = s.saveTo;
      break;
    case 'screenshot':
      d.extra = s.saveTo ?? (s.fullPage ? 'full page' : 'viewport');
      break;
    case 'assert':
      d.url = s.urlPattern;
      d.selector = selectorBrief(s.selector);
      d.extra = s.textContains ?? s.textAbsent;
      break;
    case 'loop':
      d.extra = `over ${s.over} as ${s.var}（${s.steps.length} 子步骤）`;
      break;
  }
  return d;
}

/** 解析单个 Playbook 文件 → 明细结构（校验失败也尽量给出可看的信息） */
function readOne(file: string): {
  item: Omit<DistilledItem, 'versionCount' | 'currentVersion'>;
  steps: StepDetail[];
  yamlText: string;
  pb?: Playbook;
} {
  const name = basename(file).replace(/\.ya?ml$/, '');
  const yamlText = readFileSync(file, 'utf-8');
  const r = loadPlaybook(resolve(file));
  let pb: Playbook | undefined;
  let steps: Step[] = [];
  let error: string | undefined;
  if (r.ok && r.playbook) {
    pb = r.playbook;
    steps = pb.steps;
  } else {
    error = r.errors[0]?.message ?? 'Playbook 校验失败';
    // 降级：直接读原始 YAML，尽量把步骤显示出来（坏流程也要能看、能删）
    try {
      const doc = yaml.load(yamlText) as { steps?: Step[] };
      if (Array.isArray(doc?.steps)) steps = doc.steps;
    } catch { /* 连 YAML 都坏了：步骤为空，保留错误信息 */ }
  }
  const origin: 'auto' | 'manual' =
    /^auto-/.test(name) || yamlText.includes('自动沉淀自') ? 'auto' : 'manual';
  const updatedAt = (() => {
    try {
      return new Date(statSync(file).mtimeMs).toISOString();
    } catch {
      return '';
    }
  })();
  return {
    item: {
      name,
      file: resolve(file),
      description: pb?.description ?? '',
      stepCount: steps.length,
      params: collectParams(steps),
      baseUrl: pb?.meta?.baseUrl ?? '',
      allowDomains: pb?.meta?.allowDomains ?? [],
      updatedAt,
      origin,
      valid: Boolean(r.ok),
      ...(error ? { error } : {}),
    },
    steps: steps.map(toStepDetail),
    yamlText,
    pb,
  };
}

/** 列出 playbooks/ 下所有 Playbook（按修改时间倒序） */
export function listDistilled(playbooksDir: string): DistilledItem[] {
  if (!existsSync(playbooksDir)) return [];
  const chains = new Map(listAllPlaybookVersions(playbooksDir).map((p) => [p.name, p]));
  const items: DistilledItem[] = [];
  for (const entry of readdirSync(playbooksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const file = join(playbooksDir, entry.name);
    try {
      const { item } = readOne(file);
      const chain = chains.get(item.name);
      items.push({
        ...item,
        versionCount: chain?.versions.length ?? 0,
        currentVersion: chain?.current ?? 1,
      });
    } catch {
      // 单个文件损坏不影响列表（界面上会少一条，但不会整个 500）
    }
  }
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** 读单个 Playbook 明细（含步骤 / 原始 YAML / 版本链）；不存在返回 null */
export function readDistilled(playbooksDir: string, name: string): DistilledDetail | null {
  if (!SAFE_NAME.test(name) || name.startsWith('.')) return null;
  const file = mainFileOf(playbooksDir, name);
  if (!file) return null;
  const { item, steps, yamlText } = readOne(file);
  const chain = listAllPlaybookVersions(playbooksDir).find((p) => p.name === name);
  return {
    ...item,
    versionCount: chain?.versions.length ?? 0,
    currentVersion: chain?.current ?? 1,
    steps,
    yaml: yamlText,
    versions: chain?.versions ?? [],
  };
}

export interface DeleteResult {
  removed: string[];
  /** 想删但没找到的（幂等：已删过） */
  missing: boolean;
}

/**
 * 删除沉淀：主文件 + 可选的版本链目录（默认一起删，避免残留孤儿版本）。
 * 只删 playbooks/ 内的文件，名字经过白名单 + 路径前缀双重校验。
 */
export function deleteDistilled(
  playbooksDir: string,
  name: string,
  withVersions = true,
): DeleteResult {
  if (!SAFE_NAME.test(name) || name.startsWith('.')) {
    throw new Error(`非法 Playbook 名: ${name}`);
  }
  const root = resolve(playbooksDir);
  const file = mainFileOf(playbooksDir, name);
  if (!file) return { removed: [], missing: true };
  if (resolve(file) !== join(root, basename(file))) {
    throw new Error('越权路径');
  }
  const removed: string[] = [];
  unlinkSync(file);
  removed.push(basename(file));
  if (withVersions) {
    const vDir = join(root, '.versions', name);
    if (existsSync(vDir)) {
      rmSync(vDir, { recursive: true, force: true });
      removed.push(`.versions/${name}/`);
    }
  }
  return { removed, missing: false };
}
