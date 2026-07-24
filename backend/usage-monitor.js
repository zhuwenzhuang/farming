const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { UsageHistoryClient } = require('./usage-history-client');
const { attachQuotaForecasts } = require('./usage-forecast');

const execFileAsync = promisify(execFile);

const USAGE_WINDOW_MS = 5 * 60 * 1000;
const USAGE_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_TIMELINE_BUCKET_COUNT = 24;
const USAGE_LIVE_TIMELINE_WINDOW_MS = 60 * 60 * 1000;
const USAGE_LIVE_TIMELINE_BUCKET_COUNT = 60;
const USAGE_DAILY_DAYS = 52 * 7;
const USAGE_DAILY_CACHE_MS = 5 * 60 * 1000;
const USAGE_LIVE_DAY_CACHE_MS = 5 * 1000;
const COMMAND_TIMEOUT_MS = 2500;
const OPENCODE_COMMAND_TIMEOUT_MS = 20_000;
const OPENCODE_EXPORT_CONCURRENCY = 4;
const OPENCODE_SESSION_LIMIT = 5000;
const OPENCODE_SESSION_CACHE_LIMIT = 5000;
const openCodeSessionEventCache = new Map();

function numberOrNull(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function roundRate(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function normalizeEpochMs(value) {
  const numberValue = numberOrNull(value);
  if (numberValue === null || numberValue <= 0) return null;
  return numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
}

function parseTimestampMs(value) {
  if (!value) return null;
  if (typeof value === 'number') return normalizeEpochMs(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenUsageSummary({ totalTokens, eventCount, source, windowMs, sampledAt }) {
  const windowMinutes = Math.max(1, windowMs / 60_000);
  return {
    available: true,
    windowMs,
    source,
    totalTokens,
    tokensPerMinute: roundRate(totalTokens / windowMinutes),
    eventCount,
    sampledAt,
  };
}

function emptyTokenBreakdown() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  };
}

function tokenBreakdownFromOpenCode(tokens) {
  if (!tokens || typeof tokens !== 'object') return emptyTokenBreakdown();
  const inputTokens = Math.max(0, numberOrNull(tokens.input) ?? 0);
  const outputTokens = Math.max(0, numberOrNull(tokens.output) ?? 0)
    + Math.max(0, numberOrNull(tokens.reasoning) ?? 0);
  const cacheReadTokens = Math.max(0, numberOrNull(tokens.cache?.read) ?? 0);
  const cacheWriteTokens = Math.max(0, numberOrNull(tokens.cache?.write) ?? 0);
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const explicitTotal = numberOrNull(tokens.total);
  const totalTokens = Math.max(0, explicitTotal ?? componentTotal);
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    unattributedTokens: Math.max(0, totalTokens - componentTotal),
  };
}

function providerHomePaths(providerHomes, provider, fallbackPath) {
  const configured = providerHomes && Array.isArray(providerHomes[provider])
    ? providerHomes[provider]
    : [];
  const candidates = configured.length > 0 ? configured : [fallbackPath];
  return Array.from(new Set(candidates.map((home) => {
    if (typeof home === 'string') return home;
    return home && typeof home.path === 'string' ? home.path : '';
  }).filter(Boolean)));
}

function ccStatisticsRoots(options = {}) {
  const codexHomes = providerHomePaths(
    options.providerHomes,
    'codex',
    options.codexHome || path.join(os.homedir(), '.codex'),
  );
  const claudeHomes = providerHomePaths(
    options.providerHomes,
    'claude',
    options.claudeHome || path.join(os.homedir(), '.claude'),
  );
  return {
    codexHomes,
    claudeHomes,
    codexRoots: codexHomes.flatMap(home => [
      path.join(home, 'sessions'),
      path.join(home, 'archived_sessions'),
    ]),
    claudeRoots: claudeHomes.map(home => path.join(home, 'projects')),
  };
}

function ccStatisticsClient(options = {}) {
  return options.usageHistoryClient || options.ccStatisticsClient || new UsageHistoryClient({
    configDir: options.configDir || path.join(os.homedir(), '.farming'),
  });
}

function unavailableCCStatisticsResult(error, now) {
  const reason = commandUnavailable(error);
  return {
    schemaVersion: 1,
    source: 'local usage history unavailable',
    sampledAt: now,
    providers: {
      codex: { events: [], quotaCandidates: [], available: false, reason, fileCount: 0 },
      claude: { events: [], quotaCandidates: [], available: false, reason, fileCount: 0 },
    },
    cache: { errors: 1 },
  };
}

async function collectCCStatistics(options = {}) {
  const now = options.now ?? Date.now();
  const roots = ccStatisticsRoots(options);
  try {
    const result = await ccStatisticsClient(options).collect({
      now,
      retentionDays: options.retentionDays ?? USAGE_DAILY_DAYS,
      codexRoots: roots.codexRoots,
      claudeRoots: roots.claudeRoots,
      fresh: options.fresh,
    });
    return { result, roots };
  } catch (error) {
    return { result: unavailableCCStatisticsResult(error, now), roots };
  }
}

function ccStatisticsProviderEvents(result, provider) {
  return (result?.providers?.[provider]?.events || []).map(event => attributeUsageEvent(
    event,
    provider,
    String(event.sessionId || 'unattributed'),
  ));
}

function addTokenBreakdown(target, source) {
  for (const field of Object.keys(emptyTokenBreakdown())) {
    target[field] += Math.max(0, numberOrNull(source?.[field]) ?? 0);
  }
  return target;
}

function usageAgentLabel(provider, agentId) {
  const providerName = {
    codex: 'Codex',
    claude: 'Claude',
    opencode: 'OpenCode',
    qoder: 'Qoder',
  }[provider] || provider;
  if (!agentId || agentId === 'unattributed') return providerName;
  const shortId = agentId.length > 12 ? `…${agentId.slice(-6)}` : agentId;
  return `${providerName} · ${shortId}`;
}

function attributeUsageEvent(event, provider, agentId) {
  return {
    ...event,
    agentId,
    agentLabel: usageAgentLabel(provider, agentId),
  };
}

function buildUsageTimeline(providerEvents, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = Math.max(60_000, options.windowMs ?? USAGE_TIMELINE_WINDOW_MS);
  const bucketCount = Math.max(1, Math.floor(options.bucketCount ?? USAGE_TIMELINE_BUCKET_COUNT));
  const bucketMs = windowMs / bucketCount;
  const endAt = options.alignToBucket
    ? Math.ceil(now / bucketMs) * bucketMs
    : now;
  const startAt = endAt - windowMs;
  const providerNames = Object.keys(providerEvents || {});
  const points = Array.from({ length: bucketCount }, (_, index) => ({
    startedAt: Math.round(startAt + index * bucketMs),
    endedAt: Math.round(startAt + (index + 1) * bucketMs),
    totalTokens: 0,
    tokensPerMinute: 0,
    providers: Object.fromEntries(providerNames.map(provider => [provider, 0])),
  }));

  for (const provider of providerNames) {
    for (const event of providerEvents[provider] || []) {
      const timestamp = parseTimestampMs(event?.timestamp);
      const totalTokens = Math.max(0, numberOrNull(event?.totalTokens) ?? 0);
      if (!timestamp || totalTokens <= 0 || timestamp < startAt || timestamp > endAt + 60_000) continue;
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((timestamp - startAt) / bucketMs)));
      points[index].providers[provider] += totalTokens;
      points[index].totalTokens += totalTokens;
    }
  }

  const bucketMinutes = bucketMs / 60_000;
  let totalTokens = 0;
  let peakTokensPerMinute = 0;
  let activeBucketCount = 0;
  for (const point of points) {
    point.tokensPerMinute = roundRate(point.totalTokens / bucketMinutes);
    totalTokens += point.totalTokens;
    peakTokensPerMinute = Math.max(peakTokensPerMinute, point.tokensPerMinute);
    if (point.totalTokens > 0) activeBucketCount += 1;
  }

  return {
    source: 'local provider token events',
    sampledAt: now,
    startAt,
    endAt,
    windowMs,
    bucketMs,
    bucketCount,
    totalTokens,
    averageTokensPerMinute: roundRate(totalTokens / (windowMs / 60_000)),
    peakTokensPerMinute: roundRate(peakTokensPerMinute),
    activeBucketCount,
    points,
  };
}

