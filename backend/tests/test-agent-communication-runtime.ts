import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SendMessageRequest, TaskState } from '@a2a-js/sdk';
import { AgentCommunicationRuntime } from '../agent-communication-runtime.cts';

test('runtime derives source from credentials and binds execution to exact recipient session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-runtime-'));
  let live = true;
  const calls: unknown[] = [];
  const runtime = new AgentCommunicationRuntime(root, () => ({
    async reconcilePeerMessage() { return null; },
    resolveCommunicationAgent(agentId: string) {
      if (!live) throw new Error('stopped');
      return { agentId, sessionKey: `provider:home:${agentId}`, name: `${agentId} display` };
    },
    async executePeerMessage(request) { calls.push(request); return { text: 'final answer' }; },
  }));
  try {
    const [first, second] = await Promise.all([runtime.tokenForLaunch('sender'), runtime.tokenForLaunch('sender')]);
    assert.equal(first, second);
    assert.equal((await runtime.credentials.list()).length, 1);
    const grant = await runtime.credentials.authenticate(first); assert.ok(grant);
    const task = await runtime.service.send(grant, 'recipient', SendMessageRequest.fromJSON({ message: {
      messageId: 'request-1', role: 'ROLE_USER', parts: [{ text: 'Review this' }],
      metadata: { senderName: 'spoofed human' },
    } }));
    await runtime.service.waitForSettledOperations();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      agentId: 'recipient', sessionKey: 'provider:home:recipient',
      requestId: (calls[0] as { requestId: string }).requestId, text: 'Review this',
      source: { version: 1, direction: 'incoming', senderAddress: 'agent:sender', senderName: 'sender display', senderAgentId: 'sender', senderSessionKey: 'provider:home:sender', senderTaskId: task.id },
    });
    live = false;
    assert.equal((await runtime.service.get(grant, 'recipient', task.id)).status?.state, TaskState.TASK_STATE_COMPLETED);
    await assert.rejects(runtime.resolveTarget(grant, 'recipient'), /stopped/);
    await runtime.credentials.revoke(grant.id);
    assert.notEqual(await runtime.tokenForLaunch('sender'), first);
    const external = await runtime.credentials.issue({ kind: 'external', peerId: 'other', name: 'Other' }, ['allowed'], Date.now() + 10000);
    await assert.rejects(runtime.resolveTarget(external.grant, 'recipient'), /not available/);
  } finally {
    await runtime.service.waitForSettledOperations();
    await fs.rm(root, { recursive: true, force: true });
  }
});
