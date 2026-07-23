const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  UsageMonitor,
  buildDailyUsage,
  buildUsageDayDetail,
  buildUsageTimeline,
  collectClaudeUsage,
  collectCodexUsage,
  readClaudeAuthStatus,
  readCodexAuthStatus,
} = require('../usage-monitor');

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-usage-monitor-'));
  const codexHome = path.join(root, 'codex');
  const secondCodexHome = path.join(root, 'codex-secondary');
  const claudeHome = path.join(root, 'claude');
  const openCodeHome = path.join(root, 'opencode');
  const qoderHome = path.join(root, 'qoder');
  const codexSessionDir = path.join(codexHome, 'sessions', '2026', '06', '28');
  const secondCodexSessionDir = path.join(secondCodexHome, 'sessions', '2026', '06', '28');
  const claudeProjectDir = path.join(claudeHome, 'projects', '-repo-usage');
  const now = Date.parse('2026-06-28T12:00:00.000Z');
  const windowMs = 5 * 60 * 1000;

  fs.mkdirSync(codexSessionDir, { recursive: true });
  fs.mkdirSync(secondCodexSessionDir, { recursive: true });
  fs.mkdirSync(claudeProjectDir, { recursive: true });

  fs.writeFileSync(path.join(codexSessionDir, 'rollout-usage.jsonl'), [
    JSON.stringify({
      timestamp: '2026-06-28T11:52:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: 1000 },
          last_token_usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 },
        },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 12, window_minutes: 300, resets_at: 1782558828 },
        },
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-28T11:58:30.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: 'Completed the current turn.',
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

  fs.writeFileSync(path.join(secondCodexSessionDir, 'rollout-secondary.jsonl'), JSON.stringify({
    timestamp: '2026-06-28T11:40:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
        last_token_usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
      },
    },
  }));

  const codexUsage = await collectCodexUsage({
    codexHome,
    claudeHome,
    configDir: root,
    now,
    windowMs,
  });
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

  const claudeUsage = await collectClaudeUsage({
    codexHome,
    claudeHome,
    configDir: root,
    now,
    windowMs,
  });
  assert.strictEqual(claudeUsage.quota.available, false);
  assert.strictEqual(claudeUsage.tokenUsage.totalTokens, 200);
  assert.strictEqual(claudeUsage.tokenUsage.tokensPerMinute, 40);

  const timeline = buildUsageTimeline({
    codex: codexUsage.tokenEvents,
    claude: claudeUsage.tokenEvents,
  }, { now, windowMs: 60 * 60 * 1000, bucketCount: 30 });
  assert.strictEqual(timeline.points.length, 30);
  assert.strictEqual(timeline.bucketMs, 2 * 60 * 1000);
  assert.strictEqual(timeline.totalTokens, 21_798);
  assert.strictEqual(timeline.averageTokensPerMinute, 363.3);
  assert(timeline.peakTokensPerMinute > 0);
  assert(timeline.activeBucketCount >= 2);
  assert(timeline.points.some(point => point.providers.codex > 0));
  assert(timeline.points.some(point => point.providers.claude > 0));

  const localMidnight = new Date(now);
  localMidnight.setHours(0, 0, 0, 0);
  const daily = buildDailyUsage({
    codex: [{
      timestamp: localMidnight.getTime() - 60_000,
      totalTokens: 120,
      inputTokens: 70,
      outputTokens: 20,
      cacheReadTokens: 30,
    }],
    claude: [{
      timestamp: localMidnight.getTime() + 60_000,
      totalTokens: 200,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 30,
    }],
  }, { now, days: 3 });
  assert.strictEqual(daily.points.length, 3);
  assert.strictEqual(daily.points[1].totalTokens, 120, 'token events before local midnight stay on the prior day');
  assert.strictEqual(daily.points[2].totalTokens, 200, 'token events after local midnight stay on the current day');
  assert.strictEqual(daily.points[2].providers.claude.totalTokens, 200);
  assert.strictEqual(daily.summary.sevenDayTokens, 320);

  const detailDate = '2026-06-28';
  const usageDay = buildUsageDayDetail({
    codex: [{
      timestamp: new Date(2026, 5, 28, 9, 15).getTime(),
      agentId: 'codex-agent-a',
      agentLabel: 'Codex Agent A',
      totalTokens: 180,
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 80,
    }],
    claude: [{
      timestamp: new Date(2026, 5, 28, 9, 45).getTime(),
      agentId: 'claude-agent-b',
      agentLabel: 'Claude Agent B',
      totalTokens: 70,
      inputTokens: 30,
      outputTokens: 30,
      cacheWriteTokens: 10,
    }, {
      timestamp: new Date(2026, 5, 28, 17, 5).getTime(),
      agentId: 'claude-agent-b',
      agentLabel: 'Claude Agent B',
      totalTokens: 50,
      inputTokens: 25,
      outputTokens: 25,
    }],
  }, { date: detailDate });
  assert.strictEqual(usageDay.date, detailDate);
  assert.strictEqual(usageDay.hours.length, 24);
  assert.strictEqual(usageDay.hours[9].totalTokens, 250);
  assert.strictEqual(usageDay.hours[17].totalTokens, 50);
  assert.strictEqual(usageDay.hours[9].agents['codex:codex-agent-a'].totalTokens, 180);
  assert.strictEqual(usageDay.hours[9].agents['claude:claude-agent-b'].totalTokens, 70);
  assert.strictEqual(usageDay.agents.length, 2);
  assert.strictEqual(usageDay.agents[0].label, 'Codex Agent A');
  assert.strictEqual(usageDay.providers.codex.totalTokens, 180);
  assert.strictEqual(usageDay.providers.claude.totalTokens, 120);
  assert.strictEqual(usageDay.total.totalTokens, 300);
  assert.throws(
    () => buildUsageDayDetail({}, { date: '2026-02-30' }),
    /valid local date/,
  );

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

  const openCodeCommandRunner = async (args) => {
    if (args[0] === 'session') {
      return {
        stdout: JSON.stringify([{
          id: 'ses_usage_test',
          created: now - 180_000,
          updated: now - 60_000,
        }]),
      };
    }
    if (args[0] === 'export') {
      return {
        stdout: JSON.stringify({
          messages: [{
            info: {
              role: 'assistant',
              time: { completed: now - 60_000 },
              tokens: {
                total: 300,
                input: 180,
                output: 40,
                reasoning: 10,
                cache: { read: 60, write: 10 },
              },
            },
          }],
        }),
      };
    }
    throw new Error(`Unexpected OpenCode command ${args.join(' ')}`);
  };

  const originalPath = process.env.PATH || '';
  const shadowBin = path.join(root, 'shadow-bin');
  const shadowRg = path.join(shadowBin, process.platform === 'win32' ? 'rg.cmd' : 'rg');
  fs.mkdirSync(shadowBin, { recursive: true });
  fs.writeFileSync(shadowRg, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') fs.chmodSync(shadowRg, 0o755);
  process.env.PATH = `${shadowBin}${path.delimiter}${originalPath}`;

  const monitor = new UsageMonitor({
    configDir: root,
    codexHome,
    claudeHome,
    openCodeHome,
    qoderHome,
    commandRunner,
    openCodeCommandRunner,
    getProviderHomes() {
      return {
        codex: [
          { id: 'default', path: codexHome },
          { id: 'secondary', path: secondCodexHome },
        ],
        claude: [{ id: 'default', path: claudeHome }],
        opencode: [{ id: 'default', path: openCodeHome }],
        qoder: [{ id: 'default', path: qoderHome }],
      };
    },
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
  assert.strictEqual(summary.providers.length, 4);
  assert.strictEqual(summary.timeline.points.length, 24);
  assert.strictEqual(summary.timeline.windowMs, 24 * 60 * 60 * 1000);
  assert.strictEqual(summary.timeline.bucketMs, 60 * 60 * 1000);
  assert.strictEqual(summary.timeline.startAt % (60 * 60 * 1000), 0);
  assert.strictEqual(summary.timeline.endAt % (60 * 60 * 1000), 0);
  assert.strictEqual(summary.timeline.totalTokens, 22_148);
  assert.strictEqual(summary.daily.points.length, 52 * 7);
  assert.strictEqual(summary.daily.syncing, false);
  assert.strictEqual(summary.daily.summary.todayTokens, 22_148);
  assert.strictEqual(summary.daily.points.at(-1).cacheReadTokens, 80);
  assert.strictEqual(summary.daily.points.at(-1).cacheWriteTokens, 40);
  assert.strictEqual(summary.daily.points.at(-1).providers.opencode.totalTokens, 300);
  assert.strictEqual(summary.daily.coverage.find(entry => entry.provider === 'codex').homeCount, 2);
  assert.strictEqual(summary.daily.coverage.find(entry => entry.provider === 'qoder').available, false);
  assert.strictEqual(summary.providers.find(entry => entry.provider === 'opencode').tokenUsage.totalTokens, 300);
  assert.strictEqual(summary.providers.find(entry => entry.provider === 'opencode').tokenUsage.available, true);
  assert.strictEqual(summary.providers.find(entry => entry.provider === 'opencode').auth.available, true);
  assert.strictEqual(summary.providers.find(entry => entry.provider === 'qoder').tokenUsage.available, false);
  assert.strictEqual(summary.agentUsage.estimatedTokensPerMinute, 2);
  assert.strictEqual(summary.systemStats.cpu, 12);
  const selectedDay = await monitor.getUsageDay(summary.daily.endDate, { now });
  assert.strictEqual(selectedDay.hours.length, 24);
  assert.strictEqual(selectedDay.total.totalTokens, summary.daily.summary.todayTokens);
  assert(selectedDay.agents.some(agent => agent.provider === 'codex' && agent.sessionId === 'rollout-usage'));
  assert(selectedDay.agents.some(agent => agent.provider === 'claude' && agent.sessionId === 'session'));

  const unavailableOpenCodeMonitor = new UsageMonitor({
    configDir: root,
    codexHome,
    claudeHome,
    openCodeHome,
    qoderHome,
    commandRunner,
    async openCodeCommandRunner() {
      const error = new Error('Command not found');
      error.code = 'ENOENT';
      throw error;
    },
    windowMs,
  });
  const unavailableOpenCodeSummary = await unavailableOpenCodeMonitor.getUsageSummary({ now });
  const unavailableOpenCode = unavailableOpenCodeSummary.providers.find(entry => entry.provider === 'opencode');
  assert.strictEqual(unavailableOpenCode.auth.available, false);
  assert.strictEqual(unavailableOpenCode.tokenUsage.available, false);

  const failedExportOpenCodeMonitor = new UsageMonitor({
    configDir: root,
    codexHome,
    claudeHome,
    openCodeHome,
    qoderHome,
    commandRunner,
    async openCodeCommandRunner(args) {
      if (args[0] === 'session') {
        return {
          stdout: JSON.stringify([{
            id: 'ses_export_failure_truthfulness',
            created: now - 180_000,
            updated: now - 60_001,
          }]),
        };
      }
      const error = new Error('OpenCode export failed after listing the session');
      error.code = 'EIO';
      throw error;
    },
    windowMs,
  });
  const failedExportSummary = await failedExportOpenCodeMonitor.getUsageSummary({ now });
  const failedExportProvider = failedExportSummary.providers.find(entry => entry.provider === 'opencode');
  assert.strictEqual(failedExportProvider.auth.available, false,
    'listing sessions without exporting every listed session is not exact coverage');
  assert.strictEqual(failedExportProvider.tokenUsage.available, false,
    'partial export coverage must not be rendered as an exact zero token rate');
  const failedExportCoverage = failedExportSummary.daily.coverage.find(entry => entry.provider === 'opencode');
  assert.strictEqual(failedExportCoverage.partial, true);
  assert.strictEqual(failedExportCoverage.sessionCount, 1);
  assert.strictEqual(failedExportCoverage.exportCount, 0);
  assert.strictEqual(selectedDay.providers.opencode.totalTokens, 300);
  const liveDay = await monitor.getUsageDay(summary.daily.endDate, { now, live: true });
  const cachedLiveDay = await monitor.getUsageDay(summary.daily.endDate, { now: now + 1_000, live: true });
  assert.strictEqual(cachedLiveDay, liveDay, 'current-day reads should reuse the five-second live cache');
  const refreshedLiveDay = await monitor.getUsageDay(summary.daily.endDate, { now: now + 5_000, live: true });
  assert.notStrictEqual(refreshedLiveDay, liveDay, 'current-day reads should refresh after the live cache expires');
  monitor.liveDayCache = {
    date: summary.daily.endDate,
    value: null,
    fetchedAt: 0,
    pending: Promise.reject(new Error('transient live scan failure')),
  };
  const recoveredLiveDay = await monitor.getUsageDay(summary.daily.endDate, { now: now + 10_000, live: true });
  assert.strictEqual(
    recoveredLiveDay.total.totalTokens,
    summary.daily.summary.todayTokens,
    'a failed live scan should fall back to the successful daily-history snapshot',
  );
  const historicalDay = await monitor.getUsageDay(summary.daily.endDate, { now: now + 5_000, live: false });
  assert.notStrictEqual(historicalDay, refreshedLiveDay, 'non-live reads should stay on the heavy daily-history cache');
  const cachedSummary = await monitor.getUsageSummary({ now: now + 1_000 });
  assert.strictEqual(cachedSummary.daily, summary.daily, 'daily history should reuse its short heavy-scan cache');
  const refreshedSummary = await monitor.getUsageSummary({ now: now + 2_000, fresh: true });
  assert.notStrictEqual(refreshedSummary.daily, summary.daily, 'an explicit fresh read should rebuild daily history');
  process.env.PATH = originalPath;

  for (const [, args] of calls) {
    assert(!args.includes('reset'), 'usage monitor must not call reset');
    assert(!args.includes('logout'), 'usage monitor must not call logout');
    assert(!args.includes('update'), 'usage monitor must not call update');
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log('✓ Usage monitor reads configured provider homes and truthful local token sources');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