function providerUsageFromEvents(events, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;
  let totalTokens = 0;
  let eventCount = 0;
  const tokenEvents = [];
  for (const event of Array.isArray(events) ? events : []) {
    const timestamp = parseTimestampMs(event?.timestamp);
    const eventTokens = Math.max(0, numberOrNull(event?.totalTokens) ?? 0);
    if (!timestamp || eventTokens <= 0 || timestamp > now + 60_000) continue;
    if (timestamp >= now - historyWindowMs) tokenEvents.push(event);
    if (timestamp >= now - windowMs) {
      totalTokens += eventTokens;
      eventCount += 1;
    }
  }
  return {
    tokenUsage: tokenUsageSummary({
      totalTokens,
      eventCount,
      source: options.source || 'local provider token events',
      windowMs,
      sampledAt: now,
    }),
    tokenEvents,
  };
}

async function defaultCommandRunner(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });

  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function commandUnavailable(error) {
  if (!error) return 'Unavailable';
  if (error.code === 'ENOENT') return 'Command not found';
  const stderr = String(error.stderr || '').trim();
  const stdout = String(error.stdout || '').trim();
  return stderr || stdout || error.message || 'Unavailable';
}

async function readCodexAuthStatus(commandRunner = defaultCommandRunner) {
  try {
    const result = await commandRunner('codex', ['login', 'status'], { timeoutMs: COMMAND_TIMEOUT_MS });
    const status = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).filter(Boolean).join(' ');
    return {
      available: true,
      status: status || 'Available',
      source: 'codex login status',
    };
  } catch (error) {
    return {
      available: false,
      status: commandUnavailable(error),
      source: 'codex login status',
    };
  }
}

