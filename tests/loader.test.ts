import { describe, it, expect } from 'vitest';
import { validatePlaybookDoc, loadYamlWithLines, loadPlaybook, validateInterpolations, countSteps } from '../src/playbook/loader.js';
import { PlaybookSchema, type Playbook } from '../src/playbook/schema.js';
import { validPlaybook } from './fixtures.js';

describe('Schema 校验', () => {
  it('合法 Playbook（含全部 12+1 种步骤）通过', () => {
    const result = PlaybookSchema.safeParse(validPlaybook);
    expect(result.success).toBe(true);
  });

  it('version 缺失报错', () => {
    const { version: _v, ...rest } = validPlaybook;
    const result = PlaybookSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('steps 为空数组报错', () => {
    const result = PlaybookSchema.safeParse({ ...validPlaybook, steps: [] });
    expect(result.success).toBe(false);
  });

  it('未知 action 报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'teleport', name: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('selector 全空报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'click', name: 'x', selector: { nth: 0 } }],
    });
    expect(result.success).toBe(false);
  });

  it('fill 缺 value 报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'fill', name: 'x', selector: { css: '#a' } }],
    });
    expect(result.success).toBe(false);
  });

  it('extract 缺 into 报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'extract', name: 'x', selector: { css: '#a' } }],
    });
    expect(result.success).toBe(false);
  });

  it('assert 三项全缺报错（语义层校验）', () => {
    const { errors } = validatePlaybookDoc(
      { ...validPlaybook, steps: [{ action: 'assert', name: 'x' }] },
      new Map(),
    );
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('至少需要');
    expect(errors[0].hint).toBeTruthy();
  });

  it('loop 空 steps 报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'loop', name: 'x', over: '${params.items}', var: 'item', steps: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('loop 内嵌套非法步骤报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{
        action: 'loop', name: 'x', over: '${params.items}', var: 'item',
        steps: [{ action: 'nope', name: 'y' }],
      }],
    });
    expect(result.success).toBe(false);
  });

  it('timeout 非正整数报错', () => {
    const result = PlaybookSchema.safeParse({
      ...validPlaybook,
      steps: [{ action: 'goto', name: 'x', url: '/a', timeout: -100 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('行号定位', () => {
  it('错误能定位到 YAML 行号', () => {
    const yamlText = `version: 1
name: t
steps:
  - action: goto
    name: 打开
    url: /a
  - action: click
    name: 坏步骤
    selector: {}
`;
    const { doc, lineMap } = loadYamlWithLines(yamlText);
    const { errors } = validatePlaybookDoc(doc, lineMap);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].line).toBeDefined();
    expect(errors[0].hint).toBeTruthy();
  });

  it('YAML 语法错误带行号', () => {
    const bad = 'version: 1\n  bad indent: [';
    expect(() => loadYamlWithLines(bad)).toThrow();
  });
});

describe('include 展开', () => {
  it('循环引用被检测', () => {
    // fixtures: a include b, b include a
    const result = loadPlaybook('tests/fixtures/cycle-a.yaml');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('循环引用'))).toBe(true);
  });

  it('正常 include 展开合并 steps', () => {
    const result = loadPlaybook('tests/fixtures/with-include.yaml');
    expect(result.ok).toBe(true);
    // 主 2 步 + 子 2 步
    expect(countSteps(result.playbook!.steps)).toBe(4);
  });

  it('include 的文件不存在给出可读错误', () => {
    const result = loadPlaybook('tests/fixtures/missing-include.yaml');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes('无法读取'))).toBe(true);
  });
});

describe('插值静态校验', () => {
  const base = { version: 1 as const, name: 't' };

  it('未知作用域报错', () => {
    const pb = { ...base, steps: [{ action: 'goto', name: 'x', url: '${unknown.key}' }] } as unknown as Playbook;
    const errors = validateInterpolations(pb);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('unknown');
  });

  it('vars 未定义变量报错', () => {
    const pb = {
      ...base,
      steps: [{ action: 'goto', name: 'x', url: '${vars.notExist}' }],
    } as unknown as Playbook;
    const errors = validateInterpolations(pb);
    expect(errors.some((e) => e.message.includes('notExist'))).toBe(true);
  });

  it('vars 已定义变量通过', () => {
    const pb = {
      ...base,
      vars: { host: 'https://a.com' },
      steps: [{ action: 'goto', name: 'x', url: '${vars.host}/x' }],
    } as unknown as Playbook;
    expect(validateInterpolations(pb)).toHaveLength(0);
  });

  it('loop 外引用循环变量报错，loop 内合法', () => {
    const pb = {
      ...base,
      steps: [
        { action: 'goto', name: 'x', url: '${item.id}' },
        { action: 'loop', name: 'l', over: '${params.items}', var: 'item',
          steps: [{ action: 'goto', name: 'y', url: '/sku/${item.id}' }] },
      ],
    } as unknown as Playbook;
    const errors = validateInterpolations(pb);
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain('item');
  });

  it('嵌套 loop 内层可用外层循环变量', () => {
    const pb = {
      ...base,
      steps: [{
        action: 'loop', name: 'l1', over: '${params.rows}', var: 'row',
        steps: [{
          action: 'loop', name: 'l2', over: '${row.cells}', var: 'cell',
          steps: [{ action: 'fill', name: 'f', selector: { css: '#a' }, value: '${cell.v}' }],
        }],
      }],
    } as unknown as Playbook;
    expect(validateInterpolations(pb)).toHaveLength(0);
  });
});
