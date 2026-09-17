#!/usr/bin/env node
// Explicit opt-in, billed real-provider acceptance. Run after npm run build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import WebSocket from 'ws';
const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.env.FARMING_REAL_ARCHIVE, '1', 'Set FARMING_REAL_ARCHIVE=1 to authorize billed Luna prompts');
const root = fs.mkdtempSync(path.join(os.homedir(), '.farming-real-archive-'));
const config = path.join(root, 'config');
const home = path.join(root, 'codex');
const workspace = path.join(root, 'archive-demo');
const output = path.join(repo, '.tmp', path.basename(root));
for (const dir of [config, home, workspace, output]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), model: 'gpt-5.6-luna', effort: 'low', platform: process.platform, prompts: [], scenarios: [], cleanup: null };
let server, browser, page;
const log = fs.openSync(path.join(output, 'server.log'), 'w', 0o600);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const poll = async (fn, label, timeout = 90000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await delay(300); }
  throw new Error(`Timed out: ${label}`);
};
const record = (name, data = {}) => { report.scenarios.push({ name, ...data }); console.log(JSON.stringify({ name, ...data })); };
async function removeOwnedSockets() {
  const { acpRuntimeHostSocketPath } = require('../backend/acp-runtime-host-path.cjs');
  const { nativePtyHostSocketPath, nativePtyHostPrivateSocketNamePattern } = require('../backend/native-pty-host-path.cjs');
  const acp = acpRuntimeHostSocketPath(config);
  const pty = nativePtyHostSocketPath(config);
  const privatePattern = nativePtyHostPrivateSocketNamePattern(pty);
  const sockets = [acp, pty, ...fs.readdirSync(path.dirname(pty))
    .filter(name => privatePattern.test(name)).map(name => path.join(path.dirname(pty), name))];
  for (const socketPath of sockets) {
    if (!fs.existsSync(socketPath)) continue;
    assert(fs.lstatSync(socketPath).isSocket());
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('Socket cleanup probe timed out')); });
      socket.once('connect', () => { socket.destroy(); reject(new Error('Owned socket is still listening')); });
      socket.once('error', error => {
        if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve();
        else reject(error);
      });
    });
    fs.rmSync(socketPath, { force: true });
  }
  if (fs.existsSync(path.dirname(acp))) fs.rmdirSync(path.dirname(acp));
}
try {
  // Copy only the selected provider declaration; never copy sessions, MCPs, plugins or login state.
  execFileSync('python3', ['-c', `import tomllib,json,pathlib,sys
source=pathlib.Path.home()/'.codex/config.toml'
c=tomllib.loads(source.read_text()); p=c['model_provider']
data={'model':'gpt-5.6-luna','model_reasoning_effort':'low','model_provider':p,'approval_policy':'never','sandbox_mode':'workspace-write','model_providers':{p:c['model_providers'][p]}}
def dump(d, prefix=[]):
 out=[]
 if prefix: out.append('['+'.'.join(json.dumps(k) for k in prefix)+']')
 for k,v in d.items():
  if not isinstance(v,dict): out.append(json.dumps(k)+' = '+json.dumps(v,ensure_ascii=False))
 for k,v in d.items():
  if isinstance(v,dict): out.extend(dump(v,prefix+[k]))
 return out
pathlib.Path(sys.argv[1]).write_text('\\n'.join(dump(data))+'\\n')`, path.join(home, 'config.toml')]);
  fs.chmodSync(path.join(home, 'config.toml'), 0o600);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Archive acceptance demo\n');
  execFileSync('git', ['init', '-q', workspace]);
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    language: 'en', appearance: 'light', browserExtensionEnabled: false, computerExtensionEnabled: false,
    languageServerEnabled: false, agentHomes: { codex: [{ id: 'default', path: home,
      newAgentDefaults: { model: report.model, reasoning: report.effort, fast: 'off' } }] },
  }));
  const portProbe = net.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const base = `http://127.0.0.1:${port}/farming`;
  server = spawn(process.execPath, ['--import', 'tsx', 'scripts/start-playwright-server.ts'], {
    cwd: repo, detached: true, stdio: ['ignore', log, log], env: { ...process.env,
      PORT: String(port), FARMING_PLAYWRIGHT_CONFIG_DIR: config, FARMING_E2E_REAL_CODEX: '1',
      FARMING_DISABLE_AUTH: '1', FARMING_BASE_PATH: '/farming', CODEX_HOME: home,
    },
  });
  const api = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: globalThis.AbortSignal.timeout(95000) });
    const data = await res.json();
    assert(res.ok, `${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  await poll(async () => { try { return await api('/control/agents'); } catch { return false; } }, 'server ready');
  browser = await chromium.launch({ headless: true, ...(fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  await page.goto(base + '/');
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const row = id => page.locator(`[data-testid="code-agent-row"][data-agent-id="${id}"]`);
  const snapshot = async id => (await api(`/agents/${id}/acp-session?includeEntries=1`)).session;
  const pin = async id => {
    const session = await poll(async () => {
      const s = await snapshot(id);
      return s?.configOptions?.length ? s : false;
    }, 'provider config ready');
    const model = session.configOptions.find(o => o.category === 'model' || o.id === 'model');
    const effort = session.configOptions.find(o => /reasoning|thought|effort/.test(`${o.category} ${o.id}`));
    assert(model && effort, 'Provider must expose model and reasoning options');
    if (model.currentValue !== report.model || effort.currentValue !== report.effort) {
      await api(`/agents/${id}/acp-session`, { configOptions: [
        { configId: model.id, value: report.model }, { configId: effort.id, value: report.effort },
      ] }, 'PATCH');
    }
    const current = await snapshot(id);
    assert.equal(current.configOptions.find(o => o.id === model.id).currentValue, report.model);
    assert.equal(current.configOptions.find(o => o.id === effort.id).currentValue, report.effort);
    return current;
  };
  const create = async () => {
    const { agentId } = await api('/control/agents', { command: 'codex', workspace,
      agentRuntimeMode: 'acp', dangerouslySkipPermissions: true });
    const session = await pin(agentId);
    console.log(JSON.stringify({ created: agentId, sessionId: session.sessionId }));
    return agentId;
  };
  const select = async id => { await expect(row(id)).toBeVisible(); await row(id).click(); };
  const assistantCounts = new Map();
  const send = async (id, message) => {
    const session = await pin(id);
    assistantCounts.set(id, session.entries.filter(e => e.role === 'assistant').length);
    await select(id);
    const input = page.getByTestId('code-acp-composer-input');
    await expect(input).toBeEnabled();
    await input.fill(message);
    await page.getByTestId('code-acp-composer-send').click();
    await expect(input).toHaveValue('');
    report.prompts.push({ agentId: id, sessionId: session.sessionId, model: report.model, effort: report.effort });
  };
  const done = async (id, marker) => {
    await poll(async () => {
      const s = await snapshot(id);
      return s.entries.filter(e => e.role === 'assistant').length > assistantCounts.get(id) && s.entries.some(e => e.role === 'assistant' && JSON.stringify(e.content).includes(marker)) && s.state === 'idle' ? s : false;
    }, `reply ${marker}`, 150000);
    // Reply text must appear outside the composer in the real browser.
    await expect(page.getByTestId('code-agent-chat-view')).toContainText(marker, { timeout: 150000 });
  };
  const writer = sessionId => {
    const files = fs.readdirSync(path.join(home, 'sessions'), { recursive: true }).filter(f => String(f).endsWith('.jsonl') && String(f).includes(sessionId));
    assert.equal(files.length, 1);
    return execFileSync('lsof', ['-t', path.join(home, 'sessions', files[0])], { encoding: 'utf8' }).trim();
  };
  const archive = async (id, label, theme = 'light', trigger) => {
    const s = await snapshot(id);
    const start = Date.now();
    if (trigger) await trigger();
    else {
      await row(id).hover();
      await row(id).getByTestId('code-agent-row-archive').click();
    }
    await poll(async () => !(await api('/control/agents')).agents.some(a => a.id === id), `archive ${label}`);
    await expect(row(id)).toHaveCount(0);
    const files = fs.existsSync(path.join(home, 'archived_sessions')) ? fs.readdirSync(path.join(home, 'archived_sessions'), { recursive: true }).filter(f => String(f).endsWith('.jsonl')) : [];
    const match = files.find(f => String(f).includes(s.sessionId));
    const history = match ? fs.readFileSync(path.join(home, 'archived_sessions', match), 'utf8') : '';
    assert(match, `Missing archived history for ${s.sessionId}`);
    const persisted = fs.readdirSync(path.join(config, 'sessions')).filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(config, 'sessions', f), 'utf8')))
      .find(r => r.providerSessionId === s.sessionId && r.lifecycleJournal?.entries.some(e => e.type === 'archive'));
    assert(persisted?.archived, 'Farming record must be archived');
    assert.equal(persisted.lifecycleJournal.entries.filter(e => e.type === 'archive').at(-1).state, 'succeeded');
    const truth = JSON.parse(execFileSync('python3', ['-c', `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
print(json.dumps(c.execute('select archived,model from threads where id=?',(sys.argv[2],)).fetchone()))`, path.join(home, 'state_5.sqlite'), s.sessionId], { encoding: 'utf8' }));
    assert.equal(truth[0], 1, 'Codex database must mark the exact session archived');
    assert.equal(truth[1], report.model, 'Provider persisted model must be Luna');
    record(label, { sessionId: s.sessionId, elapsedMs: Date.now() - start, historyBytes: Buffer.byteLength(history), theme });
    return { sessionId: s.sessionId, history };
  };
  const empty = await create();
  await row(empty).hover();
  await row(empty).getByTestId('code-agent-row-archive').click();
  await poll(async () => !(await api('/control/agents')).agents.some(a => a.id === empty), 'empty session archive');
  await expect(row(empty)).toHaveCount(0);
  record('empty session archive without billed prompt');
  const peer = await create();
  await send(peer, 'Reply exactly ARCHIVE_PEER_READY. Do not use tools.');
  await done(peer, 'ARCHIVE_PEER_READY');
  record('real Luna preflight');
  for (const theme of ['light', 'dark', 'paper']) {
    await api('/settings', { appearance: theme });
    await page.reload();
    const id = await create();
    const marker = `ARCHIVE_${theme.toUpperCase()}_OK`;
    await send(id, `Reply exactly ${marker}. Do not use tools.`);
    await done(id, marker);
    await page.screenshot({ path: path.join(output, `${theme}-before.png`) });
    assert.equal(writer((await snapshot(id)).sessionId), writer((await snapshot(peer)).sessionId), 'Both sessions must have the same live writer');
    const result = await archive(id, `idle archive ${theme}`, theme);
    assert(result.history.includes(marker));
    await page.screenshot({ path: path.join(output, `${theme}-after.png`) });
    if (theme === 'light') report.restoreTarget = result.sessionId;
  }
  await send(peer, 'Reply exactly ARCHIVE_PEER_STILL_ALIVE. Do not use tools.');
  await done(peer, 'ARCHIVE_PEER_STILL_ALIVE');
  record('peer remains usable after three archives');
  const active = await create();
  await send(active, 'Use the shell to run exactly: touch archive-tool-started; sleep 20; touch archive-tool-finished. Then reply ARCHIVE_TOOL_FINISHED.');
  await poll(() => fs.existsSync(path.join(workspace, 'archive-tool-started')), 'real shell tool starts');
  assert.equal((await snapshot(active)).state, 'working');
  await archive(active, 'archive during real shell execution', 'paper');
  await send(peer, 'Reply exactly ARCHIVE_PEER_AFTER_CANCEL. Do not use tools.');
  await done(peer, 'ARCHIVE_PEER_AFTER_CANCEL');
  record('peer usable after cancellation and archive');
  // Additional scenarios are kept in this script so failed preflight cannot spend more turns.
  const restored = await api(`/agent-sessions/codex/${report.restoreTarget}/resume`, {
    providerHomeId: 'default', unarchiveArchived: true, agentRuntimeMode: 'chat', acpHistoryMode: 'load',
  });
  console.log(JSON.stringify({ resumeStatus: restored.status, agentId: restored.agentId }));
  const restoredId = restored.agentId;
  assert(restoredId, 'Resume must return an agent ID');
  assert.equal((await pin(restoredId)).sessionId, report.restoreTarget);
  await send(restoredId, 'What exact ARCHIVE_ marker did you reply earlier in this conversation? Reply only that marker.');
  await done(restoredId, 'ARCHIVE_LIGHT_OK');
  await archive(restoredId, 'restore same conversation and rearchive', 'paper');
  const coding = await create();
  await send(coding, 'In this workspace create sum.mjs exporting sum(a,b) and sum.test.mjs using node:assert/strict to test positive, negative and zero inputs. Run node sum.test.mjs. Do not install dependencies or change other files. When all tests pass reply CODE_TASK_VERIFIED.');
  await done(coding, 'CODE_TASK_VERIFIED');
  execFileSync(process.execPath, ['sum.test.mjs'], { cwd: workspace });
  const codingSession = (await snapshot(coding)).sessionId;
  await archive(coding, 'archive after actual code edit and test', 'paper');
  // Same-instance hard stop and fresh start must retain archive and resume identity.
  const { hardStopConfigProcesses } = require('../backend/config-process-ownership.cjs');
  assert.equal((await hardStopConfigProcesses(config)).refused, 0);
  await delay(150);
  assert(server.signalCode || server.exitCode !== null, 'Exact server must have stopped');
  server = spawn(process.execPath, ['--import', 'tsx', 'scripts/start-playwright-server.ts'], {
    cwd: repo, detached: true, stdio: ['ignore', log, log], env: { ...process.env,
      PORT: String(port), FARMING_PLAYWRIGHT_CONFIG_DIR: config, FARMING_E2E_REAL_CODEX: '1',
      FARMING_DISABLE_AUTH: '1', FARMING_BASE_PATH: '/farming', CODEX_HOME: home,
    },
  });
  await poll(async () => { try { return await api('/control/agents'); } catch { return false; } }, 'restart ready');
  await page.reload();
  const codingRestore = await api(`/agent-sessions/codex/${codingSession}/resume`, {
    providerHomeId: 'default', unarchiveArchived: true, agentRuntimeMode: 'chat', acpHistoryMode: 'load',
  });
  assert.equal((await pin(codingRestore.agentId)).sessionId, codingSession);
  await send(codingRestore.agentId, 'Run our existing sum.test.mjs again, do not edit any files, then reply RESTART_TEST_VERIFIED.');
  await done(codingRestore.agentId, 'RESTART_TEST_VERIFIED');
  record('hard restart, restore same code conversation, rerun real tests');
  await send(peer, 'Reply exactly PEER_AFTER_RESTART. Do not use tools.');
  await done(peer, 'PEER_AFTER_RESTART');
  // Exercise concurrent archive admissions, including a repeated command for one exact Agent.
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('WS handshake timed out')); }, 10000);
    socket.once('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'protocol-hello') {
        socket.send(JSON.stringify({ type: 'protocol-hello', protocolVersion: message.protocolVersion }));
        clearTimeout(timer); resolve();
      }
    });
  });
  try {
    const archiveRequests = [];
    const gate = new Promise(resolve => {
      archiveRequests.push(resolve);
    });
    let admissions = 0;
    const trigger = async () => {
      if (++admissions === 2) {
        for (const agentId of [codingRestore.agentId, peer, peer]) socket.send(JSON.stringify({ type: 'archive-agent', agentId }));
        archiveRequests[0]();
      }
      await gate;
    };
    await Promise.all([
      archive(codingRestore.agentId, 'concurrent archive restored coding session', 'paper', trigger),
      archive(peer, 'concurrent and repeated archive peer', 'paper', trigger),
    ]);
  } finally { socket.close(); }
  assert.equal((await api('/control/agents')).agents.filter(a => a.providerSessionProvider === 'codex' || a.provider === 'codex').length, 0);
  assert.equal(fs.existsSync(path.join(workspace, 'archive-tool-finished')), false,
    'The cancelled shell tool must not continue writing after Archive');
  record('cancelled shell tool has no late side effect');
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error.stack || error);
  console.error(report.error);
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  const { hardStopConfigProcesses } = require('../backend/config-process-ownership.cjs');
  try {
    report.cleanup = await hardStopConfigProcesses(config);
    await delay(100);
    assert.equal(report.cleanup.refused, 0, 'Cleanup must prove every owned process identity');
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await poll(() => server.exitCode !== null || server.signalCode !== null, 'owned server exits', 5000);
    }
    await removeOwnedSockets();
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    report.success = false;
    report.cleanupError = String(error);
    process.exitCode = 1;
  }
  fs.closeSync(log);
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${path.relative(repo, output)}`);
}
