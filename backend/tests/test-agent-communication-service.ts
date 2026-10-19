import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { Task, TaskState, SendMessageRequest } from '@a2a-js/sdk';
import { AgentCommunicationService, type CommunicationPorts } from '../agent-communication-service.cts';
import type { CommunicationGrant } from '../agent-communication-credentials.cts';

const grant: CommunicationGrant = { id: 'grant', principal: { kind: 'external', peerId: 'builder', name: 'Builder' }, targets: ['target'], expiresAt: Date.now() + 60000 };
const message = (text = 'verify', id = 'message-1') => SendMessageRequest.fromJSON({ message: { messageId: id, role: 'ROLE_USER', parts: [{ text }] } });
const ports = (execute: CommunicationPorts['execute']): CommunicationPorts => ({
  resolveTarget: async () => ({ agentId: 'target', sessionKey: 'exact-session', name: 'Target' }),
  resolveSource: async () => ({ version: 1, direction: 'incoming', senderAddress: 'external:builder', senderName: 'Builder' }),
  execute,
});

test('journal capacity measures persisted bytes and preserves readable history on rejection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-journal-capacity-'));
  let executions = 0;
  const service = new AgentCommunicationService(root, ports(async () => { executions++; return { text: '' }; }));
  const file = path.join(root, 'agent-communications.json');
  const limit = 32 * 1024 * 1024;
  try {
    const records = Array.from({ length: 256 }, (_, index) => ({
      version: 1, owner: 'external:builder', messageId: `saved-${index}`, hash: 'a'.repeat(64), delivery: 'completed',
      execution: { requestId: `request-${index}`, taskId: `task-${index}`, contextId: `ctx-${index}`, text: '',
        target: { agentId: 'target', sessionKey: 'exact-session', name: 'Target' },
        source: { version: 1, direction: 'incoming', senderAddress: 'external:builder', senderName: 'Builder' } },
      task: Task.toJSON(Task.fromJSON({ id: `task-${index}`, contextId: `ctx-${index}`,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-01-01T00:00:00.000Z' } })),
    }));
    // Production-shaped history: bounded input and result per record, with room
    // for only 512 more serialized bytes. Each text stays below the 64 KiB limit.
    const value = { version: 1, records };
    for (const record of records) record.task = Task.toJSON(Task.fromJSON({ ...record.task as object,
      artifacts: [{ artifactId: record.execution.taskId, parts: [{ text: '' }] }] }));
    const remaining = limit - 512 - Buffer.byteLength(JSON.stringify(value, null, 2));
    const perText = Math.floor(remaining / (records.length * 2));
    assert.ok(perText < 65536);
    for (const record of records) {
      record.execution.text = 'x'.repeat(perText);
      record.task = Task.toJSON(Task.fromJSON({ ...record.task as object,
        artifacts: [{ artifactId: record.execution.taskId, parts: [{ text: 'x'.repeat(perText) }] }] }));
    }
    const serialized = JSON.stringify(value, null, 2);
    await fs.writeFile(file, serialized);
    await assert.rejects(service.send(grant, 'target', message('new request')), /capacity/);
    assert.equal(executions, 0);
    assert.equal(await fs.readFile(file, 'utf8'), serialized);
    const restored = new AgentCommunicationService(root, ports(async () => { throw new Error('must not replay'); }));
    assert.equal((await restored.get(grant, 'target', 'task-0')).status?.state, TaskState.TASK_STATE_COMPLETED);
  } finally { await service.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent A2A retries execute once, bind content, retain results and isolate peers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-communication-'));
  let service: AgentCommunicationService | undefined;
  try {
    let executions = 0;
    service = new AgentCommunicationService(root, ports(async request => {
      executions++;
      assert.equal(request.source.senderName, 'Builder');
      const saved = JSON.parse(await fs.readFile(path.join(root, 'agent-communications.json'), 'utf8'));
      assert.equal(saved.records[0].delivery, 'working', 'journal must precede provider execution');
      return { text: 'Verified' };
    }));
    const results = await Promise.all(Array.from({ length: 5 }, () => service!.send(grant, 'target', message())));
    assert.equal(new Set(results.map(t => t.id)).size, 1);
    await service.waitForSettledOperations();
    assert.equal(executions, 1);
    const task = await service.get(grant, 'target', results[0].id);
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(task.artifacts[0].parts[0].content?.value, 'Verified');
    await assert.rejects(service.send(grant, 'target', message('different')), /different content/);
    await assert.rejects(service.get({ ...grant, principal: { kind: 'external', peerId: 'other', name: 'Other' } }, 'target', task.id));
    await assert.rejects(service.send(grant, 'forbidden', message()));
    const restored = new AgentCommunicationService(root, ports(async () => { throw new Error('must not replay'); }));
    assert.equal((await restored.send(grant, 'target', message())).status?.state, TaskState.TASK_STATE_COMPLETED);
  } finally { await service?.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('restart with unresolved work exposes uncertainty without executing it', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-communication-'));
  let settle!: (value: { text: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new AgentCommunicationService(root, ports(async () => {
    entered(); return new Promise(resolve => { settle = resolve; });
  }));
  try {
    const task = await service.send(grant, 'target', message());
    await started;
    // Snapshot the crash image into a separate instance directory: never run two writers on one journal.
    const recovery = path.join(root, 'recovery'); await fs.mkdir(recovery);
    await fs.copyFile(path.join(root, 'agent-communications.json'), path.join(recovery, 'agent-communications.json'));
    const restored = new AgentCommunicationService(recovery, ports(async () => { throw new Error('must not replay'); }));
    assert.equal((await restored.get(grant, 'target', task.id)).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    assert.equal((await restored.send(grant, 'target', message())).id, task.id);
  } finally {
    settle?.({ text: 'done' }); await service.waitForSettledOperations();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('failed persistence prevents execution; non-text and task continuation reject', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-communication-'));
  let executions = 0;
  const service = new AgentCommunicationService(root, ports(async () => { executions++; return { text: '' }; }));
  try {
    await fs.mkdir(path.join(root, 'agent-communications.json'));
    await assert.rejects(service.send(grant, 'target', message()));
    assert.equal(executions, 0);
    await assert.rejects(service.send(grant, 'target', SendMessageRequest.fromJSON({ message: { messageId: 'file', parts: [{ url: 'https://example.com/a' }] } })), /text/);
    await assert.rejects(service.send(grant, 'target', SendMessageRequest.fromJSON({ message: { messageId: 'continuation', taskId: 'existing', parts: [{ text: 'hello' }] } })), /continuation/);
  } finally { await service.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('follow-ups bind to owned tasks and an exact recipient session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-communication-context-'));
  let sessionKey = 'session-original';
  let lastReference: string | undefined;
  const service = new AgentCommunicationService(root, {
    ...ports(async request => { lastReference = request.replyToTaskId; return { text: 'done' }; }),
    resolveTarget: async (_grant, agentId) => ({ agentId, sessionKey, name: 'Target' }),
  });
  const followup = (id: string, reference: string, contextId = '') => SendMessageRequest.fromJSON({ message: {
    messageId: id, contextId, referenceTaskIds: [reference], parts: [{ text: 'follow up' }],
  } });
  try {
    const first = await service.send(grant, 'target', message());
    await service.waitForSettledOperations();
    const second = await service.send(grant, 'target', followup('followup', first.id));
    await service.waitForSettledOperations();
    assert.equal(second.contextId, first.contextId);
    assert.equal(second.history[0].contextId, first.contextId);
    assert.deepEqual(second.history[0].referenceTaskIds, [first.id]);
    assert.equal(lastReference, first.id);
    await assert.rejects(service.send(grant, 'target', followup('conflict', first.id, 'different-context')), /another context/);
    const other = { ...grant, principal: { kind: 'external' as const, peerId: 'other', name: 'Other' } };
    await assert.rejects(service.send(other, 'target', followup('unauthorized', first.id)), /not available/);
    const broadGrant = { ...grant, targets: ['target', 'second-target'] };
    await assert.rejects(service.send(broadGrant, 'second-target', SendMessageRequest.fromJSON({ message: {
      messageId: 'cross-target', contextId: first.contextId, parts: [{ text: 'hello' }],
    } })), /another recipient session/);
    sessionKey = 'replacement';
    await assert.rejects(service.send(grant, 'target', followup('replacement', first.id)), /not available/);
    assert.equal((await service.send(grant, 'target', followup('followup', first.id))).id, second.id,
      'same-ID reads retain original evidence after session replacement');
  } finally { await service.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('task lists paginate within peer scope, trim history and omit artifacts by default', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-task-list-'));
  const service = new AgentCommunicationService(root, ports(async () => ({ text: 'result' })));
  try {
    const { ListTasksRequest } = await import('@a2a-js/sdk');
    const first = await service.send(grant, 'target', message('one', 'one'));
    await service.waitForSettledOperations();
    const second = await service.send(grant, 'target', message('two', 'two'));
    await service.waitForSettledOperations();
    const page = await service.list(grant, 'target', ListTasksRequest.fromJSON({ pageSize: 1, historyLength: 0 }));
    assert.equal(page.totalSize, 2);
    assert.equal(page.tasks[0].id, second.id);
    assert.deepEqual(page.tasks[0].history, []);
    assert.deepEqual(page.tasks[0].artifacts, []);
    const next = await service.list(grant, 'target', ListTasksRequest.fromJSON({ pageSize: 1, pageToken: page.nextPageToken, includeArtifacts: true }));
    assert.equal(next.tasks[0].id, first.id);
    assert.equal(next.tasks[0].artifacts[0].parts[0].content?.value, 'result');
    const stranger = { ...grant, principal: { kind: 'external' as const, peerId: 'stranger', name: 'Stranger' } };
    assert.equal((await service.list(stranger, 'target', ListTasksRequest.fromJSON({}))).tasks.length, 0);
    await assert.rejects(service.list(stranger, 'target', ListTasksRequest.fromJSON({ pageToken: page.nextPageToken })));
    await assert.rejects(service.list(grant, 'target', ListTasksRequest.fromJSON({ historyLength: -1 })));
    await assert.rejects(service.list(grant, 'target', ListTasksRequest.fromJSON({ pageSize: 101 })));
    assert.equal((await service.list(grant, 'target', ListTasksRequest.fromJSON({ contextId: first.contextId }))).totalSize, 1);
  } finally { await service.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('reverse replies require both original sessions and retain the shared context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-task-reply-'));
  const sessions: Record<string, string> = { a: 'session-a', b: 'session-b', c: 'session-c' };
  const local = (agentId: string): CommunicationGrant => ({ ...grant, principal: { kind: 'agent', agentId } });
  const service = new AgentCommunicationService(root, {
    resolveTarget: async (_grant, agentId) => ({ agentId, sessionKey: sessions[agentId], name: agentId }),
    resolveSource: async grant => {
      assert.equal(grant.principal.kind, 'agent');
      const id = grant.principal.kind === 'agent' ? grant.principal.agentId : '';
      return { version: 1, direction: 'incoming', senderAddress: id, senderAgentId: id, senderSessionKey: sessions[id] };
    },
    execute: async () => ({ text: 'reply' }),
  });
  const reply = (id: string, taskId: string) => SendMessageRequest.fromJSON({ message: { messageId: id, referenceTaskIds: [taskId], parts: [{ text: 'reply' }] } });
  try {
    const first = await service.send(local('a'), 'b', message());
    await service.waitForSettledOperations();
    const reverse = await service.send(local('b'), 'a', reply('reverse', first.id));
    await service.waitForSettledOperations();
    assert.equal(reverse.contextId, first.contextId);
    await assert.rejects(service.send(local('c'), 'a', reply('stranger', first.id)));
    sessions.a = 'replacement-a';
    await assert.rejects(service.send(local('b'), 'a', reply('replacement', first.id)));
    await assert.rejects(service.send(local('a'), 'b', reply('replaced-source', first.id)));
    await assert.rejects(service.send(local('a'), 'b', SendMessageRequest.fromJSON({ message: {
      messageId: 'replaced-context-source', contextId: first.contextId, parts: [{ text: 'new request' }],
    } })), /another sender session/);
  } finally { await service.waitForSettledOperations(); await fs.rm(root, { recursive: true, force: true }); }
});

test('definitive execution failures are terminal; cancellation needs the exact settled receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-task-cancel-'));
  let release!: (value: { text: string; outcome: 'canceled' }) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let canceledId = '';
  const service = new AgentCommunicationService(root, {
    ...ports(async request => {
      if (request.text === 'fail') return { text: 'provider rejected input', outcome: 'failed' };
      started();
      return new Promise(resolve => { release = resolve; });
    }),
    cancel: async request => { canceledId = request.taskId; release({ text: '', outcome: 'canceled' }); },
    reconcile: async request => request.taskId === canceledId ? { text: '', outcome: 'canceled' } : null,
  });
  try {
    const failed = await service.send(grant, 'target', message('fail', 'failed'));
    await service.waitForSettledOperations();
    assert.equal((await service.get(grant, 'target', failed.id)).status?.state, TaskState.TASK_STATE_FAILED);
    await assert.rejects(service.cancel(grant, 'target', failed.id));
    const active = await service.send(grant, 'target', message('wait', 'active'));
    await entered;
    const canceled = await service.cancel(grant, 'target', active.id);
    assert.equal(canceledId, active.id);
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED);
    assert.deepEqual(canceled.artifacts, []);
    assert.equal((await service.cancel(grant, 'target', active.id)).status?.state, TaskState.TASK_STATE_CANCELED);
  } finally {
    release?.({ text: '', outcome: 'canceled' }); await service.waitForSettledOperations();
    await fs.rm(root, { recursive: true, force: true });
  }
});
