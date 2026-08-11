const os = require('os') as typeof import('os');
const path = require('path') as typeof import('path');
const { execFile } = require('child_process') as typeof import('child_process');
const { promisify } = require('util') as typeof import('util');
import {
  UsageHistoryClient,
  type UsageHistoryEvent,
  type UsageHistoryProvider,
  type UsageHistoryResult,
} from './usage-history-client.cjs';
import { attachQuotaForecasts } from './usage-forecast.cjs';
import {
  getProviderAdapter,
  listProviderAdapters,
  type ProviderAdapter,
  type ProviderId,
  type ProviderUsageLiveCollector,
} from './provider-adapters.cjs';

type DataRecord = Record<string, unknown>;
type ProviderHomes = Record<string, Array<string | { path?: unknown }> | undefined>;

interface TokenBreakdown extends DataRecord {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unattributedTokens: number;
}

type UsageEvent = UsageHistoryEvent;

type ProviderEvents = Record<string, UsageEvent[] | undefined>;

type CCStatisticsResult = UsageHistoryResult;

interface UsageHistoryClientLike {
  collect(options: {
    now: number;
    retentionDays: number;
    roots: Record<string, string[]>;
    fresh?: boolean;
    scanBudgetMs?: number;
  }): Promise<CCStatisticsResult>;
}

interface CCStatisticsOptions {
  now?: number;
  days?: number;
  retentionDays?: number;
  fresh?: boolean;
  scanBudgetMs?: number;
  providerHomes?: ProviderHomes;
  codexHome?: string;
  claudeHome?: string;
  configDir?: string;
  usageHistoryClient?: UsageHistoryClientLike;
  ccStatisticsClient?: UsageHistoryClientLike;
}

interface CommandResult {
  stdout?: string;
  stderr?: string;
}

