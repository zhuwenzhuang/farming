#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function isReadOnlyObservation(args) {
  return ['run view', 'run list', 'repo view'].includes(args.slice(0, 2).join(' '))
    || (args[0] === 'api' && !args.some(arg => /^(?:-[XFf]|--(?:method|field|raw-field|input)(?:=|$))/.test(arg)));
}

// The deadline bounds the complete request, including process startup. Tests
// control the clock separately from fixture readiness instead of racing a cold
// interpreter against an artificially short network deadline.
export function observeGitHub(args, {
  timeoutMs = 30_000,
  spawnProcess = spawn,
  signals = process,
  killProcess = process.kill.bind(process),
  schedule = setTimeout,
  unschedule = clearTimeout,
  stderr = console.error,
  platform = process.platform,
  onStdout,
  maxOutputBytes = 2_000_000,
} = {}) {
  if (!isReadOnlyObservation(args) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || (onStdout !== undefined && typeof onStdout !== 'function')
    || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 20_000_000) {
    stderr('Expected a read-only GitHub observation and a timeout between 1 and 60000ms.');
    return Promise.resolve(2);
  }
  return new Promise(resolve => {
    const child = spawnProcess('gh', args, {
      stdio: onStdout ? ['ignore', 'pipe', 'ignore'] : 'inherit',
      detached: platform !== 'win32',
    });
    let forcedExit;
    let groupKilled = false;
    const killOwned = () => {
      if (!child.pid || groupKilled) return;
      try {
        if (platform === 'win32') child.kill('SIGKILL');
        else killProcess(-child.pid, 'SIGKILL');
        groupKilled = true;
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        groupKilled = true;
      }
    };
    if (onStdout) {
      let outputBytes = 0;
      child.stdout.on('data', chunk => {
        if (forcedExit !== undefined) return;
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          forcedExit = 125;
          stderr(`GitHub observation exceeded ${maxOutputBytes} output bytes; workflow outcome remains unknown.`);
          killOwned();
          return;
        }
        onStdout(chunk);
      });
    }
    const timer = schedule(() => {
      forcedExit = 124;
      stderr(`GitHub observation exceeded ${timeoutMs}ms; workflow outcome remains unknown.`);
      killOwned();
    }, timeoutMs);
    const handlers = [['SIGINT', 130], ['SIGTERM', 143]].map(([signal, code]) => {
      const handler = () => { forcedExit = code; killOwned(); };
      signals.once(signal, handler);
      return [signal, handler];
    });
    const finish = code => {
      unschedule(timer);
      for (const [signal, handler] of handlers) signals.removeListener(signal, handler);
      killOwned();
      resolve(forcedExit ?? code ?? 1);
    };
    // Cancellation can race asynchronous spawn completion. Once ownership is
    // established, kill the newly created group even if the deadline fired first.
    child.once('spawn', () => { if (forcedExit !== undefined) killOwned(); });
    child.once('error', error => {
      stderr(`GitHub observation could not start: ${error.message}`);
      finish(127);
    });
    child.once('close', finish);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  observeGitHub(process.argv.slice(2), {
    timeoutMs: Number(process.env.FARMING_RELEASE_OBSERVATION_TIMEOUT_MS || 30_000),
  }).then(code => { process.exitCode = code; });
}
