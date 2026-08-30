const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { AcpRuntime } = require('../acp-runtime.cjs');

// Deterministic fake-connection harness (same pattern as the shared-crash
// tests in test-acp-runtime.ts): no real provider processes, fully scripted
// ACP connection.
function createOwnershipRuntime(home, runtimeOptions: { failInitializeFromGeneration?: number } = {}) {
  const children = [];
  let connectionGeneration = 0;
  const runtime = new AcpRuntime({
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      children.push(child);
      return child;
    },
    resolveLaunch() {
      // A long-lived stdin consumer stands in for the adapter process. It
      // must not depend on process.execPath: under the glibc-compat loader
      // execPath resolves to the loader itself, which cannot be spawned.
      return {
        command: '/bin/cat',
        args: [],
        version: 'reconnect-ownership-test',
      };
    },
    async createConnection(handlers) {
      connectionGeneration += 1;
      const generation = connectionGeneration;
      const signal = { aborted: false };
      let resolveClosed;
      return {
        signal,
        closed: new Promise(resolve => {
          resolveClosed = resolve;
        }),
        async initialize() {
          if (
            runtimeOptions.failInitializeFromGeneration
            && generation >= runtimeOptions.failInitializeFromGeneration
          ) {
            throw new Error('simulated candidate startup failure');
          }
          return {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
              sessionCapabilities: { close: {}, resume: {} },
            },
            agentInfo: { name: 'reconnect-ownership-test', version: '1' },
          };
        },
        async newSession() {
          return { sessionId: `ownership-session-${generation}-${crypto.randomUUID()}` };
        },
        async resumeSession({ sessionId }) {
          return { sessionId };
        },
        async loadSession({ sessionId }) {
          // History replay emits the restored transcript; it must advance the
          // revision fence like the real adapter replay.
          await handlers.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: `ownership-replayed-${generation}`,
              content: { type: 'text', text: 'replayed history' },
            },
          });
          return { sessionId };
        },
        async closeSession() {
          return {};
        },
        async prompt({ sessionId, prompt }) {
          await handlers.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: `ownership-answer-${generation}`,
              content: { type: 'text', text: String(prompt?.[0]?.text || '') },
            },
          });
          return { stopReason: 'end_turn' };
        },
        async cancel() {
          return {};
        },
        close() {
          signal.aborted = true;
          resolveClosed();
        },
      };
    },
  });
  return { runtime, children };
}

async function prepareAgent(runtime, home, agentId, extraOptions = {}) {
  await runtime.prepareAgent({
    agentId,
    provider: 'codex',
    providerHomeId: 'ownership-home',
    providerHomePath: home,
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: home, FARMING_AGENT_ID: agentId },
    ...extraOptions,
  });
}

// Exact cleanup proof: every spawned child PID must have exited after
// dispose. Bounded polling keeps a leaked child visible instead of letting a
// forced exit hide liveness.
async function verifyChildrenExited(children, context, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (const child of children) {
    while (child.exitCode === null && child.signalCode === null) {
      if (Date.now() > deadline) {
        throw new Error(`${context}: child ${child.pid || 'unknown'} was still live after dispose`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

async function disposeOwnershipRuntime(runtime, children, home, context) {
  const cleanupFailures = [];
  let exitProofSucceeded = false;
  try {
    await runtime.dispose();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // Fallback exact termination: every registered child still live gets
  // SIGTERM (SIGKILL after a bounded grace) and an exact exit proof, even
  // when dispose itself failed, so failure paths cannot leak children.
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null && child.killed !== true) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; the exit proof below is authoritative.
      }
    }
  }
  try {
    await verifyChildrenExited(children, context);
    exitProofSucceeded = true;
  } catch (verifyError) {
    cleanupFailures.push(verifyError);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the exit proof below is authoritative.
        }
      }
    }
    try {
      await verifyChildrenExited(children, `${context} (after SIGKILL)`);
      exitProofSucceeded = true;
    } catch (killError) {
      cleanupFailures.push(killError);
    }
  }
  if (exitProofSucceeded) {
    // Fixture removal happens only after the exact child-exit proof; a
    // removal failure is collected instead of masking the other failures.
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (removeError) {
      cleanupFailures.push(removeError);
    }
  }
  if (cleanupFailures.length > 0) {
    // Without exit proof the fixture is retained at its exact path for
    // diagnosis. All original failures are surfaced together, unmasked.
    const detail = cleanupFailures
      .map(error => (error && error.message) || String(error))
      .join(' | ');
    throw new AggregateError(
      cleanupFailures,
      `${context}: cleanup failed`
      + (exitProofSucceeded ? '' : ` (fixture retained at ${home})`)
      + `: ${detail}`,
    );
  }
}

