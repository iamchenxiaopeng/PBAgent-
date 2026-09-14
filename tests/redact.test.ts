import { describe, it, expect } from 'vitest';
import { redact, redactString, isSensitiveKey } from '../src/shared/redact.js';

describe('脱敏管道', () => {
  it('敏感 key 的值替换为 ***', () => {
    const input = { username: 'demo', password: 's3cret', nested: { apiToken: 'tk_123' } };
    const out = redact(input);
    expect(out.password).toBe('***');
    expect(out.nested.apiToken).toBe('***');
    expect(out.username).toBe('demo');
  });

  it('自定义敏感列表生效', () => {
    const out = redact({ idCard: '3501...', name: '张三' }, ['idCard']);
    expect(out.idCard).toBe('***');
    expect(out.name).toBe('张三');
  });

  it('数组递归处理', () => {
    const out = redact([{ password: 'a' }, { ok: 1 }]);
    expect(out[0].password).toBe('***');
    expect(out[1].ok).toBe(1);
  });

  it('原始对象不被修改（纯函数）', () => {
    const input = { password: 'keep' };
    redact(input);
    expect(input.password).toBe('keep');
  });

  it('字符串模板脱敏', () => {
    expect(redactString('password=hunter2 and "token":"abc123"'))
      .toBe('password=*** and "token":"***"');
    expect(redactString('username=demo')).toBe('username=demo');
  });

  it('null/原始值透传', () => {
    expect(redact(null)).toBeNull();
    expect(redact(42)).toBe(42);
    expect(redact('plain')).toBe('plain');
  });

  it('isSensitiveKey 大小写不敏感', () => {
    expect(isSensitiveKey('PASSWORD')).toBe(true);
    expect(isSensitiveKey('ApiToken')).toBe(true);
    expect(isSensitiveKey('username')).toBe(false);
  });
});
