const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { atomicWriteJson } = require('../atomic-json-store.cjs');
const { FarmingSessionStore } = require('../farming-session-store.cjs');

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
  assert.strictEqual(index.version, 2);
  assert.strictEqual(index.providerSessionRecords, undefined, 'index v2 should own membership only');
  const legacyRecordId = store.getRecordForProviderSessionKey('agent-session:codex:legacy-session').id;
  assert(/^agent_/.test(legacyRecordId), 'legacy provider session should be mapped to a stable Agent record id');
  assert(fs.existsSync(path.join(root, 'sessions', `${legacyRecordId}.json`)));

  store.rememberMainPageSessionKey('agent-session:claude:claude-session', {
    cwd: '/repo',
    runtimeAgentId: 'agent-live-1',
  });
  index = readJson(indexFile);
  const claudeRecordId = store.getRecordForProviderSessionKey('agent-session:claude:claude-session').id;
  assert(/^agent_/.test(claudeRecordId));
  const claudeRecord = readJson(path.join(root, 'sessions', `${claudeRecordId}.json`));
  assert.strictEqual(claudeRecord.id, claudeRecordId);
  assert.strictEqual(claudeRecord.provider, 'claude');
  assert.strictEqual(claudeRecord.providerSessionId, 'claude-session');
  assert.strictEqual(claudeRecord.runtimeAgentId, 'agent-live-1');
  assert.strictEqual(claudeRecord.visibleOnMainPage, undefined, 'stable membership belongs only to index v2');
  assert.deepStrictEqual(store.getMainPageSessionKeys(), [
    'agent-session:claude:claude-session',
    'agent-session:codex:legacy-session',
  ]);

  store.rememberMainPageSessionKey('agent-session:claude:claude-session', {
    runtimeAgentId: 'agent-live-2',
  });
  assert.strictEqual(
    store.getRecordForProviderSessionKey('agent-session:claude:claude-session').id,
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
  assert.strictEqual(hiddenClaudeRecord.visibleOnMainPage, undefined);
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
  assert(/^agent_/.test(tempRecordId));
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
  assert.strictEqual(
    store.getRecordForProviderSessionKey('agent-session:codex:resolved-codex-session').id,
    tempRecordId,
  );
  const resolvedRecord = store.readRecord(tempRecordId);
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
  const resolvedMetadata = readJson(path.join(root, 'sessions', `${tempRecordId}.json`));
  const resolvedState = readJson(path.join(root, 'sessions', `${tempRecordId}.state.json`));
  assert.strictEqual(resolvedMetadata.recordVersion, 1);
  assert.strictEqual(resolvedMetadata.agentRecordId, tempRecordId);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resolvedMetadata, 'acpState'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(resolvedMetadata, 'attentionSeq'), false);
  assert.strictEqual(resolvedState.agentStateVersion, 1);
  assert.strictEqual(resolvedState.agentRecordId, tempRecordId);
  assert.strictEqual(resolvedState.acpState, 'idle');
  assert.strictEqual(fs.statSync(path.join(root, 'sessions', `${tempRecordId}.json`)).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(root, 'sessions', `${tempRecordId}.state.json`)).mode & 0o777, 0o600);
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
  assert.strictEqual(
    store.getRecordForProviderSessionKey('agent-session:codex:home:work:resolved-codex-session').id,
    workRecordId,
  );
  const workRecord = readJson(path.join(root, 'sessions', `${workRecordId}.json`));
  assert.strictEqual(workRecord.providerHomeId, 'work');
  assert.strictEqual(workRecord.providerHomePath, '/homes/codex-work');
  assert.strictEqual(workRecord.providerSessionId, 'resolved-codex-session');
  store.ensureRecordForAgent({
    id: 'agent-opencode-work',
    providerHomeId: 'work',
    providerHomePath: '/homes/opencode-work',
    providerSessionProvider: 'opencode',
    providerSessionId: 'ses_global_identity',
    providerSessionKey: 'agent-session:opencode:home:work:ses_global_identity',
    providerSessionTemporary: false,
  });
  assert.throws(
    () => store.ensureRecordForAgent({
      id: 'agent-opencode-default',
      providerHomeId: 'default',
      providerHomePath: '/homes/opencode',
      providerSessionProvider: 'opencode',
      providerSessionId: 'ses_global_identity',
      providerSessionKey: 'agent-session:opencode:ses_global_identity',
      providerSessionTemporary: false,
    }),
    /already bound to Agent Home "work"/,
    'one global OpenCode session must keep one stable Farming Home owner',
  );
  assert.throws(
    () => store.ensureRecordForAgent({
      id: 'agent-invalid-stable-rebind',
      persistentSessionId: workRecordId,
      providerSessionProvider: 'codex',
      providerSessionId: 'different-stable-session',
      providerSessionKey: 'agent-session:codex:home:work:different-stable-session',
      providerSessionTemporary: false,
    }),
    /already bound/,
    'one Agent record must not be rebound from one stable provider identity to another',
  );

  const legacyReadonlyId = 'fsess_readonly_upgrade';
  const legacyReadonlyFile = path.join(root, 'sessions', `${legacyReadonlyId}.json`);
  const legacyReadonlyRecord = {
    id: legacyReadonlyId,
    kind: 'agent',
    createdAt: 1,
    updatedAt: 2,
    runtimeAgentId: 'agent-legacy-runtime',
    command: 'codex',
    cwd: '/legacy/repo',
    projectWorkspace: '/legacy/repo',
    provider: 'codex',
    providerSessionId: '',
    providerSessionKey: '',
    providerSessionTemporary: true,
    agentRuntimeMode: 'acp',
    acpState: 'working',
    attentionSeq: 3,
    readAttentionSeq: 1,
    archived: false,
    visibleOnMainPage: true,
  };
  fs.writeFileSync(legacyReadonlyFile, JSON.stringify(legacyReadonlyRecord, null, 2));
  const legacyBytes = fs.readFileSync(legacyReadonlyFile);
  assert.strictEqual(store.readRecord(legacyReadonlyId).acpState, 'working');
  const upgradedRecordId = store.ensureRecordForAgent({
    id: 'agent-legacy-runtime',
    agentRecordId: legacyReadonlyId,
    persistentSessionId: legacyReadonlyId,
    command: 'codex',
    cwd: '/legacy/repo',
    projectWorkspace: '/legacy/repo',
    providerSessionProvider: 'codex',
    providerSessionId: '',
    providerSessionTemporary: true,
    agentRuntimeMode: 'acp',
    acpState: 'idle',
    attentionSeq: 4,
    readAttentionSeq: 1,
  });
  assert(/^agent_/.test(upgradedRecordId));
  assert.notStrictEqual(upgradedRecordId, legacyReadonlyId);
  assert.deepStrictEqual(fs.readFileSync(legacyReadonlyFile), legacyBytes, 'legacy fsess files must remain byte-for-byte read-only');
  assert.strictEqual(store.readRecord(upgradedRecordId).legacyRecordId, legacyReadonlyId);
  assert.strictEqual(store.readRecord(upgradedRecordId).acpState, 'idle');
  assert.strictEqual(store.readRecord(upgradedRecordId).attentionSeq, 4);
  assert.strictEqual(
    store.listAgentRecords().some(record => record.id === legacyReadonlyId),
    false,
    'a promoted legacy record must not be returned beside its Agent-record successor',
  );
  const upgradedMetadataFile = path.join(root, 'sessions', `${upgradedRecordId}.json`);
  const metadataBeforeStateUpdate = fs.readFileSync(upgradedMetadataFile);
  const stateUpdateRecordId = store.ensureRecordForAgent({
    id: 'agent-legacy-runtime',
    agentRecordId: upgradedRecordId,
    command: 'codex',
    cwd: '/legacy/repo',
    projectWorkspace: '/legacy/repo',
    providerSessionProvider: 'codex',
    providerSessionId: '',
    providerSessionTemporary: true,
    agentRuntimeMode: 'acp',
    acpState: 'working',
    attentionSeq: 5,
    readAttentionSeq: 1,
  });
  assert.strictEqual(stateUpdateRecordId, upgradedRecordId, 'the new Agent record id must work without its legacy alias');
  assert.deepStrictEqual(
    fs.readFileSync(upgradedMetadataFile),
    metadataBeforeStateUpdate,
    'an internal Agent-state update must not rewrite the outer metadata record',
  );
  assert.strictEqual(store.readRecord(upgradedRecordId).acpState, 'working');
  assert.strictEqual(store.readRecord(upgradedRecordId).attentionSeq, 5);

  const legacyProviderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-store-legacy-provider-'));
  const legacyProviderSessions = path.join(legacyProviderRoot, 'sessions');
  fs.mkdirSync(legacyProviderSessions, { recursive: true });
  const legacyProviderId = 'fsess_legacy_provider';
  const legacyProviderKey = 'agent-session:claude:legacy-provider-session';
  const legacyProviderFile = path.join(legacyProviderSessions, `${legacyProviderId}.json`);
  fs.writeFileSync(legacyProviderFile, JSON.stringify({
    id: legacyProviderId,
    kind: 'agent',
    createdAt: 1,
    updatedAt: 2,
    runtimeAgentId: 'agent-legacy-provider-runtime',
    command: 'claude',
    cwd: '/legacy/provider',
    projectWorkspace: '/legacy/provider',
    provider: 'claude',
    providerSessionId: 'legacy-provider-session',
    providerSessionKey: legacyProviderKey,
    providerSessionTemporary: false,
    agentRuntimeMode: 'acp',
    acpState: 'idle',
    archived: false,
    visibleOnMainPage: true,
  }, null, 2));
  fs.writeFileSync(path.join(legacyProviderSessions, 'index.json'), JSON.stringify({
    version: 1,
    mainPageSessionKeys: [legacyProviderKey],
    providerSessionRecords: { [legacyProviderKey]: legacyProviderId },
    updatedAt: 2,
  }, null, 2));
  const legacyProviderBytes = fs.readFileSync(legacyProviderFile);
  const legacyProviderStore = new FarmingSessionStore(
    legacyProviderRoot,
    { normalizeMainPageSessionKeys },
  );
  legacyProviderStore.init();
  assert.strictEqual(legacyProviderStore.getRecordForProviderSessionKey(legacyProviderKey).id, legacyProviderId);
  const upgradedProviderId = legacyProviderStore.ensureRecordForAgent({
    id: 'agent-legacy-provider-runtime',
    agentRecordId: legacyProviderId,
    persistentSessionId: legacyProviderId,
    command: 'claude',
    cwd: '/legacy/provider',
    projectWorkspace: '/legacy/provider',
    providerSessionProvider: 'claude',
    providerSessionId: 'legacy-provider-session',
    providerSessionKey: legacyProviderKey,
    providerSessionTemporary: false,
    agentRuntimeMode: 'acp',
    acpState: 'working',
  });
  assert(/^agent_/.test(upgradedProviderId));
  assert.deepStrictEqual(fs.readFileSync(legacyProviderFile), legacyProviderBytes);
  const upgradedIndex = readJson(path.join(legacyProviderSessions, 'index.json'));
  assert.strictEqual(upgradedIndex.version, 2);
  assert.strictEqual(upgradedIndex.providerSessionRecords, undefined);
  const restartedLegacyProviderStore = new FarmingSessionStore(
    legacyProviderRoot,
    { normalizeMainPageSessionKeys },
  );
  restartedLegacyProviderStore.init();
  assert.strictEqual(
    restartedLegacyProviderStore.getRecordForProviderSessionKey(legacyProviderKey).id,
    upgradedProviderId,
  );
  assert.deepStrictEqual(
    restartedLegacyProviderStore.listAgentRecords().map(record => record.id),
    [upgradedProviderId],
    'restart must expose only the writable successor of a read-only legacy provider record',
  );
  fs.rmSync(legacyProviderRoot, { recursive: true, force: true });

  const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-store-repair-'));
  const repairStore = new FarmingSessionStore(repairRoot, { normalizeMainPageSessionKeys });
  repairStore.init();
  const repairKey = 'agent-session:claude:repair-session';
  const repairId = repairStore.ensureRecordForAgent({
    id: 'agent-repair',
    providerSessionProvider: 'claude',
    providerSessionId: 'repair-session',
    providerSessionKey: repairKey,
    providerSessionTemporary: false,
  });
  const repairIndexFile = path.join(repairRoot, 'sessions', 'index.json');
  const brokenIndex = readJson(repairIndexFile);
  fs.writeFileSync(repairIndexFile, JSON.stringify(brokenIndex, null, 2));
  const repairedStore = new FarmingSessionStore(repairRoot, { normalizeMainPageSessionKeys });
  repairedStore.init();
  assert.strictEqual(
    repairedStore.getRecordForProviderSessionKey(repairKey).id,
    repairId,
    'startup must repair a record-written/index-missing crash cut',
  );

  repairedStore.rememberMainPageSessionKey(repairKey);
  const tombstone = repairedStore.readRecord(repairId);
  tombstone.archived = true;
  tombstone.runtimeAgentId = '';
  tombstone.lifecycleJournal = {
    sequence: 1,
    entries: [{
      id: 'aop_1',
      type: 'delete',
      state: 'succeeded',
      requestKey: 'delete',
      request: {},
      result: null,
      startedAt: 1,
      updatedAt: 2,
      finishedAt: 2,
      error: '',
    }],
  };
  fs.writeFileSync(
    path.join(repairRoot, 'sessions', `${repairId}.json`),
    JSON.stringify(tombstone, null, 2),
  );
  const tombstoneRepairedStore = new FarmingSessionStore(
    repairRoot,
    { normalizeMainPageSessionKeys },
  );
  tombstoneRepairedStore.init({ legacyMainPageSessionKeys: [repairKey] });
  assert.strictEqual(
    tombstoneRepairedStore.getMainPageSessionKeys().includes(repairKey),
    false,
    'a committed Delete tombstone must remove stale main-page membership on restart',
  );

  const duplicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-store-conflict-'));
  const duplicateStore = new FarmingSessionStore(duplicateRoot, { normalizeMainPageSessionKeys });
  duplicateStore.init();
  const duplicateKey = 'agent-session:claude:duplicate-session';
  const duplicateId = duplicateStore.ensureRecordForAgent({
    id: 'agent-duplicate-a',
    providerSessionProvider: 'claude',
    providerSessionId: 'duplicate-session',
    providerSessionKey: duplicateKey,
    providerSessionTemporary: false,
  });
  const duplicateRecord = duplicateStore.readRecord(duplicateId);
  fs.writeFileSync(
    path.join(duplicateRoot, 'sessions', 'fsess_duplicate_conflict.json'),
    JSON.stringify({
      ...duplicateRecord,
      id: 'fsess_duplicate_conflict',
      runtimeAgentId: 'agent-duplicate-b',
    }, null, 2),
  );
  assert.throws(
    () => new FarmingSessionStore(
      duplicateRoot,
      { normalizeMainPageSessionKeys },
    ).init(),
    /Conflicting Farming session records/,
    'duplicate canonical provider records must fail closed',
  );
  fs.rmSync(repairRoot, { recursive: true, force: true });
  fs.rmSync(duplicateRoot, { recursive: true, force: true });

  const failedMembershipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-session-membership-failure-'));
  let failIndexWrite = false;
  const membershipStore = new FarmingSessionStore(failedMembershipRoot, {
    normalizeMainPageSessionKeys,
    writeJson(file, value) {
      if (failIndexWrite && file.endsWith(`${path.sep}index.json`)) {
        throw new Error('simulated membership index failure');
      }
      atomicWriteJson(file, value, { mode: 0o600 });
    },
  });
  membershipStore.init();
  const failedMembershipIndex = path.join(failedMembershipRoot, 'sessions', 'index.json');
  const indexBeforeFailedMembership = fs.readFileSync(failedMembershipIndex, 'utf8');
  failIndexWrite = true;
  const failedMembershipKey = 'agent-session:claude:record-survives-index-failure';
  assert.throws(
    () => membershipStore.rememberMainPageSessionKey(failedMembershipKey),
    /membership index failure/,
  );
  assert.deepStrictEqual(membershipStore.getMainPageSessionKeys(), []);
  assert.strictEqual(fs.readFileSync(failedMembershipIndex, 'utf8'), indexBeforeFailedMembership);
  assert(
    membershipStore.getRecordForProviderSessionKey(failedMembershipKey),
    'a committed provider record should remain discoverable as History after membership commit fails',
  );
  failIndexWrite = false;
  const restartedMembershipStore = new FarmingSessionStore(
    failedMembershipRoot,
    { normalizeMainPageSessionKeys },
  );
  restartedMembershipStore.init();
  assert.deepStrictEqual(restartedMembershipStore.getMainPageSessionKeys(), []);
  assert(restartedMembershipStore.getRecordForProviderSessionKey(failedMembershipKey));

  restartedMembershipStore.setMainPageSessionKeys([
    failedMembershipKey,
    'agent-session:codex:second-membership',
  ]);
  const membershipBeforeFailedRemoval = restartedMembershipStore.getMainPageSessionKeys();
  const removalIndexBytes = fs.readFileSync(failedMembershipIndex, 'utf8');
  restartedMembershipStore.writeJson = () => {
    throw new Error('simulated bulk membership removal failure');
  };
  assert.throws(
    () => restartedMembershipStore.removeMainPageSessionKeys(membershipBeforeFailedRemoval),
    /bulk membership removal failure/,
  );
  assert.deepStrictEqual(restartedMembershipStore.getMainPageSessionKeys(), membershipBeforeFailedRemoval);
  assert.strictEqual(fs.readFileSync(failedMembershipIndex, 'utf8'), removalIndexBytes);
  fs.rmSync(failedMembershipRoot, { recursive: true, force: true });

  console.log('test-farming-session-store passed');
}

run();
