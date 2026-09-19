import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const { AcpRuntime } = require('../acp-runtime.cjs');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-retained-session-'));
  let spawns = 0;
  const options = {
    configDir: root,
    spawn(...args: Parameters<typeof spawn>) { spawns++; return spawn(...args); },
    resolveLaunch: () => ({ command: process.execPath, args: ['--import', require.resolve('tsx'), path.resolve(__dirname, 'fixtures/fake-acp-agent.mts')], version: 'test' }),
  };
  let runtime = new AcpRuntime(options);
  const prepare = { agentId: 'retained-child', provider: 'codex', cwd: root, providerHomeId: 'test', providerHomePath: path.join(root, 'home') };
  try {
    const opened = await runtime.prepareAgent(prepare);
    await runtime.submitMessage(prepare.agentId, [{ type: 'text', text: 'image attachment retained transcript' }]);
    const original = runtime.getSession(prepare.agentId);
    const liveBinding = runtime.bindings.get(prepare.agentId);
    liveBinding.initializeResponse.agentCapabilities._meta = { sessionArchive: { version: 1, method: '_session/archive' } };
    const child = liveBinding.child;
    const result = await runtime.retainAgent(prepare.agentId);
    assert.equal(result.sessionId, opened.sessionId);
    assert.equal(result.retained, true);
    assert.equal(runtime.getSession(prepare.agentId).state, 'closed');
    assert.deepEqual(runtime.getSession(prepare.agentId).entries, original.entries, 'retention preserves readable history');
    assert.equal(runtime.bindings.get(prepare.agentId).runtime, null);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned provider process must exit');
    assert.equal(await runtime.archiveSession(prepare.agentId), false, 'retained history must not send an archive RPC to its stopped writer');
    assert.equal(runtime.getSession(prepare.agentId).state, 'closed');
    const count = spawns;
    await runtime.dispose();
    runtime = new AcpRuntime(options);
    await runtime.prepareAgent({ ...prepare, sessionId: opened.sessionId, retained: true });
    assert.equal(spawns, count, 'cold retained recovery must not spawn a provider');
    assert.deepEqual(runtime.getSession(prepare.agentId).entries, original.entries);
    const resumed = await runtime.reconnectAgent(prepare.agentId);
    assert.equal(resumed.reconnected, true);
    assert.equal(resumed.sessionId, opened.sessionId);
    assert.equal(spawns, count + 1, 'sending preparation resumes exactly once');
    await runtime.submitMessage(prepare.agentId, [{ type: 'text', text: 'image attachment after retained resume' }]);
    assert.equal(runtime.getSession(prepare.agentId).state, 'idle');
    const pending = runtime.submitMessage(prepare.agentId, [{ type: 'text', text: 'long subagent supervision loss' }]).catch(() => null);
    const deadline = Date.now() + 5000;
    while (!runtime.bindings.get(prepare.agentId).activeTurn || !runtime.bindings.get(prepare.agentId).subagentStates.size) {
      if (Date.now() > deadline) throw new Error('Fake subagent did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await assert.rejects(runtime.retainAgent(prepare.agentId), /active|idle|working|turn/i);
    await runtime.retainAgent(prepare.agentId, true);
    await pending;
    assert.equal(runtime.bindings.get(prepare.agentId).activeTurn, null);
    const interrupted = runtime.getSession(prepare.agentId).entries.findLast((entry: { role?: string }) => entry.role === 'user');
    assert.ok(interrupted.turnCompletedAt, 'forced release must seal the interrupted turn');
    const beforeResume = spawns;
    await runtime.reconnectAgent(prepare.agentId);
    assert.equal(spawns, beforeResume + 1);
    assert.equal(runtime.bindings.get(prepare.agentId).activeTurn, null, 'resume cannot replay the interrupted prompt');
    await runtime.retainAgent(prepare.agentId);
    assert.equal(await runtime.unregisterAgentAndWait(prepare.agentId), true);
    assert.equal(runtime.hasBinding(prepare.agentId), false, 'delete must remove the retained slot');
    console.log('retained ACP session tests passed');
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