interface CommandOptions {
  timeoutMs?: number;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

interface OpenCodeCommandOptions extends CommandOptions {
  openCodeHome?: string;
  openCodeBin?: string;
  maxBuffer?: number;
}

type OpenCodeCommandRunner = (
  args: string[],
  options?: OpenCodeCommandOptions,
) => Promise<CommandResult>;

interface CollectionOptions extends CCStatisticsOptions {
  days?: number;
  windowMs?: number;
  historyWindowMs?: number;
  source?: string;
  openCodeHome?: string;
  qoderHome?: string;
  openCodeCommandRunner?: OpenCodeCommandRunner;
}

interface TimeOptions {
  now?: number;
}

interface TimelineOptions extends TimeOptions {
  windowMs?: number;
  bucketCount?: number;
  alignToBucket?: boolean;
}

interface ProviderUsageOptions extends TimeOptions {
  windowMs?: number;
  historyWindowMs?: number;
  source?: string;
}

interface DailyUsageOptions extends TimeOptions {
  days?: number;
}

interface UsageDayOptions {
  date?: unknown;
  agentLabels?: Map<string, string>;
}

interface OpenCodeEventOptions extends TimeOptions {
  cutoffMs?: number;
}

interface OpenCodeCollectOptions extends OpenCodeEventOptions {
  openCodeCommandRunner?: OpenCodeCommandRunner;
}

interface OpenCodeSession {
  id: string;
  openCodeHome: string;
  updatedAt: number;
}

interface OpenCodeSessionCacheEntry {
  updatedAt: number;
  events: UsageEvent[];
}

interface TokenUsageSummary {
  available: boolean;
  windowMs: number;
  source: string;
  totalTokens: number;
  tokensPerMinute: number;
  eventCount: number;
  sampledAt: number;
  reason?: string;
}

interface UsageProviderCoverage extends DataRecord {
  available: boolean;
  homeCount: number;
  provider: string;
  providerName: string;
  source: string;
  exportCount?: number;
  fileCount?: number;
  partial?: boolean;
  reason?: string;
  sessionCount?: number;
}

interface DailyUsagePoint extends TokenBreakdown {
  date: string;
  providers: Record<string, TokenBreakdown>;
}

interface HourUsagePoint extends TokenBreakdown {
  hour: number;
  label: string;
  agents: Record<string, TokenBreakdown>;
}

interface UsageAgent extends TokenBreakdown {
  key: string;
  provider: string;
  sessionId: string;
  label: string;
}

interface AgentManagerLike {
  systemMonitor?: SystemMonitorLike;
  getState?(): { agents?: unknown };
  getAgentUsageSnapshots?(options: { now: number; windowMs: number }): unknown;
}

interface SystemMonitorLike {
  getSystemStats(): Promise<unknown>;
}

interface UsageMonitorOptions extends CollectionOptions {
  agentManager?: AgentManagerLike;
  systemMonitor?: SystemMonitorLike;
  commandRunner?: CommandRunner;
  getProviderHomes?: () => ProviderHomes;
  dailyDays?: number;
  dailyCacheMs?: number;
  liveDayCacheMs?: number;
}

interface UsageReadOptions extends TimeOptions {
  force?: boolean;
  fresh?: boolean;
  live?: boolean;
  windowMs?: number;
  historyWindowMs?: number;
}

function asRecord(value: unknown): DataRecord | null {
  return typeof value === 'object' && value !== null ? value as DataRecord : null;
}

const execFileAsync = promisify(execFile);

const USAGE_WINDOW_MS = 5 * 60 * 1000;
const USAGE_TIMELINE_WINDOW_MS = 24 * 60 * 60 * 1000;
const USAGE_TIMELINE_BUCKET_COUNT = 24;
const USAGE_LIVE_TIMELINE_WINDOW_MS = 60 * 60 * 1000;
const USAGE_LIVE_TIMELINE_BUCKET_COUNT = 60;
const USAGE_DAILY_DAYS = 52 * 7;
const USAGE_DAILY_CACHE_MS = 5 * 60 * 1000;
const USAGE_LIVE_DAY_CACHE_MS = 5 * 1000;
const USAGE_FOREGROUND_SCAN_BUDGET_MS = 500;
const COMMAND_TIMEOUT_MS = 2500;
const OPENCODE_COMMAND_TIMEOUT_MS = 20_000;
const OPENCODE_EXPORT_CONCURRENCY = 4;
const OPENCODE_SESSION_LIMIT = 5000;
const OPENCODE_SESSION_CACHE_LIMIT = 5000;
const openCodeSessionEventCache = new Map<string, OpenCodeSessionCacheEntry>();

function numberOrNull(value: unknown): number | null {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function roundRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

function normalizeEpochMs(value: unknown): number | null {
  const numberValue = numberOrNull(value);
  if (numberValue === null || numberValue <= 0) return null;
  return numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
}

function parseTimestampMs(value: unknown): number | null {
  if (!value) return null;
  if (typeof value === 'number') return normalizeEpochMs(value);
  const parsed = Date.parse(value as string);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenUsageSummary({
  totalTokens,
  eventCount,
  source,
  windowMs,
  sampledAt,
}: {
  totalTokens: number;
  eventCount: number;
  source: string;
  windowMs: number;
  sampledAt: number;
}): TokenUsageSummary {
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

function emptyTokenBreakdown(): TokenBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    unattributedTokens: 0,
  };
}

function tokenBreakdownFromOpenCode(tokens: unknown): TokenBreakdown {
  if (!tokens || typeof tokens !== 'object') return emptyTokenBreakdown();
  const source = tokens as DataRecord;
  const cache = asRecord(source.cache);
  const inputTokens = Math.max(0, numberOrNull(source.input) ?? 0);
  const outputTokens = Math.max(0, numberOrNull(source.output) ?? 0)
    + Math.max(0, numberOrNull(source.reasoning) ?? 0);
  const cacheReadTokens = Math.max(0, numberOrNull(cache?.read) ?? 0);
  const cacheWriteTokens = Math.max(0, numberOrNull(cache?.write) ?? 0);
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const explicitTotal = numberOrNull(source.total);
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

function providerHomePaths(
  providerHomes: ProviderHomes | undefined,
  provider: string,
  fallbackPath: string,
): string[] {
  const configured = providerHomes && Array.isArray(providerHomes[provider])
    ? providerHomes[provider]
    : [];
  const candidates = configured.length > 0 ? configured : [fallbackPath];
  return Array.from(new Set(candidates.map((home): string => {
    if (typeof home === 'string') return home;
    return home && typeof home.path === 'string' ? home.path : '';
  }).filter(Boolean)));
}

function providerHomeOverride(
  options: CCStatisticsOptions & Pick<CollectionOptions, 'openCodeHome' | 'qoderHome'>,
  provider: ProviderId,
): string | undefined {
  const legacyOverrides: Partial<Record<ProviderId, string | undefined>> = {
    codex: options.codexHome,
    claude: options.claudeHome,
    opencode: options.openCodeHome,
    qoder: options.qoderHome,
  };
  return legacyOverrides[provider];
}

function usageProviderHomePaths(
  options: CCStatisticsOptions & Pick<CollectionOptions, 'openCodeHome' | 'qoderHome'>,
): Map<ProviderId, string[]> {
  return new Map(listProviderAdapters().map(adapter => [
    adapter.id,
    providerHomePaths(
      options.providerHomes,
      adapter.id,
      providerHomeOverride(options, adapter.id)
        || path.join(os.homedir(), adapter.usage.defaultHomeDirectory),
    ),
  ]));
}

function ccStatisticsRoots(options: CCStatisticsOptions = {}): Record<string, string[]> {
  const homePaths = usageProviderHomePaths(options);
  return Object.fromEntries(listProviderAdapters().flatMap(adapter => {
    const collection = adapter.usage.collection;
    if (collection.kind !== 'local-history') return [];
    const homes = homePaths.get(adapter.id) || [];
    return [[
      adapter.id,
      homes.flatMap(home => collection.rootDirectories.map(directory => (
        path.join(home, directory)
      ))),
    ]];
  }));
}

function ccStatisticsClient(options: CCStatisticsOptions = {}): UsageHistoryClientLike {
  return options.usageHistoryClient || options.ccStatisticsClient || new UsageHistoryClient({
    configDir: options.configDir || path.join(os.homedir(), '.farming'),
  });
}

function unavailableCCStatisticsResult(error: unknown, now: number): CCStatisticsResult {
  const reason = commandUnavailable(error);
  return {
    schemaVersion: 1,
    source: 'local usage history unavailable',
    sampledAt: now,
    providers: Object.fromEntries(listProviderAdapters().flatMap(adapter => (
      adapter.usage.collection.kind === 'local-history'
        ? [[adapter.id, { events: [], quotaCandidates: [], available: false, reason, fileCount: 0 }]]
        : []
    ))),
    cache: { errors: 1 },
  };
}

async function collectCCStatistics(options: CCStatisticsOptions = {}) {
  const now = options.now ?? Date.now();
  const roots = ccStatisticsRoots(options);
  try {
    const result = await ccStatisticsClient(options).collect({
      now,
      retentionDays: options.retentionDays ?? USAGE_DAILY_DAYS,
      roots,
      fresh: options.fresh,
      scanBudgetMs: options.scanBudgetMs,
    });
    return { result, roots };
  } catch (error) {
    return { result: unavailableCCStatisticsResult(error, now), roots };
  }
}

function ccStatisticsProviderEvents(
  result: CCStatisticsResult,
  provider: string,
): UsageEvent[] {
  const providers = result?.providers as Record<string, UsageHistoryProvider | undefined>;
  return (providers?.[provider]?.events || []).map(event => attributeUsageEvent(
    event,
    provider,
    String(event.sessionId || 'unattributed'),
  ));
}

function addTokenBreakdown(
  target: TokenBreakdown,
  source: DataRecord | null | undefined,
): TokenBreakdown {
  type TokenBreakdownField =
    | 'totalTokens'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadTokens'
    | 'cacheWriteTokens'
    | 'unattributedTokens';
  for (const field of Object.keys(emptyTokenBreakdown()) as TokenBreakdownField[]) {
    target[field] += Math.max(0, numberOrNull(source?.[field]) ?? 0);
  }
  return target;
}

function usageAgentLabel(provider: string, agentId: string): string {
  const providerName = getProviderAdapter(provider)?.displayName || provider;
  if (!agentId || agentId === 'unattributed') return providerName;
  const shortId = agentId.length > 12 ? `…${agentId.slice(-6)}` : agentId;
  return `${providerName} · ${shortId}`;
}

function attributeUsageEvent(
  event: UsageEvent,
  provider: string,
  agentId: string,
): UsageEvent {
  return {
    ...event,
    agentId,
    agentLabel: usageAgentLabel(provider, agentId),
  };
}

function buildUsageTimeline(
  providerEvents: ProviderEvents,
  options: TimelineOptions = {},
) {
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

function providerUsageFromEvents(
  events: UsageEvent[] | null | undefined,
  options: ProviderUsageOptions = {},
) {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? USAGE_WINDOW_MS;
  const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;
  let totalTokens = 0;
  let eventCount = 0;
  const tokenEvents: UsageEvent[] = [];
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

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const result = await execFileAsync(command, args, {
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });

  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function commandUnavailable(error: unknown): string {
  if (!error) return 'Unavailable';
  const details = asRecord(error);
  if (details?.code === 'ENOENT') return 'Command not found';
  const stderr = String(details?.stderr || '').trim();
  const stdout = String(details?.stdout || '').trim();
  return stderr || stdout || String(details?.message || '') || 'Unavailable';
}

async function readCodexAuthStatus(commandRunner: CommandRunner = defaultCommandRunner) {
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

async function readClaudeAuthStatus(commandRunner: CommandRunner = defaultCommandRunner) {
  try {
    const result = await commandRunner('claude', ['auth', 'status', '--json'], { timeoutMs: COMMAND_TIMEOUT_MS });
    const parsed = JSON.parse((result.stdout || result.stderr || '{}').trim() || '{}') as DataRecord;
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

function localDateKey(timestamp: unknown): string {
  const date = new Date(timestamp as string | number | Date);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildDailyUsage(
  providerEvents: ProviderEvents,
  options: DailyUsageOptions = {},
) {
  const now = options.now ?? Date.now();
  const days = Math.max(1, Math.floor(options.days ?? USAGE_DAILY_DAYS));
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - days + 1);
  const points: DailyUsagePoint[] = [];
  const byDate = new Map<string, DailyUsagePoint>();
  const providerNames = Object.keys(providerEvents || {});

  for (let index = 0; index < days; index += 1) {
    const date = localDateKey(cursor.getTime());
    const point: DailyUsagePoint = {
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

  const sumRange = (count: number): number => points
    .slice(Math.max(0, points.length - count))
    .reduce((total, point) => total + point.totalTokens, 0);
  const peak = points.reduce<DailyUsagePoint | null>((best, point) => (
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

function buildUsageDayDetail(
  providerEvents: ProviderEvents,
  options: UsageDayOptions = {},
) {
  const date = String(options.date || '').trim();
  const parts = date.split('-').map(Number);
  const dateProbe = parts.length === 3
    ? new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0)
    : null;
  if (!dateProbe || localDateKey(dateProbe.getTime()) !== date) {
    throw new RangeError('Usage day must be a valid local date in YYYY-MM-DD format.');
  }

  const providerNames = Object.keys(providerEvents || {});
  const hours: HourUsagePoint[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: String(hour).padStart(2, '0'),
    ...emptyTokenBreakdown(),
    agents: {},
  }));
  const providers: Record<string, TokenBreakdown> = Object.fromEntries(
    providerNames.map(provider => [provider, emptyTokenBreakdown()]),
  );
  const total = emptyTokenBreakdown();
  const agents = new Map<string, UsageAgent>();
  const agentLabels = options.agentLabels instanceof Map ? options.agentLabels : new Map();

  for (const provider of providerNames) {
    for (const event of providerEvents[provider] || []) {
      const timestamp = parseTimestampMs(event?.timestamp);
      if (localDateKey(timestamp) !== date) continue;
      const hour = new Date(timestamp as number).getHours();
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

async function defaultOpenCodeCommandRunner(
  args: string[],
  options: OpenCodeCommandOptions = {},
): Promise<CommandResult> {
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

function openCodeTokenEventsFromExport(
  sessionExport: unknown,
  options: OpenCodeEventOptions = {},
): UsageEvent[] {
  const cutoffMs = options.cutoffMs ?? 0;
  const now = options.now ?? Date.now();
  const events: UsageEvent[] = [];
  const exported = asRecord(sessionExport);
  for (const messageValue of Array.isArray(exported?.messages) ? exported.messages : []) {
    const message = asRecord(messageValue);
    const info = asRecord(message?.info);
    const time = asRecord(info?.time);
    if (info?.role !== 'assistant' || !info.tokens) continue;
    const timestamp = parseTimestampMs(time?.completed ?? time?.created);
    if (!timestamp || timestamp < cutoffMs || timestamp > now + 60_000) continue;
    const breakdown = tokenBreakdownFromOpenCode(info.tokens);
    if (breakdown.totalTokens > 0) events.push({ timestamp, ...breakdown });
  }
  return events;
}

function cacheOpenCodeSessionEvents(cacheKey: string, value: OpenCodeSessionCacheEntry): void {
  openCodeSessionEventCache.delete(cacheKey);
  openCodeSessionEventCache.set(cacheKey, value);
  while (openCodeSessionEventCache.size > OPENCODE_SESSION_CACHE_LIMIT) {
    const oldestKey = openCodeSessionEventCache.keys().next().value;
    if (oldestKey === undefined) break;
    openCodeSessionEventCache.delete(oldestKey);
  }
}

async function collectOpenCodeDailyEvents(
  homePaths: string[],
  options: OpenCodeCollectOptions = {},
) {
  const now = options.now ?? Date.now();
  const cutoffMs = options.cutoffMs ?? 0;
  const commandRunner = options.openCodeCommandRunner || defaultOpenCodeCommandRunner;
  const sessions: OpenCodeSession[] = [];
  const seenSessionIds = new Set<string>();
  let successfulHomes = 0;
  let successfulExports = 0;
  let partial = false;
  let reason = '';

  for (const openCodeHome of homePaths) {
    try {
      const result = await commandRunner([
        'session', 'list', '--format', 'json', '--max-count', String(OPENCODE_SESSION_LIMIT),
      ], { openCodeHome, timeoutMs: OPENCODE_COMMAND_TIMEOUT_MS });
      const listed = JSON.parse(String(result?.stdout || '[]')) as unknown;
      if (!Array.isArray(listed)) throw new Error('OpenCode session list was not an array');
      successfulHomes += 1;
      if (listed.length >= OPENCODE_SESSION_LIMIT) {
        partial = true;
        reason = reason
          || `OpenCode returned the ${OPENCODE_SESSION_LIMIT.toLocaleString('en-US')} session limit; older sessions may be omitted.`;
      }
      for (const sessionValue of listed) {
        const session = asRecord(sessionValue);
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

  const events: UsageEvent[] = [];
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
        const exported = JSON.parse(String(result?.stdout || '{}')) as unknown;
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

type UsageProviderAdapter = ProviderAdapter;
type SessionExportResult = Awaited<ReturnType<typeof collectOpenCodeDailyEvents>>;
type SessionUsageExportCollectorId = Extract<
  ProviderAdapter['usage']['collection'],
  { kind: 'session-export' }
>['collector'];

type SessionUsageExportCollector = (
    homePaths: string[],
    options: { cutoffMs: number; now: number; openCodeCommandRunner?: OpenCodeCommandRunner },
  ) => Promise<SessionExportResult>;

const SESSION_USAGE_EXPORT_COLLECTORS: Readonly<
  Record<SessionUsageExportCollectorId, SessionUsageExportCollector>
> = Object.freeze({
  'opencode-session-export': (homePaths: string[], options: OpenCodeCollectOptions) => (
      collectOpenCodeDailyEvents(homePaths, options)
  ),
});

function sessionUsageExportCollector(
  id: SessionUsageExportCollectorId,
): SessionUsageExportCollector {
  return SESSION_USAGE_EXPORT_COLLECTORS[id];
}

function providerUsageCoverage(
  adapter: UsageProviderAdapter,
  context: {
    homePaths: ReadonlyMap<ProviderId, string[]>;
    localHistory: CCStatisticsResult;
    sessionExports: ReadonlyMap<ProviderId, SessionExportResult>;
  },
): UsageProviderCoverage {
  const policy = adapter.usage;
  const homeCount = context.homePaths.get(adapter.id)?.length || 0;
  if (policy.collection.kind === 'local-history') {
    const providers = context.localHistory.providers as Record<string, UsageHistoryProvider | undefined>;
    const provider = providers[adapter.id];
    return {
      provider: adapter.id,
      providerName: policy.coverageName || adapter.displayName,
      available: provider?.available === true,
      homeCount,
      fileCount: provider?.fileCount || 0,
      source: provider?.source || context.localHistory.source || policy.source,
      ...(provider?.reason
        ? { reason: provider.reason }
        : !provider
          ? { reason: `${adapter.displayName} local history parser is unavailable.` }
          : {}),
    };
  }
  if (policy.collection.kind === 'session-export') {
    const exported = context.sessionExports.get(adapter.id);
    return {
      provider: adapter.id,
      providerName: policy.coverageName || adapter.displayName,
      available: exported?.available === true,
      homeCount,
      sessionCount: exported?.sessionCount || 0,
      exportCount: exported?.exportCount || 0,
      partial: exported?.partial === true,
      source: policy.source,
      ...(exported?.reason ? { reason: exported.reason } : {}),
    };
  }
  return {
    provider: adapter.id,
    providerName: policy.coverageName || adapter.displayName,
    available: false,
    homeCount,
    source: policy.coverageSource || policy.source,
    reason: policy.tokenUnavailableReason || `${adapter.displayName} usage telemetry is unavailable.`,
  };
}

async function collectUsageHistory(options: CollectionOptions = {}) {
  const now = options.now ?? Date.now();
  const days = options.days ?? USAGE_DAILY_DAYS;
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);
  const homePaths = usageProviderHomePaths(options);
  const exportAdapters = listProviderAdapters().filter(adapter => (
    adapter.usage.collection.kind === 'session-export'
  ));
  const [ccStatistics, sessionExportEntries] = await Promise.all([
    collectCCStatistics({ ...options, now, days }),
    Promise.all(exportAdapters.map(async adapter => {
      if (adapter.usage.collection.kind !== 'session-export') {
        throw new Error(`Invalid usage export adapter: ${adapter.id}`);
      }
      const collector = sessionUsageExportCollector(adapter.usage.collection.collector);
      return [
        adapter.id,
        await collector(homePaths.get(adapter.id) || [], {
          now,
          cutoffMs: cutoff.getTime(),
          openCodeCommandRunner: options.openCodeCommandRunner,
        }),
      ] as const;
    })),
  ]);
  const sessionExports = new Map<ProviderId, SessionExportResult>(sessionExportEntries);
  const providerEvents: ProviderEvents = {};
  for (const adapter of listProviderAdapters()) {
    if (adapter.usage.collection.kind === 'local-history') {
      providerEvents[adapter.id] = ccStatisticsProviderEvents(ccStatistics.result, adapter.id);
    } else if (adapter.usage.collection.kind === 'session-export') {
      providerEvents[adapter.id] = sessionExports.get(adapter.id)?.events || [];
    }
  }
  const coverage = listProviderAdapters().map(adapter => providerUsageCoverage(adapter, {
    homePaths,
    localHistory: ccStatistics.result,
    sessionExports,
  }));
  const coverageByProvider = new Map(coverage.map(entry => [entry.provider, entry]));
  const partial = listProviderAdapters().some(adapter => {
    const providerCoverage = coverageByProvider.get(adapter.id);
    return adapter.usage.collection.kind === 'local-history'
      ? providerCoverage?.available !== true
      : adapter.usage.collection.kind === 'session-export' && providerCoverage?.partial === true;
  });
  return {
    daily: {
      ...buildDailyUsage(providerEvents, { now, days }),
      partial,
      syncing: ccStatistics.result.cache?.scan_complete === false,
      coverage,
      ccStatisticsCache: ccStatistics.result.cache,
    },
    providerEvents,
    coverage,
  };
}

async function collectDailyUsage(options: CollectionOptions = {}) {
  return (await collectUsageHistory(options)).daily;
}

function parseCodexLimit(limit: unknown) {
  if (!limit || typeof limit !== 'object') return null;
  const source = limit as DataRecord;
  const usedPercent = numberOrNull(source.used_percent ?? source.usedPercent);
  const windowMinutes = numberOrNull(source.window_minutes ?? source.windowMinutes ?? source.windowDurationMins);
  const resetsAt = normalizeEpochMs(source.resets_at ?? source.resetsAt);
  const totalTokens = numberOrNull(source.total_tokens ?? source.totalTokens ?? source.limit_tokens ?? source.limitTokens);

  if (usedPercent === null && windowMinutes === null && resetsAt === null && totalTokens === null) return null;
  return {
    usedPercent,
    windowMinutes,
    resetsAt,
    totalTokens,
  };
}

function parseCodexRateLimits(rateLimits: unknown) {
  if (!rateLimits || typeof rateLimits !== 'object') return null;
  const source = rateLimits as DataRecord;
  const primary = parseCodexLimit(source.primary);
  const secondary = parseCodexLimit(source.secondary);

  if (!primary && !secondary) return null;
  const resetCredits = asRecord(source.rate_limit_reset_credits ?? source.rateLimitResetCredits);
  const resetCreditsAvailable = numberOrNull(resetCredits?.available_count ?? resetCredits?.availableCount);
  return {
    available: true,
    source: 'codex token_count events',
    limitId: source.limit_id || source.limitId || '',
    limitName: source.limit_name ?? source.limitName ?? null,
    planType: source.plan_type || source.planType || '',
    resetCreditsAvailable,
    primary,
    secondary,
  };
}

function isCodexOverallRateLimit(quota: { limitId?: unknown } | null | undefined): boolean {
  const limitId = String(quota?.limitId || '').trim().toLowerCase();
  return !limitId || limitId === 'codex';
}

async function collectCodexUsage(options: CollectionOptions = {}) {
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
  let latestQuota: ReturnType<typeof parseCodexRateLimits> = null;
  let latestQuotaAt = 0;
  let latestOverallQuota: ReturnType<typeof parseCodexRateLimits> = null;
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

async function collectClaudeUsage(options: CollectionOptions = {}) {
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

interface LiveProviderUsageCollector {
  collect(options: CollectionOptions): Promise<{ quota: unknown; tokenUsage: unknown }>;
  readAuth(commandRunner: CommandRunner): Promise<unknown>;
}

const LIVE_PROVIDER_USAGE_COLLECTORS: Readonly<
  Record<ProviderUsageLiveCollector, LiveProviderUsageCollector>
> = Object.freeze({
  'codex-cli': Object.freeze({
    collect: collectCodexUsage,
    readAuth: readCodexAuthStatus,
  }),
  'claude-cli': Object.freeze({
    collect: collectClaudeUsage,
    readAuth: readClaudeAuthStatus,
  }),
});

function liveProviderUsageCollector(
  id: ProviderUsageLiveCollector,
): LiveProviderUsageCollector {
  return LIVE_PROVIDER_USAGE_COLLECTORS[id];
}

type CollectedUsageHistory = Awaited<ReturnType<typeof collectUsageHistory>>;
type UsageDayDetail = ReturnType<typeof buildUsageDayDetail>;

interface DailyUsageCache {
  value: CollectedUsageHistory | null;
  fetchedAt: number;
  pending: Promise<CollectedUsageHistory> | null;
}

interface LiveDayCache {
  date: string;
  value: UsageDayDetail | null;
  fetchedAt: number;
  pending: Promise<UsageDayDetail> | null;
}

interface ProviderUsageObservation {
  auth: unknown;
  quota: unknown;
  tokenUsage: unknown;
}

function providerUsageSummary(
  adapter: UsageProviderAdapter,
  context: {
    coverage: UsageProviderCoverage | undefined;
    events: UsageEvent[];
    historyWindowMs: number;
    now: number;
    observation: ProviderUsageObservation | undefined;
    windowMs: number;
  },
): DataRecord {
  if (context.observation) {
    return {
      provider: adapter.id,
      providerName: adapter.displayName,
      ...context.observation,
    };
  }

  const policy = adapter.usage;
  const reason = context.coverage?.reason
    || policy.tokenUnavailableReason
    || `${adapter.displayName} usage telemetry is unavailable.`;
  if (policy.collection.kind === 'session-export') {
    const usage = providerUsageFromEvents(context.events, {
      now: context.now,
      windowMs: context.windowMs,
      historyWindowMs: context.historyWindowMs,
      source: policy.source,
    });
    return {
      provider: adapter.id,
      providerName: adapter.displayName,
      auth: {
        available: context.coverage?.available === true,
        status: context.coverage?.available === true
          ? policy.authStatus || 'Local session export'
          : reason,
        source: policy.source,
      },
      quota: {
        available: false,
        source: policy.source,
        reason: policy.quotaUnavailableReason || reason,
      },
      tokenUsage: context.coverage?.available === true
        ? usage.tokenUsage
        : { ...usage.tokenUsage, available: false, reason },
    };
  }

  return {
    provider: adapter.id,
    providerName: adapter.displayName,
    auth: {
      available: true,
      status: policy.authStatus || 'Local sessions',
      source: policy.source,
    },
    quota: {
      available: false,
      source: policy.source,
      reason,
    },
    tokenUsage: {
      available: false,
      windowMs: context.windowMs,
      source: policy.source,
      totalTokens: null,
      tokensPerMinute: null,
      eventCount: 0,
      sampledAt: context.now,
      reason,
    },
  };
}

class UsageMonitor {
  agentManager: AgentManagerLike | null;
  systemMonitor: SystemMonitorLike | null;
  commandRunner: CommandRunner;
  codexHome: string | undefined;
  claudeHome: string | undefined;
  openCodeHome: string | undefined;
  qoderHome: string | undefined;
  getProviderHomes: (() => ProviderHomes) | null;
  openCodeCommandRunner: OpenCodeCommandRunner | undefined;
  configDir: string;
  ccStatisticsClient: UsageHistoryClientLike;
  windowMs: number;
  dailyDays: number;
  dailyCacheMs: number;
  dailyCache: DailyUsageCache;
  liveDayCacheMs: number;
  liveDayCache: LiveDayCache;
  foregroundScanBudgetMs: number;

  constructor(options: UsageMonitorOptions = {}) {
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
    this.foregroundScanBudgetMs = options.scanBudgetMs ?? USAGE_FOREGROUND_SCAN_BUDGET_MS;
  }

  invalidateDailyCache(): void {
    this.dailyCache.fetchedAt = 0;
    this.liveDayCache.fetchedAt = 0;
  }

  usageAgentLabels(): Map<string, string> {
    const labels = new Map<string, string>();
    const agents = this.agentManager?.getState?.().agents;
    if (!Array.isArray(agents)) return labels;
    for (const agentValue of agents) {
      const agent = asRecord(agentValue);
      const provider = String(agent?.providerSessionProvider || '').trim();
      const sessionId = String(agent?.providerSessionId || '').trim();
      if (!provider || !sessionId) continue;
      const label = String(
        agent?.customTitle
        || agent?.task
        || agent?.sessionTitle
        || agent?.providerSessionTitle
        || '',
      ).trim();
      if (label) labels.set(`${provider}:${sessionId}`, label);
    }
    return labels;
  }

  buildUsageDay(providerEvents: ProviderEvents, date: unknown): UsageDayDetail {
    return buildUsageDayDetail(providerEvents, {
      date,
      agentLabels: this.usageAgentLabels(),
    });
  }

  getDailyUsage(options: UsageReadOptions = {}): Promise<CollectedUsageHistory> {
    const now = options.now ?? Date.now();
    if (
      !options.force
      && this.dailyCache.value
      && this.dailyCache.value.daily.syncing !== true
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
      scanBudgetMs: this.foregroundScanBudgetMs,
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

  async getUsageDay(date: unknown, options: UsageReadOptions = {}): Promise<UsageDayDetail> {
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
      const historySyncing = this.dailyCache.value?.daily?.syncing === true;
      const recoverWithFallback = (error: unknown): UsageDayDetail => {
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
        return options.fresh !== true && historySyncing && fallback
          ? fallback
          : options.fresh === true
            ? this.liveDayCache.pending
            : this.liveDayCache.pending.catch(recoverWithFallback);
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
        scanBudgetMs: this.foregroundScanBudgetMs,
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
      void pending.catch(() => {});
      if (options.fresh !== true && historySyncing && fallback) return fallback;
      return options.fresh === true ? pending : pending.catch(recoverWithFallback);
    }
    const history = await this.getDailyUsage({
      now,
      force: options.fresh === true,
    });
    return this.buildUsageDay(history.providerEvents, date);
  }

  async getUsageSummary(options: UsageReadOptions = {}) {
    const now = options.now ?? Date.now();
    const windowMs = options.windowMs ?? this.windowMs;
    const historyWindowMs = options.historyWindowMs ?? USAGE_TIMELINE_WINDOW_MS;

    const providerHomes = this.getProviderHomes ? this.getProviderHomes() : undefined;
    const liveUsageOptions: CollectionOptions = {
      codexHome: this.codexHome,
      claudeHome: this.claudeHome,
      providerHomes,
      configDir: this.configDir,
      ccStatisticsClient: this.ccStatisticsClient,
      scanBudgetMs: this.foregroundScanBudgetMs,
      now,
      windowMs,
      historyWindowMs,
    };
    const liveAdapters = listProviderAdapters().filter(adapter => adapter.usage.liveCollector);
    const [observationEntries, history, systemStats] = await Promise.all([
      Promise.all(liveAdapters.map(async adapter => {
        const collectorId = adapter.usage.liveCollector;
        if (!collectorId) throw new Error(`Missing live usage collector policy: ${adapter.id}`);
        const collector = liveProviderUsageCollector(collectorId);
        const [auth, usage] = await Promise.all([
          collector.readAuth(this.commandRunner),
          collector.collect(liveUsageOptions),
        ]);
        return [adapter.id, {
          auth,
          quota: usage.quota,
          tokenUsage: usage.tokenUsage,
        }] as const;
      })),
      this.getDailyUsage({ now, force: options.fresh === true }),
      this.systemMonitor?.getSystemStats ? this.systemMonitor.getSystemStats().catch(() => null) : Promise.resolve(null),
    ]);

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
    const observations = new Map<string, ProviderUsageObservation>(observationEntries);
    const coverageByProvider = new Map(
      history.coverage.map(entry => [entry.provider, entry]),
    );
    const providers = listProviderAdapters().map(adapter => providerUsageSummary(adapter, {
      coverage: coverageByProvider.get(adapter.id),
      events: history.providerEvents[adapter.id] || [],
      historyWindowMs,
      now,
      observation: observations.get(adapter.id),
      windowMs,
    }));

    return {
      sampledAt: now,
      windowMs,
      timeline,
      liveTimeline,
      daily: history.daily,
      providers,
      agentUsage: this.agentManager?.getAgentUsageSnapshots
        ? this.agentManager.getAgentUsageSnapshots({ now, windowMs })
        : null,
      systemStats,
    };
  }
}

export {
  USAGE_WINDOW_MS,
  USAGE_TIMELINE_WINDOW_MS,
  USAGE_TIMELINE_BUCKET_COUNT,
  USAGE_LIVE_TIMELINE_WINDOW_MS,
  USAGE_LIVE_TIMELINE_BUCKET_COUNT,
  USAGE_DAILY_DAYS,
  USAGE_DAILY_CACHE_MS,
  USAGE_LIVE_DAY_CACHE_MS,
  USAGE_FOREGROUND_SCAN_BUDGET_MS,
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