// Defect: a stale reconnect failure must not overwrite a fresh binding that
// now owns the Agent slot. A concurrent replacement settles in the reconnect
// window (after the old process is stopped); the stale failure path then
// corrupts the fresh authoritative state.
async function staleCatchMustNotOverwriteFreshBinding() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-overwrite-'));
  const { runtime, children } = createOwnershipRuntime(home);
  try {
    await prepareAgent(runtime, home, 'agent-overwrite');
    await runtime.prompt('agent-overwrite', 'seed');
    const staleBinding = runtime.bindings.get('agent-overwrite');
    const staleSessionId = staleBinding.sessionId;
    runtime.handleExit(staleBinding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(runtime.getSession('agent-overwrite').state, 'error');
    assert.strictEqual(staleBinding.retryableReconnect, true);

    let replacementBinding = null;
    await assert.rejects(
      runtime.reconnectAgent('agent-overwrite', {
        onProcessStopped: async () => {
          // A concurrent replacement settles in the reconnect window with a
          // fresh session identity for the same Agent.
          await prepareAgent(runtime, home, 'agent-overwrite');
          replacementBinding = runtime.bindings.get('agent-overwrite');
        },
      }),
      /already registered/,
      'the stale reconnect must reject once the slot has a fresh owner',
    );

    assert.ok(replacementBinding, 'the replacement must have settled');
    assert.notStrictEqual(replacementBinding, staleBinding);
    assert.notStrictEqual(replacementBinding.sessionId, staleSessionId,
      'the replacement owns a fresh session identity');
    // The fresh authoritative state must survive the stale failure.
    assert.strictEqual(runtime.bindings.get('agent-overwrite'), replacementBinding,
      'the fresh binding must remain the owner');
    assert.strictEqual(replacementBinding.exited, false,
      'a stale reconnect failure must not mark the fresh binding exited');
    assert.strictEqual(replacementBinding.state, 'idle',
      'a stale reconnect failure must not corrupt the fresh binding state');
    assert.strictEqual(replacementBinding.sessionId, runtime.getSession('agent-overwrite').sessionId);
    // And the replacement stays usable.
    assert.strictEqual(
      (await runtime.prompt('agent-overwrite', 'after replacement')).stopReason,
      'end_turn',
      'the fresh binding must keep serving prompts',
    );
  } finally {
    await disposeOwnershipRuntime(runtime, children, home, 'staleCatchMustNotOverwriteFreshBinding');
  }
}

// Control: an ordinary reconnect failure with no replacement keeps the Agent
// visible and retryable (the existing recovery UX must be preserved).
async function failedReconnectWithoutReplacementStaysRetryable() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-retryable-'));
  const { runtime, children } = createOwnershipRuntime(home);
  try {
    // The runtime refresh hook is persisted with the binding's restart
    // options; a failing refresh makes the reconnect fail after the old
    // process was stopped (no replacement settles).
    await prepareAgent(runtime, home, 'agent-retryable', {
      refreshMcpServersForRuntime: async () => ({ capabilityRuntimeEpoch: '', mcpServers: [] }),
    });
    await runtime.prompt('agent-retryable', 'seed');
    const binding = runtime.bindings.get('agent-retryable');
    runtime.handleExit(binding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(binding.retryableReconnect, true);

    await assert.rejects(
      runtime.reconnectAgent('agent-retryable'),
      /invalid epoch/,
    );

    const failedBinding = runtime.bindings.get('agent-retryable');
    assert.strictEqual(failedBinding, binding, 'the failed Agent stays visible on its own binding');
    assert.strictEqual(failedBinding.state, 'error');
    assert.strictEqual(failedBinding.stopReason, 'error');
    assert.strictEqual(failedBinding.exited, true);
    assert.strictEqual(failedBinding.retryableReconnect, true,
      'the failure stays retryable for the exact Agent');
  } finally {
    await disposeOwnershipRuntime(runtime, children, home, 'failedReconnectWithoutReplacementStaysRetryable');
  }
}

// Defect: an external unregister/delete arriving after the reconnect removed
// the old binding (slot already empty) must invalidate the reconnect's claim
// on the vacancy. The stale failure must leave the deleted Agent absent.
async function externalUnregisterKeepsDeletedAgentAbsent() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-deleted-'));
  const { runtime, children } = createOwnershipRuntime(home);
  try {
    // A failing runtime refresh hook makes the reconnect fail after the
    // external delete lands.
    await prepareAgent(runtime, home, 'agent-deleted', {
      refreshMcpServersForRuntime: async () => ({ capabilityRuntimeEpoch: '', mcpServers: [] }),
    });
    await runtime.prompt('agent-deleted', 'seed');
    const binding = runtime.bindings.get('agent-deleted');
    runtime.handleExit(binding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(binding.retryableReconnect, true);

    await assert.rejects(
      runtime.reconnectAgent('agent-deleted', {
        onProcessStopped: async () => {
          // An external lifecycle operation (kill/archive) deletes the Agent
          // in the reconnect window; the slot is already empty.
          await runtime.unregisterAgentAndWait('agent-deleted');
        },
      }),
      /invalid epoch/,
    );

    assert.strictEqual(runtime.bindings.has('agent-deleted'), false,
      'an externally deleted Agent must stay absent after a stale reconnect failure');
  } finally {
    await disposeOwnershipRuntime(runtime, children, home, 'externalUnregisterKeepsDeletedAgentAbsent');
  }
}

