import { Command } from 'commander';
import { listDomains, normalizeDomain, checkPermission, removeCredentials, setCredentials } from '../credentials/store.js';

/** 解析 key=value 行集合（容忍空行/坏行，坏行告警不中断） */
function parsePairs(text: string, out: Record<string, string>): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      console.error(`  忽略无法解析的行: ${trimmed}`);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    out[key] = value;
  }
}

/** 交互读取多行（逐行读；空行或 EOF 结束；兼容管道与终端） */
async function readInteractive(): Promise<string> {
  process.stdin.setEncoding('utf-8');
  return new Promise<string>((resolve) => {
    let buf = '';
    const finish = (): void => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
      resolve(buf);
    };
    const onData = (chunk: string): void => {
      buf += chunk;
      // 任一行敲了回车且该行为空（只有换行）→ 结束
      if (/\r?\n\s*(\r?\n|$)/.test(buf) || buf.endsWith('\n') || buf.endsWith('\r')) {
        finish();
      }
    };
    const onEnd = (): void => resolve(buf);
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.resume();
  });
}

/**
 * pbagent auth set <domain> [--pair k=v]...
 *   默认交互式输入 key=value 对（如 username=demo），空行或 Ctrl+Z 回车结束
 *   --pair username=demo --pair demo_password=demo123  非交互（CI/脚本/管道友好）
 * pbagent auth list
 * pbagent auth rm <domain>
 */
/** 读完管道 stdin（EOF 结束） */
function readAllPiped(): Promise<string> {
  return new Promise<string>((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c: string) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

export const authCmd = new Command('auth')
  .description('凭证管理：加密存储 / 查看 / 删除')
  .addCommand(
    new Command('set')
      .description('存储凭证（交互式输入，或 --pair k=v 非交互传入）')
      .argument('<domain>', '站点域名，如 admin.example.com')
      .option('--pair <key=value>', '非交互传入凭证字段（可重复）', (v: string, acc: string[]) => [...acc, v], [] as string[])
      .action(async (domain: string, opts: { pair: string[] }) => {
        const creds: Record<string, string> = {};
        if (opts.pair.length > 0) {
          // 非交互：--pair 解析
          parsePairs(opts.pair.join('\n'), creds);
        } else if (!process.stdin.isTTY) {
          // 管道输入（如 printf 'k=v\n' | pbagent auth set domain）
          parsePairs(await readAllPiped(), creds);
        } else {
          // 终端交互（空行结束）
          console.log(`为 ${normalizeDomain(domain)} 存储凭证，输入 key=value（空行结束）：`);
          parsePairs(await readInteractive(), creds);
        }
        if (Object.keys(creds).length === 0) {
          console.error('✗ 未输入任何凭证');
          process.exit(1);
        }
        setCredentials(domain, creds);
        console.log(`✓ 已存储 ${Object.keys(creds).length} 个字段（AES-256-GCM 加密）`);
        if (Object.keys(creds).some((k) => /password|secret|token/i.test(k))) {
          console.log('  提示: 密码等敏感字段已加密存储；也可通过 PBAGENT_KEY 环境变量管理主密钥');
        }
      }),
  )
  .addCommand(
    new Command('list')
      .description('列出已存储凭证的域名')
      .action(() => {
        const domains = listDomains();
        if (domains.length === 0) {
          console.log('（无存储凭证）');
          return;
        }
        for (const d of domains) {
          const check = checkPermission(d);
          console.log(`  ${d}  ${check.ok ? '✓' : '✗ ' + check.detail}`);
        }
      }),
  )
  .addCommand(
    new Command('rm')
      .description('删除指定域名的凭证')
      .argument('<domain>')
      .action((domain: string) => {
        const removed = removeCredentials(domain);
        console.log(removed ? `✓ 已删除 ${normalizeDomain(domain)}` : `（${domain} 无存储凭证）`);
      }),
  );
