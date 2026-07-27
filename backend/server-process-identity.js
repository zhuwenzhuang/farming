const { execFileSync } = require('child_process');

const SERVER_PROCESS_IDENTITY_FORMAT = 'ps-lstart-c-utc-v1';

async function readServerProcessIdentity(pid) {
  const processId = Number(pid);
  if (!Number.isSafeInteger(processId) || processId <= 0 || process.platform === 'win32') return null;
  let stdout;
  try {
    stdout = execFileSync(
      '/bin/ps',
      ['-p', String(processId), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart='],
      {
        encoding: 'utf8',
        timeout: 1_000,
        maxBuffer: 16_384,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      },
    );
  } catch (error) {
    if (error?.status === 1 || error?.code === 'ESRCH') return null;
    throw error;
  }
  const match = String(stdout || '').trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
  if (!match || Number(match[1]) !== processId) return null;
  return {
    pid: processId,
    processGroupId: Number(match[2]),
    startedAt: match[3].trim(),
    format: SERVER_PROCESS_IDENTITY_FORMAT,
  };
}

function matchingProcessIdentity(expected, current) {
  return Boolean(
    current
    && current.pid === Number(expected?.pid)
    && current.processGroupId === Number(expected?.processGroupId)
    && current.startedAt === String(expected?.startedAt || '')
  );
}

module.exports = {
  SERVER_PROCESS_IDENTITY_FORMAT,
  matchingProcessIdentity,
  readServerProcessIdentity,
};
