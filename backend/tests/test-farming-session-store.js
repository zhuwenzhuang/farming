const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FarmingSessionStore } = require('../farming-session-store');

function normalizeMainPageSessionKeys(keys) {
  const result = [];
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== 'string') continue;
    const value = key.trim();
    if (!/^agent-session:[a-z][a-z0-9_-]*:.+$/i.test(value)) continue;
    if (value.includes('tmp_uuid')) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result.slice(0, 50);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-store-'));
  const store = new FarmingSessionStore(root, { normalizeMainPageSessionKeys });
  store.init({
    legacyMainPageSessionKeys: [
      'agent-session:codex:legacy-session',
      'agent-session:codex:tmp_uuid_11111111-2222-4333-8444-555555555555',
    ],
  });

  assert.deepStrictEqual(store.getMainPageSessionKeys(), ['agent-session:codex:legacy-session']);
  const indexFile = path.join(root, 'sessions', 'index.json');
  let index = readJson(indexFile);
  const legacyRecordId = index.providerSessionRecords['agent-session:codex:legacy-session'];
  assert(/^fsess_/.test(legacyRecordId), 'legacy provider session should be mapped to a stable Farming session id');
  assert(fs.existsSync(path.join(root, 'sessions', `${legacyRecordId}.json`)));

  store.rememberMainPageSessionKey('agent-session:claude:claude-session', {
    cwd: '/repo',
    runtimeAgentId: 'agent-live-1',
  });
  index = readJson(indexFile);
  const claudeRecordId = index.providerSessionRecords['agent-session:claude:claude-session'];
  assert(/^fsess_/.test(claudeRecordId));
  const claudeRecord = readJson(path.join(root, 'sessions', `${claudeRecordId}.json`));
  assert.strictEqual(claudeRecord.id, claudeRecordId);
  assert.strictEqual(claudeRecord.provider, 'claude');
  assert.strictEqual(claudeRecord.providerSessionId, 'claude-session');
  assert.strictEqual(claudeRecord.runtimeAgentId, 'agent-live-1');
  assert.strictEqual(claudeRecord.visibleOnMainPage, true);
  assert.deepStrictEqual(store.getMainPageSessionKeys(), [
    'agent-session:claude:claude-session',
    'agent-session:codex:legacy-session',
  ]);

  store.rememberMainPageSessionKey('agent-session:claude:claude-session', {
    runtimeAgentId: 'agent-live-2',
  });
  index = readJson(indexFile);
  assert.strictEqual(
    index.providerSessionRecords['agent-session:claude:claude-session'],
    claudeRecordId,
    'remembering the same provider session should reuse the stable Farming session file'
  );
  assert.strictEqual(
    readJson(path.join(root, 'sessions', `${claudeRecordId}.json`)).runtimeAgentId,
    'agent-live-2'
  );

  assert.strictEqual(store.removeMainPageSessionKey('agent-session:claude:claude-session'), true);
  assert.deepStrictEqual(store.getMainPageSessionKeys(), ['agent-session:codex:legacy-session']);
  const hiddenClaudeRecord = readJson(path.join(root, 'sessions', `${claudeRecordId}.json`));
  assert.strictEqual(hiddenClaudeRecord.visibleOnMainPage, false);
  assert(fs.existsSync(path.join(root, 'sessions', `${claudeRecordId}.json`)), 'history metadata should survive main-page removal');
  assert.strictEqual(
    store.setProviderSessionDisplayState('agent-session:claude:claude-session', { pinned: true }),
    claudeRecordId
  );
  assert.strictEqual(
    readJson(path.join(root, 'sessions', `${claudeRecordId}.json`)).displayPinned,
    true,
    'Farming pin overrides should persist in the stable provider session record'
  );
  store.setProviderSessionDisplayState('agent-session:claude:claude-session', { pinned: false });
  assert.strictEqual(readJson(path.join(root, 'sessions', `${claudeRecordId}.json`)).displayPinned, false);

  const tempRecordId = store.ensureRecordForAgent({
    id: 'agent-temp-codex',
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    providerSessionTemporary: true,
    terminalInputReceived: true,
    wantsMain: true,
    engineName: 'native',
    projectOrder: 4096,
    pinnedOrder: 2048,
  });
  assert(/^fsess_/.test(tempRecordId));
  const temporaryRecord = readJson(path.join(root, 'sessions', `${tempRecordId}.json`));
  assert.strictEqual(temporaryRecord.projectOrder, 4096);
  assert.strictEqual(temporaryRecord.pinnedOrder, 2048);
  assert.strictEqual(temporaryRecord.terminalInputReceived, true);
  assert.strictEqual(temporaryRecord.wantsMain, true);
  const resolvedRecordId = store.ensureRecordForAgent({
    id: 'agent-temp-codex',
    persistentSessionId: tempRecordId,
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    providerSessionProvider: 'codex',
    providerSessionId: 'resolved-codex-session',
    providerSessionKey: 'agent-session:codex:resolved-codex-session',
    providerSessionTemporary: false,
    providerSessionTitle: '看下cron worker怎么加新模块',
    agentRuntimeMode: 'acp',
    acpState: 'idle',
    engineName: 'native',
  });
  assert.strictEqual(resolvedRecordId, tempRecordId, 'resolved provider id should keep the original Farming session file');
  index = readJson(indexFile);
  assert.strictEqual(index.providerSessionRecords['agent-session:codex:resolved-codex-session'], tempRecordId);
  const resolvedRecord = readJson(path.join(root, 'sessions', `${tempRecordId}.json`));
  assert.strictEqual(resolvedRecord.providerSessionId, 'resolved-codex-session');
  assert.strictEqual(resolvedRecord.providerSessionTemporary, false);
  assert.strictEqual(resolvedRecord.providerSessionTitle, '看下cron worker怎么加新模块');
  assert.strictEqual(resolvedRecord.agentRuntimeMode, 'acp');
  assert.strictEqual(resolvedRecord.acpState, 'idle');
  assert.strictEqual(resolvedRecord.title, '看下cron worker怎么加新模块');

  const workRecordId = store.ensureRecordForAgent({
    id: 'agent-work-codex',
    command: 'codex',
    cwd: '/repo',
    providerHomeId: 'work',
    providerHomePath: '/homes/codex-work',
    providerSessionProvider: 'codex',
    providerSessionId: 'resolved-codex-session',
    providerSessionTemporary: false,
    engineName: 'native',
  });
  assert.notStrictEqual(workRecordId, resolvedRecordId, 'the same provider session id in another home needs its own Farming record');
  index = readJson(indexFile);
  assert.strictEqual(index.providerSessionRecords['agent-session:codex:home:work:resolved-codex-session'], workRecordId);
  const workRecord = readJson(path.join(root, 'sessions', `${workRecordId}.json`));
  assert.strictEqual(workRecord.providerHomeId, 'work');
  assert.strictEqual(workRecord.providerHomePath, '/homes/codex-work');
  assert.strictEqual(workRecord.providerSessionId, 'resolved-codex-session');

  console.log('test-farming-session-store passed');
}

run();
