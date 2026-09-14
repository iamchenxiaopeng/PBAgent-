import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { PlaybookSchema, type Playbook } from '../playbook/schema.js';
import { loadPlaybook } from '../playbook/loader.js';
import { diffPlaybooks, renderDiffMarkdown } from './differ.js';

/**
 * Playbook 版本链管理（DESIGN §7.2 / F-06）：
 *
 * playbooks/
 *   reprice.yaml              ← 当前生效版本
 *   .versions/
 *     reprice/
 *       v1.yaml               # 原版存档
 *       v2.yaml               # 沉淀版（草稿，未 promote 不生效）
 *       v2.diff.md            # 人可读 diff
 *       meta.json             # {current, history[]}
 *
 * 沉淀流程：saveLearnedVersion（写 v(n+1).yaml + diff + meta 更新，不动主文件）
 * → promote（确认后替换主文件，meta.current 前进）
 * → rollback（把旧版拷回主文件，meta.current 回退）
 */

export interface VersionMeta {
  current: number;
  history: Array<{ v: number; runId?: string; date: string; reason: string }>;
}

/** 沉淀时的上下文信息 */
export interface LearnContext {
  runId?: string;
  reason: string;
}

/** 主 Playbook 文件对应的版本目录（<dir>/.versions/<name>/） */
export function versionsDir(mainFile: string): string {
  return join(dirname(resolve(mainFile)), '.versions', basename(mainFile).replace(/\.ya?ml$/, ''));
}

/** 读 meta.json（不存在返回初始态：v1 即当前） */
export function readMeta(versionsDir: string): VersionMeta {
  const file = join(versionsDir, 'meta.json');
  if (!existsSync(file)) return { current: 1, history: [] };
  return JSON.parse(readFileSync(file, 'utf-8')) as VersionMeta;
}

function writeMeta(versionsDir: string, meta: VersionMeta): void {
  mkdirSync(versionsDir, { recursive: true });
  writeFileSync(join(versionsDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
}

/** Playbook → YAML 文本（注释头标注来源） */
export function playbookToYaml(pb: Playbook, header?: string): string {
  const body = yaml.dump(pb, {
    lineWidth: 120,
    noRefs: true,
    quotingType: "'",
  });
  return header ? `# ${header}\n${body}` : body;
}

/**
 * 沉淀新版本（不动主文件！默认不生效，等 promote 确认）：
 * 1. 当前主文件内容存档为 v1（首次沉淀时）
 * 2. 新版本写 v(n+1).yaml
 * 3. 生成 v(n+1).diff.md（与当前版本的步骤级 diff）
 * 4. meta.history 追加记录
 */
export function saveLearnedVersion(
  mainFile: string,
  learned: Playbook,
  ctx: LearnContext,
): { newVersion: number; versionFile: string; diffFile: string } {
  const dir = versionsDir(mainFile);
  mkdirSync(dir, { recursive: true });
  const meta = readMeta(dir);

  // 当前生效版（= meta.current）没有存档时先补存档
  const currentFile = join(dir, `v${meta.current}.yaml`);
  if (!existsSync(currentFile)) {
    copyFileSync(mainFile, currentFile);
  }

  const newV = nextVersionNumber(dir);
  const versionFile = join(dir, `v${newV}.yaml`);
  const diffFile = join(dir, `v${newV}.diff.md`);

  // diff 基准：当前生效的版本（主文件内容）
  const currentPb = loadPlaybookForDiff(mainFile);
  writeFileSync(versionFile, playbookToYaml(learned, `v${newV} — 沉淀自 Agent 兜底轨迹（${ctx.reason}）${ctx.runId ? ` runId=${ctx.runId}` : ''}`), 'utf-8');
  const diff = diffPlaybooks(currentPb, learned);
  writeFileSync(diffFile, renderDiffMarkdown(diff, `v${meta.current}(当前)`, `v${newV}(沉淀)`), 'utf-8');

  meta.history.push({ v: newV, runId: ctx.runId, date: new Date().toISOString(), reason: ctx.reason });
  writeMeta(dir, meta);
  return { newVersion: newV, versionFile, diffFile };
}

/** 版本目录里下一个可用版本号（max+1；不复用空档） */
function nextVersionNumber(dir: string): number {
  if (!existsSync(dir)) return 2; // 首次沉淀：当前是 v1，新版本 v2
  const vs = readdirSync(dir)
    .map((f) => /^v(\d+)\.yaml$/.exec(f)?.[1])
    .filter(Boolean)
    .map(Number);
  return vs.length === 0 ? 2 : Math.max(...vs) + 1;
}

/** diff 基准加载（容错：主文件损坏时退化为空 steps 对比） */
function loadPlaybookForDiff(file: string): Playbook {
  try {
    const r = loadPlaybook(file);
    if (r.ok && r.playbook) return r.playbook;
  } catch { /* fallthrough */ }
  // 兜底：直接 YAML 解析（不做 include 展开——diff 只看步骤序列）
  try {
    const doc = yaml.load(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    const parsed = PlaybookSchema.safeParse(doc);
    if (parsed.success) return parsed.data;
  } catch { /* fallthrough */ }
  throw new Error(`无法加载当前版本 Playbook: ${file}`);
}

/** promote：沉淀版本生效（把 vN.yaml 拷贝到主文件，meta.current 前进） */
export function promoteVersion(mainFile: string, toVersion: number): { promotedTo: number } {
  const dir = versionsDir(mainFile);
  const versionFile = join(dir, `v${toVersion}.yaml`);
  if (!existsSync(versionFile)) {
    throw new Error(`版本 v${toVersion} 不存在（${versionFile}）`);
  }
  // 校验目标版本合法（防手写 YAML 错误传播到主文件）
  const r = loadPlaybook(versionFile);
  if (!r.ok) {
    throw new Error(`v${toVersion} 校验失败: ${r.errors[0]?.message}`);
  }
  const meta = readMeta(dir);
  copyFileSync(versionFile, mainFile);
  meta.current = toVersion;
  meta.history.push({ v: toVersion, date: new Date().toISOString(), reason: 'promote' });
  writeMeta(dir, meta);
  return { promotedTo: toVersion };
}

/** rollback：回退到旧版本（把 vN.yaml 拷回主文件，meta.current 回退） */
export function rollbackVersion(mainFile: string, toVersion: number): { rolledBackTo: number } {
  const dir = versionsDir(mainFile);
  const meta = readMeta(dir);
  if (toVersion >= meta.current) {
    throw new Error(`回退目标 v${toVersion} 不早于当前版本 v${meta.current}`);
  }
  const versionFile = join(dir, `v${toVersion}.yaml`);
  if (!existsSync(versionFile)) {
    throw new Error(`版本 v${toVersion} 不存在（${versionFile}）`);
  }
  copyFileSync(versionFile, mainFile);
  meta.current = toVersion;
  meta.history.push({ v: toVersion, date: new Date().toISOString(), reason: 'rollback' });
  writeMeta(dir, meta);
  return { rolledBackTo: toVersion };
}

/** 版本链清单（CLI 列表用） */
export function listVersions(mainFile: string): { current: number; versions: number[] } {
  const dir = versionsDir(mainFile);
  const meta = readMeta(dir);
  const versions = existsSync(dir)
    ? readdirSync(dir)
        .map((f) => /^v(\d+)\.yaml$/.exec(f)?.[1])
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b)
    : [];
  // 主文件存在但从未沉淀过：当前就是 v1（无 .versions 目录）
  return { current: meta.current, versions: versions.length > 0 ? versions : [1] };
}
