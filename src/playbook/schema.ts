import { z } from 'zod';

/**
 * 选择器：多层 fallback，css → xpath → text → role/label。
 * 至少提供一项，命中多个元素时按 nth（默认 0）+ 可见性过滤。
 */
export const SelectorSchema = z
  .object({
    css: z.string().optional(),
    xpath: z.string().optional(),
    text: z.string().optional(),
    role: z.string().optional(),
    label: z.string().optional(),
    nth: z.number().int().min(0).optional(),
  })
  .refine((s) => Boolean(s.css || s.xpath || s.text || s.role || s.label), {
    message: 'selector 至少需要 css/xpath/text/role/label 中的一项',
  });

export const ScreenshotPolicySchema = z.enum(['always', 'on-fail', 'never']);

/** 步骤失败时的处置策略：takeover=Agent 兜底接管 / fail=直接失败 / skip=跳过继续 */
export const OnFailureSchema = z.enum(['takeover', 'fail', 'skip']);

/** 所有步骤的公共字段 */
export const BaseStepSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  timeout: z.number().int().positive().optional(),
  screenshot: ScreenshotPolicySchema.optional(),
  onFailure: OnFailureSchema.optional(),
});

/** 变量插值来源：${params.x} / ${vars.x} / ${ctx.x} / ${env.x} */
const Interpolated = z.string();

export const GotoStepSchema = BaseStepSchema.extend({
  action: z.literal('goto'),
  url: Interpolated,
});

export const ClickStepSchema = BaseStepSchema.extend({
  action: z.literal('click'),
  selector: SelectorSchema,
  /** 点击时出现原生弹窗（confirm/alert）的处置：accept 自动确认 / dismiss 取消（默认 dismiss） */
  dialog: z.enum(['accept', 'dismiss']).optional(),
});

export const FillStepSchema = BaseStepSchema.extend({
  action: z.literal('fill'),
  selector: SelectorSchema,
  value: Interpolated,
});

export const SelectStepSchema = BaseStepSchema.extend({
  action: z.literal('select'),
  selector: SelectorSchema,
  value: Interpolated,
});

export const CheckStepSchema = BaseStepSchema.extend({
  action: z.literal('check'),
  selector: SelectorSchema,
  checked: z.boolean().default(true),
});

export const HoverStepSchema = BaseStepSchema.extend({
  action: z.literal('hover'),
  selector: SelectorSchema,
});

export const PressStepSchema = BaseStepSchema.extend({
  action: z.literal('press'),
  key: z.string().min(1),
});

export const WaitStepSchema = BaseStepSchema.extend({
  action: z.literal('wait'),
  ms: z.number().int().positive().optional(),
  urlPattern: z.string().optional(),
  selector: SelectorSchema.optional(),
});

export const ExtractStepSchema = BaseStepSchema.extend({
  action: z.literal('extract'),
  selector: SelectorSchema,
  attr: z.enum(['text', 'value', 'href', 'src']).default('text'),
  into: z.string().min(1),
});

export const ScrollStepSchema = BaseStepSchema.extend({
  action: z.literal('scroll'),
  to: z.enum(['top', 'bottom']),
  selector: SelectorSchema.optional(),
});

export const DownloadStepSchema = BaseStepSchema.extend({
  action: z.literal('download'),
  urlPattern: z.string().optional(),
  saveTo: z.string(),
});

export const ScreenshotStepSchema = BaseStepSchema.extend({
  action: z.literal('screenshot'),
  fullPage: z.boolean().default(false),
  saveTo: z.string().optional(),
});

export const AssertStepSchema = BaseStepSchema.extend({
  action: z.literal('assert'),
  selector: SelectorSchema.optional(),
  urlPattern: z.string().optional(),
  textContains: z.string().optional(),
  textAbsent: z.string().optional(),
});

export const LoopStepSchema = BaseStepSchema.extend({
  action: z.literal('loop'),
  over: Interpolated,
  var: z.string().min(1),
  steps: z.array(z.lazy((): z.ZodTypeAny => StepSchema)).min(1),
});

/** 12+1 种步骤类型（12 种原子步骤 + loop 控制步骤） */
export const StepSchema = z.discriminatedUnion('action', [
  GotoStepSchema,
  ClickStepSchema,
  FillStepSchema,
  SelectStepSchema,
  CheckStepSchema,
  HoverStepSchema,
  PressStepSchema,
  WaitStepSchema,
  ExtractStepSchema,
  ScrollStepSchema,
  DownloadStepSchema,
  ScreenshotStepSchema,
  AssertStepSchema,
  LoopStepSchema,
]);

export const PlaybookMetaSchema = z.object({
  baseUrl: z.string().optional(),
  allowDomains: z.array(z.string()).optional(),
  sensitive: z.array(z.string()).optional(),
});

export const PlaybookSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().optional(),
  vars: z.record(z.string()).optional(),
  include: z.array(z.string()).optional(),
  auth: z.string().optional(),
  meta: PlaybookMetaSchema.optional(),
  steps: z.array(StepSchema).min(1),
});

export type Selector = z.infer<typeof SelectorSchema>;
export type Step = z.infer<typeof StepSchema>;
/** loop 步骤类型：从 Step 联合中提取（schema 用 z.lazy 递归，无法直接 infer） */
export type LoopStep = Extract<Step, { action: 'loop' }>;
export type Playbook = z.infer<typeof PlaybookSchema>;

/** 步骤类型清单（校验/报告用） */
export const STEP_ACTIONS = [
  'goto', 'click', 'fill', 'select', 'check', 'hover', 'press',
  'wait', 'extract', 'scroll', 'download', 'screenshot', 'assert', 'loop',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];
