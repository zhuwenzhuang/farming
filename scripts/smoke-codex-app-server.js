#!/usr/bin/env node
/**
 * Explicit, low-volume integration smoke for the installed Codex App Server.
 *
 * It intentionally updates the current thread's permission settings, sends
 * one tiny real turn, and verifies that the resulting thread can be resumed
 * by a second App Server client binding. It is never part of `npm test` or
 * release CI.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAppServerRuntime } = require('../backend/codex-app-server-runtime');
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
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const runtime = new CodexAppServerRuntime({ connectTimeoutMs: 15_000 });
  try {
    const prepared = await runtime.prepareAgent({
      agentId: 'real-smoke-start',
      codexHome,
      executable: resolved.path,
      env: process.env,
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
      message: 'Reply with exactly: ready',
    });
    assert.strictEqual(turn.kind, 'start');
    assert(turn.turnId, 'turn/start must return a turn id');
    await completion;

    const resumed = await runtime.prepareAgent({
      agentId: 'real-smoke-resume',
      codexHome,
      executable: resolved.path,
      env: process.env,
      cwd: workspace,
      workspaceRoot: workspace,
      resumeThreadId: prepared.threadId,
    });
    assert.strictEqual(resumed.threadId, prepared.threadId, 'a thread with its first turn must resume');
    console.log('✓ real Codex App Server settings-update/start/turn/resume smoke passed');
  } finally {
    runtime.dispose();
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
