import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { AgentCommunicationRuntime } from '../agent-communication-runtime.cts';
import { createAgentCommunicationExchangeRouter } from '../agent-communication-exchanges.cts';

test('supervision requires owner auth, binds user provenance and reconciles identical sends', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-exchange-owner-'));
  let executions = 0;
  let observed: unknown;
  const runtime = new AgentCommunicationRuntime(root, () => ({
    resolveCommunicationAgent: agentId => {
      if (!['a', 'b'].includes(agentId)) throw new Error('No live Agent');
      return { agentId, sessionKey: 'session-' + agentId, name: 'Agent ' + agentId };
    },
    executePeerMessage: async request => { executions++; observed = request.source; return { text: 'review result' }; },
    reconcilePeerMessage: async () => null,
  }));
  const app = express();
  app.use('/api/communication', createAgentCommunicationExchangeRouter({ runtime, isOwner: req => req.get('authorization') === 'Bearer owner' }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/communication`;
    const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
    const intent = { sourceAgentId: 'a', targetAgentId: 'b', messageId: 'request-1', text: 'Please review',
      source: { senderName: 'Spoofed', initiatedBy: undefined }, principal: { kind: 'external', peerId: 'spoofed' } };
    assert.equal((await fetch(base + '/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent) })).status, 403);
    assert.equal((await fetch(base + '/exchanges?agentId=a')).status, 403);
    assert.equal((await fetch(base + '/send', { method: 'POST', headers, body: JSON.stringify({ ...intent, text: ' ' }) })).status, 400);
    const sent = await fetch(base + '/send', { method: 'POST', headers, body: JSON.stringify(intent) });
    assert.equal(sent.status, 202);
    const item = await sent.json() as { taskId: string };
    await runtime.service.waitForSettledOperations();
    assert.deepEqual(observed, { version: 1, direction: 'incoming', senderAddress: 'agent:a', senderName: 'Agent a',
      senderAgentId: 'a', senderSessionKey: 'session-a', initiatedBy: 'user', senderTaskId: item.taskId });
    const repeated = await fetch(base + '/send', { method: 'POST', headers, body: JSON.stringify(intent) });
    assert.equal((await repeated.json() as { taskId: string }).taskId, item.taskId);
    assert.equal(executions, 1);
    for (const agentId of ['a', 'b']) {
      const response = await fetch(base + '/exchanges?agentId=' + agentId, { headers });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const list = await response.json() as { items: Array<{ taskId: string; result: string }> };
      assert.equal(list.items[0].taskId, item.taskId);
      assert.equal(list.items[0].result, 'review result');
    }
    assert.equal((await fetch(base + '/exchanges/' + item.taskId)).status, 403);
    assert.equal((await fetch(base + '/exchanges/' + item.taskId + '/cancel', { method: 'POST' })).status, 403);
    assert.equal((await fetch(base + '/exchanges/' + item.taskId + '/cancel', { method: 'POST', headers })).status, 409);
  } finally {
    await runtime.service.waitForSettledOperations(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
