import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { summarizeRun, writeReports } from '../src/reporter/report.js';
import type { RunTrace } from '../src/executor/engine.js';

const trace: RunTrace = {
  playbook: 'sku-reprice',
  startedAt: '2026-09-08T12:00:00.000Z',
  steps: [
    { stepId: 's1', name: '打开登录页', action: 'goto', status: 'ok', ms: 812, note: 'http://localhost:3456/login' },
    { stepId: 's2', name: '填用户名', action: 'fill', status: 'ok', ms: 120 },
    { stepId: 's3', name: '点保存', action: 'click', status: 'failed', ms: 4200, failure: { kind: 'E1', kindLabel: '元素定位失败', message: '元素定位失败，已尝试策略: text=保存' } },
  ],
  ctxStore: { doneCount: '共 3 个 SKU' },
};

describe('运行报告生成', () => {
  it('summarizeRun 统计正确（成功场景）', () => {
    const s = summarizeRun(trace, 'run-x', 5000);
    expect(s.status).toBe('failed');
    expect(s.totalSteps).toBe(3);
    expect(s.okSteps).toBe(2);
    expect(s.failedSteps).toBe(1);
    expect(s.failure?.kind).toBe('E1');
  });

  it('run.json 结构完整可机读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbagent-test-'));
    const summary = summarizeRun(trace, 'run-x', 5000);
    const { json } = writeReports(dir, trace, summary);
    const parsed = JSON.parse(readFileSync(json, 'utf-8')) as {
      summary: { status: string; failure?: { kind: string } };
      steps: Array<{ status: string }>;
    };
    expect(parsed.summary.status).toBe('failed');
    expect(parsed.summary.failure?.kind).toBe('E1');
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[2].status).toBe('failed');
    rmSync(dir, { recursive: true, force: true });
  });

  it('report.html 包含关键信息且为单文件（无外部资源引用）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pbagent-test-'));
    const summary = summarizeRun(trace, 'run-x', 5000);
    const { html } = writeReports(dir, trace, summary);
    const content = readFileSync(html, 'utf-8');
    expect(content).toContain('FAILED');
    expect(content).toContain('E1');
    expect(content).toContain('元素定位失败');
    expect(content).toContain('sku-reprice');
    expect(content).toContain('doneCount');
    // 无外部资源（单文件约束）
    expect(content).not.toMatch(/<link|src="http|href="http/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('成功场景报告不含失败区块', () => {
    const okTrace: RunTrace = { ...trace, steps: trace.steps.slice(0, 2) };
    const summary = summarizeRun(okTrace, 'run-ok', 1000);
    expect(summary.status).toBe('success');
    const dir = mkdtempSync(join(tmpdir(), 'pbagent-test-'));
    const { html } = writeReports(dir, okTrace, summary);
    const content = readFileSync(html, 'utf-8');
    expect(content).toContain('SUCCESS');
    // 失败区块不渲染（class="card fail-card" 的 section 不存在，样式定义除外）
    expect(content).not.toContain('class="card fail-card"');
    rmSync(dir, { recursive: true, force: true });
  });
});
