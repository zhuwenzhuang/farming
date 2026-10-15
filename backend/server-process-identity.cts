'use strict';

import { execFileSync } from 'child_process';

const SERVER_PROCESS_IDENTITY_FORMAT = 'ps-lstart-c-utc-v1';

interface ServerProcessIdentity {
  pid: number;
  processGroupId: number;
  startedAt: string;
  format: typeof SERVER_PROCESS_IDENTITY_FORMAT;
}

interface ExpectedServerProcessIdentity {
  pid?: unknown;
  processGroupId?: unknown;
  startedAt?: unknown;
}

function processLookupError(error: unknown): error is { status?: unknown; code?: unknown } {
  return typeof error === 'object' && error !== null;
}

function readProcessIdentity(pid: unknown, includeExited: boolean): ServerProcessIdentity | null {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0 || process.platform === 'win32') return null;
  let stdout;
  try {
    stdout = execFileSync(
      '/bin/ps',
      ['-p', String(processId), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'stat='],
      {
        encoding: 'utf8',
        timeout: 1_000,
        maxBuffer: 16_384,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      },
    );
  } catch (error) {
    if (processLookupError(error) && (error.status === 1 || error.code === 'ESRCH')) return null;
    if (processLookupError(error) && error.code === 'ENOENT') {
      throw new Error('Farming requires /bin/ps to verify process ownership. Install procps (Debian/Ubuntu) or procps-ng (RHEL/Rocky/CentOS), then retry.', { cause: error });
    }
    throw error;
  }
  const match = String(stdout || '').trim().match(/^(\d+)\s+(\d+)\s+(.+?)\s+(\S+)$/);
  if (!match || Number(match[1]) !== processId) return null;
  if (!includeExited && /^[ZXx]/.test(match[4])) return null;
  return {
    pid: processId,
    processGroupId: Number(match[2]),
    startedAt: match[3].trim(),
    format: SERVER_PROCESS_IDENTITY_FORMAT,
  };
}

// Group cleanup still needs an exited leader's identity to prove ownership of
// live descendants. Server liveness is a separate observation of the same ps row.
function readServerProcessIdentity(pid: unknown): ServerProcessIdentity | null {
  return readProcessIdentity(pid, true);
}

function readLiveServerProcessIdentity(pid: unknown): ServerProcessIdentity | null {
  return readProcessIdentity(pid, false);
}

function matchingProcessIdentity(
  expected: ExpectedServerProcessIdentity | null | undefined,
  current: ServerProcessIdentity | null | undefined,
): boolean {
  return Boolean(
    current
    && current.pid === Number(expected?.pid)
    && current.processGroupId === Number(expected?.processGroupId)
    && current.startedAt === String(expected?.startedAt || '')
  );
}

export {
  SERVER_PROCESS_IDENTITY_FORMAT,
  matchingProcessIdentity,
  readServerProcessIdentity,
  readLiveServerProcessIdentity,
};
export type {
  ExpectedServerProcessIdentity,
  ServerProcessIdentity,
};
