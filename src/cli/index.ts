import { Command } from 'commander';
import { validateCmd } from './validate.js';
import { runCmd } from './run.js';
import { authCmd } from './auth.js';
import { chatCmd } from './chat.js';
import { versionsCmd, promoteCmd, rollbackCmd, diffCmd } from './versions.js';

const program = new Command();

program
  .name('pbagent')
  .description('Playbook + LLM 混合式浏览器操作 Agent')
  .version('0.1.0');

program.addCommand(validateCmd);
program.addCommand(runCmd);
program.addCommand(authCmd);
program.addCommand(chatCmd);
program.addCommand(versionsCmd);
program.addCommand(promoteCmd);
program.addCommand(rollbackCmd);
program.addCommand(diffCmd);

/** 演示站点：本地 Express test-site（含改版模拟/踢下线等测试设施） */
program
  .command('dev:site')
  .description('启动演示站点（test-site，端口 3456）')
  .action(async () => {
    // test-site 在 rootDir 之外，用相对 cwd 的动态路径（tsx 运行时加载）
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'test-site/server.ts'], {
      stdio: 'inherit',
    });
    p.on('exit', (code) => process.exit(code ?? 0));
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
