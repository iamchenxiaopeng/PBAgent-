import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { snapshot, renderDomDigest } from '../src/perception/snapshot.js';

const BASE = 'http://localhost:3456';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
}, 120_000);

afterAll(async () => {
  await browser.close();
}, 60_000);

describe('感知器：截图 + DOM 压缩', () => {
  it('登录页：识别输入框/按钮 + form 归属', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    const snap = await snapshot(page);
    expect(snap.url).toContain('/login');
    expect(snap.screenshotBase64.length).toBeGreaterThan(1000); // 截图非空
    const digest = renderDomDigest(snap);
    expect(digest).toContain('type="password"'); // 密码框
    expect(digest).toContain('用户名'); // label 文本
    expect(digest).toContain('form→/login'); // form 归属
    expect(snap.elements.length).toBeGreaterThanOrEqual(5);
  }, 30_000);

  it('SKU 编辑页：表单值 + form action + 感知耗时 < 2s', async () => {
    // 登录
    await page.fill('#username', 'demo');
    await page.fill('#password', 'demo123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');
    await page.goto(`${BASE}/sku/S001/edit`, { waitUntil: 'domcontentloaded' });
    const snap = await snapshot(page);
    const digest = renderDomDigest(snap);
    expect(digest).toContain('form→/api/sku/save');
    expect(digest).toContain('value="'); // 价格输入框带当前值
    expect(snap.ms).toBeLessThan(2000);
  }, 30_000);

  it('50 行列表页：元素截断 + bodyText 限长', async () => {
    await page.goto(`${BASE}/sku/list`, { waitUntil: 'domcontentloaded' });
    const snap = await snapshot(page);
    expect(snap.elements.length).toBeLessThanOrEqual(120); // 上限截断
    expect(snap.elements.length).toBeGreaterThanOrEqual(50); // 50 行编辑链接都在
    expect(snap.bodyText.length).toBeLessThanOrEqual(1200); // 文本限长
    const digest = renderDomDigest(snap);
    expect(digest).toContain('href="/sku/S001/edit"'); // 链接可定位
  }, 30_000);
});