async function readClaudeAuthStatus(commandRunner = defaultCommandRunner) {
  try {
    const result = await commandRunner('claude', ['auth', 'status', '--json'], { timeoutMs: COMMAND_TIMEOUT_MS });
    const parsed = JSON.parse((result.stdout || result.stderr || '{}').trim() || '{}');
    const loggedIn = parsed.loggedIn === true;
    const statusParts = [
      loggedIn ? 'logged in' : 'logged out',
      parsed.authMethod,
      parsed.apiProvider,
    ].filter(Boolean);

    return {
      available: true,
      status: statusParts.join(' / ') || 'Available',
      loggedIn,
      authMethod: parsed.authMethod || '',
      apiProvider: parsed.apiProvider || '',
      source: 'claude auth status --json',
    };
  } catch (error) {
    return {
      available: false,
      status: commandUnavailable(error),
      loggedIn: false,
      authMethod: '',
      apiProvider: '',
      source: 'claude auth status --json',
    };
  }
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDailyUsage(providerEvents, options = {}) {
  const now = options.now ?? Date.now();
  const days = Math.max(1, Math.floor(options.days ?? USAGE_DAILY_DAYS));
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - days + 1);
  const points = [];
  const byDate = new Map();
  const providerNames = Object.keys(providerEvents || {});

  for (let index = 0; index < days; index += 1) {
    const date = localDateKey(cursor.getTime());
    const point = {
      date,
      ...emptyTokenBreakdown(),
      providers: Object.fromEntries(providerNames.map(provider => [provider, emptyTokenBreakdown()])),
    };
    points.push(point);
    byDate.set(date, point);
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const provider of providerNames) {
    for (const event of providerEvents[provider] || []) {
      const point = byDate.get(localDateKey(parseTimestampMs(event?.timestamp)));
      if (!point) continue;
      addTokenBreakdown(point, event);
      addTokenBreakdown(point.providers[provider], event);
    }
  }

  const sumRange = count => points
    .slice(Math.max(0, points.length - count))
    .reduce((total, point) => total + point.totalTokens, 0);
  const peak = points.reduce((best, point) => (
    !best || point.totalTokens > best.totalTokens ? point : best
  ), null);

  return {
    source: 'local provider token events',
    sampledAt: now,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    days,
    startDate: points[0]?.date || '',
    endDate: points[points.length - 1]?.date || '',
    summary: {
      todayTokens: sumRange(1),
      sevenDayTokens: sumRange(7),
      thirtyDayTokens: sumRange(30),
      periodTokens: sumRange(days),
      peakDate: peak?.date || '',
      peakTokens: peak?.totalTokens || 0,
    },
    points,
  };
}

function buildUsageDayDetail(providerEvents, options = {}) {
  const date = String(options.date || '').trim();
  const parts = date.split('-').map(Number);
  const dateProbe = parts.length === 3
    ? new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0)
    : null;
  if (!dateProbe || localDateKey(dateProbe.getTime()) !== date) {
    throw new RangeError('Usage day must be a valid local date in YYYY-MM-DD format.');
  }

  const providerNames = Object.keys(providerEvents || {});
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: String(hour).padStart(2, '0'),
    ...emptyTokenBreakdown(),
    agents: {},
  }));
  const providers = Object.fromEntries(
    providerNames.map(provider => [provider, emptyTokenBreakdown()]),
  );
  const total = emptyTokenBreakdown();
  const agents = new Map();
  const agentLabels = options.agentLabels instanceof Map ? options.agentLabels : new Map();

  for (const provider of providerNames) {
    for (const event of providerEvents[provider] || []) {
      const timestamp = parseTimestampMs(event?.timestamp);
      if (localDateKey(timestamp) !== date) continue;
      const hour = new Date(timestamp).getHours();
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      const agentId = String(event?.agentId || 'unattributed');
      const agentKey = `${provider}:${agentId}`;
      let agent = agents.get(agentKey);
      if (!agent) {
        agent = {
          key: agentKey,
          provider,
          sessionId: agentId === 'unattributed' ? '' : agentId,
          label: agentLabels.get(agentKey) || event?.agentLabel || usageAgentLabel(provider, agentId),
          ...emptyTokenBreakdown(),
        };
        agents.set(agentKey, agent);
      }
      if (!hours[hour].agents[agentKey]) hours[hour].agents[agentKey] = emptyTokenBreakdown();
      addTokenBreakdown(hours[hour], event);
      addTokenBreakdown(hours[hour].agents[agentKey], event);
      addTokenBreakdown(providers[provider], event);
      addTokenBreakdown(agent, event);
      addTokenBreakdown(total, event);
    }
  }

  return {
    source: 'local provider token events',
    date,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    total,
    hours,
    providers,
    agents: Array.from(agents.values()).sort((left, right) => (
      right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)
    )),
  };
}