// Control: the ordinary recovery path still succeeds end-to-end. A reconnect
// after abrupt loss with no interference replaces the binding, resumes the
// same provider session, and the reservation does not block it.
async function ordinaryReconnectAfterLossSucceeds() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-success-'));
  const { runtime, children } = createOwnershipRuntime(home);
  try {
    await prepareAgent(runtime, home, 'agent-success');
    await runtime.prompt('agent-success', 'seed');
    const binding = runtime.bindings.get('agent-success');
    const sessionId = binding.sessionId;
    const revision = binding.sessionState.revision;
    runtime.handleExit(binding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(runtime.getSession('agent-success').state, 'error');

    const recovered = await runtime.reconnectAgent('agent-success');
    assert.strictEqual(recovered.reconnected, true);
    const reconnected = runtime.getSession('agent-success');
    assert.strictEqual(reconnected.sessionId, sessionId, 'recovery restores the same provider session');
    assert.strictEqual(reconnected.state, 'idle');
    assert.ok(reconnected.revision > revision, 'history recovery advances the revision fence');
    assert.strictEqual(
      (await runtime.prompt('agent-success', 'after recovery')).stopReason,
      'end_turn',
      'the replacement binding accepts a new explicit prompt',
    );
    assert.strictEqual(runtime.reconnectReservations.has('agent-success'), false,
      'a successful reconnect leaves no lingering reservation');
  } finally {
    await disposeOwnershipRuntime(runtime, children, home, 'ordinaryReconnectAfterLossSucceeds');
  }
}

// No-interference failure after the candidate binding has been installed:
// the reconnect-owned prepare keeps its reservation through startup and
// expected cleanup, so the stale failure restores the old binding retryable
// instead of leaving the Agent absent.
async function candidateStartupFailureRestoresOldBindingRetryable() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-candidate-'));
  const { runtime, children } = createOwnershipRuntime(home, { failInitializeFromGeneration: 2 });
  try {
    await prepareAgent(runtime, home, 'agent-candidate');
    await runtime.prompt('agent-candidate', 'seed');
    const oldBinding = runtime.bindings.get('agent-candidate');
    runtime.handleExit(oldBinding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(oldBinding.retryableReconnect, true);

    await assert.rejects(
      runtime.reconnectAgent('agent-candidate'),
      /simulated candidate startup failure/,
    );

    const restored = runtime.bindings.get('agent-candidate');
    assert.strictEqual(restored, oldBinding,
      'the old binding is restored when the reconnect-owned candidate fails');
    assert.strictEqual(restored.state, 'error');
    assert.strictEqual(restored.stopReason, 'error');
    assert.match(restored.error, /ACP reconnect failed/);
    assert.strictEqual(restored.retryableReconnect, true,
      'the restored failure stays retryable for the exact Agent');
    assert.strictEqual(runtime.reconnectReservations.has('agent-candidate'), false,
      'the failure consumes the reservation');
  } finally {
    // Exact cleanup proof includes every spawned process exiting.
    await disposeOwnershipRuntime(runtime, children, home, 'candidateStartupFailureRestoresOldBindingRetryable');
  }
}

// External unregister during the reconnect window with no injected later
// failure: the reconnect-owned prepare must be rejected at admission, and
// the deleted Agent must stay absent (no resurrection through a fresh
// candidate binding).
async function externalUnregisterRejectsReconnectOwnedPrepare() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-reconnect-admission-'));
  const { runtime, children } = createOwnershipRuntime(home);
  try {
    await prepareAgent(runtime, home, 'agent-admission');
    await runtime.prompt('agent-admission', 'seed');
    const binding = runtime.bindings.get('agent-admission');
    runtime.handleExit(binding, new Error('simulated abrupt adapter loss'));
    assert.strictEqual(binding.retryableReconnect, true);

    await assert.rejects(
      runtime.reconnectAgent('agent-admission', {
        onProcessStopped: async () => {
          await runtime.unregisterAgentAndWait('agent-admission');
        },
      }),
      /reservation no longer owns this Agent slot/,
    );

    assert.strictEqual(runtime.bindings.has('agent-admission'), false,
      'the deleted Agent stays absent when its reservation was invalidated');
    assert.strictEqual(runtime.reconnectReservations.has('agent-admission'), false);
  } finally {
    await disposeOwnershipRuntime(runtime, children, home, 'externalUnregisterRejectsReconnectOwnedPrepare');
  }
}

async function run() {
  await failedReconnectWithoutReplacementStaysRetryable();
  await staleCatchMustNotOverwriteFreshBinding();
  await externalUnregisterKeepsDeletedAgentAbsent();
  await candidateStartupFailureRestoresOldBindingRetryable();
  await externalUnregisterRejectsReconnectOwnedPrepare();
  await ordinaryReconnectAfterLossSucceeds();
}

// No forced exit: leaked children or open handles must stay visible as
// liveness instead of being masked by process.exit.
run().then(() => {
  console.log('acp reconnect ownership tests passed');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
