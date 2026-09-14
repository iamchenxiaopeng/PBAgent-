import yaml from 'js-yaml';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PlaybookSchema, type Playbook, type Step } from './schema.js';

export interface ValidationError {
  message: string;
  /** YAML 中的行号（1-based），无法定位时为 undefined */
  line?: number;
  /** 修复建议 */
  hint?: string;
  /** 出错对象在文档中的 JSON 路径 */
  path: string;
}

export interface ValidateResult {
  ok: boolean;
  errors: ValidationError[];
  playbook?: Playbook;
  /** include 展开的前插步骤数（自动重登重试时跳过这段登录流程） */
  includedSteps?: number;
}

interface YamlNode {
  /** js-yaml load 保留的行号信息 */
  __line?: number;
  __endLine?: number;
  [key: string]: unknown;
}

/**
 * 加载 YAML 文本并保留每个映射/序列节点的行号（供错误定位）。
 * js-yaml 的 load with schema CORE_SCHEMA 不保留行号，这里自己用 load 的
 * 每个节点后处理不现实，改为在 YAML 文本前加标记再解析的方案过于 hack。
 * 实际实现：使用 js-yaml 的 load 拿到对象树，行号通过二次扫描 YAML 文本
 * 按 key 名匹配估算（见 src/playbook/line-tracker.ts）。
 */
export interface RawPlaybook {
  /** 原始 YAML 行号映射：JSON path → 起始行 */
  lineMap: Map<string, number>;
  doc: Record<string, unknown>;
}

export function loadYamlWithLines(text: string): RawPlaybook {
  const doc = yaml.load(text) as Record<string, unknown>;
  const lineMap = new Map<string, number>();
  if (doc && typeof doc === 'object') {
    trackLines(doc, '', text, lineMap);
  }
  return { doc, lineMap };
}

function trackLines(
  node: unknown,
  path: string,
  source: string,
  lineMap: Map<string, number>,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      const itemPath = `${path}[${i}]`;
      recordLine(itemPath, item, source, lineMap);
      trackLines(item, itemPath, source, lineMap);
    });
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      recordLine(childPath, value, source, lineMap);
      trackLines(value, childPath, source, lineMap);
    }
  }
}

/** 在源文本中查找 key 或数组元素出现的位置，估算行号 */
function recordLine(
  path: string,
  value: unknown,
  source: string,
  lineMap: Map<string, number>,
): void {
  const lastSegment = path.includes('.')
    ? path.slice(path.lastIndexOf('.') + 1)
    : path.replace(/\[\d+\]$/, '');
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isKeyMatch =
      typeof value !== 'object' || value === null
        ? new RegExp(`^\\s*(-\\s+)?${escapeRegex(lastSegment)}\\s*:`).test(line)
        : true;
    const isArrayItem = /\[\d+\]$/.test(path);
    if (isArrayItem && /^\s*-\s/.test(line)) {
      // 数组项：首个未使用的 "- " 行，由调用方顺序保证（简化：记录首个匹配）
    }
    if (isKeyMatch && new RegExp(`(^|\\s)${escapeRegex(lastSegment)}\\s*:`).test(line)) {
      lineMap.set(path, i + 1);
      return;
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** zod 错误路径转 JSON path 字符串 */
function zodPathToString(segments: (string | number)[]): string {
  return segments
    .map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? s : `.${s}`))
    .join('');
}

const ZOD_HINTS: Record<string, string> = {
  version: 'Playbook 顶层必须声明 version: 1',
  name: 'Playbook 顶层必须提供 name（非空字符串）',
  steps: 'steps 是步骤数组，至少 1 个步骤',
  'selector': 'selector 至少需要 css/xpath/text/role/label 中的任意一项，例如 selector: { text: "保存" }',
  'action': 'action 必须是受支持的步骤类型之一：goto/click/fill/select/check/hover/press/wait/extract/scroll/download/screenshot/assert/loop',
  'url': 'goto 步骤需要 url 字段，支持 ${vars.x}/${params.x} 插值',
  'value': 'fill/select 步骤需要 value 字段',
  'into': 'extract 步骤需要 into 字段（提取值存入 ctx.<into>）',
  'key': 'press 步骤需要 key 字段，如 Enter/Escape',
  'saveTo': 'download 步骤需要 saveTo 字段（保存路径）',
  'to': 'scroll 步骤需要 to: top/bottom',
  'over': 'loop 步骤需要 over 字段（指向数组变量，如 ${params.items}）',
  'var': 'loop 步骤需要 var 字段（循环变量名）',
};

