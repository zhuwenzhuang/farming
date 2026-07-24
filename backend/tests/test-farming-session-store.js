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
  }, {
    acpAdditionalDirectories: ['/shared/docs'],
    acpMcpServers: [{ name: 'docs', command: '/bin/docs-mcp', args: [], env: [] }],
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
  assert.deepStrictEqual(resolvedRecord.acpAdditionalDirectories, ['/shared/docs']);
  assert.deepStrictEqual(resolvedRecord.acpMcpServers, [
    { name: 'docs', command: '/bin/docs-mcp', args: [], env: [] },
  ]);
  assert.strictEqual(fs.statSync(path.join(root, 'sessions', `${tempRecordId}.json`)).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(indexFile).mode & 0o777, 0o600);

  store.ensureRecordForAgent({
    id: 'agent-renamed-codex',
    persistentSessionId: tempRecordId,
    providerSessionProvider: 'codex',
    providerSessionId: 'resolved-codex-session',
    providerSessionKey: 'agent-session:codex:resolved-codex-session',
    providerSessionTemporary: false,
    customTitle: '用户自定义名称',
  }, {
    customTitle: '用户自定义名称',
  });
  const resumedRecordId = store.ensureRecordForAgent({
    id: 'agent-resumed-without-title',
    providerSessionProvider: 'codex',
    providerSessionId: 'resolved-codex-session',
    providerSessionKey: 'agent-session:codex:resolved-codex-session',
    providerSessionTemporary: false,
    customTitle: '',
  });
  assert.strictEqual(resumedRecordId, tempRecordId);
  assert.strictEqual(
    store.readRecord(tempRecordId).customTitle,
    '用户自定义名称',
    'a resume snapshot without a custom title must not clear the Farming-owned name',
  );
  store.ensureRecordForAgent({
    id: 'agent-explicitly-cleared-title',
    providerSessionProvider: 'codex',
    providerSessionId: 'resolved-codex-session',
    providerSessionKey: 'agent-session:codex:resolved-codex-session',
    providerSessionTemporary: false,
    customTitle: '',
  }, {
    customTitle: '',
  });
  assert.strictEqual(
    store.readRecord(tempRecordId).customTitle,
    '',
    'an explicit empty custom-title patch must still clear the name',
  );

  const collisionKey = 'agent-session:codex:collision-session';
  const canonicalCollisionId = store.ensureRecordForAgent({
    id: 'agent-old-collision',
    providerSessionProvider: 'codex',
    providerSessionId: 'collision-session',
    providerSessionKey: collisionKey,
    providerSessionTemporary: false,
    customTitle: 'Canonical name',
    projectWorkspace: '/canonical/project',
    pinned: true,
    pinnedOrder: 512,
    attentionSeq: 9,
    readAttentionSeq: 7,
    attentionOutputEpoch: 'canonical-epoch',
    attentionOutputSeq: 90,
    readOutputEpoch: 'canonical-epoch',
    readOutputSeq: 80,
  });
  assert.strictEqual(
    store.getRecordForProviderSessionKey(collisionKey).id,
    canonicalCollisionId,
    'provider resume should load the canonical Farming session record through the index',
  );
  const temporaryCollisionId = store.ensureRecordForAgent({
    id: 'agent-new-collision',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid_collision',
    providerSessionTemporary: true,
    customTitle: 'Live temporary name',
    projectWorkspace: '/temporary/project',
    pinned: false,
    pinnedOrder: 2048,
    attentionSeq: 2,
    readAttentionSeq: 2,
    attentionOutputEpoch: 'temporary-epoch',
    attentionOutputSeq: 20,
    readOutputEpoch: 'temporary-epoch',
    readOutputSeq: 20,
  }, {
    visibleOnMainPage: true,
  });
  const reboundCollisionId = store.ensureRecordForAgent({
    id: 'agent-new-collision',
    persistentSessionId: temporaryCollisionId,
    providerSessionProvider: 'codex',
    providerSessionId: 'collision-session',
    providerSessionKey: collisionKey,
    providerSessionTemporary: false,
    customTitle: 'Live temporary name',
  });
  assert.strictEqual(reboundCollisionId, canonicalCollisionId);
  assert.strictEqual(
    store.readRecord(canonicalCollisionId).customTitle,
    'Canonical name',
    'provider confirmation must preserve the existing canonical product metadata',
  );
  const canonicalCollisionRecord = store.readRecord(canonicalCollisionId);
  assert.strictEqual(canonicalCollisionRecord.projectWorkspace, '/canonical/project');
  assert.strictEqual(canonicalCollisionRecord.pinned, true);
  assert.strictEqual(canonicalCollisionRecord.pinnedOrder, 512);
  assert.strictEqual(canonicalCollisionRecord.attentionSeq, 9);
  assert.strictEqual(canonicalCollisionRecord.readAttentionSeq, 7);
  assert.strictEqual(canonicalCollisionRecord.attentionOutputEpoch, 'canonical-epoch');
  assert.strictEqual(canonicalCollisionRecord.attentionOutputSeq, 90);
  assert.strictEqual(canonicalCollisionRecord.readOutputEpoch, 'canonical-epoch');
  assert.strictEqual(canonicalCollisionRecord.readOutputSeq, 80);
  const mergedTemporaryRecord = store.readRecord(temporaryCollisionId);
  assert.strictEqual(mergedTemporaryRecord.visibleOnMainPage, false);
  assert.strictEqual(mergedTemporaryRecord.archived, true);
  assert.strictEqual(mergedTemporaryRecord.runtimeAgentId, '');
  assert.strictEqual(mergedTemporaryRecord.mergedInto, canonicalCollisionId);
  store.ensureRecordForAgent({
    id: 'agent-new-collision',
    persistentSessionId: temporaryCollisionId,
    providerSessionProvider: 'codex',
    providerSessionId: 'collision-session',
    providerSessionKey: collisionKey,
    providerSessionTemporary: false,
    customTitle: 'Explicit live rename',
  }, {
    customTitle: 'Explicit live rename',
  });
  assert.strictEqual(
    store.readRecord(canonicalCollisionId).customTitle,
    'Explicit live rename',
    'an explicit user rename must still win while a stale temporary record is being rebound',
  );

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
