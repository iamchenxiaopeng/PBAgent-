import type { Playbook } from '../playbook/schema.js';

export class InterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterpolationError';
  }
}

const REF_PATTERN = /\$\{(\w+(?:\.\w+)*)\}/g;

/**
 * 运行时上下文：vars（静态）/ params（CLI 注入）/ env（环境变量）/
 * store（extract 写入）/ loop 变量栈（loop 步骤压栈）。
 */
export class RunContext {
  private readonly loopStack: Array<Map<string, unknown>> = [];
  readonly store: Record<string, unknown> = {};

  constructor(
    private readonly playbook: Playbook,
    private readonly params: Record<string, unknown>,
  ) {}

  /** 按作用域解析变量路径，找不到抛错（带定位信息） */
  get(path: string): unknown {
    const [scope, ...rest] = path.split('.');
    switch (scope) {
      case 'vars': {
        const v = this.playbook.vars?.[rest[0]];
        if (v === undefined) throw new InterpolationError(`vars.${rest[0]} 未定义`);
        return v;
      }
      case 'params': {
        const v = rest.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], this.params);
        if (v === undefined) throw new InterpolationError(`params.${rest.join('.')} 未注入（CLI --params 提供）`);
        return v;
      }
      case 'env': {
        const v = process.env[rest[0]];
        if (v === undefined) throw new InterpolationError(`env.${rest[0]} 环境变量不存在`);
        return v;
      }
      case 'ctx': {
        const v = rest.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], this.store);
        if (v === undefined) throw new InterpolationError(`ctx.${rest.join('.')} 尚未产生（由前序 extract 写入）`);
        return v;
      }
      default: {
        // loop 变量：从栈顶往下找
        for (let i = this.loopStack.length - 1; i >= 0; i--) {
          if (this.loopStack[i].has(scope)) return rest.length ? (this.loopStack[i].get(scope) as Record<string, unknown>)?.[rest[0]] : this.loopStack[i].get(scope);
        }
        throw new InterpolationError(`变量 ${path} 无法解析（不在 vars/params/env/ctx/循环变量中）`);
      }
    }
  }

  /** 模板插值：整串引用且值为非字符串时保留原类型（如数组，供 loop.over 用） */
  resolve<T = string>(template: string): T {
    const exact = /^\$\{(\w+(?:\.\w+)*)\}$/.exec(template.trim());
    if (exact) return this.get(exact[1]) as T;
    return template.replace(REF_PATTERN, (_, ref: string) => String(this.get(ref))) as T;
  }

  /** loop 进入/退出 */
  pushLoopScope(vars: Record<string, unknown>): void {
    this.loopStack.push(new Map(Object.entries(vars)));
  }
  popLoopScope(): void {
    this.loopStack.pop();
  }
}
