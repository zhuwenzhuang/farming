import { spawn } from 'node:child_process';

/** A read-only discovery probe owns its complete temporary process group. */
export function runDiscoveryCommand(command: string, args: string[], options: {
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  includeStderr?: boolean;
}): Promise<string | null> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let bytes = 0;
    let failed = false;
    const kill = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* This exact probe may already have exited. */ }
    };
    const timer = setTimeout(() => { failed = true; kill(); }, options.timeoutMs);
    const consume = (chunk: string, stdout: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) { failed = true; kill(); return; }
      if (stdout || options.includeStderr) output += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => consume(chunk, true));
    child.stderr.on('data', (chunk: string) => consume(chunk, false));
    child.stdin.on('error', () => { /* Process failure is reported by close. */ });
    child.stdin.end();
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      kill();
      resolve(!failed && code === 0 ? output : null);
    });
  });
}
