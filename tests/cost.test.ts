import { describe, it, expect } from 'vitest';
import { CostTracker, extractJson } from '../src/agent/llm.js';

/** 成本统计单元测试（不调真实 LLM） */

describe('CostTracker：tokens 累计与 USD 折算', () => {
  it('累计多次调用的 tokens', () => {
    const t = new CostTracker();
    t.add({ prompt_tokens: 100, completion_tokens: 50 });
    t.add({ prompt_tokens: 200, completion_tokens: 150 });
    t.add(undefined); // 网关不返回 usage 的调用只计次数
    expect(t.calls).toBe(3);
    expect(t.tokensIn).toBe(300);
    expect(t.tokensOut).toBe(200);
  });

  it('已知模型折算 USD（qwen3.8-max: $1.6/$6.4 每 1M tokens）', () => {
    const t = new CostTracker();
    t.add({ prompt_tokens: 1_000_000, completion_tokens: 500_000 });
    // 1M * 1.6 + 0.5M * 6.4 = 1.6 + 3.2 = 4.8
    expect(t.usd('qwen3.8-max')).toBeCloseTo(4.8, 6);
  });

  it('未知模型返回 null（只报 tokens 不报价）', () => {
    const t = new CostTracker();
    t.add({ prompt_tokens: 1000, completion_tokens: 100 });
    expect(t.usd('unknown-model-x')).toBeNull();
  });

  it('toJSON 产出 run.json cost 结构（DESIGN §10.2）', () => {
    const t = new CostTracker();
    t.add({ prompt_tokens: 18400, completion_tokens: 620 });
    const json = t.toJSON('qwen3.8-max');
    expect(json).toEqual({
      llmCalls: 1,
      tokensIn: 18400,
      tokensOut: 620,
      usd: (18400 * 1.6 + 620 * 6.4) / 1_000_000,
      model: 'qwen3.8-max',
    });
  });
});

describe('extractJson：多对象连排容错（W7 踩坑回归）', () => {
  it('两个 JSON 连排时只取第一个', () => {
    const raw = '{"action":"click","ref":3,"reason":"r"}\n{"action":"fill","ref":1}';
    const parsed = extractJson<Record<string, unknown>>(raw);
    expect(parsed.action).toBe('click');
    expect(parsed.ref).toBe(3);
  });

  it('字符串内的花括号不干扰配对', () => {
    const raw = '噪声 {"action":"fill","value":"a{b}c","ref":1,"reason":"r"} 尾巴';
    const parsed = extractJson<Record<string, unknown>>(raw);
    expect(parsed.value).toBe('a{b}c');
  });

  it('转义引号不翻转字符串状态', () => {
    const raw = '{"action":"fill","value":"x\\"y{","ref":1,"reason":"r"}';
    const parsed = extractJson<Record<string, unknown>>(raw);
    expect(parsed.value).toBe('x"y{');
  });
});