async function defaultOpenCodeCommandRunner(args, options = {}) {
  const env = { ...process.env };
  if (options.openCodeHome) env.OPENCODE_CONFIG_DIR = options.openCodeHome;
  const result = await execFileAsync(
    options.openCodeBin || process.env.FARMING_OPENCODE_BIN || 'opencode',
    args,
    {
      env,
      timeout: options.timeoutMs ?? OPENCODE_COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return { stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

function openCodeTokenEventsFromExport(sessionExport, options = {}) {
  const cutoffMs = options.cutoffMs ?? 0;
  const now = options.now ?? Date.now();
  const events = [];
  for (const message of Array.isArray(sessionExport?.messages) ? sessionExport.messages : []) {
    const info = message?.info;
    if (info?.role !== 'assistant' || !info.tokens) continue;
    const timestamp = parseTimestampMs(info.time?.completed ?? info.time?.created);
    if (!timestamp || timestamp < cutoffMs || timestamp > now + 60_000) continue;
    const breakdown = tokenBreakdownFromOpenCode(info.tokens);
    if (breakdown.totalTokens > 0) events.push({ timestamp, ...breakdown });
  }
  return events;
}

function cacheOpenCodeSessionEvents(cacheKey, value) {
  openCodeSessionEventCache.delete(cacheKey);
  openCodeSessionEventCache.set(cacheKey, value);
  while (openCodeSessionEventCache.size > OPENCODE_SESSION_CACHE_LIMIT) {
    const oldestKey = openCodeSessionEventCache.keys().next().value;
    if (oldestKey === undefined) break;
    openCodeSessionEventCache.delete(oldestKey);
  }
}

async function collectOpenCodeDailyEvents(homePaths, options = {}) {
  const now = options.now ?? Date.now();
  const cutoffMs = options.cutoffMs ?? 0;
  const commandRunner = options.openCodeCommandRunner || defaultOpenCodeCommandRunner;
  const sessions = [];
  const seenSessionIds = new Set();
  let successfulHomes = 0;
  let successfulExports = 0;
  let partial = false;
  let reason = '';

  for (const openCodeHome of homePaths) {
    try {
      const result = await commandRunner([
        'session', 'list', '--format', 'json', '--max-count', String(OPENCODE_SESSION_LIMIT),
      ], { openCodeHome, timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS });
      const listed = JSON.parse(String(result?.stdout || '[]'));
      if (!Array.isArray(listed)) throw new Error('OpenCode session list was not an array');
      successfulHomes += 1;
      if (listed.length >= OPENCODE_SESSION_LIMIT) {
        partial = true;
        reason = reason
          || `OpenCode returned the ${OPENCODE_SESSION_LIMIT.toLocaleString('en-US')} session limit; older sessions may be omitted.`;
      }
      for (const session of listed) {
        const id = typeof session?.id === 'string' ? session.id.trim() : '';
        const updatedAt = parseTimestampMs(session?.updated ?? session?.created);
        if (!id || seenSessionIds.has(id) || (updatedAt && updatedAt < cutoffMs)) continue;
        seenSessionIds.add(id);
        sessions.push({ id, openCodeHome, updatedAt: updatedAt || 0 });
      }
    } catch (error) {
      partial = true;
      reason = reason || commandUnavailable(error);
    }
  }

  const events = [];
  let nextSessionIndex = 0;
  const worker = async () => {
    while (nextSessionIndex < sessions.length) {
      const session = sessions[nextSessionIndex];
      nextSessionIndex += 1;
      const cacheKey = `${session.openCodeHome}:${session.id}`;
      const cached = openCodeSessionEventCache.get(cacheKey);
      if (cached?.updatedAt === session.updatedAt) {
        cacheOpenCodeSessionEvents(cacheKey, cached);
        successfulExports += 1;
        events.push(...cached.events);
        continue;
      }
      try {
        const result = await commandRunner(
          ['export', session.id, '--pure', '--sanitize'],
          { openCodeHome: session.openCodeHome, timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS },
        );
        const exported = JSON.parse(String(result?.stdout || '{}'));
        const sessionEvents = openCodeTokenEventsFromExport(exported, { cutoffMs, now })
          .map(event => attributeUsageEvent(event, 'opencode', session.id));
        successfulExports += 1;
        cacheOpenCodeSessionEvents(
          cacheKey,
          { updatedAt: session.updatedAt, events: sessionEvents },
        );
        events.push(...sessionEvents);
      } catch (error) {
        partial = true;
        reason = reason || commandUnavailable(error);
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(OPENCODE_EXPORT_CONCURRENCY, sessions.length) },
    () => worker(),
  ));

  return {
    events,
    partial,
    available: !partial
      && successfulHomes === homePaths.length
      && (sessions.length === 0 || successfulExports === sessions.length),
    reason,
    sessionCount: sessions.length,
    exportCount: successfulExports,
  };
}

async function collectUsageHistory(options = {}) {
  const now = options.now ?? Date.now();
  const days = options.days ?? USAGE_DAILY_DAYS;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  const openCodeHomes = providerHomePaths(
    options.providerHomes,
    'opencode',
    options.openCodeHome || path.join(os.homedir(), '.opencode'),
  );
  const qoderHomes = providerHomePaths(
    options.providerHomes,
    'qoder',
    options.qoderHome || path.join(os.homedir(), '.qoder'),
  );
  const [ccStatistics, openCode] = await Promise.all([
    collectCCStatistics({ ...options, now, days }),
    collectOpenCodeDailyEvents(openCodeHomes, {
      now,
      cutoffMs: cutoff.getTime(),
      openCodeCommandRunner: options.openCodeCommandRunner,
    }),
  ]);
  const codex = ccStatistics.result.providers.codex;
  const claude = ccStatistics.result.providers.claude;
  const codexEvents = ccStatisticsProviderEvents(ccStatistics.result, 'codex');
  const claudeEvents = ccStatisticsProviderEvents(ccStatistics.result, 'claude');
  const providerEvents = {
    codex: codexEvents,
    claude: claudeEvents,
    opencode: openCode.events,
  };
  const coverage = [
    {
      provider: 'codex',
      providerName: 'Codex',
      available: codex.available === true,
      homeCount: ccStatistics.roots.codexHomes.length,
      fileCount: codex.fileCount,
      source: codex.source || ccStatistics.result.source,
      ...(codex.reason ? { reason: codex.reason } : {}),
    },
    {
      provider: 'claude',
      providerName: 'Claude',
      available: claude.available === true,
      homeCount: ccStatistics.roots.claudeHomes.length,
      fileCount: claude.fileCount,
      source: claude.source || ccStatistics.result.source,
      ...(claude.reason ? { reason: claude.reason } : {}),
    },
    {
      provider: 'opencode',
      providerName: 'OpenCode',
      available: openCode.available,
      homeCount: openCodeHomes.length,
      sessionCount: openCode.sessionCount,
      exportCount: openCode.exportCount,
      partial: openCode.partial,
      source: 'opencode session export',
      ...(openCode.reason ? { reason: openCode.reason } : {}),
    },
    {
      provider: 'qoder',
      providerName: 'Qoder',
      available: false,
      homeCount: qoderHomes.length,
      source: 'local Qoder sessions',
      reason: 'Qoder session files do not expose model token usage.',
    },
  ];
  return {
    daily: {
      ...buildDailyUsage(providerEvents, { now, days }),
      partial: codex.available !== true || claude.available !== true || openCode.partial,
      syncing: ccStatistics.result.cache?.scan_complete === false,
      coverage,
      ccStatisticsCache: ccStatistics.result.cache,
    },
    providerEvents,
    coverage,
  };
}

async function collectDailyUsage(options = {}) {
  return (await collectUsageHistory(options)).daily;
}

function parseCodexLimit(limit) {
  if (!limit || typeof limit !== 'object') return null;
  const usedPercent = numberOrNull(limit.used_percent ?? limit.usedPercent);
  const windowMinutes = numberOrNull(limit.window_minutes ?? limit.windowMinutes ?? limit.windowDurationMins);
  const resetsAt = normalizeEpochMs(limit.resets_at ?? limit.resetsAt);
  const totalTokens = numberOrNull(limit.total_tokens ?? limit.totalTokens ?? limit.limit_tokens ?? limit.limitTokens);

  if (usedPercent === null && windowMinutes === null && resetsAt === null && totalTokens === null) return null;
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    totalTokens,
  };
}

function parseCodexRateLimits(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const primary = parseCodexLimit(rateLimits.primary);
  const secondary = parseCodexLimit(rateLimits.secondary);

  if (!primary && !secondary) return null;
  const resetCredits = rateLimits.rate_limit_reset_credits ?? rateLimits.rateLimitResetCredits;
  const resetCreditsAvailable = numberOrNull(resetCredits?.available_count ?? resetCredits?.availableCount);
  return {
    available: true,
    source: 'codex token_count events',
    limitId: rateLimits.limit_id || rateLimits.limitId || '',
    limitName: rateLimits.limit_name ?? rateLimits.limitName ?? null,
    planType: rateLimits.plan_type || rateLimits.planType || '',
    resetCreditsAvailable,
    primary,
    secondary,
  };
}

function isCodexOverallRateLimit(quota) {
  const limitId = String(quota?.limitId || '').trim().toLowerCase();
  return !limitId || limitId === 'codex';
}

async function collectCodexUsage(options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;
  const ccStatistics = await collectCCStatistics({
    ...options,
    now,
    days: options.days ?? USAGE_DAILY_DAYS,
  });
  const provider = ccStatistics.result.providers.codex;
  const providerSource = provider.source || ccStatistics.result.source;
  const events = ccStatisticsProviderEvents(ccStatistics.result, 'codex');
  let latestQuota = null;
  let latestQuotaAt = 0;
  let latestOverallQuota = null;
  let latestOverallQuotaAt = 0;

  for (const candidate of provider.quotaCandidates || []) {
    const timestamp = parseTimestampMs(candidate.timestamp);
    const rateLimits = parseCodexRateLimits(candidate.rateLimits);
    if (rateLimits && (!timestamp || timestamp >= latestQuotaAt)) {
      latestQuota = rateLimits;
      latestQuotaAt = timestamp ?? latestQuotaAt;
    }
    if (rateLimits && isCodexOverallRateLimit(rateLimits) && (!timestamp || timestamp >= latestOverallQuotaAt)) {
      latestOverallQuota = rateLimits;
      latestOverallQuotaAt = timestamp ?? latestOverallQuotaAt;
    }
  }
  const quota = latestOverallQuota || latestQuota || {
    available: false,
    source: providerSource,
    reason: provider.reason || 'No Codex token_count event with rate limits was found.',
  };
  const usage = providerUsageFromEvents(events, {
    now,
    windowMs,
    historyWindowMs,
    source: providerSource,
  });
  if (provider.available !== true) {
    usage.tokenUsage.available = false;
    usage.tokenUsage.reason = provider.reason || 'Local usage history is unavailable.';
  }

  return {
    quota: attachQuotaForecasts(quota, { now }),
    ...usage,
  };
}

async function collectClaudeUsage(options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;
  const ccStatistics = await collectCCStatistics({
    ...options,
    now,
    days: options.days ?? USAGE_DAILY_DAYS,
  });
  const provider = ccStatistics.result.providers.claude;
  const providerSource = provider.source || ccStatistics.result.source;
  const events = ccStatisticsProviderEvents(ccStatistics.result, 'claude');
  const usage = providerUsageFromEvents(events, {
    now,
    windowMs,
    historyWindowMs,
    source: providerSource,
  });
  if (provider.available !== true) {
    usage.tokenUsage.available = false;
    usage.tokenUsage.reason = provider.reason || 'Local usage history is unavailable.';
  }

  return {
    quota: {
      available: false,
      source: 'claude auth status',
      reason: 'Claude Code auth/status output does not expose usage remaining.',
    },
    ...usage,
  };
}

class UsageMonitor {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.systemMonitor = options.systemMonitor || this.agentManager?.systemMonitor || null;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
    this.codexHome = options.codexHome;
    this.claudeHome = options.claudeHome;
    this.openCodeHome = options.openCodeHome;
    this.qoderHome = options.qoderHome;
    this.getProviderHomes = options.getProviderHomes || null;
    this.openCodeCommandRunner = options.openCodeCommandRunner;
    this.configDir = options.configDir || path.join(os.homedir(), '.farming');
    this.ccStatisticsClient = options.usageHistoryClient
      || options.ccStatisticsClient
      || new UsageHistoryClient({ configDir: this.configDir });
    this.windowMs = options.windowMs ?? USAGE_WINDOW_MS;
    this.dailyDays = options.dailyDays ?? USAGE_DAILY_DAYS;
    this.dailyCacheMs = options.dailyCacheMs ?? USAGE_DAILY_CACHE_MS;
    this.dailyCache = { value: null, fetchedAt: 0, pending: null };
    this.liveDayCacheMs = options.liveDayCacheMs ?? USAGE_LIVE_DAY_CACHE_MS;
    this.liveDayCache = { date: '', value: null, fetchedAt: 0, pending: null };
  }

  invalidateDailyCache() {
    this.dailyCache.fetchedAt = 0;
    this.liveDayCache.fetchedAt = 0;
  }

  usageAgentLabels() {
    const labels = new Map();
    const agents = this.agentManager?.getState?.().agents;
    if (!Array.isArray(agents)) return labels;
    for (const agent of agents) {
      const provider = String(agent?.providerSessionProvider || '').trim();
      const sessionId = String(agent?.providerSessionId || '').trim();
      if (!provider || !sessionId) continue;
      const label = String(
        agent.customTitle
        || agent.task
        || agent.sessionTitle
        || agent.providerSessionTitle
        || '',
      ).trim();
      if (label) labels.set(`${provider}:${sessionId}`, label);
    }
    return labels;
  }

  buildUsageDay(providerEvents, date) {
    return buildUsageDayDetail(providerEvents, {
      date,
      agentLabels: this.usageAgentLabels(),
    });
  }

  getDailyUsage(options = {}) {
    const now = options.now ?? Date.now();
    if (
      !options.force
      && this.dailyCache.value
      && now - this.dailyCache.fetchedAt <= this.dailyCacheMs
    ) {
      return Promise.resolve(this.dailyCache.value);
    }
    if (this.dailyCache.pending) return this.dailyCache.pending;
    const providerHomes = this.getProviderHomes ? this.getProviderHomes() : undefined;
    this.dailyCache.pending = collectUsageHistory({
      codexHome: this.codexHome,
      claudeHome: this.claudeHome,
      openCodeHome: this.openCodeHome,
      qoderHome: this.qoderHome,
      providerHomes,
      openCodeCommandRunner: this.openCodeCommandRunner,
      configDir: this.configDir,
      ccStatisticsClient: this.ccStatisticsClient,
      now,
      days: this.dailyDays,
    }).then(value => {
      this.dailyCache.value = value;
      this.dailyCache.fetchedAt = now;
      return value;
    }).finally(() => {
      this.dailyCache.pending = null;
    });
    return this.dailyCache.pending;
  }

  async getUsageDay(date, options = {}) {
    const now = options.now ?? Date.now();
    if (options.live === true && String(date || '').trim() === localDateKey(now)) {
      const liveDate = String(date).trim();
      const dailyFallback = this.dailyCache.value?.providerEvents
        ? this.buildUsageDay(this.dailyCache.value.providerEvents, liveDate)
        : null;
      const cachedFallback = this.liveDayCache.date === liveDate
        ? this.liveDayCache.value
        : null;
      const fallback = cachedFallback || dailyFallback;
      const recoverWithFallback = error => {
        if (!fallback) throw error;
        if (this.liveDayCache.date === liveDate) {
          this.liveDayCache.value = fallback;
          this.liveDayCache.fetchedAt = now;
        }
        return fallback;
      };
      if (
        options.fresh !== true
        && this.liveDayCache.date === liveDate
        && this.liveDayCache.value
        && now - this.liveDayCache.fetchedAt < this.liveDayCacheMs
      ) {
        return this.liveDayCache.value;
      }
      if (this.liveDayCache.pending && this.liveDayCache.date === liveDate) {
        return this.liveDayCache.pending.catch(recoverWithFallback);
      }
      this.liveDayCache.date = liveDate;
      const pending = collectUsageHistory({
        codexHome: this.codexHome,
        claudeHome: this.claudeHome,
        openCodeHome: this.openCodeHome,
        qoderHome: this.qoderHome,
        providerHomes: this.getProviderHomes ? this.getProviderHomes() : undefined,
        openCodeCommandRunner: this.openCodeCommandRunner,
        configDir: this.configDir,
        ccStatisticsClient: this.ccStatisticsClient,
        now,
        days: 1,
      }).then(history => {
        const detail = this.buildUsageDay(history.providerEvents, liveDate);
        if (this.liveDayCache.date === liveDate) {
          this.liveDayCache.value = detail;
          this.liveDayCache.fetchedAt = now;
        }
        return detail;
      }).finally(() => {
        if (this.liveDayCache.pending === pending) this.liveDayCache.pending = null;
      });
      this.liveDayCache.pending = pending;
      return pending.catch(recoverWithFallback);
    }
    const history = await this.getDailyUsage({
      now,
      force: options.fresh === true,
    });
    return this.buildUsageDay(history.providerEvents, date);
  }

  async getUsageSummary(options = {}) {
    const now = options.now ?? Date.now();
    const windowMs = options.windowMs ?? this.windowMs;
    const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;

    const providerHomes = this.getProviderHomes ? this.getProviderHomes() : undefined;
    const [
      codexAuth,
      claudeAuth,
      codexUsage,
      claudeUsage,
      history,
      systemStats,
    ] = await Promise.all([
      readCodexAuthStatus(this.commandRunner),
      readClaudeAuthStatus(this.commandRunner),
      collectCodexUsage({
        codexHome: this.codexHome,
        claudeHome: this.claudeHome,
        providerHomes,
        configDir: this.configDir,
        ccStatisticsClient: this.ccStatisticsClient,
        now,
        windowMs,
        historyWindowMs,
      }),
      collectClaudeUsage({
        codexHome: this.codexHome,
        claudeHome: this.claudeHome,
        providerHomes,
        configDir: this.configDir,
        ccStatisticsClient: this.ccStatisticsClient,
        now,
        windowMs,
        historyWindowMs,
      }),
      this.getDailyUsage({ now, force: options.fresh === true }),
      this.systemMonitor?.getSystemStats ? this.systemMonitor.getSystemStats().catch(() => null) : Promise.resolve(null),
    ]);

    const openCodeUsage = providerUsageFromEvents(history.providerEvents.opencode, {
      now,
      windowMs,
      historyWindowMs,
      source: 'opencode session export',
    });
    const timeline = buildUsageTimeline(history.providerEvents, {
      now,
      windowMs: historyWindowMs,
      alignToBucket: true,
    });
    const liveTimeline = buildUsageTimeline(history.providerEvents, {
      now,
      windowMs: USAGE_LIVE_TIMELINE_WINDOW_MS,
      bucketCount: USAGE_LIVE_TIMELINE_BUCKET_COUNT,
      alignToBucket: true,
    });
    const openCodeCoverage = history.coverage.find(entry => entry.provider === 'opencode');
    const qoderCoverage = history.coverage.find(entry => entry.provider === 'qoder');

    return {
      sampledAt: now,
      windowMs,
      timeline,
      liveTimeline,
      daily: history.daily,
      providers: [
        {
          provider: 'codex',
          providerName: 'Codex',
          auth: codexAuth,
          quota: codexUsage.quota,
          tokenUsage: codexUsage.tokenUsage,
        },
        {
          provider: 'claude',
          providerName: 'Claude',
          auth: claudeAuth,
          quota: claudeUsage.quota,
          tokenUsage: claudeUsage.tokenUsage,
        },
        {
          provider: 'opencode',
          providerName: 'OpenCode',
          auth: {
            available: openCodeCoverage?.available === true,
            status: openCodeCoverage?.available === true
              ? 'Local session export'
              : openCodeCoverage?.reason || 'OpenCode unavailable',
            source: 'opencode session export',
          },
          quota: {
            available: false,
            source: 'opencode session export',
            reason: 'OpenCode session exports do not expose quota remaining.',
          },
          tokenUsage: openCodeCoverage?.available === true
            ? openCodeUsage.tokenUsage
            : {
                ...openCodeUsage.tokenUsage,
                available: false,
                reason: openCodeCoverage?.reason || 'OpenCode token usage is unavailable.',
              },
        },
        {
          provider: 'qoder',
          providerName: 'Qoder',
          auth: { available: true, status: 'Local sessions', source: 'Qoder session files' },
          quota: {
            available: false,
            source: 'Qoder session files',
            reason: qoderCoverage?.reason || 'Qoder quota telemetry is unavailable.',
          },
          tokenUsage: {
            available: false,
            windowMs,
            source: 'Qoder session files',
            totalTokens: null,
            tokensPerMinute: null,
            eventCount: 0,
            sampledAt: now,
            reason: qoderCoverage?.reason || 'Qoder session files do not expose model token usage.',
          },
        },
      ],
      agentUsage: this.agentManager?.getAgentUsageSnapshots
        ? this.agentManager.getAgentUsageSnapshots({ now, windowMs })
        : null,
      systemStats,
    };
  }
}

module.exports = {
  USAGE_WINDOW_MS,
  USAGE_TIMELINE_WINDOW_MS,
  USAGE_TIMELINE_BUCKET_COUNT,
  USAGE_LIVE_TIMELINE_WINDOW_MS,
  USAGE_LIVE_TIMELINE_BUCKET_COUNT,
  USAGE_DAILY_DAYS,
  USAGE_DAILY_CACHE_MS,
  USAGE_LIVE_DAY_CACHE_MS,
  UsageMonitor,
  buildUsageTimeline,
  buildDailyUsage,
  buildUsageDayDetail,
  collectDailyUsage,
  collectClaudeUsage,
  collectCodexUsage,
  collectOpenCodeDailyEvents,
  openCodeTokenEventsFromExport,
  readClaudeAuthStatus,
  readCodexAuthStatus,
};
