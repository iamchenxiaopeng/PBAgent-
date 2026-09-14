import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStep } from '../agent/loop.js';

/**
 * Web 控制台任务历史（落盘 runs/web-history.json）。
 * 记录：时间、功能（起始 URL + 任务描述）、参数、结果、步骤时间线。
 * LLM Key 不落盘（只在请求内存存活）；截图不落历史（体积大，run 目录另有归档）。
 */

export interface HistoryEntry {
  id: string;
  /** 任务提交时间（ISO 8601） */
  startedAt: string;
  /** 结束时间 */
  endedAt: string;
  /** 使用参数 */
  options: {
    url: string;
    task: string;
    maxSteps: number | null;
    headed: boolean;
    /** 是否用了自带 LLM 配置（只记布尔，不记 key 本身） */
    llmOverride: boolean;
    model?: string;
    /** 命中的沉淀流程（⚡Playbook 模式标记；Agent 模式无此字段） */
    playbookFile?: string;
    playbookName?: string;
  };
  status: 'done' | 'error';
  success: boolean;
  summary: string;
  totalMs: number;
  llmCalls: number;
  cost?: {
    llmCalls: number; tokensIn: number; tokensOut: number;
    usd: number | null; model: string;
  };
  /** 步骤时间线（瘦身：无截图） */
  steps: Array<Pick<AgentStep, 'step' | 'url' | 'afterUrl' | 'ok' | 'error' | 'engine' | 'usage' | 'llmMs' | 'execMs' | 'perceptionMs'>>;
}

const HISTORY_FILE = join(process.cwd(), 'runs', 'web-history.json');
const MAX_ENTRIES = 200; // 防无限增长

function readAll(): HistoryEntry[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8')) as HistoryEntry[];
  } catch {
    return []; // 文件损坏不致命——历史丢了就丢了
  }
}

/** 追加一条历史（写盘同步——低频操作，不值得异步复杂度） */
export function appendHistory(entry: HistoryEntry): void {
  const all = readAll();
  all.push(entry);
  // 新的在前，截断保上限
  const trimmed = all.slice(-MAX_ENTRIES);
  mkdirSync(join(process.cwd(), 'runs'), { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf-8');
}

/** 查询历史（新的在前；limit 默认 50） */
export function listHistory(limit = 50): HistoryEntry[] {
  const all = readAll();
  return all.slice(-limit).reverse();
}
