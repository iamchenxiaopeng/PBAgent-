import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDistilled, readDistilled, deleteDistilled } from '../src/server/drafts.js';

/** 单元测试：沉淀库（列表 / 明细 / 删除）——纯文件操作，不碰浏览器与 LLM */

let dir: string;
const dirs: string[] = [];

const AUTO_PB = `# 自动沉淀自 Agent 成功轨迹（测试） runId=abc
version: 1
name: auto-reprice
description: 自动改价（自动沉淀，待人工确认）
meta:
  baseUrl: https://shop.example.com
  allowDomains: [shop.example.com]
steps:
  - action: goto
    name: 打开页面
    url: /sku/list
  - action: fill
    name: 填价格
    selector:
      css: '#price'
    value: \${params.price}
  - action: click
    name: 点保存
    selector:
      text: 保存
  - action: assert
    name: 成功断言
    urlPattern: /sku/list
`;

const MANUAL_PB = `version: 1
name: manual-flow
description: 手写流程
meta:
  baseUrl: https://admin.example.com
steps:
  - action: goto
    name: 打开后台
    url: /dashboard
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pbagent-drafts-'));
  dirs.push(dir);
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('沉淀库列表', () => {
  it('列出全部 Playbook（含无版本链的自动草稿）', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    writeFileSync(join(dir, 'manual-flow.yaml'), MANUAL_PB);
    const items = listDistilled(dir);
    expect(items.map((i) => i.name).sort()).toEqual(['auto-reprice', 'manual-flow']);
  });

  it('自动沉淀标记 origin=auto，手写为 manual', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    writeFileSync(join(dir, 'manual-flow.yaml'), MANUAL_PB);
    const items = listDistilled(dir);
    expect(items.find((i) => i.name === 'auto-reprice')?.origin).toBe('auto');
    expect(items.find((i) => i.name === 'manual-flow')?.origin).toBe('manual');
  });

  it('提取 ${params.*} 参数、步骤数、站点信息', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    const it = listDistilled(dir)[0];
    expect(it.params).toEqual(['price']);
    expect(it.stepCount).toBe(4);
    expect(it.baseUrl).toBe('https://shop.example.com');
    expect(it.allowDomains).toEqual(['shop.example.com']);
    expect(it.valid).toBe(true);
    expect(it.versionCount).toBe(0);
  });

  it('坏 YAML 不拖垮列表：valid=false 且带错误信息（界面上要能看能删）', () => {
    writeFileSync(join(dir, 'broken.yaml'), 'version: 1\nname: broken\nsteps:\n  - action: goto\n   url: /x\n');
    const it = listDistilled(dir)[0];
    expect(it.valid).toBe(false);
    expect(it.error).toBeTruthy();
  });

  it('空目录 / 不存在的目录返回空数组', () => {
    expect(listDistilled(dir)).toEqual([]);
    expect(listDistilled(join(dir, 'nope'))).toEqual([]);
  });
});

describe('沉淀明细', () => {
  it('返回步骤明细（url / selector / value 分列）', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    const d = readDistilled(dir, 'auto-reprice')!;
    expect(d).not.toBeNull();
    expect(d.steps).toHaveLength(4);
    expect(d.steps[0]).toMatchObject({ index: 1, action: 'goto', url: '/sku/list' });
    expect(d.steps[1]).toMatchObject({ action: 'fill', selector: '#price', value: '${params.price}' });
    expect(d.steps[2]).toMatchObject({ action: 'click', selector: '保存' });
    expect(d.yaml).toContain('自动沉淀自');
  });

  it('不存在的流程返回 null', () => {
    expect(readDistilled(dir, 'nope')).toBeNull();
  });
});

describe('删除沉淀', () => {
  it('删除主文件（含版本链目录）', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    mkdirSync(join(dir, '.versions', 'auto-reprice'), { recursive: true });
    writeFileSync(join(dir, '.versions', 'auto-reprice', 'v1.yaml'), AUTO_PB);
    const r = deleteDistilled(dir, 'auto-reprice');
    expect(r.missing).toBe(false);
    expect(r.removed).toContain('auto-reprice.yaml');
    expect(existsSync(join(dir, 'auto-reprice.yaml'))).toBe(false);
    expect(existsSync(join(dir, '.versions', 'auto-reprice'))).toBe(false);
  });

  it('versions=0 时保留历史版本目录', () => {
    writeFileSync(join(dir, 'auto-reprice.yaml'), AUTO_PB);
    mkdirSync(join(dir, '.versions', 'auto-reprice'), { recursive: true });
    deleteDistilled(dir, 'auto-reprice', false);
    expect(existsSync(join(dir, 'auto-reprice.yaml'))).toBe(false);
    expect(existsSync(join(dir, '.versions', 'auto-reprice'))).toBe(true);
  });

  it('重复删除：missing=true（幂等，不抛错）', () => {
    const r = deleteDistilled(dir, 'ghost');
    expect(r.missing).toBe(true);
    expect(r.removed).toEqual([]);
  });

  it('路径穿越被拒绝', () => {
    expect(() => deleteDistilled(dir, '../../package')).toThrow(/非法/);
    expect(() => deleteDistilled(dir, '.env')).toThrow(/非法/);
  });
});
