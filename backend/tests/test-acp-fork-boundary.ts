import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpSessionState } from '../acp-session-state.cjs';
import { AcpRuntime } from '../acp-runtime.cjs';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

function message(state: AcpSessionState, id: string, role: string, text: string) {
  state.pushEntry({ id, type: 'message', role, content: [{ type: 'text', text }] });
}

for (const provider of ['codex', 'claude', 'gemini', 'qoder', 'pi']) {
  const state = new AcpSessionState({ provider, sessionId: 'child' });
  message(state, 'u1', 'user', 'first question');
  message(state, 'a1', 'assistant', 'first answer');
  message(state, 'u2', 'user', 'second question');
  message(state, 'a2', 'assistant', 'second answer');
  state.captureForkOrigin('parent');
  message(state, 'u3', 'user', 'child question');
  message(state, 'a3', 'assistant', 'child answer');
  const projection = projectAcpTranscript(state.snapshot());
  assert.equal(projection.forkOrigin?.afterTurnId, 'acp-turn-u2');
  assert.equal(projection.turns.at(-1)?.id, 'acp-turn-u3');
  // Paging/deltas must carry the same boundary, never attach it to their tail.
  assert.equal(projectAcpTranscript(state.transcriptSlice({ maxTurns: 1 })).forkOrigin?.afterTurnId, 'acp-turn-u2');
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!;
  assert.deepEqual(restored.snapshot().forkOrigin, state.snapshot().forkOrigin);
  const replay = new AcpSessionState({ provider, sessionId: 'child' });
  message(replay, 'replay-u1', 'user', 'first question');
  message(replay, 'replay-a1', 'assistant', 'first answer');
  replay.pushEntry({ id: 'extra-tool', type: 'tool', title: 'Different replay shape' });
  message(replay, 'replay-u2', 'user', 'second question');
  message(replay, 'replay-a2', 'assistant', 'second answer');
  message(replay, 'replay-u3', 'user', 'child question');
  replay.restoreForkOrigin(state.forkOrigin);
  assert.equal(projectAcpTranscript(replay.snapshot()).forkOrigin?.afterTurnId, 'acp-turn-replay-u2');
  replay.captureForkOrigin('child');
  assert.equal(projectAcpTranscript(replay.snapshot()).forkOrigin?.afterTurnId, 'acp-turn-replay-u3');
  assert.equal(replay.forkOrigin?.sourceSessionId, 'child', 'a second fork owns its new boundary');
  const compacted = new AcpSessionState({ provider, sessionId: 'child' });
  message(compacted, 'summary', 'user', 'compacted history');
  compacted.restoreForkOrigin(state.forkOrigin);
  assert.equal(projectAcpTranscript(compacted.snapshot()).forkOrigin?.status, 'unavailable');
  const empty = new AcpSessionState({ provider, sessionId: 'empty-child' });
  empty.captureForkOrigin('empty-parent');
  message(empty, 'new', 'user', 'first child question');
  assert.equal(projectAcpTranscript(empty.snapshot()).forkOrigin?.afterTurnId, '');
  assert.equal(projectAcpTranscript(new AcpSessionState({ provider }).snapshot()).forkOrigin, null);
}

async function testRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-fork-boundary-'));
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
  const options = {
    agentId: 'child', provider: 'codex', cwd: root, env: process.env,
    sessionId: 'existing-session', historyMode: 'load', approvalMode: 'full',
  };
  try {
    const first = create();
    await first.prepareAgent({ ...options, forkOriginSessionId: 'parent' });
    const origin = first.getTranscriptSession('child').forkOrigin;
    assert.equal(origin?.status, 'ready');
    assert.ok(origin?.afterEntryId);
    const binding = first.requireBinding('child');
    assert.equal(binding.restartOptions.forkOriginSessionId, undefined, 'restart must not recapture the boundary');
    const saved = await first.checkpointStore!.load(first.checkpointIdentity(binding)!, { allowDirty: true });
    assert.ok(saved, 'fork lineage is durable before prepare returns');
    await first.dispose();
    runtimes.splice(runtimes.indexOf(first), 1);
    const restarted = create();
    await restarted.prepareAgent(options);
    assert.deepEqual(restarted.getTranscriptSession('child').forkOrigin, origin,
      'authoritative history load restores the original boundary from the checkpoint');
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.dispose()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testRecovery().then(() => console.log('ACP fork boundary tests passed')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
