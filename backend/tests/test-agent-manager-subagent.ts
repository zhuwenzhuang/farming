import assert from 'node:assert/strict';
const { AgentManager } = require('../agent-manager.cjs');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');
const { forkRequestSignature } = require('../fork-operation-coordinator.cjs');

async function run() {
  const parentKey = encodeProviderSessionKey('codex', 'parent-session', 'default');
  const parent = { id: 'parent', persistentSessionId: 'parent-record', providerSessionKey: parentKey,
    runtimeBinding: { kind: 'acp', state: 'working', sessionRevision: 7 } };
  const manager = Object.create(AgentManager.prototype);
  manager.recoveryGate = { wait: async () => {} };
  manager.agents = new Map([['parent', parent]]);
  manager.subagentRequests = new Map();
  let records: Record<string, unknown>[] = [];
  manager.configManager = { listAgentSessionRecords: () => records };
  let resumes = 0;
  let resumeError = '';
  const childKey = encodeProviderSessionKey('codex', 'child-session', 'default');
  const resumeSession = async (provider: string, sessionId: string, homeId: string) => {
    resumes++;
    assert.equal(provider, 'codex');
    assert.equal(sessionId, 'child-session');
    assert.equal(homeId, 'default');
    if (resumeError) return { error: resumeError };
    manager.agents.set('resumed-child', { id: 'resumed-child', providerSessionKey: childKey,
      subagentParentSessionKey: parentKey, status: 'running', archived: false });
    return { agentId: 'resumed-child' };
  };
  const openSubagent = (id: string) => manager.openSubagent(id, resumeSession);
  manager.emitStateChange = () => {};
  manager.runAgentLifecycleOperation = async (_id: string, _key: string, _kind: string, _label: string, operation: () => Promise<unknown>) => operation();
  let calls = 0;
  let release: (() => void) | undefined;
  manager.forkAgent = async (id: string, mode: string, options: Record<string, unknown>) => {
    calls++;
    assert.equal(id, 'parent');
    assert.equal(mode, 'same-worktree');
    assert.equal(options.purpose, 'subagent');
    assert.equal(options.expectedRevision, 7);
    await new Promise<void>(resolve => { release = resolve; });
    records = [{ subagentParentSessionKey: parentKey, runtimeAgentId: 'child', providerSessionKey: childKey,
      provider: 'codex', providerSessionId: 'child-session', providerHomeId: 'default' }];
    manager.agents.set('child', { id: 'child', providerSessionKey: childKey, subagentParentSessionKey: parentKey, status: 'running' });
    return { agentId: 'child' };
  };
  const first = openSubagent('parent');
  const second = openSubagent('parent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'simultaneous windows must join the same fork');
  assert.ok(release); release();
  assert.deepEqual(await first, await second);
  assert.equal((await openSubagent('parent')).agentId, 'child');
  assert.equal(calls, 1, 'opening a retained subagent cannot fork again');
  assert.equal(resumes, 0, 'an attached child needs no resume');
  manager.agents.delete('child');
  records[0].archived = true;
  records[0].runtimeAgentId = '';
  const reopened = await Promise.all([openSubagent('parent'), openSubagent('parent')]);
  assert.equal(resumes, 1, 'concurrent archived opens share one exact resume');
  assert.equal(reopened[0].agentId, 'resumed-child');
  assert.deepEqual(reopened[0], reopened[1]);
  assert.equal(calls, 1, 'archived children never fork again');
  manager.agents.delete('resumed-child');
  records[0].archived = false;
  resumeError = 'Provider resume rejected';
  assert.match((await openSubagent('parent')).error, /Provider resume rejected/);
  resumeError = '';
  assert.equal((await openSubagent('parent')).agentId, 'resumed-child', 'cold child reattaches after restart');
  manager.agents.get('resumed-child').subagentParentSessionKey = 'wrong-parent';
  const mismatch = await manager.openSubagent('parent', async () => ({ agentId: 'resumed-child' }));
  assert.equal(mismatch.uncertain, true, 'a mismatched resume cannot report success');
  records.push({ subagentParentSessionKey: parentKey, runtimeAgentId: 'conflict' });
  assert.match((await openSubagent('parent')).error, /Multiple subagents/);
  records = [];
  Object.assign(parent, { lifecycleJournal: { entries: [{ type: 'fork', state: 'blocked', requestKey: 'fork-request:uncertain', request: { purpose: 'subagent', expectedRevision: 3 } }] } });
  manager.forkAgent = async (_id: string, _mode: string, options: Record<string, unknown>) => {
    assert.equal(options.requestId, 'uncertain');
    assert.equal(options.expectedRevision, 3);
    return { error: 'Uncertain outcome', uncertain: true };
  };
  assert.equal((await openSubagent('parent')).uncertain, true, 'recovery must reconcile the original request');
  Object.assign(parent, { subagentParentSessionKey: 'codex:default:grandparent' });
  assert.match((await openSubagent('parent')).error, /independent, durable/);
  assert.notEqual(forkRequestSignature(parent, 'same-worktree', { expectedRevision: 7 }),
    forkRequestSignature(parent, 'same-worktree', { expectedRevision: 7, purpose: 'subagent' }),
    'ordinary forks cannot satisfy subagent admission');
  manager.lifecycleCoordinator = { get: () => null };
  manager.agents.set('orphan', { id: 'orphan', subagentParentSessionKey: 'missing-parent' });
  await assert.rejects(manager.sendComposerMessage('orphan', 'cannot resume'), /parent session is unavailable/);
  await assert.rejects(manager.sendComposerMessageNow('orphan', 'queued before parent stop'), /parent session is unavailable/);
  let released = 0;
  const watched = new Set<string>();
  const staleChild = { id: 'stale-subagent', subagentParentSessionKey: parentKey,
    subagentSupervisionExpiresAt: Date.now() - 1, runtimeBinding: { kind: 'acp', state: 'working' } };
  manager.agents = new Map([['stale-subagent', staleChild]]);
  manager.sessionPersistence = { persist: () => {} };
  manager.setSubagentSupervisionProbe((key: string) => watched.has(key));
  manager.retainSubagent = async (id: string, force: boolean) => { assert.equal(id, 'stale-subagent'); assert.equal(force, false); released++; return true; };
  watched.add('another-parent');
  await manager.reconcileSubagentSupervision();
  assert.equal(released, 0, 'disconnect never interrupts an accepted turn');
  for (const state of ['waiting-for-permission', 'waiting-for-input', 'interrupting']) {
    staleChild.runtimeBinding.state = state;
    await manager.reconcileSubagentSupervision();
    assert.equal(released, 0, `${state} survives supervision expiry`);
  }
  staleChild.runtimeBinding.state = 'idle';
  await manager.reconcileSubagentSupervision();
  assert.equal(released, 1, 'only a settled child releases after disconnect');
  watched.add(parentKey);
  await manager.reconcileSubagentSupervision();
  assert.equal(staleChild.subagentSupervisionExpiresAt, 0, 'reconnect before cleanup reacquires only the exact parent');
  assert.equal(released, 1);
  watched.delete(parentKey);
  await manager.reconcileSubagentSupervision();
  assert.ok(staleChild.subagentSupervisionExpiresAt > Date.now(), 'disconnect has a bounded persisted lease');
  assert.equal(released, 1, 'initial disconnect does not immediately stop an active turn');
  const cleanupChild = { id: 'cleanup-subagent', providerSessionId: 'child-session', subagentParentSessionKey: parentKey,
    subagentRetained: true, runtimeBinding: { kind: 'acp', state: 'closed', error: '' }, status: 'running', engineStatus: 'running' };
  manager.agents = new Map([['cleanup-subagent', cleanupChild]]);
  manager.runAgentLifecycleOperation = async (_id: string, _key: string, _kind: string, _label: string, operation: () => Promise<unknown>) => operation();
  manager.acpRuntime = { retainAgent: async () => ({ retained: true, sessionId: 'child-session' }) };
  manager.emitStateChange = () => {};
  let cleanupAttempts = 0;
  manager.setSubagentResourceCleanup(async () => { if (++cleanupAttempts === 1) throw new Error('external cleanup uncertain'); });
  await assert.rejects(AgentManager.prototype.retainSubagent.call(manager, 'cleanup-subagent', true), /external cleanup uncertain/);
  assert.equal(cleanupChild.status, 'error');
  assert.equal(await AgentManager.prototype.retainSubagent.call(manager, 'cleanup-subagent', true), true);
  assert.equal(cleanupAttempts, 2, 'retained Provider state cannot bypass uncertain Resource cleanup');
  assert.equal(cleanupChild.status, 'running');
  assert.equal(cleanupChild.runtimeBinding.state, 'closed');
  // Archive ordering is owned by the parent lifecycle, including failure.
  const archiveParent = { id: 'archive-parent', providerSessionKey: parentKey, runtimeBinding: { kind: 'acp', state: 'idle' }, providerSessionProvider: 'codex', providerSessionId: 'parent-session' };
  const archiveChild = { id: 'archive-child', providerSessionKey: 'child-key', subagentParentSessionKey: parentKey, runtimeBinding: { kind: 'acp', state: 'idle' } };
  const order: string[] = [];
  const archiveManager = Object.create(AgentManager.prototype);
  archiveManager.agents = new Map<string, typeof archiveParent | typeof archiveChild>([['archive-parent', archiveParent], ['archive-child', archiveChild]]);
  archiveManager.configManager = { listAgentSessionRecords: () => [] };
  archiveManager.lifecycleJournalService = { begin: () => ({ operation: { id: 'archive-op' } }), transition: () => {} };
  archiveManager.emitStateChange = () => {};
  archiveManager.providerSessionMutationCoordinator = { run: (request: { operation: () => Promise<unknown> }) => request.operation() };
  archiveManager.acpRuntime = { archiveSession: async () => { order.push('parent-provider'); return true; } };
  archiveManager.killAgent = async () => { order.push('parent-stop'); return {}; };
  archiveManager.mainPageSessionIndex = { removeAgents: () => [] };
  archiveManager.forgetStoppedAgentRecord = () => {};
  archiveManager.archiveAgent = async (id: string) => { order.push(id); return { archived: true }; };
  await archiveManager.performArchiveAgent('archive-parent', { recordHistory: false }, Symbol('archive'));
  assert.deepEqual(order, ['archive-child', 'parent-provider', 'parent-stop']);
  order.length = 0;
  archiveManager.archiveAgent = async () => { throw new Error('child archive uncertain'); };
  const rejected = await archiveManager.performArchiveAgent('archive-parent', { recordHistory: false }, Symbol('archive'));
  assert.match(rejected.error, /child archive uncertain/);
  assert.deepEqual(order, [], 'uncertain child archive must not touch the parent provider or publish success');
  const coldKey = encodeProviderSessionKey('codex', 'cold-child', 'default');
  archiveManager.agents = new Map([['archive-parent', archiveParent]]);
  archiveManager.configManager = { listAgentSessionRecords: () => [{ id: 'cold-record',
    runtimeAgentId: '', providerSessionKey: coldKey, providerSessionId: 'cold-child', providerSessionProvider: 'codex',
    subagentParentSessionKey: parentKey, subagentRetained: true, runtimeBinding: { kind: 'acp', state: 'closed' },
  }, { id: 'other-home', providerSessionKey: encodeProviderSessionKey('codex', 'cold-child', 'other'),
    subagentParentSessionKey: encodeProviderSessionKey('codex', 'parent-session', 'other'),
  }] };
  archiveManager.archiveAgent = async (id: string) => {
    assert.equal(id, 'cold-record');
    const recovered = archiveManager.agents.get(id);
    assert.equal(recovered.providerSessionKey, coldKey);
    assert.equal(recovered.subagentRetained, true);
    assert.equal(recovered.status, 'stopped', 'cold archival must not resume the child');
    return { archived: true };
  };
  await archiveManager.archiveOwnedSideChats(archiveParent, {});
  assert.equal(archiveManager.agents.has('other-home'), false, 'same session IDs in another home are unrelated');
  archiveManager.agents.set('cold-record', { id: 'cold-record', providerSessionKey: 'unrelated' });
  await assert.rejects(archiveManager.archiveOwnedSideChats(archiveParent, {}), /belongs to another session/);
  const closedParent = { ...parent, subagentParentSessionKey: '', archived: true };
  manager.agents = new Map([['parent', closedParent]]);
  assert.match((await openSubagent('parent')).error, /archived or removed/);
  console.log('subagent admission tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
