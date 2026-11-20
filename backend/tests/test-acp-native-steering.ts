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
      binding.sessionState.apply({ sessionId: binding.sessionId, update: {
        sessionUpdate: 'notice', severity: 'warning', title: 'Advisory before Steer',
      } });
      await runtime.submitMessage('native', [{ type: 'text', text: 'first change' }], { delivery: 'steer' });
      assert.deepEqual(binding.sessionState.notices, [], 'accepted native Steer clears earlier notices');
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
        const delayedTurn = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void delayedTurn.catch(() => {});
        await until(() => runtime.canSteer('native'));
        let acceptedCount = 0;
        let admissionSettled = false;
        const delayedSteer = runtime.submitMessage('native', [{ type: 'text', text: 'delay native steer echo' }], {
          delivery: 'steer', admissionDeadline: Date.now() + 100,
          onSubmitted: () => { acceptedCount += 1; },
        }).then(value => { admissionSettled = true; return { value }; }, error => { admissionSettled = true; return { error }; });
        await until(() => fs.existsSync(path.join(root, 'delayed-steer-received')));
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(admissionSettled, false, 'an observation deadline cannot reject input already dispatched to the provider');
        fs.writeFileSync(path.join(root, 'release-steer-echo'), 'ready');
        assert.equal('error' in await delayedSteer, false);
        assert.equal(acceptedCount, 1, 'late acceptance must still reach the submission owner');
        assert.equal(fs.readFileSync(path.join(root, 'delayed-steer-received'), 'utf8'), 'received\n', 'delivery must not replay');
        assert.equal(binding.sessionState.entries.filter(entry => entry._meta?.farming?.steer === true
          && entry.content?.some(block => block.text === 'delay native steer echo')).length, 1);
        await runtime.cancel('native');
        assert.equal((await delayedTurn).stopReason, 'cancelled');

        const partial = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void partial.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await runtime.steer('native', [
          { type: 'text', text: 'pause after first echo' },
          { type: 'text', text: 'finish native turn' },
        ]);
        await until(() => binding.activeTurn?.concurrentSteers?.[0]?.echoedBlocks === 1);
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'finish native turn' }]), /confirm the previous steer/);
        fs.writeFileSync(path.join(root, 'continue-echo'), 'ready');
        await until(() => binding.activeTurn?.concurrentSteers?.[0]?.echoedBlocks === 2);
        await runtime.steer('native', [{ type: 'text', text: 'finish native turn' }]);
        assert.equal((await partial).stopReason, 'end_turn');
        assert.equal(binding.sessionState.entries.filter(entry => entry.role === 'user' && entry.content?.length === 1
          && entry.content[0].text === 'finish native turn').length, 2, 'repeated text gets its own accepted input after the previous echo closes');

        // Antigravity >= 1.5.11 confirms concurrent-prompt steering by settling the
        // predecessor RPC without emitting live user_message_chunk echoes.
        const silent = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void silent.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await runtime.submitMessage('native', [{ type: 'text', text: 'silent native steer 1' }], { delivery: 'steer' });
        assert.equal(binding.sessionState.entries.filter(entry => entry._meta?.farming?.steer === true
          && entry.content?.some(block => block.text === 'silent native steer 1')).length, 1,
          'predecessor handover confirms silent steer immediately without user_message_chunk');
        await runtime.submitMessage('native', [{ type: 'text', text: 'silent native steer 2' }], { delivery: 'steer' });
        assert.equal(binding.sessionState.entries.filter(entry => entry._meta?.farming?.steer === true
          && entry.content?.some(block => block.text === 'silent native steer 2')).length, 1,
          'chained silent steers confirm on each predecessor handover without waiting for echoes');
        await runtime.cancel('native');
        assert.equal((await silent).stopReason, 'cancelled');
        assert.equal(binding.sessionState.entries.filter(entry => entry._meta?.farming?.steer === true
          && entry.content?.some(block => String(block.text || '').startsWith('silent native steer '))).length, 2,
          'cancelling after handover preserves accepted silent steers in transcript');

        // Antigravity <= 1.5.9 can emit delayed user_message_chunk echoes for chained
        // steers after the first steer RPC already settled at handover to the second steer.
        const delayedChain = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void delayedChain.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await runtime.submitMessage('native', [{ type: 'text', text: 'delayed echo chain 1' }], { delivery: 'steer' });
        await runtime.submitMessage('native', [{ type: 'text', text: 'delayed echo chain 2' }], { delivery: 'steer' });
        fs.writeFileSync(path.join(root, 'release-chain-echo'), 'ready');
        assert.equal((await delayedChain).stopReason, 'end_turn');
        assert.equal(binding.sessionState.entries.filter(entry => entry.role === 'user'
          && entry.content?.some(block => block.text === 'delayed echo chain 1')).length, 1,
          'delayed echo arriving after chained handover must not duplicate the first steer');
        assert.equal(binding.sessionState.entries.filter(entry => entry.role === 'user'
          && entry.content?.some(block => block.text === 'delayed echo chain 2')).length, 1,
          'delayed echo arriving after chained handover must not duplicate the second steer');

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

        const completed = runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]);
        void completed.catch(() => {});
        await until(() => runtime.canSteer('native'));
        await runtime.steer('native', [
          { type: 'resource_link', uri: 'file:///demo/fixture.txt', name: 'fixture.txt' },
          { type: 'text', text: 'sparse native echo' },
        ]);
        await until(() => binding.activeTurn?.concurrentSteers?.[0]?.echoedBlocks === 2);
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'cancel native steer after original ended' }]), /cancelled before acceptance/);
        assert.equal((await completed).stopReason, 'end_turn', 'an unconfirmed cancelled successor does not change a completed owner');
        assert.equal(binding.sessionState.entries.filter(entry => entry.role === 'user'
          && entry.content?.some(block => block.text === 'sparse native echo')).length, 1);

        const failedBeforeHandover = assert.rejects(runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]), /Native steer failed before handover/);
        await until(() => runtime.canSteer('native'));
        await assert.rejects(runtime.steer('native', [{ type: 'text', text: 'fail native steer before handover' }]), /Native steer failed before handover/);
        await failedBeforeHandover;

        const failedAfterHandover = assert.rejects(runtime.prompt('native', [{ type: 'text', text: 'native steering hold' }]), /Native handover failed before echo/);
        await until(() => runtime.canSteer('native'));
        await runtime.steer('native', [{ type: 'text', text: 'fail native handover without echo' }]);
        await failedAfterHandover;
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
    assert.throws(() => runtime.routeProviderChildUpdate(parent, { sessionId: parent.sessionId, update: {
      _meta: { 'opencode/child-session': { id: parent.sessionId, parentID: 'child', depth: 2 } },
    } }), /identity conflicts/);
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
