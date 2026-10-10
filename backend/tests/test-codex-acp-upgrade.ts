import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';

async function scenario(kind: 'writer' | 'air' | 'air-native' | 'standard' | 'recovery'): Promise<void> {
  const root = path.join(__dirname, '..', '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-upgrade-'));
  const resultFile = path.join(tmp, 'answer.json');
  const requestLog = path.join(tmp, 'requests.jsonl');
  const child = spawn(process.execPath, [path.join(root, 'dist/acp/codex-acp-2.2.2.mjs')], {
    cwd: root, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: tmp, CODEX_PATH: path.join(__dirname, 'fixtures/fake-codex-app-server.ts'),
      FARMING_TEST_ACTIVE_WRITER: kind === 'writer' ? '1' : '0',
      FARMING_TEST_USER_INPUT_RESULT_FILE: kind === 'writer' ? '' : resultFile,
      FARMING_TEST_REQUEST_LOG_FILE: requestLog, FARMING_TEST_SESSION_ENVIRONMENT: '1' },
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let schema: Record<string, { oneOf?: { const: string }[]; _meta?: Record<string, unknown> }> | undefined;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'elicitation/create') {
      schema = message.params.requestedSchema.properties;
      const noteName = Object.entries(schema || {}).find(([, field]) => field._meta?.codex
        && (field._meta.codex as { role: string }).role === 'user_note')?.[0];
      assert.ok(noteName, 'alternative answers must retain the generic note field');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
        result: { action: 'accept', content: { choice: kind === 'air' ? '  A third host  ' : 'None of the above',
          ...(kind !== 'air' ? { [noteName]: '  A third host  ' } : {}) } } }) + '\n');
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { data: message.error.data, code: message.error.code }));
    else request.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    await request('initialize', { protocolVersion: 1, clientInfo: { name: 'farming-upgrade-test', version: '1' },
      clientCapabilities: { elicitation: { form: {} }, ...(kind === 'air' || kind === 'air-native' ? { _meta: { jetbrains: { air: { version: 1, capabilities: [kind === 'air' ? 'customAnswer' : 'nativeSubagentSessions'] } } } } : {}) } });
    if (kind === 'writer') {
      await assert.rejects(request('session/load', { sessionId: '019f0000-0000-7000-8000-000000000999', cwd: tmp, mcpServers: [] }),
        (error: Error & { data?: { reason: string; threadId: string }; code?: number }) => {
          assert.equal(error.code, -32600);
          assert.equal(error.data?.reason, 'thread_active_writer');
          assert.equal(error.data?.threadId, '019f0000-0000-7000-8000-000000000999');
          assert.match(error.message, /another Codex client/);
          return true;
        });
      return;
    }
    const session = await request('session/new', { cwd: tmp, mcpServers: [],
      _meta: { farming: { env: { FARMING_AGENT_ID: 'upgrade-owner' } } } }) as { sessionId: string };
    if (kind === 'recovery') {
      const initial = JSON.parse(fs.readFileSync(requestLog, 'utf8').trim().split('\n')[0]);
      process.kill(initial.pid, 'SIGKILL');
      const deadline = Date.now() + 3000;
      for (;;) {
        try { process.kill(initial.pid, 0); }
        catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); break; }
        assert.ok(Date.now() < deadline, 'the exact owned app-server must terminate');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await request('authentication/status', {});
    }
    await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Choose a target' }] });
    assert.ok(schema, 'the pinned adapter must issue a real ACP elicitation');
    if (kind === 'recovery') {
      const requests = fs.readFileSync(requestLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(requests.filter(item => item.method === 'initialize').length, 2,
        'one crashed app-server must be replaced exactly once');
      const resumed = requests.find(item => item.method === 'thread/resume');
      assert.equal(resumed?.params.threadId, session.sessionId, 'recovery must resume the original Session');
      const environment = requests.filter(item => item.method === 'fixture/session-environment').at(-1);
      assert.equal(environment?.params.environment.FARMING_AGENT_ID, 'upgrade-owner',
        'recovery must retain the owning Agent environment');
    }
    assert.deepEqual(schema.choice.oneOf?.map(option => option.const), kind === 'air' ? ['Local', 'Remote'] : ['Local', 'Remote', 'None of the above']);
    const response = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.deepEqual(response.result.answers.choice.answers, ['None of the above', 'user_note: A third host']);
    const note = Object.values(schema).find(field => field._meta?.codex && (field._meta.codex as { role: string }).role === 'user_note');
    assert.ok(note);
    if (kind === 'air') assert.deepEqual(note._meta?.jetbrains, { air: { version: 1, customAnswer: true } });
    else assert.equal(note._meta?.jetbrains, undefined);
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    lines.close();
    const exited = child.exitCode === null && child.signalCode === null ? once(child, 'exit') : Promise.resolve();
    if (child.pid) {
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); }
      await exited;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
(async () => {
  for (const kind of ['writer', 'air', 'air-native', 'standard', 'recovery'] as const) await scenario(kind);
  console.log('Codex ACP upgrade: active writer rejection, AIR/standard choice round trips and crash recovery passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
