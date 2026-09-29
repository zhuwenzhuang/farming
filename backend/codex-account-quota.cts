import { spawn } from 'node:child_process';
import { resolveTerminalCodexExecutable } from './executable-discovery.cjs';

type RecordValue = Record<string, unknown>;
export interface AccountQuota {
  available: boolean;
  source: string;
  sampledAt: number;
  reason?: string;
  accountId?: string;
  planType?: string;
  limitId?: string;
  primary?: { usedPercent: number; windowMinutes: number; resetsAt: number | null } | null;
  secondary?: { usedPercent: number; windowMinutes: number; resetsAt: number | null } | null;
}
const SOURCE = 'Codex account/rateLimits/read';
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}
function windowLimit(value: unknown): AccountQuota['primary'] {
  const input = record(value);
  if (!input || typeof input.usedPercent !== 'number' || !Number.isFinite(input.usedPercent)
    || input.usedPercent < 0 || input.usedPercent > 100
    || typeof input.windowDurationMins !== 'number' || !Number.isFinite(input.windowDurationMins)
    || input.windowDurationMins <= 0) return null;
  return { usedPercent: input.usedPercent, windowMinutes: input.windowDurationMins,
    resetsAt: typeof input.resetsAt === 'number' && Number.isFinite(input.resetsAt) && input.resetsAt > 0 ? input.resetsAt * 1000 : null };
}
export function normalizeAccountQuota(value: unknown, sampledAt: number, accountId?: string): AccountQuota {
  const response = record(value);
  const buckets = record(response?.rateLimitsByLimitId);
  const limits = record(buckets ? buckets.codex : response?.rateLimits);
  const primary = windowLimit(limits?.primary); const secondary = windowLimit(limits?.secondary);
  if (!limits || (limits.limitId && limits.limitId !== 'codex') || (!primary && !secondary)) {
    return { available: false, source: SOURCE, sampledAt, reason: 'Account quota is unavailable.' };
  }
  return { available: true, source: SOURCE, sampledAt, accountId, limitId: 'codex',
    planType: typeof limits.planType === 'string' ? limits.planType : '', primary, secondary };
}

// A bounded read-only app-server session. Never create a thread or request a turn.
export function readCodexAccountQuota(home: string, options: {
  executable?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<AccountQuota> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, CODEX_HOME: home };
  const executable = options.executable || resolveTerminalCodexExecutable('', env.PATH || '').path || 'codex';
  return new Promise(resolve => {
    const unavailable = (reason: string): AccountQuota => ({ available: false, source: SOURCE, sampledAt: Date.now(), reason });
    let result: AccountQuota | null = null;
    let pending = ''; let bytes = 0; let expectedId = 1; let accountId: string | undefined;
    const child = spawn(executable, ['app-server'], { env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (value: AccountQuota) => {
      if (result) return;
      result = value;
      clearTimeout(timer);
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* The process may already have exited. */ }
    };
    const timer = setTimeout(() => finish(unavailable('Account quota read timed out.')), options.timeoutMs ?? 8_000);
    const send = (message: RecordValue) => { if (!result) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on('error', () => finish(unavailable('Account quota transport failed.')));
    child.on('error', () => finish(unavailable('Codex account reader could not start.')));
    child.on('close', () => {
      if (!result) finish(unavailable('Codex account reader exited without a result.'));
      resolve(result!);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (result) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { finish(unavailable('Account quota response exceeded its size limit.')); return; }
      pending += chunk;
      let newline: number;
      while (!result && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message: RecordValue | null;
        try { message = record(JSON.parse(line)); } catch { finish(unavailable('Invalid account quota response.')); return; }
        if (!message || message.id !== expectedId) continue;
        if (message.error) { finish(unavailable('Account quota request was rejected by Codex.')); return; }
        if (expectedId === 1) {
          expectedId = 2;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (expectedId === 2) {
          const account = record(record(message.result)?.account);
          if (account?.type !== 'chatgpt') { finish(unavailable('No ChatGPT account is signed in for this Agent Home.')); return; }
          accountId = typeof account.id === 'string' ? account.id : undefined;
          expectedId = 3;
          send({ id: 3, method: 'account/rateLimits/read' });
        } else finish(normalizeAccountQuota(message.result, Date.now(), accountId));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'farming_usage', version: '1.0.0' } } });
  });
}
