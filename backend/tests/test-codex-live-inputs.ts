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