/** 校验单个 Playbook 文档（不含 include 展开）：成功返回 zod parse 后的数据（含 default 填充），失败返回带行号的错误列表 */
export function validatePlaybookDoc(
  doc: unknown,
  lineMap: Map<string, number>,
): { errors: ValidationError[]; playbook?: Playbook } {
  const result = PlaybookSchema.safeParse(doc);
  const errors: ValidationError[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = zodPathToString(issue.path);
      const line = lineMap.get(path) ?? lineMap.get(path.replace(/\[\d+\]$/, ''));
      errors.push({
        message: issue.message,
        path,
        line,
        hint: ZOD_HINTS[issue.path[issue.path.length - 1] as string] ?? ZOD_HINTS[issue.path[0] as string],
      });
    }
  }
  // 语义层校验始终执行（Schema 失败时对可解析部分尽力校验，一次暴露全部问题）
  if (doc && typeof doc === 'object' && Array.isArray((doc as { steps?: unknown }).steps)) {
    const steps = (doc as { steps: unknown[] }).steps;
    errors.push(...validateSemanticRulesOnRaw(steps, lineMap));
  }
  return { errors, playbook: result.success ? result.data : undefined };
}

/** 语义规则：跨字段约束（原始文档版本，容忍字段缺失） */
function validateSemanticRulesOnRaw(
  steps: unknown[],
  lineMap: Map<string, number>,
): ValidationError[] {
  const errors: ValidationError[] = [];
  steps.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const step = raw as Record<string, unknown>;
    if (step.action === 'assert'
      && !step.selector && !step.urlPattern && !step.textContains && !step.textAbsent) {
      const path = `steps[${i}]`;
      errors.push({
        message: 'assert 至少需要 selector/urlPattern/textContains/textAbsent 中的一项',
        path,
        line: lineMap.get(path),
        hint: '例如：textContains: "保存成功" 或 urlPattern: "/order/done"',
      });
    }
    if (step.action === 'loop' && Array.isArray(step.steps)) {
      const loopPath = `steps[${i}]`;
      const inner = validateSemanticRulesOnRaw(step.steps as unknown[], lineMap);
      // 内层路径重映射：steps[j] → steps[i].steps[j]
      for (const e of inner) {
        e.path = `${loopPath}.${e.path}`;
      }
      errors.push(...inner);
    }
  });
  return errors;
}

export interface LoadOptions {
  /** include 展开的最大深度（防循环引用） */
  maxDepth?: number;
}

/**
 * 完整加载入口：
 * 1. 读文件 + YAML 解析（语法错误直接报行号）
 * 2. Schema 校验（含行号定位）
 * 3. include 递归展开（子 Playbook 的 steps 前插，循环引用报错）
 * 4. 变量插值静态校验（${x} 引用的变量必须可解析）
 */
