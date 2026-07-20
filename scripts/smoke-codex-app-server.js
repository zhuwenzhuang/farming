#!/usr/bin/env node
/**
 * Explicit, low-volume integration smoke for the installed Codex App Server.
 *
 * It intentionally updates the current thread's permission settings, sends
 * one mixed text/image/audio turn, steers that live turn, and verifies that
 * the resulting thread can be resumed by a second App Server client binding.
 * It is never part of `npm test` or release CI.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAppServerRuntime } = require('../backend/codex-app-server-runtime');
const { ensureCodexAppServerHome } = require('../backend/codex-app-server-home');
const { resolveCompatibleCodexExecutable } = require('../backend/executable-discovery');

function waitForTurnCompletion(runtime, agentId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      runtime.off('agent-runtime', onRuntimeEvent);
      reject(new Error('Timed out waiting for Codex App Server turn completion'));
    }, timeoutMs);
    const onRuntimeEvent = event => {
      if (event.agentId !== agentId || event.state !== 'idle') return;
      clearTimeout(timer);
      runtime.off('agent-runtime', onRuntimeEvent);
      resolve();
    };
    runtime.on('agent-runtime', onRuntimeEvent);
  });
}

async function run() {
  if (process.env.FARMING_REAL_CODEX_APP_SERVER_SMOKE !== '1') {
    throw new Error('Set FARMING_REAL_CODEX_APP_SERVER_SMOKE=1 to send the one real Codex App Server smoke turn');
  }

  const resolved = resolveCompatibleCodexExecutable();
  if (!resolved.compatible || !resolved.path) {
    throw new Error(resolved.error || 'A compatible installed Codex CLI is required');
  }

  const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'farming-codex-app-server-'));
  // macOS resolves os.tmpdir() to a long /var/folders/... path. Keep this
  // App Server control socket below the Unix-domain socket pathname limit.
  const runtimeConfigDir = await fs.promises.mkdtemp('/tmp/fm-codex-');
  const sourceCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  // Match the product runtime: the App Server gets a private control socket
  // while the selected Codex home's identity/configuration is linked in.
  const codexHome = ensureCodexAppServerHome({
    configDir: runtimeConfigDir,
    agentId: 'agent-real-smoke',
    sourceHome: sourceCodexHome,
  });
  const runtimeEnv = { ...process.env, CODEX_HOME: codexHome };
  const runtime = new CodexAppServerRuntime({ connectTimeoutMs: 15_000 });
  try {
    const imagePath = path.join(workspace, 'smoke-image.png');
    const audioPath = path.join(workspace, 'smoke-audio.wav');
    // Tiny, valid public-format fixtures. The model is told not to inspect
    // them; they exercise Farming's Composer transport only.
    await fs.promises.writeFile(imagePath, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLw3QAAAABJRU5ErkJggg==',
      'base64'
    ));
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36, 4);
    wav.write('WAVEfmt ', 8, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(8000, 28);
    wav.writeUInt16LE(1, 32);
    wav.writeUInt16LE(8, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(0, 40);
    await fs.promises.writeFile(audioPath, wav);

    const prepared = await runtime.prepareAgent({
      agentId: 'real-smoke-start',
      codexHome,
      executable: resolved.path,
      env: runtimeEnv,
      cwd: workspace,
      workspaceRoot: workspace,
      approvalMode: 'approve',
    });
    const permissionUpdate = await runtime.updateAgentPermissionMode({
      agentId: 'real-smoke-start',
      approvalMode: 'ask',
    });
    assert.strictEqual(permissionUpdate.threadId, prepared.threadId);
    const completion = waitForTurnCompletion(runtime, 'real-smoke-start');
    const turn = await runtime.submitComposerMessage({
      agentId: 'real-smoke-start',
      message: 'Reply with exactly: ready. Do not inspect the attached files.',
      input: [
        { type: 'text', text: 'Reply with exactly: ready. Do not inspect the attached files.' },
        { type: 'image', path: imagePath },
        { type: 'audio', path: audioPath },
      ],
    });
    assert.strictEqual(turn.kind, 'start');
    assert(turn.turnId, 'turn/start must return a turn id');
    const steer = await runtime.submitComposerMessage({
      agentId: 'real-smoke-start',
      message: 'Continue the active turn and reply with exactly: steered',
    });
    assert(['steer', 'start'].includes(steer.kind), 'the follow-up must either steer the live turn or recover one stale steer as a new turn');
    if (steer.kind === 'steer') {
      assert.strictEqual(steer.turnId, turn.turnId);
    }
    await completion;
    const appliedInput = runtime.transcripts.get('real-smoke-start').events.find(event => (
      event.method === 'item/started'
      && event.params && event.params.item && event.params.item.id.startsWith(`farming-composer-${turn.turnId}-`)
    )).params.item.content;
    assert(appliedInput.some(item => item.type === 'localImage' && item.path === imagePath));
    const appServerEntry = runtime.homeEntry(codexHome);
    if (appServerEntry.supportsLocalAudio === false) {
      assert(appliedInput.some(item => item.type === 'input_text' && item.text.includes(audioPath)), 'an older App Server must receive an explicit audio-path fallback');
    } else {
      assert(appliedInput.some(item => item.type === 'localAudio' && item.path === audioPath));
    }

    const resumed = await runtime.prepareAgent({
      agentId: 'real-smoke-resume',
      codexHome,
      executable: resolved.path,
      env: runtimeEnv,
      cwd: workspace,
      workspaceRoot: workspace,
      resumeThreadId: prepared.threadId,
    });
    assert.strictEqual(resumed.threadId, prepared.threadId, 'a thread with its first turn must resume');
    console.log(`✓ real Codex App Server settings-update/mixed-input/${steer.kind === 'steer' ? 'steer' : 'stale-steer-recovery'}/turn/resume smoke passed`);
  } finally {
    runtime.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true });
    await fs.promises.rm(runtimeConfigDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
