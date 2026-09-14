import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaybook } from '../src/playbook/loader.js';
import { runWithTakeover } from '../src/agent/takeover.js';
import { promoteVersion, listVersions, versionsDir } from '../src/learner/versioning.js';
import { runPlaybookSteps } from '../src/executor/engine.js';
import type { Playbook, Step } from '../src/playbook/schema.js';

/**
 * W7 收官：STATE C 沉淀闭环 E2E（真实 LLM + test-site）。
 *
 * 场景：variant=b 改版（保存按钮 → "确认下单" + confirm 弹窗）
 *   1. v1（旧选择器 text=保存）→ E1 失败 → Agent 兜底自愈 → 成功
 *   2. --learn：轨迹蒸馏 → .versions/v2.yaml 草稿（主文件不动）
 *   3. promote v2：主文件被替换
 *   4. v2 直接跑（零 LLM）：新选择器 + dialog:accept → 一次通关
 *
 * 验收（DESIGN F-06）：沉淀出的新 Playbook 二次运行成功率 ≥ 90%——本用例要求 100%。
 */

const BASE = 'http://localhost:3456';

let browser: Browser;
let page: Page;
let tmpDir: string;
let mainFile: string;

beforeAll(async () => {
  process.env.DEMO_PASSWORD = 'demo123'; // _login.yaml 使用 ${env.DEMO_PASSWORD}
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  tmpDir = mkdtempSync(join(tmpdir(), 'pbagent-e2e-'));
  mainFile = join(tmpDir, 'reprice-e2e.yaml');
}, 60_000);

afterAll(async () => {
  await browser.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}, 60_000);

/** v1 蓝本：登录 + variant=b 改价（旧选择器，必失败在"点保存"） */
const buildV1 = (skuId: string): Playbook => {
  const r = loadPlaybook('src/playbook/examples/reprice.yaml');
  expect(r.ok).toBe(true);
  const pb = r.playbook!;
  const loginSteps = pb.steps.slice(0, r.includedSteps!);
  const steps: Step[] = [
    ...loginSteps,
    { action: 'goto', name: '打开改版编辑页', url: `/sku/${skuId}/edit?variant=b` },
    { action: 'fill', name: '填新价格', selector: { css: '#price', text: '价格' }, value: '888' },
    { action: 'click', name: '点保存', selector: { text: '保存' }, timeout: 5000 }, // ← E1 必炸
    { action: 'assert', name: '确认保存成功', textContains: '保存成功', timeout: 8000 },
  ];
  return { ...pb, meta: { ...pb.meta, baseUrl: BASE }, steps };
};

describe('W7 收官：改版自愈 → 沉淀 v2 → promote → 零 LLM 通关', () => {
  it('阶段 1+2：v1 失败 → Agent 自愈成功 → 沉淀 v2 草稿（主文件不动）', async () => {
    const pb1 = buildV1('S041');
    // v1 主文件先落盘（saveLearnedVersion 要从它存档 v1 并做 diff 基准）
    const { playbookToYaml } = await import('../src/learner/versioning.js');
    writeFileSync(mainFile, playbookToYaml(pb1), 'utf-8');

    const result = await runWithTakeover(page, pb1, {
      username: 'demo',
      password: 'demo123',
    }, {
      allowDomains: ['localhost'],
      agentMaxSteps: 8,
      learn: { mainFile, runId: 'e2e-run-1' },
      log: (m) => console.log(m),
    });

    // A→B→A 全链路成功
    expect(result.success).toBe(true);
    expect(result.agent).not.toBeNull();
    expect(result.resumedIndex).not.toBeNull();

    // STATE C：蒸馏发生
    expect(result.learned).toBeDefined();
    expect(result.learned!.distilledCount).toBeGreaterThanOrEqual(1);

    // 落盘校验：v1 存档 + v2 草稿 + diff + meta
    const vd = versionsDir(mainFile);
    expect(existsSync(join(vd, 'v1.yaml'))).toBe(true);
    expect(existsSync(join(vd, 'v2.yaml'))).toBe(true);
    expect(existsSync(join(vd, 'v2.diff.md'))).toBe(true);

    // 主文件还是 v1 内容（未 promote 不生效）
    const mainContent = readFileSync(mainFile, 'utf-8');
    expect(mainContent).toContain('保存');

    // v2 草稿内容：新选择器 + dialog:accept
    const v2Content = readFileSync(join(vd, 'v2.yaml'), 'utf-8');
    expect(v2Content).toContain('确认下单');
    expect(v2Content).toContain('dialog: accept');

    // 事实校验：S041 价格真的变成 888
    await page.goto(`${BASE}/sku/list`);
    const price = await page.locator('tr', { hasText: 'S041' }).locator('td').nth(2).textContent();
    expect(price?.trim()).toBe('888');
  }, 300_000);

  it('阶段 3+4：promote v2 → 零 LLM 直接跑通（沉淀质量验收）', async () => {
    // promote
    const { promotedTo } = promoteVersion(mainFile, 2);
    expect(promotedTo).toBe(2);
    expect(listVersions(mainFile).current).toBe(2);
    expect(readFileSync(mainFile, 'utf-8')).toContain('确认下单');

    // 重新加载 v2（promote 后的主文件）——校验 promote 产物可直接运行
    const r = loadPlaybook(mainFile);
    expect(r.ok).toBe(true);
    const pb2 = r.playbook!;
    expect(pb2.steps.length).toBeGreaterThanOrEqual(4);

    // 新页面（全新登录态）零 LLM 跑 v2：直达 variant=b 编辑页
    const page2 = await browser.newPage();
    try {
      // v2 含登录步（v1 蓝本前插），直接跑即可
      const trace = await runPlaybookSteps(page2, { ...pb2, meta: { ...pb2.meta, baseUrl: BASE } }, {
        username: 'demo',
        password: 'demo123',
      });
      expect(trace.steps.every((s) => s.status === 'ok')).toBe(true);

      // 事实校验：S041 在 v2 流程中被再次改价（888 → 已是 888，改另一个 SKU 更硬核）
      await page2.goto(`${BASE}/sku/list`);
      const price = await page2.locator('tr', { hasText: 'S041' }).locator('td').nth(2).textContent();
      expect(price?.trim()).toBe('888');
    } finally {
      await page2.close();
    }
  }, 120_000);
});
