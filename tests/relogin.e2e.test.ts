import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadPlaybook } from '../src/playbook/loader.js';
import { runWithAutoRelogin, isOnLoginPage } from '../src/executor/relogin.js';
import { StepFailure } from '../src/detector/failure.js';
import { setCredentials, removeCredentials } from '../src/credentials/store.js';
import { saveSession } from '../src/credentials/session.js';

const BASE = 'http://localhost:3456';
const DOMAIN = 'localhost';

let browser: Browser;
let page: Page;

beforeAll(async () => {
  // 凭证：demo/demo123（密码字段加密存储；字段名 demo_password → 注入 env.DEMO_PASSWORD，与 _login.yaml 对应）
  setCredentials(DOMAIN, { username: 'demo', demo_password: 'demo123' });
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 60_000);

afterAll(async () => {
  await browser.close();
  removeCredentials(DOMAIN);
});

const loadReprice = () => {
  const result = loadPlaybook('src/playbook/examples/reprice.yaml');
  expect(result.ok).toBe(true);
  const pb = result.playbook!;
  pb.meta = { ...pb.meta, baseUrl: BASE };
  return { pb, included: result.includedSteps! };
};

describe('自动重登（session 过期自愈）', () => {
  it('isOnLoginPage：登录页 URL 识别', () => {
    expect(isOnLoginPage('http://x/login')).toBe(true);
    expect(isOnLoginPage('http://x/login?next=/dash')).toBe(true);
    expect(isOnLoginPage('http://x/dashboard')).toBe(false);
    expect(isOnLoginPage('http://x/loginx')).toBe(false); // 尾边界：/login 后必须 ? 或结尾
  });

  it('无 session 首跑：include 登录子流程正常执行', async () => {
    const { pb, included } = loadReprice();
    const trace = await runWithAutoRelogin(page, pb, {
      items: [{ id: 'S001', price: '160' }],
    }, { includedSteps: included, authDomain: DOMAIN });
    expect(trace.steps.every((s) => s.status === 'ok')).toBe(true);
    expect(trace.recovered).toBeUndefined();
    expect(trace.steps.some((s) => s.name.includes('填密码'))).toBe(true); // 登录步骤真实执行
    expect(page.url()).toContain('/sku/list');
    // 首跑成功 → session 已可复用（relogin 成功路径 saveSession 或外层手动）
    saveSession(DOMAIN, await page.context().storageState());
  }, 60_000);

  it('核心场景：session 过期被踢 → 自动重登 → 业务重试成功（recovered）', async () => {
    const { pb, included } = loadReprice();
    // 上一用例存了 session；先正常进入业务页，再被踢下线
    const trace1 = await runWithAutoRelogin(page, pb, {
      items: [{ id: 'S002', price: '130' }],
    }, { includedSteps: included, authDomain: DOMAIN, hasSession: true });
    expect(trace1.steps.some((s) => s.name.includes('跳过登录子流程'))).toBe(true);
    expect(trace1.steps.some((s) => s.name.includes('填密码'))).toBe(false); // 确实跳过了登录

    // 服务端踢下线（模拟 session 过期）
    await page.request.post(`${BASE}/api/kick`);
    // 受保护页跳登录页的验证（不用 reprice 流程验证）
    await page.goto(`${BASE}/dashboard`);
    expect(isOnLoginPage(page.url())).toBe(true);

    // 重跑：复用失效 session → 业务第一步 goto 就被 302 到 /login → E2 → 自动重登 → 重试成功
    const trace = await runWithAutoRelogin(page, pb, {
      items: [{ id: 'S003', price: '140' }],
    }, { includedSteps: included, authDomain: DOMAIN, hasSession: true });
    expect(trace.recovered).toBe(true);
    // trace 结构：session 标记 + 业务首跑失败步 + relogin 标记 + 重登步骤 + 重试业务步骤
    expect(trace.steps.some((s) => s.stepId === 'session')).toBe(true);
    expect(trace.steps.some((s) => s.stepId === 'relogin')).toBe(true);
    expect(trace.steps.some((s) => s.name.includes('填密码') && s.status === 'ok')).toBe(true); // 重登真实执行
    expect(trace.steps.at(-1)?.status).toBe('ok'); // 最后一步（业务重试）成功
    // 改价真实生效
    await page.goto(`${BASE}/sku/list`);
    const price = await page.locator('tr', { hasText: 'S003' }).locator('td').nth(2).textContent();
    expect(price?.trim()).toBe('140');
    // session 已被刷新（重登成功即持久化）
  }, 90_000);

  it('无凭证时不自动重登：直接抛出原失败', async () => {
    const { pb, included } = loadReprice();
    removeCredentials(DOMAIN);
    await page.request.post(`${BASE}/api/kick`);
    await page.goto(`${BASE}/dashboard`); // 确认被踢到登录页
    const err = await runWithAutoRelogin(page, pb, {
      items: [{ id: 'S001', price: '999' }],
    }, { includedSteps: included, authDomain: DOMAIN, hasSession: true }).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    expect(traceOf(err).recovered).toBeUndefined();
    // 恢复凭证给后续用例
    setCredentials(DOMAIN, { username: 'demo', demo_password: 'demo123' });
  }, 60_000);

  it('登录子流程本身失败（密码错误）：报错含重登轨迹且不掩盖原失败', async () => {
    const { pb, included } = loadReprice();
    setCredentials(DOMAIN, { username: 'demo', demo_password: 'wrong-password' });
    await page.request.post(`${BASE}/api/kick`);
    const err = await runWithAutoRelogin(page, pb, {
      items: [{ id: 'S001', price: '999' }],
    }, { includedSteps: included, authDomain: DOMAIN, hasSession: true }).catch((e) => e);
    expect(err).toBeInstanceOf(StepFailure);
    const trace = traceOf(err);
    // 完整轨迹：首跑失败 + relogin 标记 + 重登失败步（填密码后的断言 E4）
    expect(trace.steps.some((s) => s.stepId === 'relogin')).toBe(true);
    expect(trace.steps.some((s) => s.stepId.startsWith('re-') && s.status === 'failed')).toBe(true);
    expect(trace.recovered).toBeUndefined();
    // 恢复正确凭证
    setCredentials(DOMAIN, { username: 'demo', demo_password: 'demo123' });
  }, 60_000);
});

const traceOf = (err: unknown): import('../src/executor/engine.js').RunTrace =>
  (err as { __trace?: import('../src/executor/engine.js').RunTrace }).__trace!;
