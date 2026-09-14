import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadPlaybook } from '../src/playbook/loader.js';
import { runWithTakeover } from '../src/agent/takeover.js';
import type { Playbook, Step } from '../src/playbook/schema.js';

/**
 * W6 标志性场景：改版自愈（STATE A → B → A）
 * variant=b 模拟改版：保存按钮改文本"确认下单" + 类名重命名 + confirm 弹窗。
 * Playbook 用旧选择器（text=保存）→ E1 失败 → Agent 兜底：
 *   发现新按钮 → 处理 confirm 弹窗 → 命中恢复点（保存成功文本）→ 续跑 → 成功。
 * 注意：真实 LLM（qwen3.8-max），需 .env 与 test-site。
 */

const BASE = 'http://localhost:3456';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  process.env.DEMO_PASSWORD = 'demo123'; // _login.yaml 使用 ${env.DEMO_PASSWORD}
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 120_000);

afterAll(async () => {
  await browser.close();
}, 60_000);

/** 构造改版场景的 Playbook：登录（确定性）+ 改价（variant=b，旧选择器） */
const buildVariantPlaybook = (skuId: string, price: string): Playbook => {
  const r = loadPlaybook('src/playbook/examples/reprice.yaml');
  expect(r.ok).toBe(true);
  const pb = r.playbook!;
  // 覆盖 steps：登录子流程（include 展开的前 5 步）+ variant=b 改价步骤（旧选择器）
  const loginSteps = pb.steps.slice(0, r.includedSteps!);
  const steps: Step[] = [
    ...loginSteps,
    {
      action: 'goto',
      name: '打开改版编辑页',
      url: `/sku/${skuId}/edit?variant=b`,
    },
    {
      action: 'fill',
      name: '填新价格',
      selector: { css: '#price', text: '价格' },
      value: price,
    },
    {
      action: 'click',
      name: '点保存', // 旧选择器：variant=b 下按钮已改名"确认下单" → E1
      selector: { text: '保存' },
      timeout: 5000,
    },
    {
      action: 'assert',
      name: '确认保存成功',
      textContains: '保存成功',
      timeout: 8000,
    },
  ];
  return { ...pb, meta: { ...pb.meta, baseUrl: BASE }, steps };
};

describe('W6 标志性场景：改版自愈（A→B→A）', () => {
  it('variant=b：旧选择器失败 → Agent 发现"确认下单" → 恢复点命中 → 续跑成功', async () => {
    const pb = buildVariantPlaybook('S030', '777');
    // 前置：确保 S030 价格不是 777（防测试数据漂移）
    const result = await runWithTakeover(page, pb, {
      username: 'demo',
      password: 'demo123',
    }, {
      allowDomains: ['localhost'],
      agentMaxSteps: 8,
      log: (m) => console.log(m),
    });

    console.log('\n--- 时间线 ---');
    for (const t of result.timeline) {
      console.log(`  ${t.phase}: ${t.from}→${t.to} ${t.note ?? ''}`);
    }

    // 兜底成功 + 断点续跑完成
    expect(result.success).toBe(true);
    expect(result.agent).not.toBeNull();
    expect(result.agent!.steps.length).toBeGreaterThan(0);
    expect(result.resumedIndex).not.toBeNull();

    // 事实校验：S030 价格真的变成 777（variant=b 的保存链路走通）
    await page.goto(`${BASE}/sku/list`);
    const price = await page.locator('tr', { hasText: 'S030' }).locator('td').nth(2).textContent();
    expect(price?.trim()).toBe('777');

    // trace 含完整模式切换历史
    const names = result.trace.steps.map((s) => s.name);
    expect(names.some((n) => n.includes('Agent 兜底'))).toBe(true);
    expect(result.trace.recovered).toBe(true);
  }, 300_000);
});
