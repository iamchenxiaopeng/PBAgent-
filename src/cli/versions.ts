import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  versionsDir,
  readMeta,
  listVersions,
  promoteVersion,
  rollbackVersion,
} from '../learner/versioning.js';

/**
 * 版本管理 CLI（DESIGN §7.2 / F-06）：
 *   pbagent versions <playbook.yaml>            # 查看版本链
 *   pbagent promote <playbook.yaml> --to 2      # 沉淀版本生效
 *   pbagent rollback <playbook.yaml> --to 1     # 回滚到旧版
 */

const showable = (file: string): string => relative(process.cwd(), file);

export const versionsCmd = new Command('versions')
  .description('查看 Playbook 版本链（当前生效版本 + 沉淀历史）')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .action((file: string) => {
    const { current, versions } = listVersions(file);
    const dir = versionsDir(file);
    const meta = readMeta(dir);
    console.log(`▶ ${showable(file)} 版本链（目录 ${showable(dir)}）`);
    for (const v of versions) {
      const mark = v === current ? '← 当前生效' : '';
      console.log(`  v${v} ${mark}`);
    }
    if (meta.history.length > 0) {
      console.log('\n历史：');
      for (const h of [...meta.history].reverse().slice(0, 10)) {
        const run = h.runId ? ` runId=${h.runId}` : '';
        console.log(`  v${h.v} · ${h.date.slice(0, 19).replace('T', ' ')} · ${h.reason}${run}`);
      }
    } else {
      console.log('\n（尚无沉淀历史）');
    }
  });

export const promoteCmd = new Command('promote')
  .description('沉淀版本生效：把 .versions/<name>/vN.yaml 替换为主文件')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .option('--to <version>', '目标版本号（如 2 表示 v2）', (v) => Number(v))
  .action((file: string, opts: { to?: number }) => {
    if (!opts.to || opts.to < 1) {
      console.error('✗ 需要指定 --to <版本号>，如 --to 2');
      process.exit(2);
    }
    try {
      const { promotedTo } = promoteVersion(file, opts.to);
      console.log(`✓ v${promotedTo} 已生效（主文件已替换）：${showable(file)}`);
      console.log(`  回滚：pbagent rollback ${showable(file)} --to ${promotedTo - 1}`);
    } catch (e) {
      console.error(`✗ promote 失败: ${(e as Error).message}`);
      process.exit(1);
    }
  });

export const rollbackCmd = new Command('rollback')
  .description('回滚 Playbook 到旧版本（把 vN.yaml 拷回主文件）')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .option('--to <version>', '目标版本号（如 1 表示 v1）', (v) => Number(v))
  .action((file: string, opts: { to?: number }) => {
    if (!opts.to || opts.to < 1) {
      console.error('✗ 需要指定 --to <版本号>，如 --to 1');
      process.exit(2);
    }
    try {
      const { rolledBackTo } = rollbackVersion(file, opts.to);
      console.log(`✓ 已回滚到 v${rolledBackTo}（主文件已替换）：${showable(file)}`);
    } catch (e) {
      console.error(`✗ rollback 失败: ${(e as Error).message}`);
      process.exit(1);
    }
  });

/** diff 查看：读 .versions/<name>/vN.diff.md 直接输出 */
export const diffCmd = new Command('diff')
  .description('查看沉淀版本的步骤级 diff（.versions/<name>/vN.diff.md）')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .option('--to <version>', '版本号（如 2 表示 v2 的 diff）', (v) => Number(v))
  .action((file: string, opts: { to?: number }) => {
    const { versions } = listVersions(file);
    const target = opts.to ?? Math.max(...versions);
    try {
      const content = readFileSync(`${versionsDir(file)}/v${target}.diff.md`, 'utf-8');
      console.log(content);
    } catch {
      console.error(`✗ v${target} 的 diff 不存在（${showable(versionsDir(file))}/v${target}.diff.md）`);
      process.exit(1);
    }
  });
