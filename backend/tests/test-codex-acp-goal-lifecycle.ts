import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime } from '../acp-runtime.cts';
import { normalizeAgentGoal } from '../../shared/agent-goal';

function turnStatus(turn: unknown) {
  assert.ok(turn && typeof turn === 'object' && 'status' in turn);
  return turn.status;
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function scenario(status: 'completed' | 'interrupted' | 'failed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-goal-lifecycle-'));
  const runtime = new AcpRuntime();
  const gate = path.join(root, 'finish-goal');
  const requestLog = path.join(root, 'requests.jsonl');
  try {
    await runtime.prepareAgent({
      agentId: 'goal-agent', provider: 'codex', cwd: root, projectWorkspace: root,
      providerHomeId: 'goal-test', providerHomePath: root,
      env: { ...process.env, CODEX_HOME: root,
        CODEX_PATH: path.join(__dirname, 'fixtures/fake-codex-app-server.ts'),
        FARMING_TEST_GOAL_COMPLETION_GATE: gate,
        FARMING_TEST_REQUEST_LOG_FILE: requestLog,
      },
    });
    await runtime.submitMessage('goal-agent', [{ type: 'text', text: 'Start the goal' }], { delivery: 'prompt' });
    await waitFor(() => JSON.stringify(runtime.getSession('goal-agent')).includes('Autonomous goal work is visible.'), 'autonomous content');
    const session = runtime.getSession('goal-agent');
    assert.equal(session.state, 'working', 'settling the user prompt must preserve the provider continuation');
    assert.equal(session.providerTurnId, 'goal-continuation');
    assert.equal(turnStatus(session.chatTurn), 'active');
    await waitFor(() => normalizeAgentGoal(runtime.getSession('goal-agent').goal)?.tokensUsed === 0, 'initial goal');
    assert.equal(session.canSteer, true);
    await runtime.steer('goal-agent', [{ type: 'text', text: 'Keep the work scoped' }]);
    assert.match(fs.readFileSync(requestLog, 'utf8'), /"method":"turn\/steer".*"expectedTurnId":"goal-continuation"/);
    if (status === 'interrupted') await runtime.cancel('goal-agent');
    else fs.writeFileSync(gate, status);
    const expected = status === 'interrupted' ? 'cancelled' : status;
    await waitFor(() => turnStatus(runtime.getSession('goal-agent').chatTurn) === expected, expected);
    assert.equal(runtime.getSession('goal-agent').state, status === 'failed' ? 'error' : 'idle');
    assert.equal(runtime.getSession('goal-agent').providerTurnId, null);
    await waitFor(() => normalizeAgentGoal(runtime.getSession('goal-agent').goal)?.tokensUsed === 42, 'goal usage refresh');
    assert.equal(normalizeAgentGoal(runtime.getSession('goal-agent').goal)?.timeUsedSeconds, 12);
  } finally {
    await runtime.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  for (const status of ['completed', 'interrupted', 'failed'] as const) await scenario(status);
  console.log('Codex ACP autonomous goal lifecycle passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
