const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  UsageMonitor,
  collectClaudeUsage,
  collectCodexUsage,
  readClaudeAuthStatus,
  readCodexAuthStatus,
} = require('../usage-monitor');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-usage-monitor-'));
  const codexHome = path.join(root, 'codex');
  const claudeHome = path.join(root, 'claude');
  const codexSessionDir = path.join(codexHome, 'sessions', '2026', '06', '28');
  const claudeProjectDir = path.join(claudeHome, 'projects', '-repo-usage');
  const now = Date.parse('2026-06-28T12:00:00.000Z');
  const windowMs = 5 * 60 * 1000;

  fs.mkdirSync(codexSessionDir, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });

  fs.writeFileSync(path.join(codexSessionDir, 'rollout-usage.jsonl'), [
    JSON.stringify({
      timestamp: '2026-06-28T11:52:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 1000 },
          last_token_usage: { total_tokens: 1000 },
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1782558828 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-28T11:59:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1400, output_tokens: 200, total_tokens: 1600 },
          last_token_usage: { input_tokens: 400, output_tokens: 200, total_tokens: 600 },
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 44, window_minutes: 300, resets_at: 1782558828 },
          secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1782952632 },
          plan_type: 'pro',
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-28T11:59:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1400, output_tokens: 200, total_tokens: 1600 },
          last_token_usage: { input_tokens: 400, output_tokens: 200, total_tokens: 600 },
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 44, window_minutes: 300, resets_at: 1782558828 },
          secondary: { used_percent: 9, window_minutes: 10080, resets_at: 1782952632 },
          plan_type: 'pro',
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-28T11:59:45.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {},
        rate_limits: {
          limit_id: 'codex_bengalfox',
          limit_name: 'GPT-5.3-Codex-Spark',
          primary: { used_percent: 0, window_minutes: 300, resets_at: 1782600000 },
          secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1783000000 },
          plan_type: 'pro',
        },
      },
    }),
  ].join('\n'));

  fs.writeFileSync(path.join(claudeProjectDir, 'session.jsonl'), [
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-28T11:50:00.000Z',
      message: {
        role: 'assistant',
        usage: { input_tokens: 9999, output_tokens: 9999 },
      },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-28T11:58:00.000Z',
      message: {
        role: 'assistant',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 20,
          output_tokens: 50,
        },
      },
    }),
  ].join('\n'));

  const codexUsage = await collectCodexUsage({ codexHome, now, windowMs });
  assert.strictEqual(codexUsage.quota.available, true);
  assert.strictEqual(codexUsage.quota.limitId, 'codex');
  assert.strictEqual(codexUsage.quota.planType, 'pro');
  assert.strictEqual(codexUsage.quota.primary.usedPercent, 44);
  assert.strictEqual(codexUsage.quota.primary.forecast.remainingPercent, 56);
  assert.strictEqual(codexUsage.quota.primary.forecast.remainingTokens, null);
  assert.strictEqual(codexUsage.quota.primary.windowMinutes, 300);
  assert.strictEqual(codexUsage.quota.primary.resetsAt, 1782558828 * 1000);
  assert.strictEqual(codexUsage.quota.secondary.usedPercent, 9);
  assert.strictEqual(codexUsage.quota.secondary.forecast.remainingPercent, 91);
  assert.strictEqual(codexUsage.tokenUsage.totalTokens, 600);
  assert.strictEqual(codexUsage.tokenUsage.tokensPerMinute, 120);

  const claudeUsage = await collectClaudeUsage({ claudeHome, now, windowMs });
  assert.strictEqual(claudeUsage.quota.available, false);
  assert.strictEqual(claudeUsage.tokenUsage.totalTokens, 200);
  assert.strictEqual(claudeUsage.tokenUsage.tokensPerMinute, 40);

  const calls = [];
  const commandRunner = async (command, args) => {
    calls.push([command, args]);
    if (command === 'codex') {
      return { stdout: 'Logged in using ChatGPT\n', stderr: '' };
    }
    if (command === 'claude') {
      return {
        stdout: JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command ${command}`);
  };

  const codexAuth = await readCodexAuthStatus(commandRunner);
  const claudeAuth = await readClaudeAuthStatus(commandRunner);
  assert.strictEqual(codexAuth.available, true);
  assert.strictEqual(codexAuth.status, 'Logged in using ChatGPT');
  assert.strictEqual(claudeAuth.loggedIn, true);
  assert.strictEqual(claudeAuth.authMethod, 'oauth_token');

  const monitor = new UsageMonitor({
    codexHome,
    claudeHome,
    commandRunner,
    windowMs,
    agentManager: {
      getAgentUsageSnapshots() {
        return {
          windowMs,
          sampledAt: now,
          source: 'terminal-output-estimate',
          totalOutputBytes: 40,
          estimatedOutputTokens: 10,
          estimatedTokensPerMinute: 2,
          agents: [],
        };
      },
    },
    systemMonitor: {
      async getSystemStats() {
        return { cpu: 12, memory: { used: 10, total: 100, percentage: 10 } };
      },
    },
  });
  const summary = await monitor.getUsageSummary({ now });
  assert.strictEqual(summary.providers.length, 2);
  assert.strictEqual(summary.agentUsage.estimatedTokensPerMinute, 2);
  assert.strictEqual(summary.systemStats.cpu, 12);

  for (const [, args] of calls) {
    assert(!args.includes('reset'), 'usage monitor must not call reset');
    assert(!args.includes('logout'), 'usage monitor must not call logout');
    assert(!args.includes('update'), 'usage monitor must not call update');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Usage monitor reads Codex/Claude usage without quota resets');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
