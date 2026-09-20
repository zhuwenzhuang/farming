import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from '../acp-runtime.cjs';
import { FarmingSessionStore } from '../farming-session-store.cjs';
import { isChatTurnState, interruptChatTurn } from '../../shared/chat-turn-state.js';

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Chat state did not converge');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function run() {
  assert.equal(isChatTurnState({ turnId: 'x', status: 'failed', message: 'error', updatedAt: NaN }), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-chat-outcome-'));
  const runtime = new AcpRuntime({
    resolveLaunch: () => ({
      command: process.execPath,
      args: ['--import', require.resolve('tsx'), path.join(__dirname, 'fixtures/fake-acp-agent.mts')],
      version: 'test',
    }),
  });
  const prepare = (agentId: string, provider = 'codex') => runtime.prepareAgent({
    agentId, provider, cwd: root, providerHomePath: path.join(root, agentId),
    env: process.env, approvalMode: 'full',
  });
  const prompt = (id: string, text: string) => runtime.prompt(id, [{ type: 'text', text }]);
  const current = (id: string) => {
    const turn = runtime.getSession(id).chatTurn;
    assert(isChatTurnState(turn));
    return turn;
  };
  try {
    const store = new FarmingSessionStore(root);
    store.init();
    const chatFailure = { turnId: 'chat-epoch:1', status: 'failed', message: 'Provider request failed', updatedAt: 1000 };
    const failedChat = { id: 'chat-outcome', persistentSessionId: '', runtimeBinding: { kind: 'acp', state: 'error' }, chatTurn: chatFailure };
    const failedChatRecord = store.ensureRecordForAgent(failedChat);
    failedChat.persistentSessionId = failedChatRecord;
    const recoveredStore = new FarmingSessionStore(root);
    assert.deepStrictEqual(recoveredStore.readRecord(failedChatRecord).chatTurn, chatFailure);
    store.ensureRecordForAgent({ ...failedChat, runtimeBinding: { kind: 'acp', state: 'idle' }, unread: false });
    assert.deepStrictEqual(store.readRecord(failedChatRecord).chatTurn, chatFailure, 'read/recovery leaves the failure intact');
    const nextChatTurn = { ...chatFailure, turnId: 'chat-epoch:2', status: 'active', message: '' };
    store.ensureRecordForAgent({ ...failedChat, chatTurn: nextChatTurn });
    assert.deepStrictEqual(recoveredStore.readRecord(failedChatRecord).chatTurn, nextChatTurn);

    for (const provider of ['codex', 'claude', 'qwen', 'pi', 'opencode', 'qoder']) {
      await prepare(provider, provider);
      await assert.rejects(prompt(provider, 'authentication error'), /Unauthorized/);
      const failed = current(provider);
      assert.equal(failed.status, 'failed');
      assert.match(failed.message, /Unauthorized/);
      await assert.rejects(runtime.prompt(provider, [{ type: 'text', text: 'rejected admission' }], {
        onTurnAdmitted: () => { throw new Error('admission rejected'); },
      }), /admission rejected/);
      assert.deepEqual(current(provider), failed, 'a rejected admission does not clear the previous failure');

      await runtime.cancel(provider);
      assert.deepEqual(current(provider), failed, 'late cancellation must not rewrite an existing failure');
      await prompt(provider, 'failed tool');
      assert.equal(current(provider).status, 'completed', 'tool failure does not fail the Chat turn');
      assert.notEqual(current(provider).turnId, failed.turnId);
      assert.equal(interruptChatTurn(current(provider), 'Host lost')?.status, 'completed');
      await runtime.unregisterAgentAndWait(provider);
    }

    await prepare('persistence-failure');
    const rejectPublication = (event: { agentId: string; chatTurn?: { status: string } }) => {
      if (event.agentId === 'persistence-failure' && event.chatTurn?.status === 'active') {
        throw new Error('Cannot persist Chat outcome');
      }
    };
    runtime.on('agent-runtime', rejectPublication);
    await assert.rejects(prompt('persistence-failure', 'must not reach provider'), /Cannot persist/);
    runtime.off('agent-runtime', rejectPublication);
    assert.equal(current('persistence-failure').status, 'failed');
    assert.equal(runtime.bindings.get('persistence-failure')!.activeTurn, null);
    await prompt('persistence-failure', 'new explicit request after reconnect');
    assert.equal(current('persistence-failure').status, 'completed');

    await prepare('cancel-race');
    const cancelledPrompt = prompt('cancel-race', 'cancel then provider error');
    const cancelledResult = assert.rejects(cancelledPrompt, /aborted after user cancellation/);
    await waitFor(() => isChatTurnState(runtime.getSession('cancel-race').chatTurn));
    await runtime.cancel('cancel-race');
    await cancelledResult;
    assert.equal(current('cancel-race').status, 'cancelled');
    assert.equal(current('cancel-race').message, '');

    await prepare('clean-exit');
    await assert.rejects(prompt('clean-exit', 'clean exit during turn'));
    assert(['failed', 'interrupted'].includes(current('clean-exit').status));
    assert(current('clean-exit').message);

    await prepare('late-result');
    const old = runtime.bindings.get('late-result')!;
    let rejectOld: (error: Error) => void = () => {};
    old.connection.prompt = () => new Promise((_resolve, reject) => { rejectOld = reject; });
    const oldPrompt = prompt('late-result', 'old pending request');
    const oldResult = assert.rejects(oldPrompt, /late old error/);
    await waitFor(() => old.chatTurn?.status === 'active');
    const active = current('late-result');
    assert.equal(interruptChatTurn(active, 'Host lost')?.status, 'interrupted');
    assert.equal(interruptChatTurn({ ...active, status: 'cancelling' }, 'Host lost')?.status, 'cancelled');
    assert.equal(interruptChatTurn(undefined, 'Host lost'), null);
    runtime.handleExit(old, new Error('Runtime lost'));
    assert.equal(current('late-result').status, 'interrupted');
    await runtime.unregisterAgentAndWait('late-result');
    await prepare('late-result');
    await prompt('late-result', 'new explicit request after reconnect');
    const latest = current('late-result');
    rejectOld(new Error('late old error'));
    await oldResult;
    assert.deepEqual(current('late-result'), latest, 'late completion belongs to the old runtime');

    await prepare('intentional-removal');
    const removed = runtime.bindings.get('intentional-removal')!;
    const removedPrompt = prompt('intentional-removal', 'mobile interrupt').catch(() => undefined);
    await waitFor(() => removed.chatTurn?.status === 'active');
    await runtime.unregisterAgentAndWait('intentional-removal');
    await removedPrompt;
    assert.equal(removed.chatTurn?.status, 'cancelled', 'intentional removal is not unexpected loss');

    await prepare('cancel-timeout');
    const pending = prompt('cancel-timeout', 'mobile interrupt');
    const pendingResult = pending.catch(() => undefined);
    await waitFor(() => isChatTurnState(runtime.getSession('cancel-timeout').chatTurn));
    const blocked = runtime.bindings.get('cancel-timeout')!;
    blocked.connection.cancel = async () => {};
    runtime.cancelTimeoutMs = 20;
    await assert.rejects(runtime.cancel('cancel-timeout'), /cancellation timed out/);
    assert.equal(current('cancel-timeout').status, 'cancelling');
    runtime.handleExit(blocked, new Error('Runtime exited after cancellation timeout'));
    assert.equal(current('cancel-timeout').status, 'cancelled');
    await runtime.unregisterAgentAndWait('cancel-timeout');
    await pendingResult;
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('Chat turn outcome tests passed');
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
