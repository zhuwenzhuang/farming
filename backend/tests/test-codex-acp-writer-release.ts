import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { AcpRuntime } from '../acp-runtime.cts';

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-writer-release-'));
  const requests = path.join(root, 'requests.jsonl');
  const startup = path.join(root, 'startup.json');
  const gate = path.join(root, 'close');
  const failure = path.join(root, 'unsubscribe-failure');
  const runtime = new AcpRuntime();
  const prepare = (agentId: string) => runtime.prepareAgent({
    agentId, provider: 'codex', providerHomeId: 'writer-release', providerHomePath: root,
    cwd: root, projectWorkspace: root,
    env: { ...process.env, CODEX_HOME: root,
      CODEX_PATH: path.join(__dirname, 'fixtures', 'fake-codex-app-server.ts'),
      FARMING_TEST_MULTI_SESSION: '1', FARMING_TEST_CHILD_INVENTORY: '1',
      FARMING_TEST_CLOSE_GATE_PREFIX: gate, FARMING_TEST_REQUEST_LOG_FILE: requests,
      FARMING_TEST_STARTUP_ARGS_FILE: startup, FARMING_TEST_UNSUBSCRIBE_FAILURE_FILE: failure },
  });
  const waitForUnsubscribe = async (sessionId: string, count = 1) => {
    const deadline = Date.now() + 5_000;
    while (fs.readFileSync(requests, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line)).filter(call => call.method === 'thread/unsubscribe' && call.params.threadId === sessionId).length < count) {
      assert.ok(Date.now() < deadline, 'unsubscribe must reach the owning app-server');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    const first = await prepare('writer-a');
    const peer = await prepare('writer-peer');
    const firstBinding = runtime.bindings.get('writer-a');
    const peerBinding = runtime.bindings.get('writer-peer');
    assert.ok(firstBinding && peerBinding);
    assert.equal(firstBinding.child.pid, peerBinding.child.pid);
    const args: string[] = JSON.parse(fs.readFileSync(startup, 'utf8'));
    assert.equal(args.at(-1), 'thread_unload_delay_secs=0');

    fs.writeFileSync(failure, 'fail');
    await assert.rejects(runtime.unregisterAgentAndWait('writer-a'), error => {
      assert.match(JSON.stringify(error), /release failure/);
      return true;
    });
    fs.rmSync(failure);
    assert.ok(runtime.bindings.has('writer-a'), 'failed release must retain its authoritative binding');
    await runtime.getSubagentTranscriptSessionForRead('writer-a', `${first.sessionId}-child`);

    let released = false;
    const closing = runtime.unregisterAgentAndWait('writer-a').then(result => { released = true; return result; });
    await waitForUnsubscribe(first.sessionId, 2);
    // The peer's completed provider read follows the unsubscribe response and
    // unrelated close notification on the same transport. Neither proves release.
    await runtime.getSubagentTranscriptSessionForRead('writer-peer', `${peer.sessionId}-child`);
    assert.equal(released, false, 'unsubscribe receipt must not release the writer');
    assert.equal(peerBinding.child.exitCode, null);

    const early = await prepare('writer-early');
    fs.writeFileSync(`${gate}.${early.sessionId}`, 'early');
    assert.equal(await runtime.unregisterAgentAndWait('writer-early'), true,
      'close acknowledgement before the response must not be lost');
    assert.equal(released, false, 'concurrent close observers must remain Session-specific');
    fs.writeFileSync(`${gate}.${first.sessionId}`, 'release');
    assert.equal(await closing, true);
    assert.equal(peerBinding.child.exitCode, null, 'release must preserve its shared peer');

    await firstBinding.connection.closeSession({ sessionId: first.sessionId });
    // Already unloaded is positive evidence; no second close notification exists.
    await assert.rejects(peerBinding.connection.closeSession({ sessionId: peer.sessionId }), error => {
      assert.match(JSON.stringify(error), /writer release timed out/);
      return true;
    });
    const lossSession = await prepare('writer-loss');
    let unsubscribedSettled = false;
    const unsubscribed = peerBinding.connection.closeSession({ sessionId: peer.sessionId })
      .finally(() => { unsubscribedSettled = true; });
    // This retry receives notSubscribed while the writer is still loaded.
    await waitForUnsubscribe(peer.sessionId, 2);
    await runtime.getSubagentTranscriptSessionForRead('writer-loss', `${lossSession.sessionId}-child`);
    assert.equal(unsubscribedSettled, false, 'notSubscribed must not be mistaken for notLoaded');
    const lost = peerBinding.connection.closeSession({ sessionId: lossSession.sessionId });
    await waitForUnsubscribe(lossSession.sessionId);
    const peerRejected = assert.rejects(unsubscribed, /closed|exit|connection|disposed/i);
    const rejected = assert.rejects(lost, /closed|exit|connection|disposed/i);
    const exited = once(peerBinding.child, 'close');
    if (process.platform === 'win32') peerBinding.child.kill('SIGKILL');
    else process.kill(-peerBinding.child.pid, 'SIGKILL');
    await Promise.all([rejected, peerRejected, exited]);
  } finally {
    fs.rmSync(failure, { force: true });
    const children = new Set([...runtime.runtimeProcesses.values()].map(process => process.child));
    for (const binding of runtime.bindings.values()) {
      fs.writeFileSync(`${gate}.${binding.sessionId}`, 'release');
    }
    try {
      await runtime.dispose();
    } catch (error) {
      console.error('Failed to dispose the owned Codex fixture', error);
      process.exitCode = 1;
    } finally {
      for (const child of children) {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
              console.error('Failed to clean the owned Codex fixture process group', error);
              process.exitCode = 1;
            }
          }
        }
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  if (!process.exitCode) console.log('Codex writer release tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
