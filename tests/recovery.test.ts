import { describe, it, expect } from 'vitest';
import { buildRecoveryPoints, checkRecovery, type MatchContext } from '../src/recovery/fingerprint.js';
import { loadPlaybook } from '../src/playbook/loader.js';
import type { Playbook } from '../src/playbook/schema.js';

const load = (file: string): Playbook => {
  const r = loadPlaybook(file);
  expect(r.ok).toBe(true);
  return r.playbook!;
};

const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  url: 'http://localhost:3456/sku/list?saved=S004',
  elements: [
    { tag: 'a', text: '编辑', href: '/sku/S004/edit' },
    { tag: 'button', text: '保存' },
    { tag: 'input', name: '价格', placeholder: '价格' },
  ],
  bodyText: 'SKU 列表 保存成功：S004 共 50 个 SKU',
  ...over,
});

describe('恢复点指纹', () => {
  it('预计算：失败步骤后 5 步窗口内提取候选', () => {
    const pb = load('src/playbook/examples/reprice.yaml');
    // reprice 展开：0-4 是登录（include），5=goto列表，6=loop，7=extract，8=screenshot
    // 失败在 loop 内的 click 保存（展开序 6）→ 候选是 7/8
    const points = buildRecoveryPoints(pb, 6);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.stepIndex > 6 && p.stepIndex <= 6 + 5)).toBe(true);
    // extract 步骤（序 7）有 selector → 应在候选中
    expect(points.some((p) => p.stepName.includes('提取'))).toBe(true);
  });

  it('匹配：URL + 文本命中 → assert 步骤得分 ≥50 → 命中', () => {
    const pb = load('src/playbook/examples/reprice.yaml');
    const points = buildRecoveryPoints(pb, 6);
    // 页面在列表页 + "保存成功" 文本出现 → 构造一个 assert 类候选验证评分
    // reprice 的候选只有 extract/screenshot；手动构造断言场景：
    const manual = [
      ...points,
      {
        stepIndex: 99,
        stepName: '确认保存成功',
        urlPattern: '/sku/list',
        assertText: '保存成功',
        selector: undefined,
        score: 0,
      },
    ];
    const { hit, scores } = checkRecovery(manual, ctx());
    expect(hit).not.toBeNull();
    expect(hit!.stepIndex).toBe(99);
    // URL 30 + text 20 = 50
    expect(scores.find((s) => s.stepIndex === 99)?.score).toBe(50);
  });

  it('评分制：selector 命中 +50 → 独立命中（即使 URL 不匹配）', () => {
    const manual = [
      { stepIndex: 10, stepName: '点编辑', selector: { text: '编辑' as const }, score: 0 },
    ];
    const { hit } = checkRecovery(manual, ctx({ url: 'http://别的页面/xxx' }));
    expect(hit?.stepIndex).toBe(10); // selector 命中即 50 分达标
  });

  it('低于阈值不命中：仅 URL 命中（30 分）不够', () => {
    const manual = [
      { stepIndex: 10, stepName: 'goto 报表', urlPattern: '/report', score: 0 },
    ];
    const { hit } = checkRecovery(manual, ctx({ url: 'http://x/report' }));
    expect(hit).toBeNull(); // 30 < 50
  });

  it('并列取 stepIndex 更小者', () => {
    const manual = [
      { stepIndex: 20, stepName: 'A', selector: { text: '保存' }, score: 0 },
      { stepIndex: 15, stepName: 'B', selector: { text: '保存' }, score: 0 },
    ];
    const { hit } = checkRecovery(manual, ctx());
    expect(hit?.stepIndex).toBe(15);
  });

  it('改版场景：类名失效但文本语义在 → selector.text 兜底命中', () => {
    // variant=b 改版：#price 类还在但保存按钮变"确认下单"
    const manual = [
      { stepIndex: 8, stepName: '点保存（旧文本）', selector: { text: '保存' }, score: 0 },
      { stepIndex: 9, stepName: '确认 toast', assertText: '保存成功', score: 0 },
    ];
    const variantCtx = ctx({
      url: 'http://localhost:3456/sku/list?saved=S004',
      elements: [
        { tag: 'button', text: '确认下单' },
        { tag: 'input', name: '价格' },
      ],
      bodyText: '保存成功：S004',
    });
    const { hit, scores } = checkRecovery(manual, variantCtx);
    // 旧文本"保存"不在元素里（按钮改名）→ 不命中；
    // 但"保存成功"文本在 body → assertText 步骤命中
    expect(scores.find((s) => s.stepIndex === 8)?.score).toBe(0);
    expect(hit?.stepIndex).toBe(9);
  });

  it('窗口边界：第 6 步之后的候选不进窗口', () => {
    const pb = load('src/playbook/examples/reprice.yaml');
    const points = buildRecoveryPoints(pb, 0);
    // 失败在 0 → 窗口 [1, 5]；loop 在 6 之外，extract(7)/screenshot(8) 也不在
    expect(points.every((p) => p.stepIndex >= 1 && p.stepIndex <= 5)).toBe(true);
  });
});
