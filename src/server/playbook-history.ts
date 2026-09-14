import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';

/**
 * 沉淀闭环历史（读取 playbooks/ 下的版本链目录）。
 * 数据源是 .versions/<name>/{v*.yaml, v*.diff.md, meta.json}——本来就永久落盘，
 * 这里只做读取聚合，不改变任何持久化语义。
 */

export interface VersionInfo {
  v: number;
  /** 沉淀/操作记录（来自 meta.history） */
  runId?: string;
  date: string;
  reason: string;
  /** 当前生效版本 */
  isCurrent: boolean;
  /** 是否已 promote 过（草稿 = 从未成为 current） */
  everPromoted: boolean;
}

export interface PlaybookVersions {
  /** Playbook 名称（主文件名去后缀） */
  name: string;
  /** 主文件路径 */
  mainFile: string;
  /** 当前生效版本号 */
  current: number;
  versions: VersionInfo[];
  /** 步骤数（主文件） */
  stepCount: number;
}

/** 扫描 playbooks/（含 .versions/）返回所有有版本链的 Playbook */
export function listAllPlaybookVersions(playbooksDir: string): PlaybookVersions[] {
  if (!existsSync(playbooksDir)) return [];
  const result: PlaybookVersions[] = [];

  for (const entry of readdirSync(playbooksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const mainFile = join(playbooksDir, entry.name);
    const dir = join(dirname(resolve(mainFile)), '.versions', basename(mainFile).replace(/\.ya?ml$/, ''));

    if (!existsSync(dir)) continue; // 从未沉淀过的 Playbook 不展示

    // meta
    let meta = { current: 1, history: [] as Array<{ v: number; runId?: string; date: string; reason: string }> };
    try {
      meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    } catch { /* meta 损坏用默认 */ }

    // 版本文件
    const vs = readdirSync(dir)
      .map((f) => /^v(\d+)\.yaml$/.exec(f)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    if (vs.length === 0) continue;

    // 哪些版本当过 current（按时间序：promote/rollback 记录）
    const everCurrent = new Set<number>([1]);
    for (const h of meta.history) {
      if (h.reason === 'promote' || h.reason === 'rollback') everCurrent.add(h.v);
    }

    // 每个版本取它最新的一条沉淀记录（同版本可能沉淀后又 promote，取最晚）
    const versions: VersionInfo[] = vs.map((v) => {
      const recs = meta.history.filter((h) => h.v === v);
      const latest = recs[recs.length - 1];
      return {
        v,
        runId: latest?.runId,
        date: latest?.date ?? '',
        reason: latest?.reason ?? '初始版本',
        isCurrent: v === meta.current,
        everPromoted: everCurrent.has(v),
      };
    });

    // 主文件步骤数（容错）
    let stepCount = 0;
    try {
      const text = readFileSync(mainFile, 'utf-8');
      stepCount = (text.match(/^\s+- action:/gm) || []).length;
    } catch { /* 忽略 */ }

    result.push({ name: basename(mainFile).replace(/\.ya?ml$/, ''), mainFile, current: meta.current, versions, stepCount });
  }
  return result;
}

/** 读某个版本的 diff 内容（无 diff 文件返回 null） */
export function readVersionDiff(playbooksDir: string, name: string, v: number): string | null {
  const diffFile = join(playbooksDir, '.versions', name, `v${v}.diff.md`);
  if (!existsSync(diffFile)) return null;
  return readFileSync(diffFile, 'utf-8');
}
