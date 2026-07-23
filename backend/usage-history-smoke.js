const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageHistoryClient } = require('./usage-history-client');

async function runUsageHistorySmoke() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-usage-smoke-'));
  try {
    const sessions = path.join(root, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    fs.writeFileSync(path.join(sessions, 'rollout.jsonl'), [
      JSON.stringify({
        timestamp: '2026-01-01T00:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'farming-usage-smoke',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: root,
        },
      }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 5, output_tokens: 2 },
            last_token_usage: { input_tokens: 5, output_tokens: 2 },
          },
        },
      }),
      '',
    ].join('\n'));
    const result = await new UsageHistoryClient({
      configDir: path.join(root, 'config'),
    }).collect({
      now: Date.parse('2026-01-01T01:00:00.000Z'),
      codexRoots: [sessions],
      claudeRoots: [],
      scanBudgetMs: 30_000,
      fresh: true,
    });
    const total = result.providers.codex.events.reduce(
      (sum, event) => sum + event.totalTokens,
      0,
    );
    if (
      result.cache.scan_complete !== true
      || result.cache.discovery_ready !== true
      || total !== 7
    ) {
      throw new Error(`Usage history smoke returned an invalid result: ${JSON.stringify({
        scanComplete: result.cache.scan_complete,
        discoveryReady: result.cache.discovery_ready,
        total,
      })}`);
    }
    return { schemaVersion: result.schemaVersion, total };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { runUsageHistorySmoke };
