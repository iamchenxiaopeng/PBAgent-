import { describe, it, expect } from 'vitest';
import { detectPageState, classifyError, stepFailure, StepFailure } from '../src/detector/failure.js';
import { ElementNotFoundError } from '../src/executor/selector.js';
import type { Step } from '../src/playbook/schema.js';

const step = { action: 'goto', name: '测试步骤', url: '/x' } as unknown as Step;

describe('E2 页面状态检测', () => {
  it('session 过期踢到登录页被识别', () => {
    const signal = detectPageState('http://a.com/login', '/dashboard', undefined);
    expect(signal?.urlPattern).toBeTruthy();
  });

  it('URL 符合预期时不误报', () => {
    expect(detectPageState('http://a.com/dashboard', '/dashboard', undefined)).toBeNull();
  });

  it('无期望 URL 时不做 URL 判定', () => {
    expect(detectPageState('http://a.com/login', null, undefined)).toBeNull();
  });

  it('主文档 404/500 被识别', () => {
    expect(detectPageState('http://a.com/x', '/x', { url: 'http://a.com/x', status: 404 })?.badStatus?.status).toBe(404);
  });
});

describe('classifyError 分类', () => {
  it('ElementNotFoundError → E1', () => {
    const f = classifyError(new ElementNotFoundError('x', ['css=#a']), step);
    expect(f.kind).toBe('E1');
  });

  it('TimeoutError → E3', () => {
    const timeoutErr = new Error('page.goto: Timeout 30000ms exceeded');
    timeoutErr.name = 'TimeoutError';
    expect(classifyError(timeoutErr, step).kind).toBe('E3');
  });

  it('等待 locator 类报错 → E1', () => {
    expect(classifyError(new Error('waiting for selector "#a" failed'), step).kind).toBe('E1');
  });

  it('未知错误 → E2', () => {
    expect(classifyError(new Error('net::ERR_CONNECTION_REFUSED'), step).kind).toBe('E2');
  });

  it('StepFailure 原样透传', () => {
    const original = stepFailure('E4', step, '断言不成立');
    expect(classifyError(original, step)).toBe(original);
  });
});
