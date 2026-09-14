import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectorFromElement, distillFromTakeover } from '../src/learner/distill.js';
import { diffPlaybooks, renderDiffMarkdown } from '../src/learner/differ.js';
import { saveLearnedVersion, promoteVersion, rollbackVersion, listVersions, versionsDir } from '../src/learner/versioning.js';
import type { AgentResult, AgentStep } from '../src/agent/loop.js';
import type { ElementInfo } from '../src/perception/snapshot.js';
import type { Playbook, Step } from '../src/playbook/schema.js';

/** 单元测试：蒸馏 → diff → 版本链（纯逻辑，不碰浏览器/LLM） */

const el = (over: Partial<ElementInfo>): ElementInfo => ({
  ref: 1, tag: 'button', isForm: true, ...over,
});

const agentStep = (over: Partial<AgentStep>): AgentStep => ({
  step: 1, url: 'http://x/edit', action: { action: 'click', ref: 1, reason: 'r' },
  ok: true, screenshotBase64: '', perceptionMs: 10, ...over,
});

const pb = (steps: Step[], name = 'test-pb'): Playbook => ({
  version: 1, name, steps,
});

describe('蒸馏：元素 → selector', () => {
  it('css + text 双保险（DESIGN §3.3）', () => {
    const s = selectorFromElement(el({ css: '#price', text: '价格' }));
    expect(s.css).toBe('#price');
    expect(s.text).toBe('价格');
  });

  it('无 css 时退化到 text', () => {
    const s = selectorFromElement(el({ css: undefined, text: '保存' }));
    expect(s.text).toBe('保存');
    expect(s.css).toBeUndefined();
  });

  it('css 与 text 都没有 → label 兜底', () => {
    const s = selectorFromElement(el({ css: undefined, text: undefined, name: '用户名' }));
    expect(s.label).toBe('用户名');
  });

  it('三无元素抛错', () => {
    expect(() => selectorFromElement(el({ css: undefined, text: undefined, name: undefined }))).toThrow();
  });

  it('text 超 40 字符截断', () => {
    const s = selectorFromElement(el({ css: undefined, text: 'a'.repeat(60) }));
    expect(s.text?.length).toBe(40);
  });
});

describe('蒸馏：Agent 轨迹 → Playbook 步骤', () => {
  const basePb = pb([
    { action: 'goto', name: '打开编辑页', url: '/sku/S001/edit?variant=b' },
    { action: 'fill', name: '填价格', selector: { css: '#price' }, value: '99' },
    { action: 'click', name: '点保存', selector: { text: '保存' } }, // ← 失败步骤（index 2）
    { action: 'assert', name: '确认成功', textContains: '保存成功' },
  ]);

  const agentOk: AgentResult = {
    success: true,
    steps: [
      agentStep({
        step: 1,
        action: { action: 'click', ref: 7, reason: '确认下单是等价按钮' },
        target: el({ ref: 7, css: 'button.btn-save-v2', text: '确认下单' }),
        sawDialog: true,
      }),
    ],
    summary: 'done', totalMs: 100, llmCalls: 1,
  };

  it('失败步骤原位替换：click 带 dialog:accept + text 兜底', () => {
    const r = distillFromTakeover(basePb, agentOk, 2, {});
    expect(r.replacedIndex).toBe(2);
    expect(r.distilledCount).toBe(1);
    const steps = r.playbook.steps;
    expect(steps).toHaveLength(4); // 4 → 替换 1 换 1，总数不变
    const click = steps[2] as Extract<Step, { action: 'click' }>;
    expect(click.action).toBe('click');
    expect(click.dialog).toBe('accept'); // Agent 处理过 confirm
    expect(click.selector.css).toBe('button.btn-save-v2');
    expect(click.selector.text).toBe('确认下单');
    // 前后步骤保留
    expect(steps[1].name).toBe('填价格');
    expect(steps[3].name).toBe('确认成功');
  });

  it('fill 值命中 params → 保留插值形式', () => {
    const agentFill: AgentResult = {
      ...agentOk,
      steps: [
        agentStep({
          step: 1,
          action: { action: 'fill', ref: 3, value: '123', reason: '填价格' },
          target: el({ ref: 3, tag: 'input', css: '#price', name: '价格', isForm: true }),
        }),
      ],
    };
    const r = distillFromTakeover(basePb, agentFill, 2, { newPrice: '123' });
    const fill = r.playbook.steps[2] as Extract<Step, { action: 'fill' }>;
    expect(fill.value).toBe('${params.newPrice}');
    expect(r.paramKeys).toEqual(['newPrice']);
  });

  it('密码框不沉淀 → 蒸馏跳过（distilledCount=0，原步骤保留）', () => {
    const agentPwd: AgentResult = {
      ...agentOk,
      steps: [
        agentStep({
          action: { action: 'fill', ref: 2, value: 'secret', reason: '密码' },
          target: el({ ref: 2, tag: 'input', type: 'password', css: 'filtered' }),
        }),
      ],
    };
    const r = distillFromTakeover(basePb, agentPwd, 2, {});
    expect(r.distilledCount).toBe(0);
    expect(r.replacedIndex).toBe(-1);
    expect(r.playbook.steps[2].name).toBe('点保存'); // 原步骤原样保留
  });

  it('剥离 include 字段（防二次展开登录步）', () => {
    const withInclude = { ...basePb, include: ['./_login.yaml'] } as Playbook;
    const r = distillFromTakeover(withInclude, agentOk, 2, {});
    expect((r.playbook as { include?: string[] }).include).toBeUndefined();
    // 其他元信息保留
    expect(r.playbook.name).toBe('test-pb');
  });

  it('press/wait 不沉淀；全无可蒸馏步骤时跳过（不抛错）', () => {
    const agentNoise: AgentResult = {
      ...agentOk,
      steps: [
        agentStep({ action: { action: 'press', key: 'Enter', reason: 'r' } }),
        agentStep({ action: { action: 'wait', ms: 500, reason: 'r' } }),
      ],
    };
    const r = distillFromTakeover(basePb, agentNoise, 2, {});
    expect(r.distilledCount).toBe(0);
    expect(r.playbook).toBe(basePb); // 原样返回
  });

  it('失败动作不沉淀', () => {
    const agentHalfFail: AgentResult = {
      ...agentOk,
      steps: [
        agentStep({ ok: false, error: 'ref 超范围' }), // 失败的 click
        agentStep({
          step: 2,
          action: { action: 'click', ref: 8, reason: '重试成功' },
          target: el({ ref: 8, text: '确认下单' }),
        }),
      ],
    };
    const r = distillFromTakeover(basePb, agentHalfFail, 2, {});
    expect(r.distilledCount).toBe(1); // 只有成功那步沉淀
  });
});

