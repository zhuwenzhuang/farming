import assert from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface RpcMessage {
  error?: unknown;
  id?: number;
  method?: string;
  params?: { update?: Record<string, unknown> };
  result?: { sessionId?: string; sessions?: unknown[] };
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-pi-acp-vendor-'));
  const agentHome = path.join(root, 'agent-home');
  const adapterState = path.join(root, 'adapter-state');
  const globalHome = path.join(root, 'global-home');
  const fakePi = path.join(root, 'fake-pi.cjs');
  const launchLog = path.join(root, 'pi-launch.json');
  const vendorEntry = path.resolve(__dirname, '..', '..', 'dist', 'acp', 'pi-acp-0.0.33.mjs');
  let child: ChildProcess | null = null;
  try {
    fs.mkdirSync(agentHome, { recursive: true });
    fs.mkdirSync(globalHome, { recursive: true });
    const defaultSessionDirectory = path.join(agentHome, 'sessions', '--default--');
    fs.mkdirSync(defaultSessionDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(defaultSessionDirectory, 'default-session.jsonl'),
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'must-not-leak-from-default',
        timestamp: '2026-08-13T00:00:00.000Z',
        cwd: root,
      })}\n`,
    );
    fs.writeFileSync(
      path.join(agentHome, 'settings.json'),
      `${JSON.stringify({ sessionDir: 'relative-sessions' })}\n`,
    );
    fs.writeFileSync(fakePi, `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const readline = require('readline');
if (process.argv.includes('--mode')) {
  fs.writeFileSync(process.env.FARMING_FAKE_PI_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    agentHome: process.env.PI_CODING_AGENT_DIR,
  }));
}
const sessionFile = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions', '--fake--', 'fake.jsonl');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === 'get_state') data = {
    sessionId: 'pi-farming-smoke',
    sessionFile,
    thinkingLevel: 'medium',
    model: { provider: 'fake', id: 'model' },
  };
  else if (request.type === 'get_available_models') data = {
    models: [{ provider: 'fake', id: 'model', name: 'Smoke Model' }],
  };
  else if (request.type === 'get_commands') data = { commands: [] };
  else if (request.type === 'get_session_stats') data = {
    cost: 0.25,
    contextUsage: { tokens: 2048, contextWindow: 131072, percent: 1.5625 },
  };
  process.stdout.write(JSON.stringify({
    type: 'response', id: request.id, command: request.type, success: true, data,
  }) + '\\n');
  if (request.type === 'prompt') {
    process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n');
    process.stdout.write(JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'fake answer' },
    }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n');
  }
});
`);
    fs.chmodSync(fakePi, 0o755);

    child = spawn(process.execPath, [
      vendorEntry,
      '--farming-pi-command', fakePi,
      '--farming-pi-acp-state-dir', adapterState,
      '--farming-append-system-prompt', 'Farming bootstrap smoke',
    ], {
      cwd: root,
      env: {
        ...process.env,
        HOME: globalHome,
        FARMING_FAKE_PI_LOG: launchLog,
        PI_CODING_AGENT_DIR: agentHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const pending = new Map<number, (message: RpcMessage) => void>();
    const updates: Array<Record<string, unknown>> = [];
    child.stderr!.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_000); });
    child.stdout!.on('data', chunk => {
      stdout += chunk.toString('utf8');
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as RpcMessage;
        if (typeof message.id === 'number') pending.get(message.id)?.(message);
        else if (message.method === 'session/update' && message.params?.update) {
          updates.push(message.params.update);
        }
      }
    });
    const request = (id: number, method: string, params: Record<string, unknown>) => (
      new Promise<RpcMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} timed out: ${stderr}`)), 10_000);
        pending.set(id, message => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        });
        child!.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      })
    );

    const initialized = await request(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'farming-test', version: '1' },
    });
    assert.strictEqual(initialized.error, undefined);
    const listed = await request(2, 'session/list', {});
    assert.strictEqual(listed.error, undefined);
    assert.deepStrictEqual(
      listed.result?.sessions,
      [],
      'a relative Pi sessionDir must not silently fall back to the default Agent Home directory',
    );
    const opened = await request(3, 'session/new', { cwd: root, mcpServers: [] });
    assert.strictEqual(opened.error, undefined);
    assert.strictEqual(opened.result?.sessionId, 'pi-farming-smoke');
    const prompted = await request(4, 'session/prompt', {
      sessionId: 'pi-farming-smoke',
      prompt: [{ type: 'text', text: 'usage smoke' }],
    });
    assert.strictEqual(prompted.error, undefined);
    assert.deepStrictEqual(
      updates.find(update => update.sessionUpdate === 'usage_update'),
      {
        sessionUpdate: 'usage_update',
        used: 2048,
        size: 131072,
        cost: { amount: 0.25, currency: 'USD' },
      },
      'Pi Chat must publish its live context window and session cost after each settled turn',
    );

    const launch = JSON.parse(fs.readFileSync(launchLog, 'utf8')) as {
      argv: string[];
      agentHome: string;
    };
    assert.deepStrictEqual(launch.argv.slice(0, 3), ['--mode', 'rpc', '--no-themes']);
    const promptIndex = launch.argv.indexOf('--append-system-prompt');
    assert(promptIndex >= 0, 'the Farming bootstrap must be passed to the Pi child');
    assert.strictEqual(launch.argv[promptIndex + 1], 'Farming bootstrap smoke');
    assert.strictEqual(launch.agentHome, agentHome);
    const sessionMap = JSON.parse(fs.readFileSync(path.join(adapterState, 'session-map.json'), 'utf8'));
    assert(sessionMap.sessions['pi-farming-smoke'], 'the Pi ACP map must live in its scoped state directory');
    assert.strictEqual(
      fs.existsSync(path.join(globalHome, '.pi', 'pi-acp', 'session-map.json')),
      false,
      'the vendored adapter must not write its upstream global state path',
    );
    console.log('Pi ACP vendor session, usage, bootstrap, and Agent Home isolation tests passed');
  } finally {
    if (child) await stopChild(child);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
