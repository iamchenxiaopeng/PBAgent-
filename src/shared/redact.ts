const SENSITIVE_KEY = /password|passwd|pwd|token|secret|cookie|credential/i;

/** 判断 key 是否敏感 */
export function isSensitiveKey(key: string, extraSensitive: string[] = []): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  return extraSensitive.includes(key);
}

const MASK = '***';

/** 脱敏管道：对象序列化前过一遍。深度遍历，敏感 key 的值替换为 ***（保留结构） */
export function redact<T>(value: T, extraSensitive: string[] = []): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, extraSensitive)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k, extraSensitive) ? MASK : redact(v, extraSensitive);
    }
    return out as unknown as T;
  }
  return value;
}

/** 字符串模板脱敏：password=xxx / "password":"xxx" 形式 */
export function redactString(s: string): string {
  return s
    .replace(/(password|passwd|pwd|token|secret|cookie)(["'\s:=]+)([^"'\s,}&]+)/gi, `$1$2${MASK}`);
}