describe('diff：步骤级对齐', () => {
  const oldPb = pb([
    { action: 'goto', name: '打开列表', url: '/list' },
    { action: 'fill', name: '填价格', selector: { css: '#price' }, value: '99' },
    { action: 'click', name: '点保存', selector: { text: '保存' } },
    { action: 'assert', name: '确认', textContains: '成功' },
  ]);

  it('完全相同 → 全 same', () => {
    const d = diffPlaybooks(oldPb, oldPb);
    expect(d.stats).toEqual({ same: 4, replaced: 0, added: 0, removed: 0 });
  });

  it('中间步骤被替换 → replace 标注', () => {
    const newPb = pb([
      { action: 'goto', name: '打开列表', url: '/list' },
      { action: 'fill', name: '填价格', selector: { css: '#price' }, value: '99' },
      { action: 'click', name: '点击「确认下单」', selector: { css: 'button.btn-save-v2', text: '确认下单' }, dialog: 'accept' },
      { action: 'assert', name: '确认', textContains: '成功' },
    ]);
    const d = diffPlaybooks(oldPb, newPb);
    expect(d.stats.replaced).toBe(1);
    expect(d.stats.same).toBe(3);
    const rep = d.ops.find((o) => o.op === 'replace');
    expect(rep && rep.op === 'replace' && rep.oldIndex).toBe(2);
    const md = renderDiffMarkdown(d, 'v1', 'v2');
    expect(md).toContain('替换');
    expect(md).toContain('确认下单');
    expect(md).toContain('弹窗:accept');
  });

  it('删除尾部步骤 → remove', () => {
    const newPb = pb(oldPb.steps.slice(0, 3));
    const d = diffPlaybooks(oldPb, newPb);
    expect(d.stats.removed).toBe(1);
    expect(d.stats.same).toBe(3);
  });

  it('新增步骤 → add', () => {
    const newPb = pb([
      ...oldPb.steps.slice(0, 2),
      { action: 'wait', name: '等动画', ms: 500 },
      ...oldPb.steps.slice(2),
    ]);
    const d = diffPlaybooks(oldPb, newPb);
    expect(d.stats.added).toBe(1);
    expect(d.stats.same).toBe(4);
  });

  it('timeout/id 噪音字段不触发 diff', () => {
    const newPb = pb(oldPb.steps.map((s, i) => (i === 1 ? { ...s, timeout: 9999 } : s)));
    const d = diffPlaybooks(oldPb, newPb);
    expect(d.stats.same).toBe(4);
  });
});

