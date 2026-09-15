import type { Playbook, Step, Selector } from '../playbook/schema.js';
import type { AgentResult, AgentStep } from '../agent/loop.js';
import type { ElementInfo } from '../perception/snapshot.js';

/**
 * STATE C：轨迹蒸馏（DESIGN F-06 / §7.1）。
 * Agent 兜底成功的轨迹 → Playbook 步骤：
 *   - 失败步骤**原位替换**（前后步骤保留，保持版本可比性）
 *   - click/fill 的 selector 优先用元素 id（改版下最稳），text 兜底（DESIGN §3.3 双保险）
 *   - 弹窗：Agent 处理过 confirm → 步骤标 dialog: accept（Playbook 引擎复跑必需）
 *   - 值回填：fill 值与 params 对应 → 保留插值形式（回放时从 params 注入）
 *   - goto/wait 不沉淀单独步骤（减少噪音；goto 已在前后步骤里）
 */

/** 蒸馏产物 */
export interface DistillResult {
  /** 新版本 Playbook（未写盘；steps 里失败步骤已被替换） */
  playbook: Playbook;
  /** 替换发生的位置（原 playbook.steps 下标） */
  replacedIndex: number;
  /** 蒸馏出的步骤数 */
  distilledCount: number;
  /** 值回填的 params 键清单（value 与 params 值相等时保留插值） */
  paramKeys: string[];
}

/** ref 元素 → 多层 selector（css+text 双保险；DESIGN §3.3） */
export function selectorFromElement(el: ElementInfo): Selector {
  const selector: Selector = {};
  if (el.css) selector.css = el.css;
  // text 只在元素有可见文本时作为兜底（css 与 text 语义对齐：都是这个元素）
  if (el.text && el.text.trim()) selector.text = el.text.trim().slice(0, 40);
  if (Object.keys(selector).length === 0) {
    // css 与 text 都没有（罕见：无名 class 的链接）——退化为 name/placeholder
    if (el.name) selector.label = el.name;
    else throw new Error(`元素 ref=${el.ref} 无法生成 selector（无 css/text/label）`);
  }
  return selector;
}

/** 单个 Agent 动作 → Playbook 步骤（不可转换的动作返回 null） */
function distillAction(
  step: AgentStep,
  params: Record<string, unknown>,
  paramKeys: string[],
): Step | null {
  const act = step.action;
  if (!step.ok) return null; // 失败的动作不沉淀（只沉淀成功路径）
  if (!step.target) return null; // 没有元素信息 → 无法生成 selector
  // 密码框不沉淀：登录流程属于 include 子 Playbook，混进业务步骤会泄露凭证结构
  if (act.action === 'fill' && step.target.type === 'password') return null;

  if (act.action === 'click') {
    return {
      action: 'click',
      name: `点击${step.target.text ? `「${step.target.text.slice(0, 12)}」` : '元素'}`,
      selector: selectorFromElement(step.target),
      ...(step.sawDialog ? { dialog: 'accept' as const } : {}),
    };
  }

  if (act.action === 'fill') {
    // 值回填：fill 值与某个 param 值相等 → 保留 ${params.x}（回放时注入）
    const matched = Object.entries(params).find(
      ([, v]) => String(v) === act.value,
    );
    if (matched) paramKeys.push(matched[0]);
    return {
      action: 'fill',
      name: `填${step.target.name ? step.target.name.slice(0, 12) : step.target.placeholder ?? '值'}`,
      selector: selectorFromElement(step.target),
      value: matched ? `\${params.${matched[0]}}` : act.value,
    };
  }

  // drag 不沉淀：拖滑块属于反爬对抗而非业务流程，
  // 沉淀进 Playbook 会让下次重放时对着正常页面做无意义的拖动
  if (act.action === 'drag') return null;

  if (act.action === 'goto') {
    return { action: 'goto', name: '打开页面', url: act.url };
  }

  // press/wait 不单独沉淀（DESIGN §7.1：合并进相邻步骤，减少噪音）
  return null;
}

/**
 * 蒸馏主入口：HybridResult 中 Agent 成功轨迹 → 新版本 Playbook。
 * 失败步骤原位替换（保留前后步骤），新步骤插到失败步骤位置。
 */
export function distillFromTakeover(
  original: Playbook,
  agent: AgentResult,
  failedIndex: number,
  params: Record<string, unknown>,
): DistillResult {
  if (failedIndex < 0 || failedIndex >= original.steps.length) {
    throw new Error(`failedIndex ${failedIndex} 越界（steps ${original.steps.length}）`);
  }
  const paramKeys: string[] = [];
  const newSteps: Step[] = [];
  for (const s of agent.steps) {
    const step = distillAction(s, params, paramKeys);
    if (step) newSteps.push(step);
  }
  // 无可蒸馏步骤（纯 press/wait/密码框）→ 不替换，原样返回（调用方按 distilledCount 跳过沉淀）
  if (newSteps.length === 0) {
    return {
      playbook: original,
      replacedIndex: -1,
      distilledCount: 0,
      paramKeys: [],
    };
  }

  const steps = [...original.steps];
  steps.splice(failedIndex, 1, ...newSteps); // 原位替换失败步骤
  // 关键：输入的 original 是 include 展开后的对象——保留 include 字段会导致 v2 二次展开登录步。
  // 蒸馏版剥离 include/auth 相关字段，纯业务步骤独立成版本（登录由 session/relogin 机制负责）。
  const { include: _drop, ...rest } = original;
  return {
    playbook: { ...rest, steps },
    replacedIndex: failedIndex,
    distilledCount: newSteps.length,
    paramKeys: [...new Set(paramKeys)],
  };
}
