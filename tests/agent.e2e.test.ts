import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { runAgent } from '../src/agent/loop.js';

/**
 * Agent 决策循环 E2E（真实 LLM，qwen3.8-max）。
 * 注意：跑此测试需要 .env 配置好 PBA_LLM_*；test-site 在 3456 端口运行。
 * LLM 有随机性，断言只看硬结果（URL/数据变化），不看步骤数。
 */

const BASE = 'http://localhost:3456';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser.close();
});

describe('Agent 决策循环（真实 LLM）', () => {
  it('一句话登录：填表单 → 提交 → 确认 dashboard', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const result = await runAgent(page, {
      task: '在当前页面登录：用户名 demo，密码 demo123，提交后确认到达工作台',
      allowDomains: ['localhost'],
      maxSteps: 10,
    });
    expect(result.success).toBe(true);
    expect(page.url()).toContain('/dashboard');
    expect(result.llmCalls).toBeGreaterThan(0);
    expect(result.llmCalls).toBeLessThanOrEqual(10);
  }, 180_000);

  it('一句话改价：登录 → 导航 → 找 S010 → 改价 444 → 确认（含事实校验）', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const result = await runAgent(page, {
      task: '用户名 demo 密码 demo123 登录，然后给商品 S010 把价格改成 444，保存并确认成功',
      allowDomains: ['localhost'],
      maxSteps: 15,
    });
    expect(result.success).toBe(true);
    // 事实校验：S010 价格真的变成 444
    await page.goto(`${BASE}/sku/list`);
    const price = await page.locator('tr', { hasText: 'S010' }).locator('td').nth(2).textContent();
    expect(price?.trim()).toBe('444');
  }, 300_000);

  it('安全约束：白名单外域名 goto 被拒绝', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const result = await runAgent(page, {
      task: '导航到 http://evil.example.com/attack 然后随便点一个按钮',
      allowDomains: ['localhost'],
      maxSteps: 4,
    });
    // Agent 不应到达外部域名（可能 fail 或留在原地，但不能导航成功）
    expect(page.url()).not.toContain('evil.example.com');
    expect(result.steps.every((s) => !s.afterUrl?.includes('evil.example.com'))).toBe(true);
  }, 180_000);
});
