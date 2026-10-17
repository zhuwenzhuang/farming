import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { SendMessageRequest, GetTaskRequest, CancelTaskRequest, TaskState } from '@a2a-js/sdk';
import { DefaultAgentCardResolver, ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { AgentCommunicationCredentials } from '../agent-communication-credentials.cts';
import { AgentCommunicationService } from '../agent-communication-service.cts';
import { createAgentCommunicationA2aRouter } from '../agent-communication-a2a.cts';

test('standard SDK discovers, sends and polls through scoped Farming A2A authentication', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-a2a-http-'));
  const credentials = new AgentCommunicationCredentials(root);
  const issued = await credentials.issue({ kind: 'external', peerId: 'fixture', name: 'Fixture' }, ['target'], Date.now() + 60000);
  let live = true;
  let calls = 0;
  const resolveTarget = async () => {
    if (!live) throw new Error('runtime no longer available');
    return { agentId: 'target', sessionKey: 'exact-session', name: 'Fixture target' };
  };
  const service = new AgentCommunicationService(root, { resolveTarget,
    resolveSource: async () => ({ version: 1, direction: 'incoming', senderAddress: 'external:fixture' }),
    execute: async () => { calls++; return { text: 'correlated result' }; },
  });
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    app.use('/api/a2a', createAgentCommunicationA2aRouter({ authorizeExternal: async () => 1, credentials, service, resolveTarget, endpointBaseUrl: origin + '/api/a2a' }));
    const authenticatedFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${issued.token}`);
      return fetch(url, { ...init, headers, signal: AbortSignal.timeout(5000) });
    };
    const factory = new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }),
      transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] });
    const client = await factory.createFromUrl(origin + '/api/a2a/agents/target/');
    const request = SendMessageRequest.fromJSON({ message: { messageId: 'sdk-message', role: 'ROLE_USER', parts: [{ text: 'hello' }] } });
    const sent = await client.sendMessage(request);
    assert.ok('id' in sent);
    await service.waitForSettledOperations();
    live = false;
    const task = await client.getTask(GetTaskRequest.fromJSON({ id: sent.id }));
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(task.artifacts[0].parts[0].content?.value, 'correlated result');
    await client.sendMessage(request);
    assert.equal(calls, 1, 'retry can resolve without a live recipient');
    await assert.rejects(client.cancelTask(CancelTaskRequest.fromJSON({ id: sent.id })));
    assert.equal((await fetch(origin + '/api/a2a/agents/target', { method: 'POST' })).status, 401);
    assert.equal((await authenticatedFetch(origin + '/api/a2a/agents/forbidden', { method: 'POST' })).status, 404);
    await credentials.revoke(issued.grant.id);
    await assert.rejects(client.getTask(GetTaskRequest.fromJSON({ id: sent.id })));
  } finally {
    await service.waitForSettledOperations(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('SDK supports blocking send, immediate admission, streamed results, resubscribe and revocation', { timeout: 20000 }, async () => {
  const { ListTasksRequest, SubscribeToTaskRequest } = await import('@a2a-js/sdk');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-a2a-stream-'));
  const credentials = new AgentCommunicationCredentials(root);
  const issued = await credentials.issue({ kind: 'external', peerId: 'stream', name: 'Stream' }, ['target'], Date.now() + 60000);
  const releases = new Map<string, () => void>();
  let executions = 0;
  let reads = 0;
  const resolveTarget = async () => ({ agentId: 'target', sessionKey: 'session', name: 'Target' });
  const service = new AgentCommunicationService(root, {
    resolveTarget, resolveSource: async () => ({ version: 1, direction: 'incoming', senderAddress: 'external:stream' }),
    execute: async request => {
      executions++;
      await new Promise<void>(resolve => { releases.set(request.text, resolve); });
      return { text: 'finished ' + request.text };
    },
  });
  const originalGet = service.get.bind(service);
  service.get = async (...args) => { reads++; return originalGet(...args); };
  const app = express(); const server = app.listen(0, '127.0.0.1');
  const waitStarted = async (text: string) => {
    const deadline = Date.now() + 3000;
    while (!releases.has(text)) {
      assert.ok(Date.now() < deadline, 'execution must start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    app.use('/api/a2a', createAgentCommunicationA2aRouter({ authorizeExternal: async () => 1, credentials, service, resolveTarget, endpointBaseUrl: origin + '/api/a2a' }));
    const authenticatedFetch: typeof fetch = (url, init) => {
      const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${issued.token}`);
      return fetch(url, { ...init, headers, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    };
    const factory = new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }),
      transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] });
    const client = await factory.createFromUrl(origin + '/api/a2a/agents/target/');
    const message = (id: string, returnImmediately?: boolean) => SendMessageRequest.fromJSON({
      message: { messageId: id, parts: [{ text: id }] }, configuration: { returnImmediately, historyLength: 0 },
    });
    let returned = false;
    const blocking = client.sendMessage(message('blocking')).then(task => { returned = true; return task; });
    await waitStarted('blocking');
    assert.equal(returned, false, 'default send waits for completion');
    releases.get('blocking')!();
    const done = await blocking;
    assert.ok('id' in done); assert.equal(done.status?.state, TaskState.TASK_STATE_COMPLETED); assert.deepEqual(done.history, []);
    const immediate = await client.sendMessage(message('immediate', true));
    assert.ok('id' in immediate);
    assert.notEqual(immediate.status?.state, TaskState.TASK_STATE_COMPLETED);
    await waitStarted('immediate');
    const resumed = client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: immediate.id }));
    const snapshot = await resumed.next(); assert.equal(snapshot.done, false); assert.equal(snapshot.value.payload?.$case, 'task');
    releases.get('immediate')!();
    const events = [];
    for await (const event of resumed) events.push(event);
    assert.ok(events.some(event => event.payload?.$case === 'artifactUpdate' && event.payload.value.artifact?.parts[0].content?.value === 'finished immediate'));
    assert.ok(events.some(event => event.payload?.$case === 'statusUpdate' && event.payload.value.status?.state === TaskState.TASK_STATE_COMPLETED));
    const stream = client.sendMessageStream(message('stream'));
    const firstEvent = await stream.next(); assert.equal(firstEvent.done, false); assert.equal(firstEvent.value.payload?.$case, 'task');
    await waitStarted('stream'); releases.get('stream')!();
    const streamed = [];
    for await (const event of stream) streamed.push(event);
    assert.ok(streamed.some(event => event.payload?.$case === 'artifactUpdate'));
    const listed = await client.listTasks(ListTasksRequest.fromJSON({ includeArtifacts: true }));
    assert.equal(listed.totalSize, 3);
    const count = executions;
    await assert.rejects(client.sendMessage(SendMessageRequest.fromJSON({
      message: { messageId: 'bad-history', parts: [{ text: 'bad' }] }, configuration: { historyLength: -1 },
    })));
    assert.equal(executions, count, 'invalid projection must reject before dispatch');

    const detached = await client.sendMessage(message('detached', true)); assert.ok('id' in detached);
    const disconnect = new AbortController();
    const detachedObserver = client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: detached.id }), { signal: disconnect.signal });
    await detachedObserver.next();
    disconnect.abort();
    await assert.rejects(detachedObserver.next());
    // Allow the server to receive socket close, then prove no further observation.
    await new Promise(resolve => setTimeout(resolve, 600));
    const afterDisconnect = reads;
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(reads, afterDisconnect);
    await waitStarted('detached');
    releases.get('detached')!();
    await service.waitForSettledOperations();
    assert.equal((await client.getTask(GetTaskRequest.fromJSON({ id: detached.id }))).status?.state, TaskState.TASK_STATE_COMPLETED,
      'disconnecting an observer must not cancel execution');

    const active = await client.sendMessage(message('revoked', true)); assert.ok('id' in active);
    const observer = client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: active.id }));
    await observer.next();
    await credentials.revoke(issued.grant.id);
    await assert.rejects(observer.next());
    const afterRevocation = reads;
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(reads, afterRevocation, 'revoked stream stops observing');
    releases.get('revoked')!();
    await service.waitForSettledOperations();
  } finally {
    for (const release of releases.values()) release();
    await service.waitForSettledOperations(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
