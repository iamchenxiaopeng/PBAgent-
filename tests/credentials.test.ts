import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setCredentials, getCredentials, removeCredentials, listDomains,
  normalizeDomain, checkPermission, CredentialError,
} from '../src/credentials/store.js';

/** 把 credentials 目录指到临时目录（模块级常量，用 chdir 实现） */
let tmpDir: string;
const origCwd = process.cwd();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pbagent-cred-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('域名归一化', () => {
  it('协议/端口/路径全部剥离', () => {
    expect(normalizeDomain('https://Admin.Example.com:8443/path?q=1')).toBe('admin.example.com');
    expect(normalizeDomain('http://localhost:3456')).toBe('localhost');
    expect(normalizeDomain('plain.host')).toBe('plain.host');
  });
});

describe('凭证加解密', () => {
  it('set 后 get 拿回原文', () => {
    setCredentials('admin.example.com', { username: 'demo', password: 's3cret!' });
    const creds = getCredentials('admin.example.com');
    expect(creds.username).toBe('demo');
    expect(creds.password).toBe('s3cret!');
  });

  it('合并语义：二次 set 只覆盖指定字段', () => {
    setCredentials('a.com', { username: 'u1', password: 'p1' });
    setCredentials('a.com', { password: 'p2' });
    const creds = getCredentials('a.com');
    expect(creds.username).toBe('u1');
    expect(creds.password).toBe('p2');
  });

  it('密文不落明文（文件里搜不到密码）', () => {
    setCredentials('b.com', { password: 'PlaintextLeak!' });
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const raw = readFileSync(join('credentials', 'b.com.enc'), 'utf-8');
    expect(raw).not.toContain('PlaintextLeak!');
    expect(raw).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('域名归一化后同域共享（带端口与不带端口是同一份）', () => {
    setCredentials('http://c.com:8080', { password: 'x' });
    const creds = getCredentials('https://c.com');
    expect(creds.password).toBe('x');
  });

  it('不存在的域返回空对象', () => {
    expect(getCredentials('never.set.com')).toEqual({});
  });

  it('remove 后读不到', () => {
    setCredentials('d.com', { password: 'x' });
    expect(removeCredentials('d.com')).toBe(true);
    expect(getCredentials('d.com')).toEqual({});
    expect(removeCredentials('d.com')).toBe(false);
  });

  it('listDomains 扫描目录', () => {
    setCredentials('e.com', { password: 'x' });
    setCredentials('f.com', { password: 'y' });
    expect(listDomains().sort()).toEqual(['e.com', 'f.com']);
  });

  it('篡改密文 → 解密失败报 CredentialError', () => {
    setCredentials('g.com', { password: 'x' });
    const { readFileSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    const file = join('credentials', 'g.com.enc');
    const parts = readFileSync(file, 'utf-8').split(':');
    parts[2] = Buffer.from('tampered-data').toString('base64'); // 篡改密文段
    writeFileSync(file, parts.join(':'), 'utf-8');
    expect(() => getCredentials('g.com')).toThrow(CredentialError);
  });

  it('权限检查：文件存在且非空', () => {
    setCredentials('h.com', { password: 'x' });
    const check = checkPermission('h.com');
    expect(check.ok).toBe(true);
    const missing = checkPermission('not-exist.com');
    expect(missing.ok).toBe(false);
  });
});
