import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpSessionState } from '../acp-session-state.cjs';
import { AcpRuntime } from '../acp-runtime.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

const previous = { id: 'old-model', name: 'Previous model' };
const next = { id: 'new-model', name: 'Next model' };
function message(state: AcpSessionState, id: string, text: string) {
  state.pushEntry({ id, type: 'message', role: 'user', content: [{ type: 'text', text }] });
}

for (const provider of ['codex', 'claude', 'gemini', 'qoder', 'pi']) {
  const state = new AcpSessionState({ provider, sessionId: 'session' });
  message(state, 'u1', 'first question');
  const revision = state.revision;
  assert.equal(state.recordModelChange(previous, next), true);
  assert.ok(state.revision > revision);
  assert.equal(state.recordModelChange(next, next), false);
  message(state, 'u2', 'next question');
  const boundary = projectAcpTranscript(state.snapshot()).modelChanges![0];
  assert.deepEqual(boundary, {
    id: boundary.id, from: previous, to: next, status: 'ready', afterTurnId: 'acp-turn-u1',
  });
  assert.deepEqual(projectAcpTranscript(state.transcriptSlice({ maxTurns: 1 })).modelChanges, [boundary]);
  assert.deepEqual(projectAcpTranscript(state.transcriptSlice({ sinceRevision: revision, entryPatches: true })).modelChanges, [boundary]);
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  assert.deepEqual(projectAcpTranscript(restored.snapshot()).modelChanges, [boundary]);
  restored.recordModelChange(next, previous);
  assert.notEqual(restored.modelChanges[0].id, restored.modelChanges[1].id);
  const replay = new AcpSessionState({ provider, sessionId: 'session' });
  message(replay, 'replayed-u1', 'first question');
  message(replay, 'replayed-u2', 'next question');
  replay.restoreModelChanges(state.modelChanges);
  assert.equal(projectAcpTranscript(replay.snapshot()).modelChanges![0].afterTurnId, 'acp-turn-replayed-u1');
  const compacted = new AcpSessionState({ provider, sessionId: 'session' });
  message(compacted, 'summary', 'different history');
  compacted.restoreModelChanges(state.modelChanges);
  assert.equal(projectAcpTranscript(compacted.snapshot()).modelChanges![0].status, 'unavailable');
  const empty = new AcpSessionState({ provider, sessionId: 'empty' });
  empty.recordModelChange(previous, next);
  assert.equal(projectAcpTranscript(empty.snapshot()).modelChanges![0].afterTurnId, '');
}

async function testRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-model-boundary-'));
  const runtimes: AcpRuntime[] = [];
  const create = () => {
    const runtime = new AcpRuntime({
      configDir: root,
      resolveLaunch: () => ({
        command: process.execPath,
        args: ['--import', require.resolve('tsx'), path.join(__dirname, 'fixtures/fake-acp-agent.mts')],
        version: 'test',
      }),
    });
    runtimes.push(runtime);
    return runtime;
  };
  try {
    for (const provider of ['codex', 'claude', 'gemini', 'qoder', 'pi']) {
      const runtime = create();
      const options = {
        agentId: provider, provider, cwd: root,
        env: { ...process.env, FARMING_TEST_ACP_MODEL_MATRIX: '1' },
        sessionId: `existing-${provider}`, historyMode: 'load', approvalMode: 'full',
      };
      await runtime.prepareAgent(options);
      const binding = runtime.requireBinding(provider);
      const changes = () => projectAcpTranscript(runtime.getTranscriptSession(provider)).modelChanges!;
      assert.equal(changes().length, 0, 'initial configuration must not create a boundary');
      await runtime.setSessionConfigOption(provider, 'model', 'gpt-5.6-luna');
      assert.equal(changes().length, 1);
      assert.equal(changes()[0].from.id, 'gpt-5.5');
      assert.equal(changes()[0].to.id, 'gpt-5.6-luna');
      await runtime.setSessionConfigOption(provider, 'model', 'gpt-5.6-luna');
      await runtime.setSessionConfigOption(provider, 'reasoning', 'medium');
      assert.equal(changes().length, 1, 'no-op and reasoning-only choices do not add model boundaries');
      const setConfig = binding.connection.setSessionConfigOption.bind(binding.connection);
      binding.connection.setSessionConfigOption = params => {
        if (params.configId === 'reasoning' && params.value === 'low') throw new Error('fixture config failure');
        return setConfig(params);
      };
      await assert.rejects(runtime.setSessionConfigOptions(provider, [
        { configId: 'model', value: 'gpt-5.5' }, { configId: 'reasoning', value: 'low' },
      ]), /fixture config failure/);
      assert.equal(changes().length, 1, 'failed batches and rollback must not create boundaries');
      binding.connection.setSessionConfigOption = setConfig;
      await runtime.writeCheckpoint(binding);
      const expected = changes();
      const configOverrides = binding.restartOptions.configOverrides;
      await runtime.dispose();
      runtimes.splice(runtimes.indexOf(runtime), 1);
      const restarted = create();
      await restarted.prepareAgent({ ...options, configOverrides });
      assert.deepEqual(projectAcpTranscript(restarted.getTranscriptSession(provider)).modelChanges, expected,
        'provider replay must preserve model history without adding restoration changes');
      const resumed = restarted.requireBinding(provider);
      const prompt = resumed.connection.prompt.bind(resumed.connection);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      resumed.connection.prompt = async request => {
        entered();
        await gate;
        return prompt(request);
      };
      const running = restarted.prompt(provider, [{ type: 'text', text: 'image attachment model history' }]);
      try {
        await started;
        await restarted.setSessionConfigOption(provider, 'model', 'gpt-5.5');
        await restarted.setSessionConfigOption(provider, 'model', 'gpt-5.6-luna');
        await restarted.setSessionConfigOption(provider, 'model', 'gpt-5.5');
        assert.equal(resumed.sessionState.modelChanges.length, 1, 'pending choices must not claim to be applied');
      } finally {
        release();
        await running;
      }
      await resumed.deferredConfigFlush;
      const afterDeferred = projectAcpTranscript(restarted.getTranscriptSession(provider));
      assert.equal(afterDeferred.modelChanges!.length, 2, 'coalesced changes create one confirmed boundary');
      assert.equal(afterDeferred.modelChanges![1].to.id, 'gpt-5.5');
      assert.equal(afterDeferred.modelChanges![1].afterTurnId, afterDeferred.turns.at(-1)!.id);
      await restarted.dispose();
      runtimes.splice(runtimes.indexOf(restarted), 1);
    }
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testRuntime().then(() => console.log('ACP model boundary tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
