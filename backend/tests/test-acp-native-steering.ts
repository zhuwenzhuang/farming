import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from '../acp-runtime.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'condition did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function run() {
  for (const provider of ['agy', 'qwen'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-native-steering-'));
    const runtime = new AcpRuntime({
      resolveLaunch: () => ({ command: process.execPath,
        args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('backend/tests/fixtures/fake-acp-agent.mts')], version: 'native-steering-fixture' }),
    });
    try {
      await runtime.prepareAgent({ agentId: 'native', provider, cwd: root, providerHomePath: root,
        env: { ...process.env, FARMING_TEST_NATIVE_STEERING: provider === 'agy' ? 'concurrent-prompt' : 'pull' } });
      const binding = runtime.bindings.get('native')!;
      if (provider === 'qwen') assert.equal(binding.supportsSteer, false, 'pull support needs evidence');
      let settled = false;
      const prompt = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]).then(value => { settled = true; return value; });
      void prompt.catch(() => {});
      await until(() => runtime.canSteer('native'));
      await runtime.submitMessage('native', [{ type: 'text', text: 'first change' }], { delivery: 'steer' });
      assert.equal(settled, false, 'handover must not complete the logical Turn');
      assert.equal(binding.state, 'working');
      assert(runtime.canSteer('native'), 'a handed-over Turn remains steerable');
      if (provider === 'agy') {
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'reject native steer' }]), /Native steer rejected/);
        assert(runtime.canSteer('native'), 'a rejected handover leaves the active request steerable');
      }
      const secondChange = [{ type: 'text', text: 'second change' }];
      if (provider === 'agy') {
        await runtime.submitMessage('native', [
          { type: 'resource_link', uri: 'file:///demo/fixture.txt', name: 'fixture.txt' },
          ...secondChange, { type: 'text', text: 'additional block' },
        ], { delivery: 'steer' });
      } else {
        await runtime.submitMessage('native', secondChange, { delivery: 'steer' });
      }
      await until(() => binding.sessionState.entries.some(entry => entry.role === 'assistant'
        && entry.content?.some(block => String(block.text || '').includes('Native steer accepted: second change'))));
      const users = binding.sessionState.entries.filter(entry => entry.role === 'user');
      assert.equal(users.length, 3, 'idless native echoes must not duplicate accepted input');
      assert.equal(projectAcpTranscript(binding.sessionState.snapshot()).turns.length, 1);
      assert.equal(users.filter(entry => entry._meta?.farming?.steer === true).length, 2);
      await runtime.cancel('native');
      assert.equal((await prompt).stopReason, 'cancelled');
      assert.equal(binding.activeTurn, null);
      assert.equal(runtime.canSteer('native'), false);
      await assert.rejects(runtime.submitMessage('native', [{ type: 'text', text: 'too late' }], { delivery: 'steer' }), /No active ACP turn/);

      const next = runtime.prompt('native', [{ type: 'text', text: 'native steering hold again' }]);
      void next.catch(() => {});
      await until(() => runtime.canSteer('native'));
      await runtime.steer('native', [{ type: 'text', text: 'finish native turn' }]);
      assert.equal((await next).stopReason, 'end_turn');
      assert.equal(projectAcpTranscript(binding.sessionState.snapshot()).turns.length, 2);

      if (provider === 'agy') {
        const rejected = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void rejected.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'reject native steer' }]), /Native steer rejected/);
        await runtime.cancel('native');
        assert.equal((await rejected).stopReason, 'cancelled', 'a last rejected successor cannot override the original outcome');

        const original = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void original.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'reject native steer' }]), /Native steer rejected/);
        const send = binding.connection.prompt;
        binding.connection.prompt = () => { throw new Error('synchronous send failure'); };
        try {
          await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'not sent' }]), /synchronous send failure/);
        } finally { binding.connection.prompt = send; }
        assert.equal(binding.activeTurn?.concurrentSteers?.length, 1, 'pre-dispatch throws leave no successor');
        const unconfirmed = assert.rejects(runtime.steer('native', [{ type: 'text', text: 'hold native steer without echo' }]), /before steer acceptance|cancelled before acceptance/);
        await until(() => binding.activeTurn?.concurrentSteers?.length === 2);
        await runtime.cancel('native');
        await unconfirmed;
        assert.equal((await original).stopReason, 'cancelled', 'rejecting or cancelling a successor does not fail the original Turn');
        assert(!JSON.stringify(binding.sessionState.entries).includes('hold native steer without echo'));
      }
    } finally {
      await runtime.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-pull-steering-'));
  const runtime = new AcpRuntime({ requestTimeoutMs: 300,
    resolveLaunch: () => ({ command: process.execPath,
      args: ['--import', path.resolve('node_modules/tsx/dist/loader.mjs'), path.resolve('backend/tests/fixtures/fake-acp-agent.mts')], version: 'pull-fixture' }),
  });
  try {
    await runtime.prepareAgent({ agentId: 'pull', provider: 'qwen', cwd: root, providerHomePath: root,
      env: { ...process.env, FARMING_TEST_NATIVE_STEERING: 'pull', FARMING_TEST_NATIVE_STEERING_DRAIN_ONCE: '1' } });
    const binding = runtime.bindings.get('pull')!;
    const prompt = runtime.prompt('pull', [{ type: 'text', text: 'native steering hold' }]);
    void prompt.catch(() => {});
    await until(() => runtime.canSteer('pull'));
    const drain = () => runtime.drainMidTurnInput(binding, 'craft/drainMidTurnQueue', { sessionId: binding.sessionId });
    await assert.rejects(runtime.drainMidTurnInput(binding, 'craft/drainMidTurnQueue', { sessionId: 'another-session' }), /owning Session/);
    await assert.rejects(runtime.drainMidTurnInput(binding, 'unknown/method', { sessionId: binding.sessionId }), /Method not found/);
    const requests = Array.from({ length: 12 }, (_, index) => runtime.steer('pull', [{ type: 'text', text: `change ${index}` }]));
    await until(() => binding.activeTurn?.pendingSteers?.size === 12);
    assert.equal((await drain()).items.length, 10);
    assert.equal((await drain()).items.length, 2);
    await Promise.all(requests);
    assert.equal((await drain()).items.length, 0, 'draining is not replayable');
    await assert.rejects(runtime.steer('pull', [{ type: 'text', text: 'expired' }]), /timed out.*not delivered/);
    assert.equal((await drain()).items.length, 0);
    assert(!JSON.stringify(binding.sessionState.entries).includes('expired'));
    const cancelled = assert.rejects(runtime.steer('pull', [{ type: 'text', text: 'cancelled pending' }]), /not delivered/);
    await until(() => binding.activeTurn?.pendingSteers?.size === 1);
    await runtime.cancel('pull');
    await cancelled;
    assert.equal((await prompt).stopReason, 'cancelled');
    assert.equal((await drain()).items.length, 0);
    assert(!JSON.stringify(binding.sessionState.entries).includes('cancelled pending'));

    await runtime.prepareAgent({ agentId: 'opencode', provider: 'opencode', cwd: root, providerHomePath: root, env: process.env });
    const parent = runtime.bindings.get('opencode')!;
    const handlers = runtime.clientHandlers(parent);
    const childMeta = { 'opencode/child-session': { id: 'child', parentID: parent.sessionId, depth: 1, title: 'Explorer' } };
    await handlers.sessionUpdate({ sessionId: parent.sessionId, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Child answer' }, _meta: childMeta,
    } });
    assert(!JSON.stringify(parent.sessionState.entries).includes('Child answer'));
    assert(JSON.stringify(parent.subagentStates.get('child')?.entries).includes('Child answer'));
    assert.equal(parent.subagentStates.get('child')?.nativeSubagent?.capabilities, undefined, 'observation does not grant child controls');
    assert.equal(runtime.routeProviderChildUpdate(parent, { sessionId: parent.sessionId, update: { _meta: childMeta } }).sessionId, 'child');
    await handlers.sessionUpdate({ sessionId: parent.sessionId, update: {
      sessionUpdate: 'session_info_update', _meta: { ...childMeta, 'opencode/compaction': { messageId: 'child-compact', status: 'completed' } },
    } });
    assert.equal(parent.subagentStates.get('child')?.entries.find(entry => entry.type === 'compaction')?.status, 'completed');
    await handlers.sessionUpdate({ sessionId: parent.sessionId, update: {
      sessionUpdate: 'tool_call', toolCallId: 'grandchild:tool', title: 'Inspect', status: 'in_progress',
      _meta: { 'opencode/child-session': { id: 'grandchild', parentID: 'child', depth: 2 } },
    } });
    assert.equal(parent.subagentStates.get('grandchild')?.nativeSubagent?.parentSessionId, 'child');
    assert.equal(runtime.routeProviderChildUpdate(parent, { sessionId: parent.sessionId, update: {
      _meta: { 'opencode/child-session': { id: 'untitled', parentID: parent.sessionId, depth: 1, title: null } },
    } }).sessionId, 'untitled');
    assert.throws(() => runtime.routeProviderChildUpdate(parent, { sessionId: parent.sessionId, update: {
      _meta: { 'opencode/child-session': { id: 'wrong-depth', parentID: 'child', depth: 1 } },
    } }), /depth does not match/);
    assert.throws(() => runtime.routeProviderChildUpdate(parent, { sessionId: 'unrelated-session', update: { _meta: childMeta } }), /owning Session/);
    assert.throws(() => runtime.routeProviderChildUpdate(parent, { sessionId: parent.sessionId, update: {
      _meta: { 'opencode/child-session': { id: 'child', parentID: 'grandchild', depth: 3 } },
    } }), /parent cannot change/);
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('test-acp-native-steering passed');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
