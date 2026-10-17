import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentCommunicationCredentials } from '../agent-communication-credentials.cts';

test('credentials retain exact identity and scope across restart, expire and revoke without exposing tokens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-credentials-'));
  try {
    let now = 1000;
    const store = new AgentCommunicationCredentials(root, () => now);
    const principal = { kind: 'external' as const, peerId: 'remote-builder', name: 'Builder' };
    const targets = ['agent-a'];
    const issuance = store.issue(principal, targets, 2000);
    principal.name = 'Changed'; targets.push('agent-b');
    const issued = await issuance;
    const restored = new AgentCommunicationCredentials(root, () => now);
    assert.deepEqual((await restored.authenticate(issued.token))?.targets, ['agent-a']);
    assert.deepEqual((await restored.authenticate(issued.token))?.principal, { kind: 'external', peerId: 'remote-builder', name: 'Builder' });
    const contents = await fs.readFile(path.join(root, 'agent-communication-credentials.json'), 'utf8');
    assert.equal(contents.includes(issued.token), false);
    assert.equal(JSON.stringify(await restored.list()).includes('digest'), false);
    assert.equal(await restored.authenticate(issued.token + 'x'), null);
    assert.equal(await restored.authenticate('owner-token'), null);
    assert.equal(await restored.revoke(issued.grant.id), true);
    assert.equal(await store.authenticate(issued.token), null, 'fresh authoritative read sees revocation');
    const next = await store.issue({ kind: 'agent', agentId: 'agent-local' }, [], 2000);
    now = 2000;
    assert.equal(await restored.authenticate(next.token), null);
    assert.deepEqual(await restored.list(), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('concurrent grants are serialized and malformed storage fails closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-credentials-'));
  try {
    const store = new AgentCommunicationCredentials(root, () => 1000);
    await assert.rejects(store.issue({ kind: 'external', peerId: 'remote', name: 'Remote' }, [], 2000));
    await Promise.all(['a', 'b'].map(agentId => store.issue({ kind: 'agent', agentId }, [], 2000)));
    assert.equal((await store.list()).length, 2);
    await fs.writeFile(path.join(root, 'agent-communication-credentials.json'), '{broken');
    await assert.rejects(store.list());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
