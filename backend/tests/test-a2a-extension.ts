import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { SendMessageRequest, GetTaskRequest, SubscribeToTaskRequest, TaskState } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { A2aExtensionService } from '../../extensions/a2a/backend/a2a-service.cts';
import { createA2aExtensionRouter } from '../../extensions/a2a/backend/a2a-router.cts';
import { createAgentCommunicationAdminRouter } from '../../extensions/a2a/backend/a2a-grants-router.cts';
import { AgentCommunicationCredentials } from '../agent-communication-credentials.cts';
import { AgentCommunicationService } from '../agent-communication-service.cts';
import { createAgentCommunicationA2aRouter } from '../agent-communication-a2a.cts';

test('A2A enablement persists, serializes CAS and isolates Configs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-plugin-state-'));
  try {
    const service = new A2aExtensionService(root);
    assert.deepEqual(await service.getState(), { version: 1, revision: 0, enabled: false });
    await assert.rejects(service.authorize(), /disabled/);
    const [saved, conflicted] = await Promise.allSettled([
      service.save({ enabled: true, expectedRevision: 0 }), service.save({ enabled: false, expectedRevision: 0 }),
    ]);
    assert.equal(saved.status, 'fulfilled'); assert.equal(conflicted.status, 'rejected');
    assert.equal(await new A2aExtensionService(root).authorize(), 1);
    assert.equal((await fs.stat(path.join(root, 'a2a-extension.json'))).mode & 0o777, 0o600);
    assert.equal((await new A2aExtensionService(path.join(root, 'other')).getState()).enabled, false);
    await assert.rejects(service.save({ enabled: 'true', expectedRevision: 1 }));
    await fs.writeFile(path.join(root, 'a2a-extension.json'), '{}');
    await assert.rejects(new A2aExtensionService(root).getState(), /Invalid/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('plugin gates external access and fences old streams without cancelling work or local communication', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a2a-plugin-http-'));
  const extension = new A2aExtensionService(root);
  const credentials = new AgentCommunicationCredentials(root);
  const external = await credentials.issue({ kind: 'external', peerId: 'ci', name: 'CI' }, ['target'], Date.now() + 60000);
  const local = await credentials.issue({ kind: 'agent', agentId: 'sender' }, [], Date.now() + 60000);
  const target = { agentId: 'target', sessionKey: 'session', name: 'Reviewer' };
  let release = () => {};
  let calls = 0;
  const service = new AgentCommunicationService(root, {
    resolveTarget: async () => target,
    resolveSource: async () => ({ version: 1, direction: 'incoming', senderAddress: 'external:ci' }),
    execute: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return { text: 'review complete' }; },
  });
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const owner = (req: express.Request) => req.headers.authorization === 'Bearer owner';
    app.use('/plugin', createA2aExtensionRouter({ service: extension, isOwner: owner, targets: () => [target], endpointBaseUrl: origin + '/a2a' }));
    app.use('/grants', createAgentCommunicationAdminRouter({ credentials, isOwner: owner, validateTarget: () => {}, authorizeIssuance: () => extension.authorize() }));
    app.use('/a2a', createAgentCommunicationA2aRouter({ credentials, service, resolveTarget: async () => target, endpointBaseUrl: '/a2a', authorizeExternal: () => extension.authorize() }));
    const call = (url: string, token: string, method = 'GET', body?: unknown) => fetch(origin + url, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    const card = '/a2a/agents/target/.well-known/agent-card.json';
    assert.equal((await call('/plugin', external.token)).status, 403);
    assert.equal((await call('/plugin', external.token, 'PUT', { enabled: true, expectedRevision: 0 })).status, 403);
    assert.equal((await call(card, external.token)).status, 403);
    assert.equal((await call(card, local.token)).status, 200);
    const grantBody = { peerId: 'new', name: 'New', targets: ['target'], expiresAt: Date.now() + 60000 };
    assert.equal((await call('/grants', 'owner', 'POST', grantBody)).status, 403);
    assert.equal((await call('/plugin', 'owner', 'PUT', { enabled: true, expectedRevision: 0 })).status, 200);
    assert.equal((await call('/plugin', 'owner', 'PUT', { enabled: false, expectedRevision: 0 })).status, 409);
    const remoteCard = await new Promise<string>((resolve, reject) => {
      const request = http.get(origin + card, { headers: { Authorization: 'Bearer ' + external.token, Host: 'farming.example.test' } }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(body));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('Card read timed out')));
    });
    assert.equal(JSON.parse(remoteCard).supportedInterfaces[0].url, 'http://farming.example.test/a2a/agents/target');
    const authenticatedFetch: typeof fetch = (url, init) => fetch(url, { ...init, headers: { ...init?.headers, Authorization: 'Bearer ' + external.token }, signal: AbortSignal.timeout(5000) });
    const client = await new ClientFactory({ cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }), transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromUrl(origin + '/a2a/agents/target/');
    const task = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: 'review', role: 'ROLE_USER', parts: [{ text: 'review' }] }, configuration: { returnImmediately: true } }));
    assert.ok('id' in task);
    const observer = client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: task.id }));
    await observer.next();
    await extension.save({ enabled: false, expectedRevision: 1 });
    assert.equal((await call(card, external.token)).status, 403);
    assert.equal((await call(card, local.token)).status, 200);
    const grants = await (await call('/grants', 'owner')).json();
    assert.equal(grants.grants.length, 1, 'only external grants are exposed');
    await extension.save({ enabled: true, expectedRevision: 2 });
    await assert.rejects(observer.next(), /./, 'reenabling cannot revive the old observer');
    release(); await service.waitForSettledOperations();
    const completed = await client.getTask(GetTaskRequest.fromJSON({ id: task.id }));
    assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(calls, 1);
    await extension.save({ enabled: false, expectedRevision: 3 });
    assert.equal((await call('/grants/' + external.grant.id, 'owner', 'DELETE')).status, 200);
    await extension.save({ enabled: true, expectedRevision: 4 });
    assert.equal((await call(card, external.token)).status, 401);
  } finally {
    release(); await service.waitForSettledOperations(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
