import { Command } from 'commander';
import { relative } from 'node:path';
import { loadPlaybook, summarize, countSteps } from '../playbook/loader.js';

export const validateCmd = new Command('validate')
  .description('校验 Playbook YAML（Schema + include + 插值），并打印流程摘要')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .option('--json', '输出 JSON 格式结果（供 CI 使用）')
  .action(async (file: string, opts: { json?: boolean }) => {
    const result = loadPlaybook(file);

    if (opts.json) {
      console.log(JSON.stringify({
        ok: result.ok,
        errors: result.errors,
        playbook: result.ok ? { name: result.playbook!.name, steps: countSteps(result.playbook!.steps) } : undefined,
      }, null, 2));
      process.exit(result.ok ? 0 : 1);
    }

    if (!result.ok) {
      console.error(`✗ 校验失败：${relative(process.cwd(), file)}\n`);
      for (const err of result.errors) {
        const loc = err.line ? `第 ${err.line} 行` : err.path || '(未知位置)';
        console.error(`  [${loc}] ${err.message}`);
        if (err.hint) console.error(`      提示: ${err.hint}`);
      }
      process.exit(1);
    }

    const pb = result.playbook!;
    console.log(`✓ 校验通过：${pb.name}`);
    if (pb.description) console.log(`  ${pb.description}`);
    if (pb.include?.length) console.log(`  include: ${pb.include.join(', ')}`);
    console.log(`  步骤总数: ${countSteps(pb.steps)}（展开后）\n`);
    for (const line of summarize(pb)) console.log(`  ${line}`);
  });
