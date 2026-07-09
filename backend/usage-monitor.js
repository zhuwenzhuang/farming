const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { attachQuotaForecasts } = require('./usage-forecast');

const execFileAsync = promisify(execFile);

const USAGE_WINDOW_MS = 5 * 60 * 1000;
const JSONL_FILE_LIMIT = 60;
const JSONL_SCAN_LIMIT = 2000;
const JSONL_TAIL_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2500;

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

function usageObjectSignature(usage) {
  if (!usage || typeof usage !== 'object') return '';
  return JSON.stringify(Object.keys(usage).sort().map(key => [key, usage[key]]));
}

function collectCodexTokenDeltas(records, { now, windowMs }) {
  const windowStart = now - windowMs;
  const sortedRecords = records
    .map((record, index) => ({
      record,
      index,
      timestamp: parseTimestampMs(record.timestamp),
    }))
    .filter(entry => entry.record.type === 'event_msg' && entry.record.payload?.type === 'token_count')
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.index - b.index);

  let previousTotal = null;
  let totalTokens = 0;
  let eventCount = 0;
  const seenFallbackUsages = new Set();

  for (const entry of sortedRecords) {
    const { record, timestamp } = entry;
    const inWindow = Boolean(timestamp && timestamp >= windowStart && timestamp <= now + 60_000);
    const info = record.payload?.info;
    const cumulativeTotal = codexTokenTotalFromInfo(info, 'total_token_usage');
    const lastTokenTotal = codexTokenTotalFromInfo(info, 'last_token_usage');

    if (cumulativeTotal > 0) {
      let delta = 0;
      if (previousTotal !== null && cumulativeTotal >= previousTotal) {
        delta = cumulativeTotal - previousTotal;
      } else if (previousTotal === null) {
        delta = lastTokenTotal > 0 ? lastTokenTotal : cumulativeTotal;
      } else if (lastTokenTotal > 0) {
        delta = lastTokenTotal;
      }

      previousTotal = cumulativeTotal;
      if (inWindow && delta > 0) {
        totalTokens += delta;
        eventCount += 1;
      }
      continue;
    }

    if (!inWindow || lastTokenTotal <= 0) continue;
    const signature = usageObjectSignature(info?.last_token_usage);
    if (signature && seenFallbackUsages.has(signature)) continue;
    if (signature) seenFallbackUsages.add(signature);
    totalTokens += lastTokenTotal;
    eventCount += 1;
  }

  return { totalTokens, eventCount };
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
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];
  const files = await findRecentJsonlFiles(roots, {
    limit: options.fileLimit ?? JSONL_FILE_LIMIT,
    maxDepth: 6,
    scanLimit: options.scanLimit ?? JSONL_SCAN_LIMIT,
  });
  let totalTokens = 0;
  let eventCount = 0;
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
    const fileUsage = collectCodexTokenDeltas(records, { now, windowMs });
    totalTokens += fileUsage.totalTokens;
    eventCount += fileUsage.eventCount;
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
  const claudeHome = options.claudeHome || path.join(os.homedir(), '.claude');
  const files = await findRecentJsonlFiles([path.join(claudeHome, 'projects')], {
    limit: options.fileLimit ?? JSONL_FILE_LIMIT,
    maxDepth: 4,
    scanLimit: options.scanLimit ?? JSONL_SCAN_LIMIT,
  });
  let totalTokens = 0;
  let eventCount = 0;

  for (const filePath of files) {
    const records = await readJsonlRecords(filePath).catch(() => []);
    for (const record of records) {
      const timestamp = parseTimestampMs(record.timestamp);
      if (!timestamp || timestamp < now - windowMs || timestamp > now + 60_000) continue;

      for (const usage of claudeUsageObjectsFromRecord(record)) {
        const tokenTotal = tokenTotalFromUsage(usage, [
          'input_tokens',
          'cache_creation_input_tokens',
          'cache_read_input_tokens',
          'output_tokens',
        ]);
        if (tokenTotal > 0) {
          totalTokens += tokenTotal;
          eventCount += 1;
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
  };
}

class UsageMonitor {
  constructor(options = {}) {
    this.agentManager = options.agentManager || null;
    this.systemMonitor = options.systemMonitor || this.agentManager?.systemMonitor || null;
    this.commandRunner = options.commandRunner || defaultCommandRunner;
    this.codexHome = options.codexHome;
    this.claudeHome = options.claudeHome;
    this.windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  }

  async getUsageSummary(options = {}) {
    const now = options.now ?? Date.now();
    const windowMs = options.windowMs ?? this.windowMs;

    const [
      codexAuth,
      claudeAuth,
      codexUsage,
      claudeUsage,
      systemStats,
    ] = await Promise.all([
      readCodexAuthStatus(this.commandRunner),
      readClaudeAuthStatus(this.commandRunner),
      collectCodexUsage({ codexHome: this.codexHome, now, windowMs }),
      collectClaudeUsage({ claudeHome: this.claudeHome, now, windowMs }),
      this.systemMonitor?.getSystemStats ? this.systemMonitor.getSystemStats().catch(() => null) : Promise.resolve(null),
    ]);

    return {
      sampledAt: now,
      windowMs,
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
  UsageMonitor,
  collectClaudeUsage,
  collectCodexUsage,
  findRecentJsonlFiles,
  readClaudeAuthStatus,
  readCodexAuthStatus,
  collectCodexTokenDeltas,
  tokenTotalFromUsage,
};
