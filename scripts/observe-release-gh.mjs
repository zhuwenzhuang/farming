#!/usr/bin/env node
import { spawn } from 'node:child_process';

// Read failures are uncertain outcomes. Bound only this observation process;
// callers retain the workflow identity and never replay a release mutation.
const args = process.argv.slice(2);
const allowed = ['run view', 'run list', 'repo view'].includes(args.slice(0, 2).join(' '))
  || (args[0] === 'api' && !args.some(arg => /^(?:-[XFf]|--(?:method|field|raw-field|input)(?:=|$))/.test(arg)));
const timeoutMs = Number(process.env.FARMING_RELEASE_OBSERVATION_TIMEOUT_MS || 30_000);
if (!allowed || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
  console.error('Expected a read-only GitHub observation and a timeout between 1 and 60000ms.');
  process.exit(2);
}
const child = spawn('gh', args, { stdio: 'inherit', detached: process.platform !== 'win32' });
let forcedExit;
const killOwned = () => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
};
const timer = setTimeout(() => {
  forcedExit = 124;
  console.error(`GitHub observation exceeded ${timeoutMs}ms; workflow outcome remains unknown.`);
  killOwned();
}, timeoutMs);
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { forcedExit = code; killOwned(); });
}
child.once('error', error => {
  forcedExit = 127;
  clearTimeout(timer);
  console.error(`GitHub observation could not start: ${error.message}`);
  process.exitCode = 127;
});
child.once('close', code => {
  clearTimeout(timer);
  killOwned();
  process.exitCode = forcedExit ?? code ?? 1;
});
