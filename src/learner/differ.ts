import type { Playbook, Step } from '../playbook/schema.js';

/**
 * Playbook 步骤级 diff（DESIGN §7.2）。
 * 粒度是步骤（不是行级 YAML diff），标注 + 新增 / ~ 替换(原 stepId) / - 删除。
 * 对齐算法：LCS（最长公共子序列）——与 git 语义一致的直觉：公共部分不动，差异最小化。
 */

export type DiffOp =
  | { op: 'same'; oldIndex: number; step: Step }
  | { op: 'replace'; oldIndex: number; from: Step; to: Step }
  | { op: 'add'; step: Step }
  | { op: 'remove'; oldIndex: number; step: Step };

export interface PlaybookDiff {
  ops: DiffOp[];
  /** 统计摘要 */
  stats: { same: number; replaced: number; added: number; removed: number };
}

/** 两步骤是否"相同"（action + 关键字段一致即视为同一步） */
function stepEquals(a: Step, b: Step): boolean {
  if (a.action !== b.action) return false;
  if (a.name !== b.name) return false;
  return JSON.stringify(withoutNoise(a)) === JSON.stringify(withoutNoise(b));
}

/** 去掉 timeout/id/screenshot 等噪音字段后再比较 */
function withoutNoise(s: Step): Step {
  const { timeout: _t, id: _i, screenshot: _s, ...rest } = s as Step & Record<string, unknown>;
  return rest as Step;
}

/** LCS 步骤对齐（O(n·m)，Playbook 规模下毫无压力） */
function alignSteps(oldSteps: Step[], newSteps: Step[]): DiffOp[] {
  const n = oldSteps.length;
  const m = newSteps.length;
  // dp[i][j] = oldSteps[i:] 与 newSteps[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = stepEquals(oldSteps[i], newSteps[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // 回溯生成 diff ops
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (stepEquals(oldSteps[i], newSteps[j])) {
      ops.push({ op: 'same', oldIndex: i, step: newSteps[j] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 老的先删（可能被新的替换——后面看是否有 add 配对）
      if (j < m && stepEquals(oldSteps[i + 1] ?? EMPTY, newSteps[j]) === false && m > j + 1 && dp[i][j + 1] > dp[i + 1][j]) {
        ops.push({ op: 'add', step: newSteps[j] });
        j++;
      } else if (stepEquals(oldSteps[i], newSteps[j + 1] ?? EMPTY)) {
        ops.push({ op: 'remove', oldIndex: i, step: oldSteps[i] });
        i++;
      } else {
        ops.push({ op: 'replace', oldIndex: i, from: oldSteps[i], to: newSteps[j] });
        i++; j++;
      }
    } else {
      if (stepEquals(oldSteps[i], newSteps[j + 1] ?? EMPTY)) {
        ops.push({ op: 'add', step: newSteps[j] });
        j++;
      } else {
        ops.push({ op: 'replace', oldIndex: i, from: oldSteps[i], to: newSteps[j] });
        i++; j++;
      }
    }
  }
  while (i < n) { ops.push({ op: 'remove', oldIndex: i, step: oldSteps[i] }); i++; }
  while (j < m) { ops.push({ op: 'add', step: newSteps[j] }); j++; }
  return ops;
}

const EMPTY = { action: 'wait', name: '', ms: 1 } as unknown as Step;

/** 入口：两版 Playbook → diff ops + 统计 */
export function diffPlaybooks(oldPb: Playbook, newPb: Playbook): PlaybookDiff {
  const ops = alignSteps(oldPb.steps, newPb.steps);
  const stats = { same: 0, replaced: 0, added: 0, removed: 0 };
  for (const op of ops) {
    if (op.op === 'same') stats.same++;
    else if (op.op === 'replace') stats.replaced++;
    else if (op.op === 'add') stats.added++;
    else stats.removed++;
  }
  return { ops, stats };
}

/** diff → 人可读 Markdown（v2.diff.md 内容） */
export function renderDiffMarkdown(diff: PlaybookDiff, oldVersion: string, newVersion: string): string {
  const lines: string[] = [
    `# Playbook Diff：${oldVersion} → ${newVersion}`,
    '',
    `步骤级对比：${diff.stats.same} 保持 / ${diff.stats.replaced} 替换 / ${diff.stats.added} 新增 / ${diff.stats.removed} 删除`,
    '',
  ];
  const brief = (s: Step): string => {
    const sel = 'selector' in s && s.selector
      ? ` · ${s.selector.css ?? s.selector.text ?? s.selector.label ?? '?'}`
      : '';
    const val = 'value' in s && s.value ? ` = ${s.value}` : '';
    const url = 'url' in s && s.url ? ` · ${s.url}` : '';
    const dlg = 'dialog' in s && s.dialog ? ` · 弹窗:${s.dialog}` : '';
    return `[${s.action}] ${s.name}${sel}${val}${url}${dlg}`;
  };
  diff.ops.forEach((op, idx) => {
    const no = String(idx + 1).padStart(2, '0');
    if (op.op === 'same') {
      lines.push(`${no}.   ${brief(op.step)}`);
    } else if (op.op === 'replace') {
      lines.push(`${no}. ~ **替换**（原步骤 ${op.oldIndex + 1}）`);
      lines.push(`       - 旧: ${brief(op.from)}`);
      lines.push(`       + 新: ${brief(op.to)}`);
    } else if (op.op === 'add') {
      lines.push(`${no}. + **新增** ${brief(op.step)}`);
    } else {
      lines.push(`${no}. - **删除**（原步骤 ${op.oldIndex + 1}）${brief(op.step)}`);
    }
  });
  return lines.join('\n');
}