export function loadPlaybook(filePath: string, options: LoadOptions = {}): ValidateResult {
  const maxDepth = options.maxDepth ?? 10;
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  let root: Playbook | undefined;

  /** 递归加载：返回 [前插的 include steps, 自身 steps]，循环引用/超深直接记错误 */
  const loadFile = (file: string, depth: number): { pre: Step[]; own: Step[] } => {
    if (depth > maxDepth) {
      errors.push({ message: `include 展开超过最大深度 ${maxDepth}，疑似循环引用`, path: file });
      return { pre: [], own: [] };
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (e) {
      errors.push({
        message: `无法读取文件: ${(e as Error).message}`,
        path: file,
        hint: '检查文件路径是否正确',
      });
      return { pre: [], own: [] };
    }

    let parsed: RawPlaybook;
    try {
      parsed = loadYamlWithLines(text);
    } catch (e) {
      const err = e as { message?: string; mark?: { line?: number } };
      errors.push({
        message: `YAML 语法错误: ${err.message ?? 'unknown'}`,
        line: err.mark?.line !== undefined ? err.mark.line + 1 : undefined,
        path: file,
        hint: '检查缩进、冒号后空格、引号闭合',
      });
      return { pre: [], own: [] };
    }

    const { errors: docErrors, playbook: parsedPb } = validatePlaybookDoc(parsed.doc, parsed.lineMap);
    if (docErrors.length > 0 || !parsedPb) {
      errors.push(...docErrors);
      return { pre: [], own: [] };
    }

    const pb = parsedPb;
    if (!root) root = pb;

    // include 递归展开：子流程步骤排在自身 steps 之前
    const pre: Step[] = [];
    for (const inc of pb.include ?? []) {
      const incPath = resolve(dirname(file), inc);
      if (seen.has(incPath)) {
        errors.push({
          message: `include 循环引用: ${incPath} 已在加载链中`,
          path: 'include',
          hint: 'A include B 的同时 B 又 include A，请拆出公共子流程',
        });
        continue;
      }
      seen.add(incPath);
      const child = loadFile(incPath, depth + 1);
      pre.push(...child.pre, ...child.own);
    }
    return { pre, own: pb.steps };
  };

  const entry = resolve(filePath);
  seen.add(entry);
  const { pre, own } = loadFile(entry, 1);

  if (errors.length > 0) return { ok: false, errors };
  if (!root) return { ok: false, errors: [{ message: '未找到任何可解析的 Playbook', path: '' }] };

  // 组装展开后的 Playbook：root 元信息 + include 前插 + 自身 steps
  const expanded: Playbook = { ...root, steps: [...pre, ...own] };
  const interpErrors = validateInterpolations(expanded);
  if (interpErrors.length > 0) return { ok: false, errors: interpErrors };

  return { ok: true, errors: [], playbook: expanded, includedSteps: pre.length };
}

/**
 * 变量插值静态校验：
 * ${params.x} / ${vars.x} / ${env.x} 在静态阶段可确认存在性；
 * ${ctx.x} 只能确认格式（运行时由 extract 产生），${item.x} 仅在 loop 内合法。
 */
export function validateInterpolations(pb: Playbook): ValidationError[] {
  const errors: ValidationError[] = [];
  const varsKeys = new Set(Object.keys(pb.vars ?? {}));
  const available = new Set<string>(['params', 'vars', 'env', 'ctx']);
  const pattern = /\$\{(\w+(?:\.\w+)*)\}/g;

  const walk = (steps: Step[], loopVars: Set<string>, pathPrefix: string): void => {
    steps.forEach((step, i) => {
      const path = `${pathPrefix}[${i}]`;
      const scopes = new Set([...available, ...loopVars]);
      // loop 步骤只校验自身字段（over/name 等），嵌套 steps 由递归 walk
      // 在正确的作用域（含循环变量）下校验，避免重复/误报
      const serialized = step.action === 'loop'
        ? JSON.stringify({ ...step, steps: undefined })
        : JSON.stringify(step);
      let match: RegExpExecArray | null;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(serialized)) !== null) {
        const ref = match[1];
        const scope = ref.split('.')[0];
        if (!scopes.has(scope)) {
          errors.push({
            message: `变量插值 \${${ref}} 引用了未定义的作用域 "${scope}"`,
            path: `${path}.(${step.action})`,
            hint: loopVars.size === 0
              ? '可用作用域：params / vars / env / ctx；loop 内还可用循环变量'
              : `当前可用作用域：${[...scopes].join(' / ')}`,
          });
        } else if (scope === 'vars' && ref.includes('.')) {
          const varName = ref.split('.')[1];
          if (!varsKeys.has(varName)) {
            errors.push({
              message: `vars.${varName} 未在 Playbook vars 中定义`,
              path: `${path}.(${step.action})`,
              hint: `在顶层 vars 中声明 ${varName}，或改用 params/ctx`,
            });
          }
        }
      }
      if (step.action === 'loop') {
        const inner = new Set([...loopVars, step.var]);
        walk(step.steps, inner, `${path}.steps`);
      }
    });
  };

  walk(pb.steps, new Set(), 'steps');
  return errors;
}

/** 统计展开后步骤总数（含 loop 嵌套） */
export function countSteps(steps: Step[]): number {
  return steps.reduce(
    (n, s) => n + (s.action === 'loop' ? countSteps(s.steps) : 1),
    0,
  );
}

/** 生成人可读的步骤摘要树 */
export function summarize(pb: Playbook): string[] {
  const lines: string[] = [];
  const render = (steps: Step[], indent: string): void => {
    steps.forEach((s) => {
      const detail = describeStep(s);
      lines.push(`${indent}- [${s.action}] ${s.name}${detail ? ` · ${detail}` : ''}`);
      if (s.action === 'loop') {
        lines.push(`${indent}  loop over ${s.over} as ${s.var}:`);
        render(s.steps, `${indent}    `);
      }
    });
  };
  render(pb.steps, '');
  return lines;
}

function describeStep(s: Step): string {
  switch (s.action) {
    case 'goto': return s.url;
    case 'click': return selectorBrief(s.selector);
    case 'fill': return `${selectorBrief(s.selector)} = ${s.value}`;
    case 'select': return `${selectorBrief(s.selector)} = ${s.value}`;
    case 'check': return `${selectorBrief(s.selector)} → ${s.checked}`;
    case 'hover': return selectorBrief(s.selector);
    case 'press': return s.key;
    case 'wait': return s.ms ? `${s.ms}ms` : s.urlPattern ? `url~${s.urlPattern}` : 'ready';
    case 'extract': return `${selectorBrief(s.selector)} → ctx.${s.into}`;
    case 'scroll': return s.to;
    case 'download': return s.saveTo;
    case 'screenshot': return s.fullPage ? 'full page' : 'viewport';
    case 'assert': return s.textContains ?? s.urlPattern ?? selectorBrief(s.selector!);
    case 'loop': return `${countSteps(s.steps)} nested steps`;
    default:
      return JSON.stringify(s).slice(0, 40);
  }
}

function selectorBrief(sel: { css?: string; xpath?: string; text?: string; role?: string; label?: string }): string {
  return sel.css ?? sel.xpath ?? sel.text ?? sel.role ?? sel.label ?? '?';
}
