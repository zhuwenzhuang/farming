const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AcpCheckpointStore } = require('../acp-checkpoint-store');
const { AcpRuntime } = require('../acp-runtime');
const { AcpSessionState } = require('../acp-session-state');

const fixture = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

function runtime(configDir) {
  return new AcpRuntime({
    configDir,
    checkpointOptions: { writeDelayMs: 0 },
    resolveLaunch: () => ({ command: process.execPath, args: [fixture], version: 'test' }),
  });
}

async function prepare(target, agentId, configDir, providerHomeId = 'default') {
  return target.prepareAgent({
    agentId,
    provider: 'codex',
    providerHomeId,
    cwd: configDir,
    env: process.env,
    sessionId: 'existing-session',
    historyMode: 'checkpoint',
    approvalMode: 'full',
  });
}

async function run() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-recovery-'));
  try {
    const cold = runtime(configDir);
    const first = await prepare(cold, 'agent-cold', configDir);
    assert.strictEqual(first.historyMode, 'load', 'a cold cache must use authoritative ACP history replay');
    assert.strictEqual(cold.getSession('agent-cold').entries[0].content[0].text, 'historical question');
    const coldRevision = cold.getTranscriptSession('agent-cold').revision;
    await cold.dispose();

    const warm = runtime(configDir);
    const resumed = await prepare(warm, 'agent-warm', configDir);
    assert.strictEqual(resumed.historyMode, 'load',
      'ACP timestamps cannot prove a conditional resume, so recovery must fail closed to full load');
    assert.strictEqual(warm.getSession('agent-warm').entries[1].content[0].text, 'historical answer');
    const staleReader = warm.getTranscriptSession('agent-warm', { sinceRevision: coldRevision });
    assert.strictEqual(staleReader.delta, false,
      'a full repair must reset browsers carrying a revision from the discarded reducer');
    assert.strictEqual(staleReader.entries.length, 2);

    const binding = warm.requireBinding('agent-warm');
    const childState = new AcpSessionState({
      provider: 'codex', sessionId: 'acp-child-session', cwd: configDir,
    });
    childState.apply({
      sessionId: 'acp-child-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'child-answer',
        content: { type: 'text', text: 'child checkpoint detail' },
      },
    });
    binding.subagentStates.set('acp-child-session', childState);
    binding.patchDecisions.set('tool-1\nREADME.md', 'kept');
    const bindingCheckpoint = warm.bindingCheckpoint(binding).exportCheckpoint();
    const restoredBinding = warm.restoreBindingCheckpoint(binding, bindingCheckpoint, {
      sessionId: binding.sessionId,
    });
    assert.strictEqual(restoredBinding.subagentStates.get('acp-child-session').entries[0].content[0].text,
      'child checkpoint detail');
    assert.strictEqual(restoredBinding.patchDecisions.get('tool-1\nREADME.md'), 'kept');
    assert.strictEqual(restoredBinding.complete, false,
      'a snapshot without a provider conditional-resume proof must never be labeled exact');

    const cwdMismatch = await warm.checkpointMatchesProviderSession({
      async listSessions() {
        return { sessions: [{
          sessionId: binding.sessionId,
          cwd: path.join(configDir, 'other-workspace'),
          checkpointRevision: 'opaque-1',
        }] };
      },
    }, { sessionCapabilities: { list: true } }, {
      sessionId: binding.sessionId,
      cwd: configDir,
    }, { state: { providerProof: { token: 'opaque-1', cwd: configDir } } });
    assert.strictEqual(cwdMismatch, false, 'provider workspace identity must match exactly');
    await warm.dispose();

    const identity = {
      provider: 'codex',
      providerHomeId: 'default',
      sessionId: 'existing-session',
      cwd: configDir,
    };
    const store = new AcpCheckpointStore(configDir);
    await store.markDirty(identity);
    await store.dispose();

    const repair = runtime(configDir);
    const repaired = await prepare(repair, 'agent-repair', configDir);
    assert.strictEqual(repaired.historyMode, 'load', 'a dirty checkpoint must fall back to full history replay');
    await repair.dispose();

    const failedPrompt = runtime(configDir);
    await prepare(failedPrompt, 'agent-failed-prompt', configDir);
    await assert.rejects(
      () => failedPrompt.prompt('agent-failed-prompt', 'authentication error'),
      /Unauthorized|sign in required/,
    );
    await failedPrompt.checkpointStore.flush();
    const failedPromptCheckpoint = await failedPrompt.checkpointStore.load(identity, { allowDirty: true });
    assert.strictEqual(failedPromptCheckpoint?.exact, false,
      'an uncertain prompt failure must retain the dirty recovery fence');
    await failedPrompt.dispose();

    const bareResumeDir = path.join(configDir, 'bare-resume');
    fs.mkdirSync(bareResumeDir, { recursive: true });
    const bareResume = runtime(bareResumeDir);
    const bare = await bareResume.prepareAgent({
      agentId: 'agent-bare-resume',
      provider: 'codex',
      cwd: bareResumeDir,
      env: process.env,
      sessionId: 'existing-session',
      historyMode: 'resume',
      approvalMode: 'full',
    });
    assert.strictEqual(bare.historyMode, 'resume');
    await bareResume.checkpointStore.flush();
    const bareIdentity = {
      provider: 'codex', providerHomeId: 'default', sessionId: 'existing-session', cwd: bareResumeDir,
    };
    assert.strictEqual((await bareResume.checkpointStore.load(bareIdentity, { allowDirty: true }))?.exact, false,
      'bare resume has no reducer proof and must never create an exact checkpoint');
    await bareResume.dispose();

    const otherHome = runtime(configDir);
    const isolated = await prepare(otherHome, 'agent-other-home', configDir, 'other');
    assert.strictEqual(isolated.historyMode, 'load', 'checkpoints must not cross Agent Home identities');
    await otherHome.dispose();
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
  console.log('ACP checkpoint recovery tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