describe('版本链：save → promote → rollback', () => {
  let dir: string;
  let mainFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pbagent-ver-'));
    mainFile = join(dir, 'reprice.yaml');
    writeFileSync(mainFile, [
      'version: 1',
      'name: reprice',
      'steps:',
      '  - action: goto',
      '    name: 打开编辑页',
      '    url: /sku/S001/edit',
      '  - action: click',
      '    name: 点保存',
      '    selector: { text: 保存 }',
    ].join('\n'), 'utf-8');
  });

  afterAll(() => {
    // mkdtemp 目录由操作系统清理策略处理；测试内不重复删除（Windows 下句柄释放有延迟）
  });

  const learnedPb = (): Playbook => ({
    version: 1,
    name: 'reprice',
    steps: [
      { action: 'goto', name: '打开编辑页', url: '/sku/S001/edit' },
      { action: 'click', name: '点击「确认下单」', selector: { css: 'button.btn-save-v2', text: '确认下单' }, dialog: 'accept' },
    ],
  });

  it('首次沉淀：主文件存档 v1，新版本落 v2 草稿（主文件不动）', () => {
    const before = readFileSync(mainFile, 'utf-8');
    const r = saveLearnedVersion(mainFile, learnedPb(), { runId: 'run-1', reason: '测试沉淀' });
    expect(r.newVersion).toBe(2);
    // 主文件未变（默认不生效）
    expect(readFileSync(mainFile, 'utf-8')).toBe(before);
    // v1 存档 + v2 草稿 + diff 都在
    const vd = versionsDir(mainFile);
    expect(existsSync(join(vd, 'v1.yaml'))).toBe(true);
    expect(existsSync(join(vd, 'v2.yaml'))).toBe(true);
    expect(existsSync(join(vd, 'v2.diff.md'))).toBe(true);
    expect(existsSync(join(vd, 'meta.json'))).toBe(true);
    // diff 内容人可读
    const diff = readFileSync(join(vd, 'v2.diff.md'), 'utf-8');
    expect(diff).toContain('确认下单');
    // meta.history 记录
    const meta = JSON.parse(readFileSync(join(vd, 'meta.json'), 'utf-8'));
    expect(meta.current).toBe(1);
    expect(meta.history).toHaveLength(1);
    expect(meta.history[0].runId).toBe('run-1');
  });

  it('promote：v2 生效（主文件被替换，current 前进）', () => {
    saveLearnedVersion(mainFile, learnedPb(), { reason: '测试' });
    const { promotedTo } = promoteVersion(mainFile, 2);
    expect(promotedTo).toBe(2);
    // 主文件已是 v2 内容
    const content = readFileSync(mainFile, 'utf-8');
    expect(content).toContain('确认下单');
    const { current, versions } = listVersions(mainFile);
    expect(current).toBe(2);
    expect(versions).toEqual([1, 2]);
  });

  it('rollback：回退到 v1（主文件恢复原内容）', () => {
    saveLearnedVersion(mainFile, learnedPb(), { reason: '测试' });
    promoteVersion(mainFile, 2);
    const { rolledBackTo } = rollbackVersion(mainFile, 1);
    expect(rolledBackTo).toBe(1);
    const content = readFileSync(mainFile, 'utf-8');
    expect(content).not.toContain('确认下单');
    expect(content).toContain('text: 保存');
    expect(listVersions(mainFile).current).toBe(1);
  });

  it('promote 不存在的版本 → 报错', () => {
    expect(() => promoteVersion(mainFile, 9)).toThrow('不存在');
  });

  it('rollback 到当前或更新版本 → 拒绝', () => {
    saveLearnedVersion(mainFile, learnedPb(), { reason: '测试' });
    expect(() => rollbackVersion(mainFile, 1)).toThrow('不早于');
  });

  it('二次沉淀：版本号递增到 v3', () => {
    saveLearnedVersion(mainFile, learnedPb(), { reason: '第一次' });
    promoteVersion(mainFile, 2);
    const r2 = saveLearnedVersion(mainFile, {
      ...learnedPb(),
      steps: [
        { action: 'goto', name: '打开编辑页', url: '/sku/S001/edit' },
        { action: 'click', name: '点击「提交订单」', selector: { css: 'button.btn-save-v3', text: '提交订单' } },
      ],
    }, { reason: '第二次' });
    expect(r2.newVersion).toBe(3);
    const { current, versions } = listVersions(mainFile);
    expect(current).toBe(2);
    expect(versions).toEqual([1, 2, 3]);
  });
});
