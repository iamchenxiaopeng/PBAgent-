import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadPlaybook } from '../src/playbook/loader.js';
import { runPlaybookSteps } from '../src/executor/engine.js';
import { StepFailure } from '../src/detector/failure.js';

const BASE = 'http://localhost:3456';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  process.env.DEMO_PASSWORD = 'demo123'; // _login.yaml 使用 ${env.DEMO_PASSWORD}
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser.close();
});

const loginParams = { username: 'demo', password: 'demo123' };

describe('执行引擎 E2E（对 test-site）', () => {
  it('登录子流程：goto + fill + click + assert 全链路', async () => {
    const result = loadPlaybook('src/playbook/examples/_login.yaml');
    expect(result.ok).toBe(true);
    const pb = result.playbook!;
    pb.meta = { ...pb.meta, baseUrl: BASE };
    const trace = await runPlaybookSteps(page, pb, loginParams);
    expect(trace.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(page.url()).toContain('/dashboard');
  }, 60_000);

  it('改价主流程：loop 多轮 + extract + 断言', async () => {
    const result = loadPlaybook('src/playbook/examples/reprice.yaml');
    expect(result.ok).toBe(true);
    const pb = result.playbook!;
    pb.meta = { ...pb.meta, baseUrl: BASE };
    // 防测试数据漂移：先把 S002 价格重置到已知值（历史运行可能改过）
    await page.goto(`${BASE}/sku/S002/edit`);
    await page.fill('#price', '100');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/sku/list**');
    const trace = await runPlaybookSteps(page, pb, {
      ...loginParams,
      items: [
        { id: 'S001', price: '150' },
        { id: 'S002', price: '120' },
      ],
    });
    expect(trace.steps.every((s) => s.status === 'ok')).toBe(true);
    // extract 步骤把结果条数写进 store（test-site 现有 50 个 SKU）
    expect(String(trace.ctxStore.doneCount)).toContain('50');
    // 第二轮改价生效校验：回列表页看价格
    await page.goto(`${BASE}/sku/list`);
    const price = await page.locator('tr', { hasText: 'S002' }).locator('td').nth(2).textContent();
    expect(price?.trim()).toBe('120');
  }, 90_000);

  it('改版模拟（variant=b）：旧选择器失败 → E1 分类正确', async () => {
    const result = loadPlaybook('src/playbook/examples/_login.yaml');
    const pb = result.playbook!;
    pb.meta = { ...pb.meta, baseUrl: BASE };
    // 直接访问 variant=b 的编辑页，用 v1 的"保存"文本点击 → 找不到 → E1
    const variantPb = {
      ...pb,
      name: 'variant-b-e1',
      steps: [
        { action: 'goto', name: '打开改版编辑页', url: `${BASE}/sku/S003/edit?variant=b` },
        { action: 'click', name: '点保存（v1 选择器）', selector: { text: '保存' }, timeout: 4000 },
      ],
    } as typeof pb;
    // 需要登录态：复用当前 page（前序用例已登录）
    const err = await runPlaybookSteps(page, variantPb, loginParams).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    expect((err as StepFailure).kind).toBe('E1');
    expect((err as StepFailure).message).toContain('已尝试策略');
  }, 30_000);

  it('session 过期场景：未登录访问受保护页 → URL 断言失败 E4 / 跳转检测', async () => {
    const context = await browser.newContext(); // 无 cookie 的新上下文
    const freshPage = await context.newPage();
    const pb = {
      version: 1 as const,
      name: 'expired-session',
      steps: [
        { action: 'goto', name: '直接访问工作台', url: `${BASE}/dashboard` },
        { action: 'assert', name: '应该到工作台', urlPattern: '/dashboard', timeout: 3000 },
      ],
    };
    const err = await runPlaybookSteps(freshPage, pb, {}).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    // 302 到 /login → assert URL 不匹配 → E4
    expect((err as StepFailure).kind).toBe('E4');
    expect((err as StepFailure).message).toContain('/login');
    await context.close();
  }, 30_000);

  it('选择器多层 fallback：css 失效后 text 层兜底命中', async () => {
    // variant=b 页面上 .btn-primary 类还在（导航链接），但保存按钮已换。
    // 构造：css 指向不存在的类 + text 指向"确认下单" → text 层命中
    const pb = {
      version: 1 as const,
      name: 'fallback-test',
      steps: [
        { action: 'goto', name: '打开改版编辑页', url: `${BASE}/sku/S003/edit?variant=b` },
        {
          action: 'click', name: '点确认下单（css 故意写错，text 兜底）',
          selector: { css: '.btn-not-exist', text: '确认下单' },
          timeout: 10_000,
        },
        { action: 'wait', name: '等保存结果', ms: 500 },
      ],
    };
    const trace = await runPlaybookSteps(page, pb, {});
    expect(trace.steps.every((s) => s.status === 'ok')).toBe(true);
  }, 30_000);

  it('E3 超时：goto 超时被分类', async () => {
    const pb = {
      version: 1 as const,
      name: 'timeout-test',
      steps: [
        { action: 'goto', name: '访问不可达地址', url: 'http://localhost:19999/x', timeout: 2000 },
      ],
    };
    const err = await runPlaybookSteps(page, pb, {}).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    expect((err as StepFailure).kind).toBe('E3');
  }, 30_000);
});
