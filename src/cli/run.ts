import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { loadPlaybook } from '../playbook/loader.js';
import { runWithAutoRelogin, type RunTrace } from '../executor/relogin.js';
import { summarizeRun, writeReports } from '../reporter/report.js';
import { StepFailure } from '../detector/failure.js';
import { redact } from '../shared/redact.js';
import { loadSession } from '../credentials/session.js';

const timestamp = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

const parseParams = (inline: string | undefined, file: string | undefined): Record<string, unknown> => {
  if (inline && file) {
    throw new Error('--params 与 --params-file 只能提供一个');
  }
  if (file) {
    return JSON.parse(readFileSync(resolve(file), 'utf-8')) as Record<string, unknown>;
  }
  if (inline) {
    return JSON.parse(inline) as Record<string, unknown>;
  }
  return {};
};

export const runCmd = new Command('run')
  .description('执行 Playbook：加载 → Playwright 确定性执行 → 归档报告')
  .argument('<playbook.yaml>', 'Playbook 文件路径')
  .option('--params <json>', '内联 JSON 参数，如 \'{"price":99}\'')
  .option('--params-file <file>', 'JSON 参数文件路径')
  .option('--headless', '无头模式运行浏览器（默认开启）', true)
  .option('--headed', '有头模式运行浏览器（调试用）')
  .option('--baseUrl <url>', '覆盖 Playbook meta.baseUrl')
  .option('--out <dir>', '运行产物根目录（默认 runs/）')
  .option('--takeover', '失败时启用 LLM Agent 兜底接管（STATE B；需 .env 配置 LLM）')
  .option('--learn', '配合 --takeover：兜底成功后蒸馏为新版本草稿（STATE C；写入 .versions/，不自动生效）')
  .action(async (file: string, opts: {
    params?: string; paramsFile?: string; headless?: boolean; headed?: boolean;
    baseUrl?: string; out?: string; takeover?: boolean; learn?: boolean;
  }) => {
    // 1. 参数解析
    let params: Record<string, unknown>;
    try {
      params = parseParams(opts.params, opts.paramsFile);
    } catch (e) {
      console.error(`✗ 参数解析失败: ${(e as Error).message}`);
      process.exit(2);
    }

    // 2. Playbook 加载与校验
    const result = loadPlaybook(file);
    if (!result.ok) {
      console.error(`✗ Playbook 校验失败：${relative(process.cwd(), file)}\n`);
      for (const err of result.errors) {
        const loc = err.line ? `第 ${err.line} 行` : err.path || '(未知位置)';
        console.error(`  [${loc}] ${err.message}`);
        if (err.hint) console.error(`      提示: ${err.hint}`);
      }
      process.exit(2);
    }
    const pb = result.playbook!;
    if (opts.baseUrl) pb.meta = { ...pb.meta, baseUrl: opts.baseUrl };

    // 3. 运行目录与浏览器
    const runId = `${timestamp()}_${pb.name}`;
    const runDir = join(opts.out ?? 'runs', runId);
    mkdirSync(runDir, { recursive: true });

    console.log(`▶ 运行 Playbook：${pb.name}（${runId}）`);
    // session 复用：声明 auth 的 Playbook 加载已有 storageState
    const authDomain = pb.auth;
    const sessionFile = authDomain ? loadSession(authDomain) : undefined;
    if (authDomain) {
      console.log(`  session: ${sessionFile ? '复用已有登录态' : '无（将执行登录流程）'}`);
    }
    const browser = await chromium.launch({ headless: opts.headed ? false : true });
    const page = await browser.newPage(
      sessionFile ? { storageState: sessionFile } : {},
    );

    let trace: RunTrace;
    let failure: StepFailure | undefined;
    let agentTakeover: Awaited<ReturnType<typeof import('../agent/takeover.js').runWithTakeover>> | null = null;
    const started = Date.now();
    if (opts.takeover) {
      // 混合模式：STATE A 失败 → Agent 兜底（STATE B）→ 恢复点续跑（STATE A）→ 沉淀（STATE C，--learn）
      const { runWithTakeover } = await import('../agent/takeover.js');
      const hybrid = await runWithTakeover(page, pb, params, {
        allowDomains: pb.meta?.allowDomains ?? [],
        log: (msg) => console.log(msg),
        ...(opts.learn ? { learn: { mainFile: resolve(file), runId } } : {}),
      }).catch((err): Awaited<ReturnType<typeof runWithTakeover>> | null => {
        failure = err instanceof StepFailure ? err : undefined;
        return null;
      });
      if (hybrid) {
        trace = hybrid.trace;
        if (!hybrid.success) {
          // 兜底失败：从 trace 找失败信息
          const failed = hybrid.trace.steps.find((s) => s.status === 'failed');
          failure = failed?.failure
            ? new StepFailure(failed.failure.message, failed.failure.kind as 'E1', failed.failure.kindLabel, { action: 'goto', name: failed.name } as never)
            : new StepFailure(hybrid.agent?.summary ?? '接管后仍未成功', 'E2', '页面状态异常', { action: 'goto', name: '(takeover)' } as never);
        }
        agentTakeover = hybrid;
      } else {
        trace = (failure as unknown as { __trace?: RunTrace })?.__trace ?? {
          playbook: pb.name,
          startedAt: new Date().toISOString(),
          steps: [],
          ctxStore: {},
        };
        if (!failure) {
          failure = new StepFailure(( hybrid as unknown as Error)?.message ?? '执行异常', 'E2', '页面状态异常', { action: 'goto', name: '(unknown)' } as never);
        }
      }
    } else {
      try {
        trace = await runWithAutoRelogin(page, pb, params, {
          includedSteps: result.includedSteps ?? 0,
          authDomain: authDomain,
          hasSession: Boolean(sessionFile),
          log: (msg) => console.log(msg),
        });
      } catch (err) {
        // engine 保证失败时 trace 已记录（runPlaybookSteps 内部 catch 后 rethrow）
        failure = err instanceof StepFailure ? err : undefined;
        trace = (err as { __trace?: RunTrace }).__trace ?? {
          playbook: pb.name,
          startedAt: new Date().toISOString(),
          steps: [],
          ctxStore: {},
        };
        if (!failure) {
          failure = new StepFailure((err as Error).message, 'E2', '页面状态异常', { action: 'goto', name: '(unknown)' } as never);
        }
      }
    }
    try {
      // 失败现场归档：截图 + DOM 快照（供兜底 Agent 与人工 review）
      if (failure && !agentTakeover) {
        try {
          mkdirSync(join(runDir, 'screenshots'), { recursive: true });
          await page.screenshot({ path: join(runDir, 'screenshots', 'failure.png'), fullPage: true });
          mkdirSync(join(runDir, 'dom'), { recursive: true });
          const html = await page.content();
          const { writeFileSync } = await import('node:fs');
          writeFileSync(join(runDir, 'dom', 'failure.html'), html, 'utf-8');
        } catch { /* 归档失败不影响主流程 */ }
      }
      // Agent 接管轨迹归档（Markdown + 每步截图）
      if (agentTakeover?.agent) {
        try {
          const a = agentTakeover.agent;
          const lines = [
            '# Agent 兜底接管轨迹', '',
            `- 失败步骤: ${agentTakeover.failedIndex + 1}（${pb.steps[agentTakeover.failedIndex]?.name ?? '?'}）`,
            `- 恢复点: ${agentTakeover.resumedIndex !== null ? `步骤 ${agentTakeover.resumedIndex + 1}（${pb.steps[agentTakeover.resumedIndex]?.name ?? '?'}）` : '未命中'}`,
            `- Agent 步数: ${a.steps.length}（LLM 调用 ${a.llmCalls} 次，${(a.totalMs / 1000).toFixed(1)}s）`,
            `- 总结: ${a.summary}`, '', '## 时间线', '',
            ...agentTakeover.timeline.map((t) => `- **${t.phase}**: ${t.from}→${t.to} ${t.note ?? ''}`), '', '## 动作明细', '',
          ];
          for (const s of a.steps) {
            const act = s.action;
            const d = 'ref' in act ? `ref=${act.ref}` : 'url' in act ? act.url : 'key' in act ? act.key : 'ms' in act ? `${act.ms}ms` : act.summary;
            const v = 'value' in act ? ` value="${act.value}"` : '';
            lines.push(`${s.step}. **[${act.action}]** ${d}${v} ${s.ok ? '✅' : '❌ ' + (s.error ?? '')} — ${act.reason}`);
            lines.push(`   页面: ${s.url} → ${s.afterUrl ?? '（无导航）'}`);
            try {
              const { writeFileSync: wf } = await import('node:fs');
              wf(join(runDir, `agent-step-${String(s.step).padStart(2, '0')}.png`), Buffer.from(s.screenshotBase64, 'base64'));
            } catch { /* 截图归档失败不中断 */ }
          }
          const { writeFileSync: wf } = await import('node:fs');
          wf(join(runDir, 'takeover-report.md'), lines.join('\n'), 'utf-8');
        } catch { /* 归档失败不影响主流程 */ }
      }
      // session 刷新：声明 auth 的 Playbook 运行后保存最新登录态（relogin 内部已存过也再存一次，幂等）
      if (authDomain) {
        try {
          const { saveSession } = await import('../credentials/session.js');
          saveSession(authDomain, await page.context().storageState());
        } catch { /* session 保存失败不影响主流程 */ }
      }
      await browser.close();
    } finally {
      await browser.close().catch(() => {});
    }
    const duration = Date.now() - started;

    // 4. 报告（ctxStore 过脱敏管道）
    const sensitiveKeys = pb.meta?.sensitive ?? [];
    const safeStore = redact(trace.ctxStore, sensitiveKeys);
    const safeTrace = { ...trace, ctxStore: safeStore };
    const summary = summarizeRun(safeTrace, runId, duration, failure, agentTakeover?.agent?.cost);
    const { json, html: htmlPath } = writeReports(runDir, safeTrace, summary);

    // 5. 控制台摘要（recovered 也算跑通：session 自愈/Agent 兜底成功）
    if (summary.status === 'success' || summary.status === 'recovered') {
      const badge = summary.status === 'recovered' ? '（含自动恢复）' : '';
      console.log(`✓ 完成${badge}：${summary.okSteps}/${summary.totalSteps} 步骤成功，耗时 ${(duration / 1000).toFixed(1)}s`);
    } else {
      console.error(`✗ 失败：[${summary.failure?.kind} ${summary.failure?.kindLabel}] 步骤「${summary.failure?.stepName}」`);
      console.error(`  ${summary.failure?.message}`);
    }
    if (summary.cost && summary.cost.llmCalls > 0) {
      const usd = summary.cost.usd !== null ? `$${summary.cost.usd.toFixed(4)}` : '(未知单价)';
      console.log(`  LLM 成本: ${summary.cost.llmCalls} 次调用，${summary.cost.tokensIn}+${summary.cost.tokensOut} tokens，${usd}（${summary.cost.model}）`);
    }
    console.log(`  报告: ${htmlPath}`);
    console.log(`  JSON: ${json}`);
    process.exit(summary.status === 'failed' ? 1 : 0);
  });
