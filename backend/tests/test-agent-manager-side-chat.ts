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
  manager.sideChatRequests = new Map();
  let records: Record<string, unknown>[] = [];
  manager.configManager = { listAgentSessionRecords: () => records };
  let calls = 0;
  let release: (() => void) | undefined;
  manager.forkAgent = async (id: string, mode: string, options: Record<string, unknown>) => {
    calls++;
    assert.equal(id, 'parent');
    assert.equal(mode, 'same-worktree');
    assert.equal(options.purpose, 'side-chat');
    assert.equal(options.expectedRevision, 7);
    await new Promise<void>(resolve => { release = resolve; });
    records = [{ sideChatParentSessionKey: parentKey, runtimeAgentId: 'child', providerSessionKey: encodeProviderSessionKey('codex', 'child-session', 'default') }];
    return { agentId: 'child' };
  };
  const first = manager.openSideChat('parent');
  const second = manager.openSideChat('parent');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'simultaneous windows must join the same fork');
  assert.ok(release); release();
  assert.deepEqual(await first, await second);
  assert.equal((await manager.openSideChat('parent')).agentId, 'child');
  assert.equal(calls, 1, 'opening a retained side chat cannot fork again');
  records.push({ sideChatParentSessionKey: parentKey, runtimeAgentId: 'conflict' });
  assert.match((await manager.openSideChat('parent')).error, /Multiple side chats/);
  records = [];
  Object.assign(parent, { lifecycleJournal: { entries: [{ type: 'fork', state: 'blocked', requestKey: 'fork-request:uncertain', request: { purpose: 'side-chat', expectedRevision: 3 } }] } });
  manager.forkAgent = async (_id: string, _mode: string, options: Record<string, unknown>) => {
    assert.equal(options.requestId, 'uncertain');
    assert.equal(options.expectedRevision, 3);
    return { error: 'Uncertain outcome', uncertain: true };
  };
  assert.equal((await manager.openSideChat('parent')).uncertain, true, 'recovery must reconcile the original request');
  Object.assign(parent, { sideChatParentSessionKey: 'codex:default:grandparent' });
  assert.match((await manager.openSideChat('parent')).error, /independent, durable/);
  assert.notEqual(forkRequestSignature(parent, 'same-worktree', { expectedRevision: 7 }),
    forkRequestSignature(parent, 'same-worktree', { expectedRevision: 7, purpose: 'side-chat' }),
    'ordinary forks cannot satisfy side-chat admission');
  manager.lifecycleCoordinator = { get: () => null };
  manager.agents.set('orphan', { id: 'orphan', sideChatParentSessionKey: 'missing-parent' });
  await assert.rejects(manager.sendComposerMessage('orphan', 'cannot resume'), /parent session is unavailable/);
  await assert.rejects(manager.sendComposerMessageNow('orphan', 'queued before parent stop'), /parent session is unavailable/);
  let released = 0;
  const watched = new Set<string>();
  const staleChild = { id: 'stale-side', sideChatParentSessionKey: parentKey,
    sideChatSupervisionExpiresAt: Date.now() - 1, runtimeBinding: { kind: 'acp', state: 'working' } };
  manager.agents = new Map([['stale-side', staleChild]]);
  manager.sessionPersistence = { persist: () => {} };
  manager.setSideChatSupervisionProbe((key: string) => watched.has(key));
  manager.retainSideChat = async (id: string, force: boolean) => { assert.equal(id, 'stale-side'); assert.equal(force, true); released++; return true; };
  watched.add('another-parent');
  await manager.reconcileSideChatSupervision();
  assert.equal(released, 1, 'another parent observer cannot keep this child alive');
  watched.add(parentKey);
  await manager.reconcileSideChatSupervision();
  assert.equal(staleChild.sideChatSupervisionExpiresAt, 0, 'reconnect before cleanup reacquires only the exact parent');
  assert.equal(released, 1);
  watched.delete(parentKey);
  await manager.reconcileSideChatSupervision();
  assert.ok(staleChild.sideChatSupervisionExpiresAt > Date.now(), 'disconnect has a bounded persisted lease');
  assert.equal(released, 1, 'initial disconnect does not immediately stop an active turn');
  const cleanupChild = { id: 'cleanup-side', providerSessionId: 'child-session', sideChatParentSessionKey: parentKey,
    sideChatRetained: true, runtimeBinding: { kind: 'acp', state: 'closed', error: '' }, status: 'running', engineStatus: 'running' };
  manager.agents = new Map([['cleanup-side', cleanupChild]]);
  manager.runAgentLifecycleOperation = async (_id: string, _key: string, _kind: string, _label: string, operation: () => Promise<unknown>) => operation();
  manager.acpRuntime = { retainAgent: async () => ({ retained: true, sessionId: 'child-session' }) };
  manager.emitStateChange = () => {};
  let cleanupAttempts = 0;
  manager.setSideChatResourceCleanup(async () => { if (++cleanupAttempts === 1) throw new Error('external cleanup uncertain'); });
  await assert.rejects(AgentManager.prototype.retainSideChat.call(manager, 'cleanup-side', true), /external cleanup uncertain/);
  assert.equal(cleanupChild.status, 'error');
  assert.equal(await AgentManager.prototype.retainSideChat.call(manager, 'cleanup-side', true), true);
  assert.equal(cleanupAttempts, 2, 'retained Provider state cannot bypass uncertain Resource cleanup');
  assert.equal(cleanupChild.status, 'running');
  assert.equal(cleanupChild.runtimeBinding.state, 'closed');
  console.log('side chat admission tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
