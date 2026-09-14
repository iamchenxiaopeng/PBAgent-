import { describe, it, expect } from 'vitest';
import { RunContext } from '../src/executor/context.js';
import type { Playbook } from '../src/playbook/schema.js';

const pb = { version: 1, name: 't', vars: { host: 'https://a.com' } } as unknown as Playbook;

describe('RunContext 插值运行时', () => {
  it('vars 插值', () => {
    const ctx = new RunContext(pb, {});
    expect(ctx.resolve('${vars.host}/list')).toBe('https://a.com/list');
  });

  it('params 插值 + 整串引用保留类型', () => {
    const ctx = new RunContext(pb, { price: 99, items: [{ id: 'S1' }, { id: 'S2' }] });
    expect(ctx.resolve('${params.price}')).toBe(99);
    expect(ctx.resolve<unknown[]>('${params.items}')).toHaveLength(2);
  });

  it('env 插值', () => {
    process.env.__TEST_VAR__ = 'hello';
    const ctx = new RunContext(pb, {});
    expect(ctx.resolve('${env.__TEST_VAR__}')).toBe('hello');
    delete process.env.__TEST_VAR__;
  });

  it('ctx.store 插值（extract 产物）', () => {
    const ctx = new RunContext(pb, {});
    ctx.store.doneCount = '3';
    expect(ctx.resolve('共 ${ctx.doneCount} 条')).toBe('共 3 条');
  });

  it('loop 变量作用域栈', () => {
    const ctx = new RunContext(pb, {});
    ctx.pushLoopScope({ item: { id: 'S001', price: 99 } });
    expect(ctx.resolve('/sku/${item.id}/edit')).toBe('/sku/S001/edit');
    ctx.popLoopScope();
    expect(() => ctx.resolve('${item.id}')).toThrow(/无法解析/);
  });

  it('嵌套 loop 内层覆盖外层同名变量', () => {
    const ctx = new RunContext(pb, {});
    ctx.pushLoopScope({ item: 'outer' });
    ctx.pushLoopScope({ item: 'inner' });
    expect(ctx.resolve('${item}')).toBe('inner');
    ctx.popLoopScope();
    expect(ctx.resolve('${item}')).toBe('outer');
  });

  it('缺变量立即报错（带作用域提示）', () => {
    const ctx = new RunContext(pb, {});
    expect(() => ctx.resolve('${params.missing}')).toThrow(/未注入/);
    expect(() => ctx.resolve('${vars.nothing}')).toThrow(/未定义/);
    expect(() => ctx.resolve('${env.NOPE_XYZ}')).toThrow(/环境变量不存在/);
  });
});
