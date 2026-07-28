#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

function parseArgs(argv) {
  const options = { args: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === '--package-root') options.packageRoot = path.resolve(value());
    else if (arg === '--command') options.command = value();
    else if (arg === '--arg') options.args.push(value());
    else if (arg === '--timeout-ms') options.timeoutMs = Number(value());
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.packageRoot && options.command) {
    throw new Error('Use either --package-root or --command, not both');
  }
  if (!options.packageRoot && !options.command) {
    throw new Error('Use --package-root or --command');
  }
  return options;
}

function launchForOptions(options) {
  if (options.packageRoot) {
    const runtime = require(path.join(options.packageRoot, 'backend', 'acp-runtime'));
    return runtime.resolveAcpLaunch('claude');
  }
  return { command: options.command, args: options.args };
}

async function smokeClaudeAcp(options) {
  const launch = launchForOptions(options);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 20_000;
  const child = spawn(launch.command, launch.args, {
    cwd: options.packageRoot || process.cwd(),
    env: { ...process.env, CLAUDE_CODE_EXECUTABLE: process.execPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdoutBuffer = '';
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16_000);
  });

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Claude ACP initialize timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    timer.unref?.();
    const finish = (callback, value) => {
      clearTimeout(timer);
      callback(value);
    };
    child.once('error', error => finish(reject, error));
    child.once('exit', (code, signal) => {
      finish(
        reject,
        new Error(`Claude ACP exited before initialize: code=${code} signal=${signal || ''}${stderr ? `: ${stderr.trim()}` : ''}`),
      );
    });
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8');
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(reject, new Error(`Claude ACP wrote non-JSON stdout: ${line}`));
          return;
        }
        if (message.id === 1) {
          finish(resolve, message);
          return;
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: 'farming-release-smoke', version: '1' },
      },
    })}\n`);
  });

  child.kill('SIGTERM');
  if (response.error) {
    throw new Error(`Claude ACP initialize failed: ${JSON.stringify(response.error)}`);
  }
  if (response.result?.protocolVersion !== 1) {
    throw new Error(`Claude ACP selected unexpected protocol version: ${response.result?.protocolVersion}`);
  }
  if (response.result?.agentCapabilities?.sessionCapabilities?.fork == null) {
    throw new Error('Claude ACP initialize omitted session/fork');
  }
  if (response.result?.agentInfo?.version !== '0.59.0') {
    throw new Error(`Claude ACP selected unexpected version: ${response.result?.agentInfo?.version}`);
  }
  console.log(`✓ Claude ACP process initialized through ${launch.command} ${launch.args.join(' ')}`);
}

smokeClaudeAcp(parseArgs(process.argv.slice(2))).catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
