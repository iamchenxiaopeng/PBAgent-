import { Command } from 'commander';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runAgent, type AgentResult } from '../agent/loop.js';
import { getLlmConfig, LlmConfigError } from '../agent/llm.js';
import { normalizeDomain } from '../credentials/store.js';
import { withCredentials, loadSession, saveSession } from '../credentials/session.js';

/**
 * pbagent chat "自然语言任务" --url <起始URL> [--auth <domain>] [--headed] [--max-steps 15]
 * STATE B 入口：LLM Agent 全程自主探索页面完成任务。
 * --auth domain：自动加载存储凭证与 session（登录类任务推荐）。
 */

const timestamp = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

/** Agent 轨迹报告（Markdown，供人工回放审计） */
function writeAgentReport(runDir: string, task: string, result: AgentResult): string {
  const lines: string[] = [
    `# Agent 运行报告`,
    ``,
    `- **任务**: ${task}`,
    `- **结果**: ${result.success ? '✅ 完成' : '❌ 未完成'}`,
    `- **总结**: ${result.summary}`,
    `- **步数**: ${result.steps.length}（LLM 调用 ${result.llmCalls} 次）`,
    `- **耗时**: ${(result.totalMs / 1000).toFixed(1)}s`,
    ...(result.cost ? [
      `- **LLM 成本**: ${result.cost.tokensIn}+${result.cost.tokensOut} tokens（${result.cost.usd !== null ? `$${result.cost.usd.toFixed(4)}` : '未知单价'}，${result.cost.model}）`,
    ] : []),
    ``,
    `## 轨迹`,
    ``,
  ];
  for (const s of result.steps) {
    const a = s.action;
    const detail = 'ref' in a ? `ref=${a.ref}` : 'url' in a ? a.url : 'key' in a ? a.key : 'ms' in a ? `${a.ms}ms` : a.summary;
    const valueInfo = 'value' in a ? ` value="${a.value}"` : '';
    lines.push(`### ${s.step}. [${a.action}] ${s.ok ? '✅' : '❌'}`);
    lines.push(`- 页面: \`${s.url}\``);
    lines.push(`- 动作: \`${a.action} ${detail}${valueInfo}\``);
    lines.push(`- 理由: ${a.reason}`);
    if (s.error) lines.push(`- 错误: ${s.error}`);
    if (s.afterUrl) lines.push(`- 动作后: \`${s.afterUrl}\``);
    lines.push(`- 耗时: 感知 ${s.perceptionMs}ms + 决策 ${s.llmMs}ms + 执行 ${s.execMs}ms`);
    lines.push('');
  }
  const path = join(runDir, 'agent-report.md');
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return path;
}

export const chatCmd = new Command('chat')
  .description('自然语言任务：LLM Agent 自主探索页面并完成（STATE B）')
  .argument('<task>', '任务描述（自然语言），如 "登录后给 S001 改价 188"')
  .requiredOption('--url <url>', '起始页面 URL')
  .option('--auth <domain>', '凭证/session 归属域名（自动加载登录态）')
  .option('--headed', '有头模式（观看 Agent 操作）')
  .option('--max-steps <n>', '步数上限（默认 15）', '15')
  .action(async (task: string, opts: { url: string; auth?: string; headed?: boolean; maxSteps?: string }) => {
    // 1. LLM 配置预检（fail fast，不浪费浏览器启动）
    try {
      const cfg = getLlmConfig();
      console.log(`◆ LLM: ${cfg.model} @ ${cfg.baseUrl}`);
    } catch (e) {
      console.error(`✗ ${(e as LlmConfigError).message}`);
      process.exit(2);
    }

    const authDomain = opts.auth ? normalizeDomain(opts.auth) : undefined;
    const maxSteps = Number(opts.maxSteps) || 15;

    // 2. 凭证注入：把存储凭证的关键信息并入任务描述（Agent 需要知道账号密码才能填表单）
    let taskFull = task;
    let injectedEnv: Record<string, string> = {};
    if (authDomain) {
      const { params: _p, env } = withCredentials({}, authDomain);
      injectedEnv = env;
      const creds = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      if (creds.length > 0) {
        // 账号类字段直接给 Agent（它要填进表单）；密码也必须给（登录表单要填）
        taskFull = `${task}（登录凭证：${creds.join(' ')}）`;
      }
    }

    // 3. session：有则复用（Agent 起手就是登录态）
    const sessionFile = authDomain ? loadSession(authDomain) : undefined;
    if (authDomain) {
      console.log(`  session: ${sessionFile ? '复用已有登录态' : '无（Agent 将自行登录）'}`);
    }

    // 4. 运行目录 + 浏览器
    const runDir = join('runs', `${timestamp()}_chat`);
    mkdirSync(runDir, { recursive: true });
    console.log(`▶ Agent 任务：${task}`);
    console.log(`  起始: ${opts.url} | 步数上限: ${maxSteps}`);

    // 临时注入凭证环境变量（重登等场景引用 ${env.X}）
    const savedEnv = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(injectedEnv)) {
      savedEnv.set(k, process.env[k]);
      process.env[k] = v;
    }

    const browser = await chromium.launch({ headless: !opts.headed });
    const page = await browser.newPage(sessionFile ? { storageState: sessionFile } : {});
    try {
      await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (e) {
      console.error(`✗ 起始页面打开失败: ${(e as Error).message}`);
      await browser.close();
      process.exit(2);
    }

    // 5. Agent 循环（白名单 = 起始 URL 域名 + auth 域名）
    const allowDomains = [new URL(opts.url).hostname, ...(authDomain ? [authDomain] : [])];
    let result: AgentResult | undefined;
    try {
      result = await runAgent(page, {
        task: taskFull,
        allowDomains,
        maxSteps,
        log: (m) => console.log(m),
      });
    } finally {
      // session 刷新（Agent 登录成功后的登录态持久化，下次免登）
      if (authDomain) {
        try {
          saveSession(authDomain, await page.context().storageState());
        } catch { /* 不影响主流程 */ }
      }
      // 恢复环境变量
      for (const [k, v] of savedEnv) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      // 每步截图归档（回放审计）
      try {
        for (const s of result?.steps ?? []) {
          writeFileSync(join(runDir, `step-${String(s.step).padStart(2, '0')}.png`), Buffer.from(s.screenshotBase64, 'base64'));
        }
      } catch { /* 归档失败不影响主流程 */ }
      await browser.close();
    }
    if (!result) process.exit(2); // runAgent 抛异常时 finally 已兜底（理论上不可达）

    // 6. 报告与退出码
    const reportPath = writeAgentReport(runDir, task, result);
    if (result.success) {
      console.log(`\n✓ 任务完成：${result.summary}`);
    } else {
      console.error(`\n✗ 任务未完成：${result.summary}`);
    }
    console.log(`  步数: ${result.steps.length} | LLM 调用: ${result.llmCalls} | 耗时: ${(result.totalMs / 1000).toFixed(1)}s`);
    if (result.cost) {
      const usd = result.cost.usd !== null ? `$${result.cost.usd.toFixed(4)}` : '(未知单价)';
      console.log(`  LLM 成本: ${result.cost.tokensIn}+${result.cost.tokensOut} tokens，${usd}（${result.cost.model}）`);
    }
    console.log(`  轨迹报告: ${reportPath}`);
    console.log(`  步骤截图: ${runDir}\\step-*.png`);
    process.exit(result.success ? 0 : 1);
  });
