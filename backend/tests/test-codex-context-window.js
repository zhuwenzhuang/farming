const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexContextWindowReader, contextWindowFromRecord } = require('../codex-context-window');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-codex-context-'));
  const codexHome = path.join(root, '.codex');
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const agentId = 'agent-context';
  const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '04');
  fs.mkdirSync(sessionDir, { recursive: true });

  fs.writeFileSync(path.join(sessionDir, `rollout-2026-07-04T01-00-00-${sessionId}.jsonl`), [
    JSON.stringify({
      timestamp: '2026-07-04T01:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: root },
    }),
    JSON.stringify({
      timestamp: '2026-07-04T01:01:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 900_000,
            output_tokens: 10_000,
            total_tokens: 910_000,
          },
          last_token_usage: {
            input_tokens: 93_000,
            cached_input_tokens: 20_000,
            output_tokens: 500,
            reasoning_output_tokens: 120,
            total_tokens: 93_500,
          },
        },
        model_context_window: 258_400,
      },
    }),
  ].join('\n'));

  const reader = new CodexContextWindowReader({ codexHome });
  const contextWindow = await reader.readForAgent({
    id: agentId,
    providerSessionProvider: 'codex',
    providerSessionId: sessionId,
    providerSessionTemporary: false,
  });

  assert.strictEqual(contextWindow.available, true);
  assert.strictEqual(contextWindow.agentId, agentId);
  assert.strictEqual(contextWindow.sessionId, sessionId);
  assert.strictEqual(contextWindow.usedTokens, 93_000);
  assert.strictEqual(contextWindow.limitTokens, 258_400);
  assert.strictEqual(contextWindow.percentUsed, 36);
  assert.strictEqual(contextWindow.percentLeft, 64);
  assert.strictEqual(contextWindow.cachedInputTokens, 20_000);
  assert.strictEqual(contextWindow.confidence, 'exact');

  const temporary = await reader.readForAgent({
    id: 'agent-temp',
    providerSessionProvider: 'codex',
    providerSessionId: 'tmp_uuid1234',
    providerSessionTemporary: true,
  });
  assert.strictEqual(temporary.available, false);
  assert.match(temporary.reason, /not been resolved/);

  const missingContext = contextWindowFromRecord('agent-missing', sessionId, {
    timestamp: '2026-07-04T01:02:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { total_tokens: 100 },
      },
    },
  });
  assert.strictEqual(missingContext, null, 'context window must not fall back to total tokens');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Codex context window reader uses explicit token_count metadata');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
