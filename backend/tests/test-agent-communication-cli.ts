import { parseArgs } from '../farming-cli.cts';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { AgentCommunicationRuntime } from '../agent-communication-runtime.cts';
import { createAgentCommunicationA2aRouter } from '../agent-communication-a2a.cts';
import { createAgentCommunicationAdminRouter } from '../../extensions/a2a/backend/a2a-grants-router.cts';
import { parseCommunicationCommand, parseCommunicationAdminCommand, runCommunicationCommand } from '../agent-communication-cli.cts';

test('message commands require stable identity, preserve body flags, and reject malformed scopes', () => {
  assert.deepEqual(parseCommunicationCommand(['send', 'target', '--id', 'r1', '--context', 'c1', '--', '--help', 'hello']), {
    operation: 'send', agentId: 'target', messageId: 'r1', contextId: 'c1', text: '--help hello',
  });
  assert.equal(parseArgs(['message', 'send', 'target', '--id', 'r1', '--', '--help']).command, 'message');
  assert.equal(parseArgs(['message', 'grants']).command, 'message-admin');
  assert.equal(parseCommunicationCommand(['send', 'target', '--id', 'r1', '--reply-to', 'previous', '--', 'follow up']).operation, 'send');
  assert.deepEqual(parseCommunicationCommand(['list', 'target', '--page', 'scope:task']), { operation: 'list', agentId: 'target', pageToken: 'scope:task' });
  assert.deepEqual(parseCommunicationCommand(['cancel', 'target', 'task']), { operation: 'cancel', agentId: 'target', taskId: 'task' });
  assert.deepEqual(parseCommunicationCommand(['subscribe', 'target', 'task']), { operation: 'subscribe', agentId: 'target', taskId: 'task' });
  assert.deepEqual(parseArgs(['message', '--help']), { command: 'help' });
  assert.throws(() => parseCommunicationCommand(['send', 'target', '--', 'hello']), /unique-request-id/);
  assert.throws(() => parseCommunicationCommand(['send', 'target', '--id', 'r1', '--id', 'r2', '--', 'hello']), /repeated/);
  assert.throws(() => parseCommunicationAdminCommand(['grant', 'peer', '--name', 'Peer']), /Use:/);
  assert.throws(() => parseCommunicationAdminCommand(['grant', 'peer', '--name', 'Peer', '--target', 'target', '--hours', '721']), /Invalid/);
});

test('owner grants enable CLI discovery/send/result, isolate targets and revoke access', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-cli-'));
  let live = true; let executions = 0;
  const runtime = new AgentCommunicationRuntime(root, () => ({
    async reconcilePeerMessage() { return null; },
    resolveCommunicationAgent(agentId: string) {
      if (!live || agentId !== 'target') throw new Error('Recipient unavailable');
      return { agentId, sessionKey: 'exact-session', name: 'Target' };
    },
    async executePeerMessage(request) {
      executions++;
      assert.equal(request.source.senderAddress, 'external:fixture');
      return { text: '**Complete reply**\n' + 'x'.repeat(800) };
    },
  }));
  const app = express(); const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const baseUrl = `http://127.0.0.1:${address.port}/prefix`;
    app.use('/prefix/api/communication/grants', createAgentCommunicationAdminRouter({
      credentials: runtime.credentials, authorizeIssuance: async () => 1, isOwner: req => req.get('authorization') === 'Bearer owner',
      validateTarget: agentId => { if (agentId !== 'target') throw new Error('Recipient unavailable'); },
    }));
    app.use('/prefix/api/a2a', createAgentCommunicationA2aRouter({ authorizeExternal: async () => 1,
      credentials: runtime.credentials, service: runtime.service, endpointBaseUrl: baseUrl + '/api/a2a',
      resolveTarget: (grant, agentId) => runtime.resolveTarget(grant, agentId),
    }));
    const adminUrl = baseUrl + '/api/communication/grants';
    const ownerHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
    assert.equal((await fetch(adminUrl)).status, 403);
    assert.equal((await fetch(adminUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ peerId: 'bad identity', name: 'Fixture', targets: ['target'], expiresAt: Date.now() + 60000 }) })).status, 400);
    const response = await fetch(adminUrl, { method: 'POST', headers: ownerHeaders, body: JSON.stringify({ peerId: 'fixture', name: 'Fixture', targets: ['target'], expiresAt: Date.now() + 60000 }) });
    assert.equal(response.status, 201);
    const issued = await response.json() as { token: string; grant: { id: string } };
    assert.equal((await fetch(adminUrl, { headers: { Authorization: `Bearer ${issued.token}` } })).status, 403);
    let output = '';
    const options = { baseUrl, token: issued.token, write: (text: string) => { output = text; } };
    await runCommunicationCommand({ operation: 'card', agentId: 'target' }, options);
    assert.equal(JSON.parse(output).name, 'Target');
    const send = parseCommunicationCommand(['send', 'target', '--id', 'stable-id', '--', 'Please review']);
    await runCommunicationCommand(send, options); const taskId = JSON.parse(output).id as string;
    await runtime.service.waitForSettledOperations();
    live = false;
    await runCommunicationCommand(send, options); assert.equal(executions, 1);
    await runCommunicationCommand({ operation: 'watch', agentId: 'target', taskId }, options);
    assert.equal(JSON.parse(output).status.state, 'TASK_STATE_COMPLETED');
    assert.ok(JSON.parse(output).artifacts[0].parts[0].text.length > 800);
    await runCommunicationCommand({ operation: 'list', agentId: 'target' }, options);
    assert.equal(JSON.parse(output).tasks[0].id, taskId);
    await runCommunicationCommand({ operation: 'subscribe', agentId: 'target', taskId }, options);
    assert.equal(JSON.parse(output).task.id, taskId);
    await assert.rejects(runCommunicationCommand({ operation: 'cancel', agentId: 'target', taskId }, options));
    await assert.rejects(runCommunicationCommand({ operation: 'get', agentId: 'forbidden', taskId }, options));
    const listed = await (await fetch(adminUrl, { headers: ownerHeaders })).text();
    assert.ok(!listed.includes(issued.token));
    assert.equal((await fetch(`${adminUrl}/${issued.grant.id}`, { method: 'DELETE', headers: ownerHeaders })).status, 200);
    await assert.rejects(runCommunicationCommand({ operation: 'get', agentId: 'target', taskId }, options));
    await assert.rejects(runCommunicationCommand(send, { ...options, token: '' }), /No communication credential/);
  } finally {
    await runtime.service.waitForSettledOperations(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
