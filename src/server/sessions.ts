import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 会话存储（对话式控制台 V2）：落盘 runs/web-sessions.json。
 * 一个会话 = 一段连续的多轮任务交互（消息流 + 任务引用）。
 * 消息里的任务结果通过 taskId 关联，正文只存摘要（体积可控，详情走任务事件流）。
 */

/** 消息：用户指令 或 Agent 任务结果 */
export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant';
  at: number;
  /** 用户消息：自然语言指令原文 */
  text?: string;
  /** assistant 消息：关联的任务与结果摘要 */
  task?: {
    id: string;
    status: 'running' | 'done' | 'error';
    success?: boolean;
    summary?: string;
    totalMs?: number;
    llmCalls?: number;
    /** 提交时的参数快照（多轮追问的记忆来源） */
    options?: {
      url: string;
      task: string;
      playbookFile?: string;
      params?: Record<string, unknown>;
    };
  };
}

export interface Session {
  id: string;
  /** 标题（首条用户消息摘要，可重命名） */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
}

const SESSIONS_FILE = join(process.cwd(), 'runs', 'web-sessions.json');
const MAX_SESSIONS = 200; // 防无限增长

function readAll(): Session[] {
  try {
    if (!existsSync(SESSIONS_FILE)) return [];
    return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8')) as Session[];
  } catch {
    return []; // 文件损坏不致命
  }
}

function writeAll(sessions: Session[]): void {
  mkdirSync(join(process.cwd(), 'runs'), { recursive: true });
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

/** 会话列表（新的在前；列表视图用，不含消息体） */
export function listSessions(limit = 100): Array<Omit<Session, 'messages'> & { messageCount: number; lastText?: string }> {
  const all = readAll();
  return all
    .slice(-limit)
    .reverse()
    .map(({ messages, ...rest }) => ({
      ...rest,
      messageCount: messages.length,
      lastText: messages.length ? (messages[messages.length - 1].text ?? messages[messages.length - 1].task?.summary ?? '') : '',
    }));
}

/** 取单个会话（含消息流） */
export function getSession(id: string): Session | null {
  return readAll().find((s) => s.id === id) ?? null;
}

/** 新建会话（首条用户消息决定标题） */
export function createSession(firstText?: string): Session {
  const s: Session = {
    id: randomUUID().slice(0, 8),
    title: (firstText ?? '新会话').slice(0, 40) || '新会话',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
  const all = readAll();
  all.push(s);
  writeAll(all.slice(-MAX_SESSIONS));
  return s;
}

/** 追加用户消息 */
export function appendUserMessage(id: string, text: string): SessionMessage | null {
  const all = readAll();
  const s = all.find((x) => x.id === id);
  if (!s) return null;
  const msg: SessionMessage = { id: randomUUID().slice(0, 8), role: 'user', at: Date.now(), text };
  s.messages.push(msg);
  s.updatedAt = Date.now();
  // 首条用户消息覆盖默认标题
  if (s.messages.filter((m) => m.role === 'user').length === 1) {
    s.title = text.slice(0, 40) || '新会话';
  }
  writeAll(all);
  return msg;
}

/** 追加 assistant 任务消息 */
export function appendTaskMessage(
  id: string,
  task: SessionMessage['task'],
): SessionMessage | null {
  const all = readAll();
  const s = all.find((x) => x.id === id);
  if (!s) return null;
  const msg: SessionMessage = { id: randomUUID().slice(0, 8), role: 'assistant', at: Date.now(), task };
  s.messages.push(msg);
  s.updatedAt = Date.now();
  writeAll(all);
  return msg;
}

/** 任务结束时回填结果摘要 */
export function completeTaskMessage(id: string, taskId: string, patch: { status: 'done' | 'error'; success?: boolean; summary?: string; totalMs?: number; llmCalls?: number }): void {
  const all = readAll();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  const msg = [...s.messages].reverse().find((m) => m.task?.id === taskId);
  if (msg?.task) Object.assign(msg.task, patch);
  s.updatedAt = Date.now();
  writeAll(all);
}

/** 重命名会话 */
export function renameSession(id: string, title: string): Session | null {
  const all = readAll();
  const s = all.find((x) => x.id === id);
  if (!s) return null;
  s.title = title.slice(0, 60) || '未命名会话';
  s.updatedAt = Date.now();
  writeAll(all);
  return s;
}

/** 删除会话 */
export function deleteSession(id: string): boolean {
  const all = readAll();
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/**
 * 构建记忆上下文：会话内最近几轮的用户指令 + 最后一个任务快照。
 * 拼进新任务描述，让 Agent 知道"之前干了什么"（同域连续操作）。
 */
export function buildMemoryContext(id: string, maxTurns = 6): string {
  const s = getSession(id);
  if (!s) return '';
  const recentUserTexts = s.messages
    .filter((m) => m.role === 'user' && m.text)
    .slice(-maxTurns)
    .map((m) => m.text);
  const lastTask = [...s.messages].reverse().find((m) => m.task)?.task;

  const lines: string[] = [];
  if (recentUserTexts.length > 1) {
    lines.push('## 会话内之前的指令（按时间序）');
    recentUserTexts.slice(0, -1).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  if (lastTask?.status === 'done' || lastTask?.status === 'error') {
    lines.push('## 上一个任务');
    lines.push(`- 目标：${lastTask.options?.task ?? ''}`);
    lines.push(`- 起始 URL：${lastTask.options?.url ?? ''}`);
    if (lastTask.options?.params && Object.keys(lastTask.options.params).length) {
      lines.push(`- 参数：${JSON.stringify(lastTask.options.params)}`);
    }
    lines.push(`- 结果：${lastTask.summary ?? '（无摘要）'}${lastTask.success === false ? '（上次未达成目标）' : ''}`);
  }
  lines.push('## 本次新指令');
  return lines.join('\n');
}
