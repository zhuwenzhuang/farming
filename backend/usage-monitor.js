const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const { attachQuotaForecasts } = require('./usage-forecast');

const execFileAsync = promisify(execFile);

const USAGE_WINDOW_MS = 5 * 60 * 1000;
const USAGE_TIMELINE_WINDOW_MS = 60 * 60 * 1000;
const USAGE_TIMELINE_BUCKET_COUNT = 30;
const USAGE_DAILY_DAYS = 52 * 7;
const USAGE_DAILY_CACHE_MS = 5 * 60 * 1000;
const JSONL_FILE_LIMIT = 60;
const JSONL_SCAN_LIMIT = 2000;
const DAILY_JSONL_FILE_LIMIT = 5000;
const DAILY_JSONL_SCAN_LIMIT = 20_000;
const JSONL_TAIL_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2500;
const OPENCODE_COMMAND_TIMEOUT_MS = 20_000;
const OPENCODE_EXPORT_CONCURRENCY = 4;
const OPENCODE_SESSION_LIMIT = 5000;
const dailyFileEventCache = new Map();
const openCodeSessionEventCache = new Map();
let nativeRipgrepPathPromise = null;

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

function tokenTotalFromUsage(usage, fields) {
  if (!usage || typeof usage !== 'object') return 0;

  const explicitTotal = numberOrNull(usage.total_tokens);
  if (explicitTotal !== null) return Math.max(0, explicitTotal);

  return fields.reduce((sum, field) => {
    const value = numberOrNull(usage[field]);
    return sum + Math.max(0, value ?? 0);
  }, 0);
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

function codexTokenTotalFromInfo(info, field) {
  return tokenTotalFromUsage(info?.[field], ['input_tokens', 'output_tokens']);
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

function tokenBreakdownFromUsage(usage, provider) {
  if (!usage || typeof usage !== 'object') return emptyTokenBreakdown();
  const rawInput = Math.max(0, numberOrNull(usage.input_tokens) ?? 0);
  const outputTokens = Math.max(0, numberOrNull(usage.output_tokens) ?? 0);
  const cacheReadTokens = Math.max(0, numberOrNull(
    usage.cached_input_tokens ?? usage.cache_read_input_tokens,
  ) ?? 0);
  const cacheWriteTokens = Math.max(0, numberOrNull(usage.cache_creation_input_tokens) ?? 0);
  const inputTokens = provider === 'codex'
    ? Math.max(0, rawInput - cacheReadTokens)
    : rawInput;
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const explicitTotal = numberOrNull(usage.total_tokens);
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

function addTokenBreakdown(target, source) {
  for (const field of Object.keys(emptyTokenBreakdown())) {
    target[field] += Math.max(0, numberOrNull(source?.[field]) ?? 0);
  }
  return target;
}

function subtractTokenBreakdown(current, previous) {
  const result = emptyTokenBreakdown();
  for (const field of Object.keys(result)) {
    result[field] = Math.max(0, current[field] - previous[field]);
  }
  return result;
}

function normalizeDeltaBreakdown(current, previous, last) {
  const deltaTotal = Math.max(0, current.totalTokens - previous.totalTokens);
  const delta = subtractTokenBreakdown(current, previous);
  const componentTotal = delta.inputTokens + delta.outputTokens + delta.cacheReadTokens
    + delta.cacheWriteTokens + delta.unattributedTokens;
  if (componentTotal === deltaTotal) return delta;
  if (last.totalTokens === deltaTotal) return last;
  return { ...emptyTokenBreakdown(), totalTokens: deltaTotal, unattributedTokens: deltaTotal };
}

function usageObjectSignature(usage) {
  if (!usage || typeof usage !== 'object') return '';
  return JSON.stringify(Object.keys(usage).sort().map(key => [key, usage[key]]));
}

function createCodexDeltaState() {
  return {
    previousTotal: null,
    previousBreakdown: emptyTokenBreakdown(),
    seenFallbackUsages: new Set(),
  };
}

function codexTokenEventFromRecord(record, state) {
  if (record?.type !== 'event_msg' || record.payload?.type !== 'token_count') return null;
  const timestamp = parseTimestampMs(record.timestamp);
  if (!timestamp) return null;
  const info = record.payload?.info;
  const cumulativeTotal = codexTokenTotalFromInfo(info, 'total_token_usage');
  const lastTokenTotal = codexTokenTotalFromInfo(info, 'last_token_usage');
  const cumulativeBreakdown = tokenBreakdownFromUsage(info?.total_token_usage, 'codex');
  const lastBreakdown = tokenBreakdownFromUsage(info?.last_token_usage, 'codex');

  if (cumulativeTotal > 0) {
    let delta = 0;
    let deltaBreakdown = emptyTokenBreakdown();
    if (state.previousTotal !== null && cumulativeTotal >= state.previousTotal) {
      delta = cumulativeTotal - state.previousTotal;
      deltaBreakdown = normalizeDeltaBreakdown(
        cumulativeBreakdown,
        state.previousBreakdown,
        lastBreakdown,
      );
    } else if (state.previousTotal === null) {
      delta = lastTokenTotal > 0 ? lastTokenTotal : cumulativeTotal;
      deltaBreakdown = lastTokenTotal > 0 ? lastBreakdown : cumulativeBreakdown;
    } else if (lastTokenTotal > 0) {
      delta = lastTokenTotal;
      deltaBreakdown = lastBreakdown;
    }
    state.previousTotal = cumulativeTotal;
    state.previousBreakdown = cumulativeBreakdown;
    return delta > 0 ? { timestamp, ...deltaBreakdown, totalTokens: delta } : null;
  }

  if (lastTokenTotal <= 0) return null;
  const signature = usageObjectSignature(info?.last_token_usage);
  if (signature && state.seenFallbackUsages.has(signature)) return null;
  if (signature) state.seenFallbackUsages.add(signature);
  return { timestamp, ...lastBreakdown, totalTokens: lastTokenTotal };
}

function collectCodexTokenDeltas(records, {
  now,
  windowMs,
  historyWindowMs = windowMs,
  includeAllEvents = false,
}) {
  const windowStart = now - windowMs;
  const historyWindowStart = now - historyWindowMs;
  const sortedRecords = records
    .map((record, index) => ({
      record,
      index,
      timestamp: parseTimestampMs(record.timestamp),
    }))
    .filter(entry => entry.record.type === 'event_msg' && entry.record.payload?.type === 'token_count')
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.index - b.index);

  let totalTokens = 0;
  let eventCount = 0;
  const tokenEvents = [];
  const deltaState = createCodexDeltaState();

  for (const entry of sortedRecords) {
    const { record } = entry;
    const event = codexTokenEventFromRecord(record, deltaState);
    if (!event) continue;
    const { timestamp } = event;
    const inWindow = Boolean(timestamp && timestamp >= windowStart && timestamp <= now + 60_000);
    const inHistoryWindow = Boolean(timestamp && (
      includeAllEvents || (timestamp >= historyWindowStart && timestamp <= now + 60_000)
    ));
    if (inWindow) {
      totalTokens += event.totalTokens;
      eventCount += 1;
    }
    if (inHistoryWindow) tokenEvents.push(event);
  }

  return { totalTokens, eventCount, tokenEvents };
}

function buildUsageTimeline(providerEvents, options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = Math.max(60_000, options.windowMs ?? USAGE_TIMELINE_WINDOW_MS);
  const bucketCount = Math.max(1, Math.floor(options.bucketCount ?? USAGE_TIMELINE_BUCKET_COUNT));
  const bucketMs = windowMs / bucketCount;
  const endAt = now;
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

async function readJsonlTail(filePath, maxBytes = JSONL_TAIL_BYTES) {
  const stat = await fsp.stat(filePath);
  const size = stat.size;
  if (size <= 0) return '';

  const bytesToRead = Math.min(size, maxBytes);
  const start = size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, start);
  } finally {
    await handle.close();
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    const newlineIndex = text.indexOf('\n');
    text = newlineIndex === -1 ? '' : text.slice(newlineIndex + 1);
  }
  return text;
}

async function findRecentJsonlFiles(roots, options = {}) {
  const limit = options.limit ?? JSONL_FILE_LIMIT;
  const maxDepth = options.maxDepth ?? 6;
  const scanLimit = options.scanLimit ?? JSONL_SCAN_LIMIT;
  const files = [];
  let scanned = 0;

  async function walk(dir, depth) {
    if (depth > maxDepth || scanned >= scanLimit) return;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scanned >= scanLimit) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      scanned += 1;
      try {
        const stat = await fsp.stat(entryPath);
        files.push({ filePath: entryPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore files that disappear while we scan.
      }
    }
  }

  for (const root of roots) {
    await walk(root, 0);
  }

  return files
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map(file => file.filePath);
}

async function readJsonlRecords(filePath) {
  const text = await readJsonlTail(filePath);
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function isNativeExecutable(filePath) {
  try {
    const resolved = await fsp.realpath(filePath);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) return false;
    const handle = await fsp.open(resolved, 'r');
    try {
      const header = Buffer.alloc(2);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.toString('utf8') !== '#!';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function codexBundledRipgrepCandidates() {
  let codexPackagePath;
  try {
    codexPackagePath = require.resolve('@openai/codex/package.json');
  } catch {
    return [];
  }
  const scopeDir = path.dirname(path.dirname(codexPackagePath));
  let packages;
  try {
    packages = await fsp.readdir(scopeDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const executableName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const candidates = [];
  for (const entry of packages) {
    if (!entry.isDirectory() || !entry.name.startsWith('codex-')) continue;
    const vendorDir = path.join(scopeDir, entry.name, 'vendor');
    let triples;
    try {
      triples = await fsp.readdir(vendorDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const triple of triples) {
      if (!triple.isDirectory()) continue;
      candidates.push(path.join(vendorDir, triple.name, 'codex-path', executableName));
    }
  }
  return candidates;
}

async function resolveNativeRipgrepPath() {
  if (process.env.FARMING_RG_BIN) return process.env.FARMING_RG_BIN;
  if (nativeRipgrepPathPromise) return nativeRipgrepPathPromise;
  nativeRipgrepPathPromise = (async () => {
    const executableName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const pathCandidates = String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map(dir => path.join(dir, executableName));
    const candidates = [
      ...pathCandidates,
      ...await codexBundledRipgrepCandidates(),
    ];
    for (const candidate of Array.from(new Set(candidates))) {
      if (await isNativeExecutable(candidate)) return candidate;
    }
    return null;
  })();
  return nativeRipgrepPathPromise;
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
  }));
  const providers = Object.fromEntries(
    providerNames.map(provider => [provider, emptyTokenBreakdown()]),
  );
  const total = emptyTokenBreakdown();

  for (const provider of providerNames) {
    for (const event of providerEvents[provider] || []) {
      const timestamp = parseTimestampMs(event?.timestamp);
      if (localDateKey(timestamp) !== date) continue;
      const hour = new Date(timestamp).getHours();
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
      addTokenBreakdown(hours[hour], event);
      addTokenBreakdown(providers[provider], event);
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
  };
}

async function readDailyFileEvents(filePath, provider, minimumMtimeMs = 0) {
  const stat = await fsp.stat(filePath);
  if (stat.mtimeMs < minimumMtimeMs) return { events: [], mtimeMs: stat.mtimeMs };
  const cacheKey = `${provider}:${filePath}`;
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = dailyFileEventCache.get(cacheKey);
  if (cached?.signature === signature) {
    return { events: cached.events, mtimeMs: stat.mtimeMs, truncated: cached.truncated };
  }

  const records = await readJsonlRecords(filePath);
  const events = [];
  if (provider === 'codex') {
    events.push(...collectCodexTokenDeltas(records, {
      now: Date.now(),
      windowMs: 1,
      includeAllEvents: true,
    }).tokenEvents);
  } else {
    for (const record of records) {
      const timestamp = parseTimestampMs(record.timestamp);
      if (!timestamp) continue;
      for (const usage of claudeUsageObjectsFromRecord(record)) {
        const breakdown = tokenBreakdownFromUsage(usage, 'claude');
        if (breakdown.totalTokens > 0) events.push({ timestamp, ...breakdown });
      }
    }
  }

  const truncated = stat.size > JSONL_TAIL_BYTES;
  dailyFileEventCache.set(cacheKey, { signature, events, truncated });
  return { events, mtimeMs: stat.mtimeMs, truncated };
}

async function collectCodexDailyEventsWithRipgrep(roots, options = {}) {
  const existingRoots = [];
  for (const root of roots) {
    try {
      await fsp.access(root);
      existingRoots.push(root);
    } catch {
      // Ignore provider history roots that do not exist yet.
    }
  }
  if (existingRoots.length === 0) return { events: [], partial: false };

  const now = options.now ?? Date.now();
  const cutoffMs = options.cutoffMs ?? 0;
  const ripgrepPath = options.ripgrepPath || await resolveNativeRipgrepPath();
  if (!ripgrepPath) return null;
  return new Promise((resolve) => {
    const child = spawn(ripgrepPath, [
      '-F',
      '"type":"token_count"',
      '--with-filename',
      '--no-heading',
      '--no-line-number',
      '-g',
      '*.jsonl',
      ...existingRoots,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    const events = [];
    const states = new Map();
    let unavailable = false;
    child.once('error', () => {
      unavailable = true;
    });
    child.stderr.resume();
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      const separator = line.indexOf(':{');
      if (separator <= 0) return;
      const filePath = line.slice(0, separator);
      let record;
      try {
        record = JSON.parse(line.slice(separator + 1));
      } catch {
        return;
      }
      let state = states.get(filePath);
      if (!state) {
        state = createCodexDeltaState();
        states.set(filePath, state);
      }
      const event = codexTokenEventFromRecord(record, state);
      if (event && event.timestamp >= cutoffMs && event.timestamp <= now + 60_000) events.push(event);
    });
    child.once('close', code => {
      if (unavailable || (code !== 0 && code !== 1)) {
        resolve(null);
        return;
      }
      resolve({ events, partial: false, source: 'ripgrep token_count scan' });
    });
  });
}

async function collectProviderDailyEvents(provider, roots, options = {}) {
  const now = options.now ?? Date.now();
  const days = Math.max(1, Math.floor(options.days ?? USAGE_DAILY_DAYS));
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  if (provider === 'codex') {
    const ripgrepResult = await collectCodexDailyEventsWithRipgrep(roots, {
      now,
      cutoffMs: cutoff.getTime(),
    });
    if (ripgrepResult) return ripgrepResult;
  }
  const fileLimit = options.fileLimit ?? DAILY_JSONL_FILE_LIMIT;
  const files = await findRecentJsonlFiles(roots, {
    limit: fileLimit,
    maxDepth: options.maxDepth ?? 6,
    scanLimit: options.scanLimit ?? DAILY_JSONL_SCAN_LIMIT,
  });
  const events = [];
  let truncated = false;
  for (const filePath of files) {
    const file = await readDailyFileEvents(filePath, provider, cutoff.getTime()).catch(() => null);
    if (!file) continue;
    events.push(...file.events);
    truncated = truncated || file.truncated === true;
  }
  return {
    events,
    partial: truncated || files.length >= fileLimit,
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

async function collectOpenCodeDailyEvents(homePaths, options = {}) {
  const now = options.now ?? Date.now();
  const cutoffMs = options.cutoffMs ?? 0;
  const commandRunner = options.openCodeCommandRunner || defaultOpenCodeCommandRunner;
  const sessions = [];
  const seenSessionIds = new Set();
  let successfulHomes = 0;
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
        events.push(...cached.events);
        continue;
      }
      try {
        const result = await commandRunner(
          ['export', session.id, '--pure', '--sanitize'],
          { openCodeHome: session.openCodeHome, timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS },
        );
        const exported = JSON.parse(String(result?.stdout || '{}'));
        const sessionEvents = openCodeTokenEventsFromExport(exported, { cutoffMs, now });
        openCodeSessionEventCache.set(cacheKey, { updatedAt: session.updatedAt, events: sessionEvents });
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
    available: successfulHomes > 0,
    reason,
    sessionCount: sessions.length,
  };
}

async function collectUsageHistory(options = {}) {
  const now = options.now ?? Date.now();
  const days = options.days ?? USAGE_DAILY_DAYS;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
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
  const [codex, claude, openCode] = await Promise.all([
    collectProviderDailyEvents('codex', codexHomes.flatMap(home => [
      path.join(home, 'sessions'),
      path.join(home, 'archived_sessions'),
    ]), { now, days, maxDepth: 6 }),
    collectProviderDailyEvents('claude', claudeHomes.map(home => path.join(home, 'projects')), {
      now,
      days,
      maxDepth: 4,
    }),
    collectOpenCodeDailyEvents(openCodeHomes, {
      now,
      cutoffMs: cutoff.getTime(),
      openCodeCommandRunner: options.openCodeCommandRunner,
    }),
  ]);
  const providerEvents = {
    codex: codex.events,
    claude: claude.events,
    opencode: openCode.events,
  };
  const coverage = [
    {
      provider: 'codex',
      providerName: 'Codex',
      available: true,
      homeCount: codexHomes.length,
      source: codex.source || 'local Codex token_count events',
    },
    {
      provider: 'claude',
      providerName: 'Claude',
      available: true,
      homeCount: claudeHomes.length,
      source: 'local Claude usage fields',
    },
    {
      provider: 'opencode',
      providerName: 'OpenCode',
      available: openCode.available,
      homeCount: openCodeHomes.length,
      sessionCount: openCode.sessionCount,
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
      partial: codex.partial || claude.partial || openCode.partial,
      coverage,
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
  const codexHomes = providerHomePaths(
    options.providerHomes,
    'codex',
    options.codexHome || path.join(os.homedir(), '.codex'),
  );
  const roots = codexHomes.flatMap(home => [
    path.join(home, 'sessions'),
    path.join(home, 'archived_sessions'),
  ]);
  const files = await findRecentJsonlFiles(roots, {
    limit: options.fileLimit ?? JSONL_FILE_LIMIT,
    maxDepth: 6,
    scanLimit: options.scanLimit ?? JSONL_SCAN_LIMIT,
  });
  let totalTokens = 0;
  let eventCount = 0;
  const tokenEvents = [];
  let latestQuota = null;
  let latestQuotaAt = 0;
  let latestOverallQuota = null;
  let latestOverallQuotaAt = 0;

  for (const filePath of files) {
    const records = await readJsonlRecords(filePath).catch(() => []);
    for (const record of records) {
      if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') continue;
      const timestamp = parseTimestampMs(record.timestamp);
      const rateLimits = parseCodexRateLimits(record.payload.rate_limits);
      if (rateLimits && (!timestamp || timestamp >= latestQuotaAt)) {
        latestQuota = rateLimits;
        latestQuotaAt = timestamp ?? latestQuotaAt;
      }
      if (rateLimits && isCodexOverallRateLimit(rateLimits) && (!timestamp || timestamp >= latestOverallQuotaAt)) {
        latestOverallQuota = rateLimits;
        latestOverallQuotaAt = timestamp ?? latestOverallQuotaAt;
      }

    }
    const fileUsage = collectCodexTokenDeltas(records, { now, windowMs, historyWindowMs });
    totalTokens += fileUsage.totalTokens;
    eventCount += fileUsage.eventCount;
    tokenEvents.push(...fileUsage.tokenEvents);
  }
  const quota = latestOverallQuota || latestQuota || {
    available: false,
    source: 'codex token_count events',
    reason: 'No recent Codex token_count event with rate limits was found.',
  };

  return {
    quota: attachQuotaForecasts(quota, { now }),
    tokenUsage: tokenUsageSummary({
      totalTokens,
      eventCount,
      source: 'codex cumulative token_count deltas',
      windowMs,
      sampledAt: now,
    }),
    tokenEvents,
  };
}

function claudeUsageObjectsFromRecord(record) {
  const objects = [];
  if (record?.message?.usage) objects.push(record.message.usage);
  if (record?.toolUseResult?.usage) objects.push(record.toolUseResult.usage);
  return objects;
}

async function collectClaudeUsage(options = {}) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;
  const claudeHomes = providerHomePaths(
    options.providerHomes,
    'claude',
    options.claudeHome || path.join(os.homedir(), '.claude'),
  );
  const files = await findRecentJsonlFiles(claudeHomes.map(home => path.join(home, 'projects')), {
    limit: options.fileLimit ?? JSONL_FILE_LIMIT,
    maxDepth: 4,
    scanLimit: options.scanLimit ?? JSONL_SCAN_LIMIT,
  });
  let totalTokens = 0;
  let eventCount = 0;
  const tokenEvents = [];

  for (const filePath of files) {
    const records = await readJsonlRecords(filePath).catch(() => []);
    for (const record of records) {
      const timestamp = parseTimestampMs(record.timestamp);
      if (!timestamp || timestamp < now - historyWindowMs || timestamp > now + 60_000) continue;

      for (const usage of claudeUsageObjectsFromRecord(record)) {
        const tokenTotal = tokenTotalFromUsage(usage, [
          'input_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
          'output_tokens',
        ]);
        if (tokenTotal > 0) {
          tokenEvents.push({ timestamp, totalTokens: tokenTotal });
          if (timestamp >= now - windowMs) {
            totalTokens += tokenTotal;
            eventCount += 1;
          }
        }
      }
    }
  }

  return {
    quota: {
      available: false,
      source: 'claude auth status',
      reason: 'Claude Code auth/status output does not expose usage remaining.',
    },
    tokenUsage: tokenUsageSummary({
      totalTokens,
      eventCount,
      source: 'claude local usage fields',
      windowMs,
      sampledAt: now,
    }),
    tokenEvents,
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
    this.windowMs = options.windowMs ?? USAGE_WINDOW_MS;
    this.dailyDays = options.dailyDays ?? USAGE_DAILY_DAYS;
    this.dailyCacheMs = options.dailyCacheMs ?? USAGE_DAILY_CACHE_MS;
    this.dailyCache = { value: null, fetchedAt: 0, pending: null };
  }

  invalidateDailyCache() {
    this.dailyCache.fetchedAt = 0;
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
    const history = await this.getDailyUsage({
      now: options.now,
      force: options.fresh === true,
    });
    return buildUsageDayDetail(history.providerEvents, { date });
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
      collectCodexUsage({ codexHome: this.codexHome, providerHomes, now, windowMs, historyWindowMs }),
      collectClaudeUsage({ claudeHome: this.claudeHome, providerHomes, now, windowMs, historyWindowMs }),
      this.getDailyUsage({ now, force: options.fresh === true }),
      this.systemMonitor?.getSystemStats ? this.systemMonitor.getSystemStats().catch(() => null) : Promise.resolve(null),
    ]);

    const openCodeUsage = providerUsageFromEvents(history.providerEvents.opencode, {
      now,
      windowMs,
      historyWindowMs,
      source: 'opencode session export',
    });
    const timeline = buildUsageTimeline({
      codex: codexUsage.tokenEvents,
      claude: claudeUsage.tokenEvents,
      opencode: openCodeUsage.tokenEvents,
    }, { now, windowMs: historyWindowMs });
    const qoderCoverage = history.coverage.find(entry => entry.provider === 'qoder');

    return {
      sampledAt: now,
      windowMs,
      timeline,
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
          auth: { available: true, status: 'Local session export', source: 'opencode session export' },
          quota: {
            available: false,
            source: 'opencode session export',
            reason: 'OpenCode session exports do not expose quota remaining.',
          },
          tokenUsage: openCodeUsage.tokenUsage,
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
  USAGE_DAILY_DAYS,
  USAGE_DAILY_CACHE_MS,
  UsageMonitor,
  buildUsageTimeline,
  buildDailyUsage,
  buildUsageDayDetail,
  collectDailyUsage,
  collectClaudeUsage,
  collectCodexUsage,
  collectOpenCodeDailyEvents,
  findRecentJsonlFiles,
  openCodeTokenEventsFromExport,
  readClaudeAuthStatus,
  readCodexAuthStatus,
  collectCodexTokenDeltas,
  tokenTotalFromUsage,
};
