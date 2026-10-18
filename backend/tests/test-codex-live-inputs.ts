import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AcpRuntime } from '../acp-runtime.cts';
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection';

test('packaged Codex adapter displays native input while preserving local echoes and distinct receipts', { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-native-input-'));
  const runtime = new AcpRuntime({ resolveLaunch: () => ({ command: process.execPath,
    args: [path.resolve('dist/acp/codex-acp-2.2.2.mjs')], version: 'test' }) });
  try {
    await runtime.prepareAgent({
      agentId: 'receiver', provider: 'codex', cwd: root, projectWorkspace: root,
      providerHomeId: 'receipt-test', providerHomePath: root,
      env: { ...process.env, CODEX_HOME: root,
        CODEX_PATH: path.resolve('backend/tests/fixtures/fake-codex-app-server.ts'),
        FARMING_TEST_INCOMING_INPUTS: '1', FARMING_TEST_MULTI_SESSION: '1',
      },
    });
    const result = await runtime.submitMessage('receiver', [{ type: 'text', text: 'Keep working' }], { delivery: 'prompt' });
    assert.equal(result.stopReason, 'end_turn');
    const session = runtime.getSession('receiver');
    assert.ok(session);
    const projected = projectAcpTranscript(session);
    const inputs = session.entries.filter(entry => entry.type === 'message' && entry.role === 'user');
    assert.equal(inputs.length, 3, JSON.stringify(inputs));
    assert.equal(projected.turns.length, 1, 'receipts must not invent completed turns');
    assert.equal(projected.turns[0].userMessage, 'Keep working');
    assert.equal(projected.turns[0].processItems.filter(item => item.type === 'user-steer'
      && item.detail === 'Receiver-owned coordination message').length, 2);
  } finally {
    await runtime.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});


for (const order of ['before', 'after']) {
  test(`packaged Codex steer echoes ${order} acknowledgement keep one input per submission`, { timeout: 15000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-steer-input-'));
    const gate = path.join(root, 'complete-goal');
    const runtime = new AcpRuntime({ resolveLaunch: () => ({ command: process.execPath,
      args: [path.resolve('dist/acp/codex-acp-2.2.2.mjs')], version: 'test' }) });
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'native input did not arrive');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      await runtime.prepareAgent({
        agentId: 'receiver', provider: 'codex', cwd: root, projectWorkspace: root,
        providerHomeId: 'steer-test', providerHomePath: root,
        env: { ...process.env, CODEX_HOME: root,
          CODEX_PATH: path.resolve('backend/tests/fixtures/fake-codex-app-server.ts'),
          FARMING_TEST_INCOMING_INPUTS: '1', FARMING_TEST_MULTI_SESSION: '1',
          FARMING_TEST_INPUT_COMPLETION_GATE: gate, FARMING_TEST_STEER_ECHO_ORDER: order,
        },
      });
      const running = runtime.submitMessage('receiver', [{ type: 'text', text: 'Keep working' }], { delivery: 'prompt' });
      void running.catch(() => {});
      await waitFor(() => runtime.getSession('receiver').entries.some(entry => entry.messageId === 'remote-input-two'));
      for (let submission = 0; submission < 2; submission++) {
        const accepted = await runtime.steer('receiver', [{ type: 'text', text: 'Also enable optimization' }]);
        await waitFor(() => runtime.getSession('receiver').entries.some(entry => entry.messageId === `receipt:${accepted.clientMessageId}`));
        const matching = runtime.getSession('receiver').entries.filter(entry => entry.role === 'user'
          && entry.content?.some(block => block.text === 'Also enable optimization'));
        assert.equal(matching.length, submission + 1, 'native UUID and client ID describe one submission');
        assert.ok(matching.every(entry => entry.createdAt && entry._meta?.farming?.steer));
      }
      const projected = projectAcpTranscript(runtime.getSession('receiver'));
      assert.equal(projected.turns.flatMap(turn => turn.processItems).filter(item =>
        item.type === 'user-steer' && item.detail === 'Also enable optimization').length, 2);
      await fs.writeFile(gate, 'completed');
      await running;
      assert.equal(runtime.getSession('receiver').state, 'idle');
    } finally {
      await runtime.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
