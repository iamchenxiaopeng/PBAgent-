import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunTrace } from '../executor/engine.js';
import type { StepFailure } from '../detector/failure.js';

export interface RunSummary {
  runId: string;
  playbook: string;
  status: 'success' | 'failed' | 'recovered';
  startedAt: string;
  durationMs: number;
  totalSteps: number;
  okSteps: number;
  failedSteps: number;
  failure?: { kind: string; kindLabel: string; message: string; stepName: string };
  ctxStore: Record<string, unknown>;
  /** LLM 成本（STATE B 兜底/chat 模式；纯 Playbook 模式为 0 调用 $0） */
  cost?: {
    llmCalls: number; tokensIn: number; tokensOut: number;
    usd: number | null; model: string;
  };
}

/** 由 trace 生成摘要（状态以 trace 中的失败步骤为权威；recovered 以标记为准，且不再展示首跑失败） */
export function summarizeRun(trace: RunTrace, runId: string, durationMs: number, failure?: StepFailure, cost?: RunSummary['cost']): RunSummary {
  const okSteps = trace.steps.filter((s) => s.status === 'ok').length;
  const failedStep = trace.steps.find((s) => s.status === 'failed');
  const hasFailure = Boolean(failedStep) || Boolean(failure);
  // recovered：失败仅出现在首跑（重登后重试已成功），失败信息不进摘要
  const showFailure = trace.recovered ? undefined : failedStep?.failure
    ? { ...failedStep.failure, stepName: failedStep.name }
    : failure
      ? {
          kind: failure.kind,
          kindLabel: failure.kindLabel,
          message: failure.message,
          stepName: failedStep?.name ?? failure.step.name,
        }
      : undefined;
  return {
    runId,
    playbook: trace.playbook,
    status: trace.recovered ? 'recovered' : hasFailure ? 'failed' : 'success',
    startedAt: trace.startedAt,
    durationMs,
    totalSteps: trace.steps.length,
    okSteps,
    failedSteps: trace.steps.length - okSteps,
    failure: showFailure,
    ctxStore: trace.ctxStore,
    cost,
  };
}

/** run.json：机器可读结构化报告 */
export function writeJsonReport(runDir: string, trace: RunTrace, summary: RunSummary): string {
  const path = join(runDir, 'run.json');
  const payload = { summary, steps: trace.steps };
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
  return path;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** report.html：单文件人可读报告（内联样式，无外部依赖） */
export function writeHtmlReport(runDir: string, trace: RunTrace, summary: RunSummary): string {
  const rows = trace.steps.map((s) => {
    const mark = s.status === 'ok' ? '<span class="ok">✓</span>' : '<span class="fail">✗</span>';
    const failure = s.failure
      ? `<div class="failure">[${esc(s.failure.kind)} ${esc(s.failure.kindLabel)}] ${esc(s.failure.message)}</div>`
      : '';
    const note = s.note ? `<div class="note">${esc(s.note)}</div>` : '';
    return `<tr>
      <td>${mark} ${esc(s.stepId)}</td>
      <td>${esc(s.action)}</td>
      <td>${esc(s.name)}${note}${failure}</td>
      <td class="num">${fmtMs(s.ms)}</td>
    </tr>`;
  }).join('\n');

  const statusBadge = summary.status === 'success'
    ? '<span class="badge ok">SUCCESS</span>'
    : summary.status === 'recovered'
      ? '<span class="badge rec">RECOVERED</span>'
      : '<span class="badge fail">FAILED</span>';

  const failureBlock = summary.failure
    ? `<section class="card fail-card">
        <h2>失败信息</h2>
        <p><b>[${esc(summary.failure.kind)} ${esc(summary.failure.kindLabel)}]</b> 步骤「${esc(summary.failure.stepName)}」</p>
        <pre>${esc(summary.failure.message)}</pre>
      </section>`
    : '';

  const storeRows = Object.entries(summary.ctxStore)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>PBAgent 运行报告 · ${esc(summary.runId)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:860px;margin:32px auto;padding:0 20px;color:#26215C;background:#fff}
h1{font-size:20px}h2{font-size:15px;margin:20px 0 8px}
.card{border:1px solid #D3D1C7;border-radius:8px;padding:16px;margin:16px 0;background:#F1EFE8}
.badge{display:inline-block;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:500}
.badge.ok{background:#EAF3DE;color:#27500A}
.badge.rec{background:#FFF3D6;color:#7A5A00}
.badge.fail{background:#FCEBEB;color:#791F1F}
.fail-card{border-color:#F09595;background:#FCEBEB}
table{border-collapse:collapse;width:100%;font-size:13px}
td,th{border:1px solid #D3D1C7;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#EEEDFE}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ok{color:#27500A;font-weight:600}.fail{color:#A32D2D;font-weight:600}
.failure{color:#A32D2D;font-size:12px;margin-top:4px}
.note{color:#5F5E5A;font-size:12px;margin-top:2px}
.kv{display:flex;gap:24px;flex-wrap:wrap}
.kv div{font-size:13px}
.kv b{display:block;font-size:11px;color:#5F5E5A;font-weight:400;text-transform:uppercase}
pre{background:#fff;border:1px solid #D3D1C7;border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;margin:8px 0}
</style>
</head>
<body>
<h1>PBAgent 运行报告 ${statusBadge}</h1>
<div class="card">
  <div class="kv">
    <div><b>Run ID</b>${esc(summary.runId)}</div>
    <div><b>Playbook</b>${esc(summary.playbook)}</div>
    <div><b>开始时间</b>${esc(summary.startedAt)}</div>
    <div><b>总耗时</b>${fmtMs(summary.durationMs)}</div>
    <div><b>步骤</b>${summary.okSteps} ok / ${summary.failedSteps} failed / ${summary.totalSteps} total</div>
    <div><b>LLM 调用</b>0 次（纯 Playbook 模式，$0）</div>
  </div>
</div>
${failureBlock}
<section>
<h2>步骤明细</h2>
<table>
<tr><th>步骤</th><th>类型</th><th>名称 / 详情</th><th>耗时</th></tr>
${rows}
</table>
</section>
${storeRows ? `<section>
<h2>提取的上下文（ctx）</h2>
<table><tr><th>键</th><th>值</th></tr>${storeRows}</table>
</section>` : ''}
<footer style="color:#5F5E5A;font-size:11px;margin:24px 0">PBAgent v0.1 · Playbook + LLM hybrid browser agent</footer>
</body>
</html>`;

  const path = join(runDir, 'report.html');
  writeFileSync(path, html, 'utf-8');
  return path;
}

/** 创建 run 目录并写入两种报告 */
export function writeReports(runDir: string, trace: RunTrace, summary: RunSummary): { json: string; html: string } {
  mkdirSync(runDir, { recursive: true });
  return {
    json: writeJsonReport(runDir, trace, summary),
    html: writeHtmlReport(runDir, trace, summary),
  };
}
