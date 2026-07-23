/**
 * Persistent local token-history scanner for Farming.
 *
 * Codex cumulative-counter accounting is a TypeScript adaptation of CodexBar
 * v0.45.2 (commit 91560ca98e776b96fdf910d4a0423c2f0c07a3b9), specifically
 * CostUsageScanner.swift and CodexSubagentRolloutShape.swift. CodexBar is MIT
 * licensed, Copyright (c) 2026 Peter Steinberger. See THIRD_PARTY_NOTICES.md.
 *
 * Claude message parsing follows the usage/message-id normalization semantics
 * of cc-statistics 1.1.0 (commit c98be0af52bbc7f09a1f277747744ace48d9e014),
 * also MIT licensed. Farming owns the filesystem checkpoints, SQLite schema,
 * scan budgeting, and browser-facing result shape.
 *
 * This module intentionally uses only Node built-ins. It runs in a Worker so
 * synchronous SQLite and filesystem operations cannot block Farming's server.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA_VERSION = 11;
const SOURCE_VERSION = 'farming-usage-ts-1-codexbar-v0.45.2';
const PREFIX_BYTES = 64 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const TRUNCATED_EDGE_BYTES = 512 * 1024;
const DEFAULT_RETENTION_DAYS = 52 * 7;
const DEFAULT_RECENT_RAW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_BUDGET_MS = 5_000;
const SEEN_TOTALS_LIMIT = 64;
const DIRECTORY_AUDIT_BATCH = 256;
const DIRECTORY_ENTRY_BATCH = 256;
const SOURCE_AUDIT_BATCH = 128;

type Provider = 'codex' | 'claude';
type Totals = {
  input: number;
  cached: number;
  output: number;
  cacheWrite: number;
};
type UsageEvent = {
  timestamp: number;
  sessionId: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unattributedTokens: number;
};
type CodexState = {
  sessionId: string;
  leafSessionId: string | null;
  parentSessionId: string | null;
  forkTimestamp: number | null;
  projectPath: string;
  lastAssistantTimestamp: number | null;
  copiedPrefix: boolean;
  isSubagent: boolean;
  ownBoundarySeen: boolean;
  pendingOwnedBoundary: boolean;
  inheritedRaw: Totals | null;
  counted: Totals | null;
  rawBaseline: Totals | null;
  watermark: Totals | null;
  seenRawTotals: Totals[];
  divergent: boolean;
  interleaved: boolean;
  skippedUnresolvedForkTotal: boolean;
  quotas: Record<string, { timestamp: number | null; rateLimits: unknown }>;
};
type ClaudeState = {
  sessionId: string;
  projectPath: string;
};
type ParserState = CodexState | ClaudeState;
type SourceCandidate = {
  provider: Provider;
  filePath: string;
  stat: fs.Stats;
  sessionId: string;
  parentSessionId: string | null;
  forkTimestamp: number | null;
  copiedPrefix: boolean;
  parentBaseline: Totals | null;
};
type Metrics = Record<string, number | boolean | Record<Provider, number>>;
type CollectRequest = {
  cacheFile: string;
  legacyCacheFile?: string;
  nowMs?: number;
  retentionDays?: number;
  recentRawMs?: number;
  scanBudgetMs?: number;
  roots?: Partial<Record<Provider, string[]>>;
};

const ZERO: Totals = { input: 0, cached: 0, output: 0, cacheWrite: 0 };
const TOKEN_FIELDS = ['input', 'cached', 'output', 'cacheWrite'] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS source_files (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  directory_path TEXT NOT NULL,
  directory_generation INTEGER NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  committed_offset INTEGER NOT NULL,
  file_dev INTEGER NOT NULL,
  file_ino INTEGER NOT NULL,
  prefix_sha256 TEXT NOT NULL,
  suffix_sha256 TEXT NOT NULL,
  parser_state TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scan_complete INTEGER NOT NULL,
  last_checked_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS source_files_provider_session
  ON source_files(provider, session_id);
CREATE INDEX IF NOT EXISTS source_files_directory
  ON source_files(directory_path);
CREATE INDEX IF NOT EXISTS source_files_audit
  ON source_files(last_checked_ms, mtime_ms);
CREATE INDEX IF NOT EXISTS source_files_recent
  ON source_files(mtime_ms DESC);
CREATE INDEX IF NOT EXISTS source_files_directory_generation
  ON source_files(directory_path, directory_generation);
CREATE TABLE IF NOT EXISTS discovery_directories (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  root_path TEXT NOT NULL,
  parent_path TEXT NOT NULL,
  is_root INTEGER NOT NULL,
  present INTEGER NOT NULL,
  pending INTEGER NOT NULL,
  scan_generation INTEGER NOT NULL,
  parent_generation INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  file_dev INTEGER NOT NULL,
  file_ino INTEGER NOT NULL,
  last_checked_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_directories_pending
  ON discovery_directories(present, pending, is_root DESC, last_checked_ms);
CREATE INDEX IF NOT EXISTS discovery_directories_audit
  ON discovery_directories(present, is_root DESC, last_checked_ms);
CREATE INDEX IF NOT EXISTS discovery_directories_parent_generation
  ON discovery_directories(parent_path, present, parent_generation);
CREATE TABLE IF NOT EXISTS discovery_source_queue (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  priority REAL NOT NULL,
  queued_at_ms INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS discovery_source_queue_priority
  ON discovery_source_queue(action, priority, queued_at_ms);
CREATE TABLE IF NOT EXISTS codex_quota_candidates (
  source_path TEXT NOT NULL,
  limit_id TEXT NOT NULL,
  timestamp_ms INTEGER,
  rate_limits_json TEXT NOT NULL,
  PRIMARY KEY(source_path, limit_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS codex_quota_candidates_latest
  ON codex_quota_candidates(timestamp_ms DESC);
CREATE TABLE IF NOT EXISTS cache_stats (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  codex_files INTEGER NOT NULL,
  claude_files INTEGER NOT NULL,
  codex_incomplete INTEGER NOT NULL,
  claude_incomplete INTEGER NOT NULL,
  committed_bytes INTEGER NOT NULL,
  hourly_rows INTEGER NOT NULL,
  recent_rows INTEGER NOT NULL,
  dedupe_rows INTEGER NOT NULL,
  pending_directories INTEGER NOT NULL,
  queued_sources INTEGER NOT NULL
);
INSERT OR IGNORE INTO cache_stats VALUES(1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
CREATE TABLE IF NOT EXISTS usage_hourly (
  source_path TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  bucket_start_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY(source_path, provider, session_id, bucket_start_ms),
  FOREIGN KEY(source_path) REFERENCES source_files(path) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_hourly_provider_time
  ON usage_hourly(provider, bucket_start_ms);
CREATE TABLE IF NOT EXISTS usage_provider_hourly (
  provider TEXT NOT NULL,
  bucket_start_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  PRIMARY KEY(provider, bucket_start_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS recent_events (
  source_path TEXT NOT NULL,
  event_key TEXT NOT NULL,
  provider TEXT NOT NULL,
  session_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY(source_path, event_key),
  FOREIGN KEY(source_path) REFERENCES source_files(path) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recent_events_provider_time
  ON recent_events(provider, timestamp_ms);
CREATE TABLE IF NOT EXISTS claude_messages (
  owner_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY(owner_session_id, message_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS claude_messages_time
  ON claude_messages(timestamp_ms);
CREATE TRIGGER IF NOT EXISTS source_files_stats_insert
AFTER INSERT ON source_files BEGIN
  UPDATE cache_stats SET
    codex_files = codex_files + (NEW.provider = 'codex'),
    claude_files = claude_files + (NEW.provider = 'claude'),
    codex_incomplete = codex_incomplete + (NEW.provider = 'codex' AND NEW.scan_complete = 0),
    claude_incomplete = claude_incomplete + (NEW.provider = 'claude' AND NEW.scan_complete = 0),
    committed_bytes = committed_bytes + NEW.committed_offset
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS source_files_stats_delete
AFTER DELETE ON source_files BEGIN
  UPDATE cache_stats SET
    codex_files = codex_files - (OLD.provider = 'codex'),
    claude_files = claude_files - (OLD.provider = 'claude'),
    codex_incomplete = codex_incomplete - (OLD.provider = 'codex' AND OLD.scan_complete = 0),
    claude_incomplete = claude_incomplete - (OLD.provider = 'claude' AND OLD.scan_complete = 0),
    committed_bytes = committed_bytes - OLD.committed_offset
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS source_files_stats_update
AFTER UPDATE OF provider, scan_complete, committed_offset ON source_files BEGIN
  UPDATE cache_stats SET
    codex_files = codex_files - (OLD.provider = 'codex') + (NEW.provider = 'codex'),
    claude_files = claude_files - (OLD.provider = 'claude') + (NEW.provider = 'claude'),
    codex_incomplete = codex_incomplete
      - (OLD.provider = 'codex' AND OLD.scan_complete = 0)
      + (NEW.provider = 'codex' AND NEW.scan_complete = 0),
    claude_incomplete = claude_incomplete
      - (OLD.provider = 'claude' AND OLD.scan_complete = 0)
      + (NEW.provider = 'claude' AND NEW.scan_complete = 0),
    committed_bytes = committed_bytes - OLD.committed_offset + NEW.committed_offset
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS usage_hourly_stats_insert
AFTER INSERT ON usage_hourly BEGIN
  UPDATE cache_stats SET hourly_rows = hourly_rows + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS usage_hourly_stats_delete
AFTER DELETE ON usage_hourly BEGIN
  UPDATE cache_stats SET hourly_rows = hourly_rows - 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS recent_events_stats_insert
AFTER INSERT ON recent_events BEGIN
  UPDATE cache_stats SET recent_rows = recent_rows + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS recent_events_stats_delete
AFTER DELETE ON recent_events BEGIN
  UPDATE cache_stats SET recent_rows = recent_rows - 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS claude_messages_stats_insert
AFTER INSERT ON claude_messages BEGIN
  UPDATE cache_stats SET dedupe_rows = dedupe_rows + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS claude_messages_stats_delete
AFTER DELETE ON claude_messages BEGIN
  UPDATE cache_stats SET dedupe_rows = dedupe_rows - 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS discovery_directories_stats_insert
AFTER INSERT ON discovery_directories WHEN NEW.present = 1 AND NEW.pending = 1 BEGIN
  UPDATE cache_stats SET pending_directories = pending_directories + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS discovery_directories_stats_delete
AFTER DELETE ON discovery_directories WHEN OLD.present = 1 AND OLD.pending = 1 BEGIN
  UPDATE cache_stats SET pending_directories = pending_directories - 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS discovery_directories_stats_update
AFTER UPDATE OF present, pending ON discovery_directories
WHEN (OLD.present = 1 AND OLD.pending = 1) != (NEW.present = 1 AND NEW.pending = 1)
BEGIN
  UPDATE cache_stats SET pending_directories = pending_directories
    - (OLD.present = 1 AND OLD.pending = 1)
    + (NEW.present = 1 AND NEW.pending = 1)
  WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS discovery_source_queue_stats_insert
AFTER INSERT ON discovery_source_queue BEGIN
  UPDATE cache_stats SET queued_sources = queued_sources + 1 WHERE singleton = 1;
END;
CREATE TRIGGER IF NOT EXISTS discovery_source_queue_stats_delete
AFTER DELETE ON discovery_source_queue BEGIN
  UPDATE cache_stats SET queued_sources = queued_sources - 1 WHERE singleton = 1;
END;
`;

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value < 10_000_000_000 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || !value) return null;
  if (/^\d+$/.test(value)) return timestampMs(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cloneTotals(value: Totals | null | undefined): Totals | null {
  return value ? { ...value } : null;
}

function addTotals(left: Totals | null, right: Totals): Totals {
  const base = left || ZERO;
  return {
    input: base.input + right.input,
    cached: base.cached + right.cached,
    output: base.output + right.output,
    cacheWrite: base.cacheWrite + right.cacheWrite,
  };
}

function minTotals(left: Totals, right: Totals): Totals {
  return {
    input: Math.min(left.input, right.input),
    cached: Math.min(left.cached, right.cached),
    output: Math.min(left.output, right.output),
    cacheWrite: Math.min(left.cacheWrite, right.cacheWrite),
  };
}

function maxTotals(left: Totals | null, right: Totals): Totals {
  if (!left) return { ...right };
  return {
    input: Math.max(left.input, right.input),
    cached: Math.max(left.cached, right.cached),
    output: Math.max(left.output, right.output),
    cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
  };
}

function subtractTotals(current: Totals, baseline: Totals | null): Totals {
  const base = baseline || ZERO;
  return {
    input: Math.max(0, current.input - base.input),
    cached: Math.max(0, current.cached - base.cached),
    output: Math.max(0, current.output - base.output),
    cacheWrite: Math.max(0, current.cacheWrite - base.cacheWrite),
  };
}

function totalsEqual(left: Totals | null, right: Totals | null): boolean {
  if (!left || !right) return left === right;
  return TOKEN_FIELDS.every(field => left[field] === right[field]);
}

function totalsAtLeast(left: Totals, right: Totals): boolean {
  return TOKEN_FIELDS.every(field => left[field] >= right[field]);
}

function totalsAtMost(left: Totals, right: Totals): boolean {
  return TOKEN_FIELDS.every(field => left[field] <= right[field]);
}

function hasUsage(value: Totals | null): value is Totals {
  return Boolean(value && TOKEN_FIELDS.some(field => value[field] > 0));
}

function localHourMs(value: number): number {
  const date = new Date(value);
  date.setMinutes(0, 0, 0);
  return date.getTime();
}

function removeDatabaseFiles(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${filePath}${suffix}`, { force: true });
    } catch (error) {
      if (suffix === '') throw error;
    }
  }
}

function databaseCompatible(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return true;
  try {
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).all() as Array<{ name: string }>;
      if (tables.length === 0) return true;
      const schema = database.prepare(
        "SELECT value FROM metadata WHERE key = 'schema_version'",
      ).get() as { value?: string } | undefined;
      const source = database.prepare(
        "SELECT value FROM metadata WHERE key = 'source_version'",
      ).get() as { value?: string } | undefined;
      const names = new Set(tables.map(row => row.name));
      const triggers = new Set((database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger'",
      ).all() as Array<{ name: string }>).map(row => row.name));
      const stats = database.prepare(
        'SELECT singleton FROM cache_stats WHERE singleton = 1',
      ).get() as { singleton?: number } | undefined;
      return schema?.value === String(SCHEMA_VERSION)
        && source?.value === SOURCE_VERSION
        && [
          'source_files',
          'usage_hourly',
          'usage_provider_hourly',
          'recent_events',
          'claude_messages',
          'discovery_directories',
          'discovery_source_queue',
          'codex_quota_candidates',
          'cache_stats',
        ]
          .every(name => names.has(name))
        && [
          'source_files_stats_insert',
          'source_files_stats_delete',
          'source_files_stats_update',
          'usage_hourly_stats_insert',
          'usage_hourly_stats_delete',
          'recent_events_stats_insert',
          'recent_events_stats_delete',
          'claude_messages_stats_insert',
          'claude_messages_stats_delete',
          'discovery_directories_stats_insert',
          'discovery_directories_stats_delete',
          'discovery_directories_stats_update',
          'discovery_source_queue_stats_insert',
          'discovery_source_queue_stats_delete',
        ].every(name => triggers.has(name))
        && stats?.singleton === 1;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

function openDatabase(filePath: string): { database: DatabaseSync; rebuilt: boolean } {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const compatible = databaseCompatible(filePath);
  if (!compatible) {
    closeCacheDirectoryCursors(filePath);
    removeDatabaseFiles(filePath);
  }
  const database = new DatabaseSync(filePath);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('PRAGMA busy_timeout=30000');
  database.exec(SCHEMA_SQL);
  database.prepare(
    "INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', ?)",
  ).run(String(SCHEMA_VERSION));
  database.prepare(
    "INSERT OR REPLACE INTO metadata(key, value) VALUES('source_version', ?)",
  ).run(SOURCE_VERSION);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return { database, rebuilt: !compatible };
}

function prefixHash(filePath: string, size?: number): string {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const lengthLimit = Math.min(PREFIX_BYTES, size ?? PREFIX_BYTES);
    const buffer = Buffer.allocUnsafe(lengthLimit);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return crypto.createHash('sha256').update(buffer.subarray(0, length)).digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function suffixHash(filePath: string, size?: number): string {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const fileSize = size ?? fs.fstatSync(descriptor).size;
    const length = Math.min(fileSize, PREFIX_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const read = fs.readSync(
      descriptor,
      buffer,
      0,
      length,
      Math.max(0, fileSize - length),
    );
    return crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

function claudeOwnerSession(filePath: string): string {
  const parent = path.dirname(filePath);
  if (path.basename(parent) === 'subagents') {
    return path.basename(path.dirname(parent));
  }
  return path.basename(filePath, '.jsonl');
}

function defaultState(provider: Provider, filePath: string): ParserState {
  if (provider === 'claude') {
    return {
      sessionId: claudeOwnerSession(filePath),
      projectPath: '',
    };
  }
  return {
    sessionId: path.basename(filePath, '.jsonl'),
    leafSessionId: null,
    parentSessionId: null,
    forkTimestamp: null,
    projectPath: '',
    lastAssistantTimestamp: null,
    copiedPrefix: false,
    isSubagent: false,
    ownBoundarySeen: false,
    pendingOwnedBoundary: false,
    inheritedRaw: null,
    counted: null,
    rawBaseline: null,
    watermark: null,
    seenRawTotals: [],
    divergent: false,
    interleaved: false,
    skippedUnresolvedForkTotal: false,
    quotas: {},
  };
}

function normalizedCodexTotals(value: unknown): Totals | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const cached = integer(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const rawInput = integer(usage.input_tokens);
  const result = {
    // Codex input_tokens includes cached_input_tokens. Farming displays the
    // mutually-exclusive breakdown while retaining CodexBar's cumulative math.
    input: Math.max(0, rawInput - cached),
    cached,
    output: integer(usage.output_tokens),
    cacheWrite: integer(usage.cache_creation_input_tokens),
  };
  return hasUsage(result) ? result : null;
}

function claudeTotals(value: unknown): Totals | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const result = {
    input: integer(usage.input_tokens),
    cached: integer(usage.cache_read_input_tokens),
    output: integer(usage.output_tokens),
    cacheWrite: integer(usage.cache_creation_input_tokens),
  };
  return hasUsage(result) ? result : null;
}

function parseLargeJsonEdge(first: Buffer, tail: Buffer): Record<string, unknown> | null {
  const text = `${first.toString('utf8')}\n${tail.toString('utf8')}`;
  const timestamp = /"timestamp"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  const topType = /"type"\s*:\s*"(assistant|event_msg|session_meta|response_item|turn_context)"/
    .exec(text)?.[1];
  if (!topType) return null;
  if (topType === 'assistant') {
    const sessionId = /"sessionId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    const messageId = /"id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    // Claude serializes the canonical message.usage after message.content.
    // Nested tool input may itself contain a usage object, so the last retained
    // occurrence is the only safe edge candidate for an oversized row.
    const usageStart = text.lastIndexOf('"usage"');
    const usageText = usageStart >= 0 ? text.slice(usageStart, usageStart + 2048) : '';
    return {
      type: 'assistant',
      timestamp,
      sessionId,
      message: {
        id: messageId,
        usage: {
          input_tokens: integer(/"input_tokens"\s*:\s*(\d+)/.exec(usageText)?.[1]),
          output_tokens: integer(/"output_tokens"\s*:\s*(\d+)/.exec(usageText)?.[1]),
          cache_read_input_tokens: integer(
            /"cache_read_input_tokens"\s*:\s*(\d+)/.exec(usageText)?.[1],
          ),
          cache_creation_input_tokens: integer(
            /"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(usageText)?.[1],
          ),
        },
      },
    };
  }
  if (
    topType !== 'event_msg'
    || !/"payload"\s*:\s*\{\s*"type"\s*:\s*"token_count"/.test(text)
  ) {
    return null;
  }
  const totalStart = text.indexOf('"total_token_usage"');
  const lastStart = text.indexOf('"last_token_usage"');
  const totalsText = totalStart >= 0 ? text.slice(totalStart, totalStart + 1024) : '';
  const lastText = lastStart >= 0 ? text.slice(lastStart, lastStart + 1024) : '';
  const fields = (source: string) => ({
    input_tokens: integer(/"input_tokens"\s*:\s*(\d+)/.exec(source)?.[1]),
    cached_input_tokens: integer(/"cached_input_tokens"\s*:\s*(\d+)/.exec(source)?.[1]),
    output_tokens: integer(/"output_tokens"\s*:\s*(\d+)/.exec(source)?.[1]),
  });
  return {
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: fields(totalsText),
        last_token_usage: fields(lastText),
      },
    },
  };
}

function interesting(provider: Provider, buffer: Buffer): boolean {
  if (provider === 'claude') return buffer.includes(Buffer.from('"assistant"'));
  return [
    '"session_meta"',
    '"token_count"',
    '"agent_message"',
    '"response_item"',
    '"turn_context"',
    '"task_started"',
    '"inter_agent_communication_metadata"',
  ].some(marker => buffer.includes(Buffer.from(marker)));
}

function parseRecord(
  provider: Provider,
  fullLine: Buffer | null,
  first: Buffer,
  tail: Buffer,
): Record<string, unknown> | null {
  const searchable = fullLine || Buffer.concat([first, tail]);
  if (!interesting(provider, searchable)) return null;
  if (fullLine) {
    try {
      const parsed = JSON.parse(fullLine.toString('utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return parseLargeJsonEdge(first, tail);
}

function divergentDelta(
  rawBaseline: Totals | null,
  countedBaseline: Totals | null,
  current: Totals,
): Totals {
  const raw = rawBaseline || ZERO;
  const counted = countedBaseline || ZERO;
  const component = (rawValue: number, countedValue: number, currentValue: number) => (
    currentValue >= rawValue
      ? Math.max(0, currentValue - rawValue)
      : Math.max(0, currentValue - countedValue)
  );
  return {
    input: component(raw.input, counted.input, current.input),
    cached: component(raw.cached, counted.cached, current.cached),
    output: component(raw.output, counted.output, current.output),
    cacheWrite: component(raw.cacheWrite, counted.cacheWrite, current.cacheWrite),
  };
}

function containedDelta(
  watermark: Totals | null,
  counted: Totals | null,
  current: Totals,
): Totals {
  const water = watermark || ZERO;
  const base = counted || ZERO;
  const component = (waterValue: number, countedValue: number, currentValue: number) => (
    currentValue >= waterValue
      ? Math.max(0, currentValue - Math.max(waterValue, countedValue))
      : Math.max(0, currentValue - countedValue)
  );
  return {
    input: component(water.input, base.input, current.input),
    cached: component(water.cached, base.cached, current.cached),
    output: component(water.output, base.output, current.output),
    cacheWrite: component(water.cacheWrite, base.cacheWrite, current.cacheWrite),
  };
}

/**
 * CodexBar's cumulative-counter reducer. The monotonic watermark is the
 * load-bearing protection against Ultra-mode high/low lineage flips; the
 * bounded exact-value set is only an optimization for repeated telemetry.
 */
function applyCodexTotals(
  state: CodexState,
  last: Totals | null,
  total: Totals | null,
): Totals | null {
  if (total && state.seenRawTotals.some(value => totalsEqual(value, total))) {
    return null;
  }
  if (total && state.watermark && TOKEN_FIELDS.some(
    field => total[field] < state.watermark![field],
  )) {
    state.interleaved = true;
  }
  const watermarkBaseline = state.watermark || state.rawBaseline;
  let delta: Totals | null = null;
  if (last) {
    delta = last;
    if (total) {
      if (state.interleaved) {
        delta = minTotals(last, containedDelta(watermarkBaseline, state.counted, total));
      } else {
        const totalDelta = subtractTotals(total, watermarkBaseline);
        if (
          !state.divergent
          && totalsAtLeast(total, watermarkBaseline || ZERO)
          && totalsAtMost(totalDelta, last)
        ) {
          delta = totalDelta;
        }
      }
      state.counted = addTotals(state.counted, delta);
      state.rawBaseline = { ...total };
      if (!totalsEqual(state.rawBaseline, state.counted)) state.divergent = true;
    } else {
      state.counted = addTotals(state.counted, delta);
      state.rawBaseline = cloneTotals(state.counted);
      state.watermark = maxTotals(state.watermark, state.counted!);
    }
  } else if (total) {
    delta = state.interleaved
      ? containedDelta(watermarkBaseline, state.counted, total)
      : state.divergent
        ? divergentDelta(watermarkBaseline, state.counted, total)
        : subtractTotals(total, watermarkBaseline);
    state.counted = addTotals(state.counted, delta);
    state.rawBaseline = { ...total };
    if (!totalsEqual(state.rawBaseline, state.counted)) state.divergent = true;
  }

  if (total) {
    state.watermark = maxTotals(state.watermark, total);
    if (!state.seenRawTotals.some(value => totalsEqual(value, total))) {
      state.seenRawTotals.push({ ...total });
      state.seenRawTotals = state.seenRawTotals.slice(-SEEN_TOTALS_LIMIT);
    }
  }
  return hasUsage(delta) ? delta : null;
}

function parseCodexMeta(record: Record<string, unknown>): {
  id: string | null;
  parentId: string | null;
  timestamp: number | null;
  cwd: string;
  isSubagent: boolean;
} | null {
  if (record.type !== 'session_meta') return null;
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : {};
  const source = payload.source && typeof payload.source === 'object'
    ? payload.source as Record<string, unknown>
    : {};
  const subagent = source.subagent && typeof source.subagent === 'object'
    ? source.subagent as Record<string, unknown>
    : {};
  const spawn = subagent.thread_spawn && typeof subagent.thread_spawn === 'object'
    ? subagent.thread_spawn as Record<string, unknown>
    : {};
  const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : null;
  const explicitParent = typeof payload.forked_from_id === 'string'
    ? payload.forked_from_id.trim()
    : '';
  const spawnedParent = typeof spawn.parent_thread_id === 'string'
    ? spawn.parent_thread_id.trim()
    : '';
  return {
    id,
    parentId: explicitParent || spawnedParent || null,
    timestamp: timestampMs(payload.timestamp) || timestampMs(record.timestamp),
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
    isSubagent: Boolean(source.subagent),
  };
}

function updateCodexMetadata(state: CodexState, record: Record<string, unknown>): void {
  const metadata = parseCodexMeta(record);
  if (!metadata) return;
  if (!state.leafSessionId) {
    state.leafSessionId = metadata.id;
    if (metadata.id) state.sessionId = metadata.id;
    state.parentSessionId = metadata.parentId;
    state.forkTimestamp = metadata.timestamp;
    state.isSubagent = metadata.isSubagent;
    if (metadata.cwd) state.projectPath = metadata.cwd;
    return;
  }
  if (metadata.id && metadata.id !== state.leafSessionId) {
    state.copiedPrefix = true;
    state.ownBoundarySeen = false;
    state.pendingOwnedBoundary = false;
    if (!state.parentSessionId) state.parentSessionId = metadata.id;
    return;
  }
  if (!state.parentSessionId && metadata.parentId) {
    state.parentSessionId = metadata.parentId;
    state.forkTimestamp = metadata.timestamp || state.forkTimestamp;
  }
  if (!state.projectPath && metadata.cwd) state.projectPath = metadata.cwd;
}

function codexRecord(
  record: Record<string, unknown>,
  state: CodexState,
): { usage: Totals | null; timestamp: number | null; quota: unknown } {
  updateCodexMetadata(state, record);
  const recordTimestamp = timestampMs(record.timestamp);
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : {};
  if (
    record.type === 'event_msg'
    && payload.type === 'agent_message'
    && typeof payload.message === 'string'
  ) {
    state.pendingOwnedBoundary = false;
    state.lastAssistantTimestamp = recordTimestamp;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  if (record.type === 'response_item') {
    state.pendingOwnedBoundary = false;
    const visibleAssistant = payload.type === 'function_call'
      || payload.type === 'web_search_call'
      || (payload.type === 'message' && payload.role === 'assistant');
    if (visibleAssistant) state.lastAssistantTimestamp = recordTimestamp;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  if (record.type === 'turn_context') {
    if (state.copiedPrefix && state.isSubagent) state.pendingOwnedBoundary = true;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  if (payload.type === 'inter_agent_communication_metadata') {
    if (state.copiedPrefix && state.isSubagent && state.pendingOwnedBoundary) {
      state.ownBoundarySeen = true;
    }
    state.pendingOwnedBoundary = false;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  if (payload.type === 'task_started') {
    if (state.copiedPrefix && !state.isSubagent) state.ownBoundarySeen = true;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  if (record.type !== 'event_msg' || payload.type !== 'token_count') {
    state.pendingOwnedBoundary = false;
    return { usage: null, timestamp: recordTimestamp, quota: null };
  }
  state.pendingOwnedBoundary = false;

  const info = payload.info && typeof payload.info === 'object'
    ? payload.info as Record<string, unknown>
    : {};
  const total = normalizedCodexTotals(info.total_token_usage);
  const last = normalizedCodexTotals(info.last_token_usage);
  const quota = payload.rate_limits && typeof payload.rate_limits === 'object'
    ? payload.rate_limits
    : null;

  if (state.copiedPrefix && !state.inheritedRaw) {
    if (!state.ownBoundarySeen) {
      if (total) state.inheritedRaw = maxTotals(state.inheritedRaw, total);
      return { usage: null, timestamp: recordTimestamp, quota };
    }
  }

  let adjustedTotal = total;
  if (state.parentSessionId) {
    if (state.inheritedRaw && total) {
      adjustedTotal = subtractTotals(total, state.inheritedRaw);
    } else if (!state.copiedPrefix && !state.skippedUnresolvedForkTotal) {
      state.skippedUnresolvedForkTotal = true;
      if (last) {
        if (total) state.inheritedRaw = subtractTotals(total, last);
        adjustedTotal = { ...last };
      } else {
        state.inheritedRaw = cloneTotals(total);
        return { usage: null, timestamp: recordTimestamp, quota };
      }
    } else if (!state.copiedPrefix && !state.inheritedRaw) {
      if (!last) return { usage: null, timestamp: recordTimestamp, quota };
      if (total) state.inheritedRaw = subtractTotals(total, last);
      adjustedTotal = { ...last };
    }
  }
  const usage = applyCodexTotals(state, last, adjustedTotal);
  return {
    usage,
    timestamp: state.lastAssistantTimestamp || recordTimestamp,
    quota,
  };
}

function claudeRecord(
  record: Record<string, unknown>,
  state: ClaudeState,
): { usage: Totals | null; timestamp: number | null; messageId: string | null } {
  if (record.type !== 'assistant') {
    return { usage: null, timestamp: null, messageId: null };
  }
  const message = record.message && typeof record.message === 'object'
    ? record.message as Record<string, unknown>
    : {};
  const usage = claudeTotals(message.usage);
  if (typeof record.cwd === 'string' && record.cwd) state.projectPath = record.cwd;
  if (typeof record.sessionId === 'string' && record.sessionId && !state.sessionId) {
    state.sessionId = record.sessionId;
  }
  return {
    usage,
    timestamp: timestampMs(record.timestamp),
    messageId: typeof message.id === 'string' && message.id ? message.id : null,
  };
}

function hourlyAdd(
  database: DatabaseSync,
  sourcePath: string,
  provider: Provider,
  sessionId: string,
  timestamp: number,
  usage: Totals,
  eventCount = 1,
): void {
  database.prepare(`
    INSERT INTO usage_hourly(
      source_path, provider, session_id, bucket_start_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, event_count
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path, provider, session_id, bucket_start_ms) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      event_count = event_count + excluded.event_count
  `).run(
    sourcePath,
    provider,
    sessionId,
    localHourMs(timestamp),
    usage.input,
    usage.output,
    usage.cached,
    usage.cacheWrite,
    eventCount,
  );
  database.prepare(`
    INSERT INTO usage_provider_hourly(
      provider, bucket_start_ms, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, event_count
    ) VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, bucket_start_ms) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      event_count = event_count + excluded.event_count
  `).run(
    provider,
    localHourMs(timestamp),
    usage.input,
    usage.output,
    usage.cached,
    usage.cacheWrite,
    eventCount,
  );
  if (eventCount < 0) {
    database.prepare(`
      DELETE FROM usage_provider_hourly
      WHERE provider = ? AND bucket_start_ms = ? AND event_count <= 0
    `).run(provider, localHourMs(timestamp));
  }
}

function hourlyDelta(
  database: DatabaseSync,
  sourcePath: string,
  provider: Provider,
  sessionId: string,
  timestamp: number,
  usage: Totals,
  direction: 1 | -1,
): void {
  const scaled = {
    input: usage.input * direction,
    cached: usage.cached * direction,
    output: usage.output * direction,
    cacheWrite: usage.cacheWrite * direction,
  };
  hourlyAdd(database, sourcePath, provider, sessionId, timestamp, scaled, direction);
  if (direction < 0) {
    database.prepare(`
      DELETE FROM usage_hourly
      WHERE source_path = ? AND provider = ? AND session_id = ?
        AND bucket_start_ms = ? AND event_count <= 0
    `).run(sourcePath, provider, sessionId, localHourMs(timestamp));
  }
}

function recentUpsert(
  database: DatabaseSync,
  sourcePath: string,
  eventKey: string,
  provider: Provider,
  sessionId: string,
  timestamp: number,
  usage: Totals,
): void {
  database.prepare(`
    INSERT INTO recent_events(
      source_path, event_key, provider, session_id, timestamp_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_path, event_key) DO UPDATE SET
      provider = excluded.provider,
      session_id = excluded.session_id,
      timestamp_ms = excluded.timestamp_ms,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens
  `).run(
    sourcePath,
    eventKey,
    provider,
    sessionId,
    timestamp,
    usage.input,
    usage.output,
    usage.cached,
    usage.cacheWrite,
  );
}

function claudeMessageUpsert(
  database: DatabaseSync,
  sourcePath: string,
  ownerSessionId: string,
  messageId: string,
  timestamp: number,
  usage: Totals,
  recentBoundary: number,
): void {
  const existing = database.prepare(`
    SELECT source_path, timestamp_ms, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens
    FROM claude_messages
    WHERE owner_session_id = ? AND message_id = ?
  `).get(ownerSessionId, messageId) as Record<string, unknown> | undefined;
  if (
    existing
    && (
      Number(existing.output_tokens) > usage.output
      || (
        Number(existing.output_tokens) === usage.output
        && String(existing.source_path) <= sourcePath
      )
    )
  ) {
    return;
  }
  if (existing) {
    const oldUsage = {
      input: Number(existing.input_tokens),
      output: Number(existing.output_tokens),
      cached: Number(existing.cache_read_tokens),
      cacheWrite: Number(existing.cache_write_tokens),
    };
    hourlyDelta(
      database,
      String(existing.source_path),
      'claude',
      ownerSessionId,
      Number(existing.timestamp_ms),
      oldUsage,
      -1,
    );
    database.prepare(
      'DELETE FROM recent_events WHERE source_path = ? AND event_key = ?',
    ).run(String(existing.source_path), `message:${messageId}`);
  }
  database.prepare(`
    INSERT INTO claude_messages(
      owner_session_id, message_id, source_path, timestamp_ms,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_session_id, message_id) DO UPDATE SET
      source_path = excluded.source_path,
      timestamp_ms = excluded.timestamp_ms,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens
    WHERE excluded.output_tokens > claude_messages.output_tokens
       OR (
         excluded.output_tokens = claude_messages.output_tokens
         AND excluded.source_path < claude_messages.source_path
       )
  `).run(
    ownerSessionId,
    messageId,
    sourcePath,
    timestamp,
    usage.input,
    usage.output,
    usage.cached,
    usage.cacheWrite,
  );
  hourlyDelta(
    database,
    sourcePath,
    'claude',
    ownerSessionId,
    timestamp,
    usage,
    1,
  );
  if (timestamp >= recentBoundary) {
    recentUpsert(
      database,
      sourcePath,
      `message:${messageId}`,
      'claude',
      ownerSessionId,
      timestamp,
      usage,
    );
  }
}

function sourceRow(database: DatabaseSync, filePath: string): Record<string, unknown> | undefined {
  return database.prepare('SELECT * FROM source_files WHERE path = ?').get(filePath) as
    Record<string, unknown> | undefined;
}

function directoryGeneration(database: DatabaseSync, directoryPath: string): number {
  const row = database.prepare(
    'SELECT scan_generation FROM discovery_directories WHERE path = ?',
  ).get(directoryPath) as { scan_generation?: number } | undefined;
  return Number(row?.scan_generation || 0);
}

function insertSource(
  database: DatabaseSync,
  candidate: SourceCandidate,
  state: ParserState,
  hash: string,
): void {
  database.prepare(`
    INSERT INTO source_files(
      path, provider, directory_path, directory_generation,
      size, mtime_ms, committed_offset, file_dev, file_ino,
      prefix_sha256, suffix_sha256, parser_state, session_id, scan_complete,
      last_checked_ms
    ) VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    candidate.filePath,
    candidate.provider,
    path.dirname(candidate.filePath),
    directoryGeneration(database, path.dirname(candidate.filePath)),
    candidate.stat.size,
    candidate.stat.mtimeMs,
    Number(candidate.stat.dev),
    Number(candidate.stat.ino),
    hash,
    suffixHash(candidate.filePath, candidate.stat.size),
    JSON.stringify(state),
    state.sessionId,
    Date.now(),
  );
}

function deleteSource(database: DatabaseSync, filePath: string): void {
  database.prepare(`
    INSERT INTO usage_provider_hourly(
      provider, bucket_start_ms, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, event_count
    )
    SELECT provider, bucket_start_ms, -input_tokens, -output_tokens,
           -cache_read_tokens, -cache_write_tokens, -event_count
    FROM usage_hourly
    WHERE source_path = ?
    ON CONFLICT(provider, bucket_start_ms) DO UPDATE SET
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
      event_count = event_count + excluded.event_count
  `).run(filePath);
  database.prepare(
    'DELETE FROM usage_provider_hourly WHERE event_count <= 0',
  ).run();
  database.prepare('DELETE FROM claude_messages WHERE source_path = ?').run(filePath);
  database.prepare('DELETE FROM codex_quota_candidates WHERE source_path = ?').run(filePath);
  database.prepare('DELETE FROM source_files WHERE path = ?').run(filePath);
}

function processRecord(
  database: DatabaseSync,
  candidate: SourceCandidate,
  state: ParserState,
  record: Record<string, unknown>,
  lineEnd: number,
  recentBoundary: number,
  metrics: Metrics,
): void {
  if (candidate.provider === 'codex') {
    const codexState = state as CodexState;
    const result = codexRecord(record, codexState);
    if (result.quota && typeof result.quota === 'object') {
      const quota = result.quota as Record<string, unknown>;
      const key = String(quota.limit_id || quota.limitId || '');
      const previous = codexState.quotas[key];
      const observedAt = timestampMs(record.timestamp);
      if (!previous || observedAt === null || previous.timestamp === null || observedAt >= previous.timestamp) {
        codexState.quotas[key] = { timestamp: observedAt, rateLimits: result.quota };
        database.prepare(`
          INSERT INTO codex_quota_candidates(
            source_path, limit_id, timestamp_ms, rate_limits_json
          ) VALUES(?, ?, ?, ?)
          ON CONFLICT(source_path, limit_id) DO UPDATE SET
            timestamp_ms = excluded.timestamp_ms,
            rate_limits_json = excluded.rate_limits_json
          WHERE excluded.timestamp_ms IS NULL
             OR codex_quota_candidates.timestamp_ms IS NULL
             OR excluded.timestamp_ms >= codex_quota_candidates.timestamp_ms
        `).run(
          candidate.filePath,
          key,
          observedAt,
          JSON.stringify(result.quota),
        );
      }
    }
    if (!result.usage || !result.timestamp) return;
    hourlyAdd(
      database,
      candidate.filePath,
      'codex',
      codexState.sessionId,
      result.timestamp,
      result.usage,
    );
    if (result.timestamp >= recentBoundary) {
      recentUpsert(
        database,
        candidate.filePath,
        `offset:${lineEnd}`,
        'codex',
        codexState.sessionId,
        result.timestamp,
        result.usage,
      );
    }
    metrics.parsed_events = Number(metrics.parsed_events) + 1;
    return;
  }

  const claudeState = state as ClaudeState;
  const result = claudeRecord(record, claudeState);
  if (!result.usage || !result.timestamp) return;
  if (result.messageId) {
    claudeMessageUpsert(
      database,
      candidate.filePath,
      claudeState.sessionId,
      result.messageId,
      result.timestamp,
      result.usage,
      recentBoundary,
    );
  } else {
    hourlyAdd(
      database,
      candidate.filePath,
      'claude',
      claudeState.sessionId,
      result.timestamp,
      result.usage,
    );
    if (result.timestamp >= recentBoundary) {
      recentUpsert(
        database,
        candidate.filePath,
        `offset:${lineEnd}`,
        'claude',
        claudeState.sessionId,
        result.timestamp,
        result.usage,
      );
    }
  }
  metrics.parsed_events = Number(metrics.parsed_events) + 1;
}

function isCompleteJsonValue(
  filePath: string,
  startOffset: number,
  endOffset: number,
): boolean {
  const descriptor = fs.openSync(filePath, 'r');
  let physicalOffset = startOffset;
  let started = false;
  let finished = false;
  let inString = false;
  let escaped = false;
  let invalid = false;
  const stack: number[] = [];
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (physicalOffset < endOffset && !invalid) {
      const length = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, endOffset - physicalOffset),
        physicalOffset,
      );
      if (length === 0) break;
      physicalOffset += length;
      for (const byte of buffer.subarray(0, length)) {
        if (!started) {
          if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) continue;
          if (byte !== 0x7b && byte !== 0x5b) {
            invalid = true;
            break;
          }
          started = true;
          stack.push(byte);
          continue;
        }
        if (finished) {
          if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d && byte !== 0x0a) {
            invalid = true;
            break;
          }
          continue;
        }
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (byte === 0x5c) {
            escaped = true;
          } else if (byte === 0x22) {
            inString = false;
          }
          continue;
        }
        if (byte === 0x22) {
          inString = true;
        } else if (byte === 0x7b || byte === 0x5b) {
          stack.push(byte);
        } else if (byte === 0x7d || byte === 0x5d) {
          const expected = byte === 0x7d ? 0x7b : 0x5b;
          if (stack.pop() !== expected) {
            invalid = true;
            break;
          }
          if (stack.length === 0) finished = true;
        }
      }
    }
    return physicalOffset >= endOffset
      && started
      && finished
      && !inString
      && !escaped
      && !invalid
      && stack.length === 0;
  } finally {
    fs.closeSync(descriptor);
  }
}

function scanFile(
  database: DatabaseSync,
  candidate: SourceCandidate,
  recentBoundary: number,
  deadline: number,
  metrics: Metrics,
): boolean {
  let row = sourceRow(database, candidate.filePath);
  if (
    row
    && row.provider === candidate.provider
    && Number(row.size) === candidate.stat.size
    && Number(row.mtime_ms) === candidate.stat.mtimeMs
    && Number(row.scan_complete) === 1
  ) {
    metrics.reused_files = Number(metrics.reused_files) + 1;
    return true;
  }

  let rebuild = !row || row.provider !== candidate.provider;
  if (row && !rebuild) {
    const sameIdentity = Number(row.file_dev) === Number(candidate.stat.dev)
      && Number(row.file_ino) === Number(candidate.stat.ino);
    if (candidate.stat.size < Number(row.committed_offset) || !sameIdentity) {
      rebuild = true;
    } else if (candidate.stat.mtimeMs !== Number(row.mtime_ms)) {
      if (
        prefixHash(candidate.filePath, Number(row.size)) !== row.prefix_sha256
        || suffixHash(candidate.filePath, Number(row.size)) !== row.suffix_sha256
      ) {
        rebuild = true;
      } else if (
        candidate.stat.size === Number(row.size)
        && Number(row.scan_complete) === 1
      ) {
        database.prepare(
          'UPDATE source_files SET mtime_ms = ?, file_dev = ?, file_ino = ?, '
            + 'last_checked_ms = ? WHERE path = ?',
        ).run(
          candidate.stat.mtimeMs,
          Number(candidate.stat.dev),
          Number(candidate.stat.ino),
          Date.now(),
          candidate.filePath,
        );
        metrics.reused_files = Number(metrics.reused_files) + 1;
        return true;
      }
    }
  }

  if (rebuild) {
    if (row) {
      deleteSource(database, candidate.filePath);
      metrics[`${candidate.provider}_cache_rebuilt`] = true;
    }
    const state = defaultState(candidate.provider, candidate.filePath);
    if (candidate.provider === 'codex') {
      const codexState = state as CodexState;
      codexState.sessionId = candidate.sessionId;
      codexState.parentSessionId = candidate.parentSessionId;
      codexState.forkTimestamp = candidate.forkTimestamp;
      codexState.copiedPrefix = candidate.copiedPrefix;
      codexState.inheritedRaw = cloneTotals(candidate.parentBaseline);
    }
    insertSource(database, candidate, state, prefixHash(candidate.filePath));
    row = sourceRow(database, candidate.filePath);
    metrics.rebuilt_files = Number(metrics.rebuilt_files) + 1;
  } else {
    metrics.appended_files = Number(metrics.appended_files) + 1;
  }
  if (!row) throw new Error(`Unable to create usage checkpoint for ${candidate.filePath}`);

  const state = JSON.parse(String(row.parser_state)) as ParserState;
  let committedOffset = Number(row.committed_offset);
  let physicalOffset = committedOffset;
  let fullChunks: Buffer[] = [];
  let lineBytes = 0;
  let first = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let truncated = false;
  let stoppedForBudget = false;

  const resetLine = () => {
    fullChunks = [];
    lineBytes = 0;
    first = Buffer.alloc(0);
    tail = Buffer.alloc(0);
    truncated = false;
  };
  const appendPart = (part: Buffer) => {
    lineBytes += part.length;
    if (!truncated && lineBytes <= MAX_LINE_BYTES) {
      fullChunks.push(part);
      return;
    }
    if (!truncated) {
      const combined = Buffer.concat(fullChunks);
      first = combined.subarray(0, TRUNCATED_EDGE_BYTES);
      tail = combined.subarray(Math.max(0, combined.length - TRUNCATED_EDGE_BYTES));
      fullChunks = [];
      truncated = true;
    }
    if (first.length < TRUNCATED_EDGE_BYTES) {
      const needed = TRUNCATED_EDGE_BYTES - first.length;
      first = Buffer.concat([first, part.subarray(0, needed)]);
    }
    tail = Buffer.concat([tail, part]);
    if (tail.length > TRUNCATED_EDGE_BYTES) {
      tail = tail.subarray(tail.length - TRUNCATED_EDGE_BYTES);
    }
  };
  const finishLine = (lineEnd: number, requireCompleteJson = false): boolean => {
    const fullLine = truncated ? null : Buffer.concat(fullChunks);
    if (requireCompleteJson) {
      if (fullLine) {
        try {
          JSON.parse(fullLine.toString('utf8'));
        } catch {
          return false;
        }
      } else if (!isCompleteJsonValue(candidate.filePath, committedOffset, lineEnd)) {
        return false;
      }
    }
    const record = parseRecord(candidate.provider, fullLine, first, tail);
    if (record) {
      processRecord(
        database,
        candidate,
        state,
        record,
        lineEnd,
        recentBoundary,
        metrics,
      );
    }
    committedOffset = lineEnd;
    resetLine();
    return true;
  };

  const descriptor = fs.openSync(candidate.filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      const length = fs.readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        physicalOffset,
      );
      if (length === 0) break;
      metrics.bytes_read = Number(metrics.bytes_read) + length;
      const block = chunk.subarray(0, length);
      let cursor = 0;
      while (cursor < block.length) {
        const newline = block.indexOf(0x0a, cursor);
        const end = newline < 0 ? block.length : newline + 1;
        appendPart(Buffer.from(block.subarray(cursor, end)));
        physicalOffset += end - cursor;
        cursor = end;
        if (newline >= 0) finishLine(physicalOffset);
      }
      if (Date.now() >= deadline && lineBytes === 0 && physicalOffset < candidate.stat.size) {
        stoppedForBudget = true;
        break;
      }
    }
  } finally {
    fs.closeSync(descriptor);
  }

  const finalStat = fs.statSync(candidate.filePath);
  if (!stoppedForBudget && physicalOffset >= finalStat.size && lineBytes > 0) {
    finishLine(physicalOffset, true);
  }
  const scanComplete = !stoppedForBudget
    && physicalOffset >= finalStat.size
    && committedOffset >= finalStat.size;
  database.prepare(`
    UPDATE source_files SET
      size = ?, mtime_ms = ?, committed_offset = ?, file_dev = ?, file_ino = ?,
      prefix_sha256 = ?, suffix_sha256 = ?, parser_state = ?, session_id = ?,
      scan_complete = ?, last_checked_ms = ?
    WHERE path = ?
  `).run(
    finalStat.size,
    finalStat.mtimeMs,
    committedOffset,
    Number(finalStat.dev),
    Number(finalStat.ino),
    prefixHash(candidate.filePath, finalStat.size),
    suffixHash(candidate.filePath, finalStat.size),
    JSON.stringify(state),
    state.sessionId,
    scanComplete ? 1 : 0,
    Date.now(),
    candidate.filePath,
  );
  metrics[scanComplete ? 'scanned_files' : 'partial_files'] =
    Number(metrics[scanComplete ? 'scanned_files' : 'partial_files']) + 1;
  return scanComplete;
}

function probeCodex(filePath: string): {
  sessionId: string;
  parentSessionId: string | null;
  forkTimestamp: number | null;
  copiedPrefix: boolean;
} {
  const fallback = path.basename(filePath, '.jsonl');
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(filePath, 'r');
    // Codex writes the authoritative session_meta first. A small bounded probe
    // avoids rereading megabytes from every uncached rollout during discovery.
    const buffer = Buffer.allocUnsafe(PREFIX_BYTES);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, length).toString('utf8').split('\n');
    let leaf: ReturnType<typeof parseCodexMeta> = null;
    let copiedPrefix = false;
    for (const line of lines) {
      if (!line.includes('session_meta')) continue;
      try {
        const parsed = JSON.parse(line);
        const metadata = parseCodexMeta(parsed);
        if (!metadata) continue;
        if (!leaf) {
          leaf = metadata;
        } else if (metadata.id && metadata.id !== leaf.id) {
          copiedPrefix = true;
        }
      } catch {
        // A partial final probe line is expected.
      }
    }
    return {
      sessionId: leaf?.id || fallback,
      parentSessionId: leaf?.parentId || null,
      forkTimestamp: leaf?.timestamp || null,
      copiedPrefix,
    };
  } catch {
    return {
      sessionId: fallback,
      parentSessionId: null,
      forkTimestamp: null,
      copiedPrefix: false,
    };
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function codexRawTotalsAt(
  filePath: string,
  cutoff: number,
  metrics: Metrics,
): Totals | null {
  const descriptor = fs.openSync(filePath, 'r');
  let physicalOffset = 0;
  let chunks: Buffer[] = [];
  let lineBytes = 0;
  let latest: Totals | null = null;
  let accumulated: Totals | null = null;
  let done = false;
  const consume = () => {
    if (lineBytes === 0 || lineBytes > 512 * 1024) {
      chunks = [];
      lineBytes = 0;
      return;
    }
    try {
      const record = JSON.parse(Buffer.concat(chunks).toString('utf8')) as
        Record<string, unknown>;
      const observedAt = timestampMs(record.timestamp);
      if (observedAt && observedAt > cutoff) {
        done = true;
        return;
      }
      const payload = record.payload && typeof record.payload === 'object'
        ? record.payload as Record<string, unknown>
        : {};
      if (record.type !== 'event_msg' || payload.type !== 'token_count') return;
      const info = payload.info && typeof payload.info === 'object'
        ? payload.info as Record<string, unknown>
        : {};
      const total = normalizedCodexTotals(info.total_token_usage);
      const last = normalizedCodexTotals(info.last_token_usage);
      if (total) {
        latest = total;
        accumulated = total;
      } else if (last) {
        accumulated = addTotals(accumulated, last);
        latest = accumulated;
      }
    } catch {
      // Only complete, canonical token rows contribute to a parent snapshot.
    } finally {
      chunks = [];
      lineBytes = 0;
    }
  };
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (!done) {
      const length = fs.readSync(
        descriptor,
        buffer,
        0,
        buffer.length,
        physicalOffset,
      );
      if (length === 0) break;
      metrics.bytes_read = Number(metrics.bytes_read) + length;
      const block = buffer.subarray(0, length);
      let cursor = 0;
      while (cursor < block.length && !done) {
        const newline = block.indexOf(0x0a, cursor);
        const end = newline < 0 ? block.length : newline + 1;
        const part = Buffer.from(block.subarray(cursor, end));
        lineBytes += part.length;
        if (lineBytes <= 512 * 1024) chunks.push(part);
        physicalOffset += part.length;
        cursor = end;
        if (newline >= 0) consume();
      }
    }
    if (!done && lineBytes > 0) consume();
    return cloneTotals(latest);
  } finally {
    fs.closeSync(descriptor);
  }
}

function rowEvent(row: Record<string, unknown>): UsageEvent {
  const input = Number(row.input_tokens);
  const output = Number(row.output_tokens);
  const cached = Number(row.cache_read_tokens);
  const cacheWrite = Number(row.cache_write_tokens);
  return {
    timestamp: Number(row.timestamp_ms),
    sessionId: String(row.session_id),
    totalTokens: input + output + cached + cacheWrite,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: cacheWrite,
    unattributedTokens: 0,
  };
}

function providerEvents(
  database: DatabaseSync,
  provider: Provider,
  retentionCutoff: number,
  recentBoundary: number,
): UsageEvent[] {
  const rows = database.prepare(`
    SELECT provider || '-aggregate' AS session_id, bucket_start_ms AS timestamp_ms,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    FROM usage_provider_hourly
    WHERE provider = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?
    UNION ALL
    SELECT session_id, timestamp_ms,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
    FROM recent_events
    WHERE provider = ? AND timestamp_ms >= ?
    ORDER BY timestamp_ms, session_id
  `).all(
    provider,
    localHourMs(retentionCutoff),
    recentBoundary,
    provider,
    recentBoundary,
  ) as Array<Record<string, unknown>>;
  return rows.map(rowEvent);
}

function latestQuotas(database: DatabaseSync): unknown[] {
  const rows = database.prepare(`
    SELECT timestamp_ms, rate_limits_json
    FROM codex_quota_candidates
    ORDER BY timestamp_ms DESC
    LIMIT 32
  `).all() as Array<{ timestamp_ms: number | null; rate_limits_json: string }>;
  const candidates: Array<{ timestamp: number | null; rateLimits: unknown }> = [];
  for (const row of rows) {
    try {
      candidates.push({
        timestamp: row.timestamp_ms === null ? null : Number(row.timestamp_ms),
        rateLimits: JSON.parse(row.rate_limits_json),
      });
    } catch {
      // A malformed disposable cache row is ignored until its source is rebuilt.
    }
  }
  return candidates;
}

function scalarCount(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number };
  return Number(row.count);
}

function metadataValue(database: DatabaseSync, key: string): string {
  const row = database.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
    { value?: string } | undefined;
  return String(row?.value || '');
}

function setMetadataValue(database: DatabaseSync, key: string, value: string): void {
  database.prepare(
    'INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)',
  ).run(key, value);
}

function configuredRoots(roots: Partial<Record<Provider, string[]>>): Array<{
  provider: Provider;
  rootPath: string;
}> {
  const configured: Array<{ provider: Provider; rootPath: string }> = [];
  for (const provider of ['codex', 'claude'] as const) {
    for (const root of Array.from(new Set(roots[provider] || [])).sort()) {
      configured.push({ provider, rootPath: path.resolve(root) });
    }
  }
  return configured;
}

function resetDiscovery(database: DatabaseSync, cacheFile: string): void {
  closeCacheDirectoryCursors(cacheFile);
  database.exec(`
    DELETE FROM discovery_source_queue;
    DELETE FROM discovery_directories;
    DELETE FROM codex_quota_candidates;
    DELETE FROM claude_messages;
    DELETE FROM usage_provider_hourly;
    DELETE FROM source_files;
  `);
}

function ensureDiscoveryRoots(
  database: DatabaseSync,
  roots: Partial<Record<Provider, string[]>>,
  nowMs: number,
  cacheFile: string,
): void {
  const configured = configuredRoots(roots);
  const signature = JSON.stringify(configured);
  if (metadataValue(database, 'roots_signature') !== signature) {
    resetDiscovery(database, cacheFile);
    setMetadataValue(database, 'roots_signature', signature);
    setMetadataValue(database, 'discovery_ready', '0');
  }
  const configuredPaths = new Set(configured.map(entry => entry.rootPath));
  database.prepare(
    'DELETE FROM discovery_directories WHERE is_root = 1 AND path NOT IN ('
      + (configured.length ? configured.map(() => '?').join(',') : "''")
      + ')',
  ).run(...configured.map(entry => entry.rootPath));
  for (const { provider, rootPath } of configured) {
    database.prepare(`
      INSERT INTO discovery_directories(
        path, provider, root_path, parent_path, is_root, present, pending,
        scan_generation, parent_generation, mtime_ms, file_dev, file_ino,
        last_checked_ms
      ) VALUES(?, ?, ?, '', 1, 1, 1, 0, 0, -1, -1, -1, 0)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        root_path = excluded.root_path,
        is_root = 1,
        present = 1,
        last_checked_ms = MIN(discovery_directories.last_checked_ms, ?)
    `).run(rootPath, provider, rootPath, nowMs);
  }
  if (configuredPaths.size === 0) setMetadataValue(database, 'discovery_ready', '1');
}

function queueSource(
  database: DatabaseSync,
  provider: Provider,
  filePath: string,
  action: 'upsert' | 'remove',
  priority: number,
  nowMs: number,
): void {
  database.prepare(`
    INSERT INTO discovery_source_queue(path, provider, action, priority, queued_at_ms)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      provider = excluded.provider,
      action = excluded.action,
      priority = excluded.priority,
      queued_at_ms = excluded.queued_at_ms
  `).run(filePath, provider, action, priority, nowMs);
}

type DirectoryCursor = {
  directory: fs.Dir;
  startStat: fs.Stats;
  generation: number;
};
const directoryCursors = new Map<string, DirectoryCursor>();

function directoryCursorKey(cacheFile: string, directoryPath: string): string {
  return `${path.resolve(cacheFile)}\0${directoryPath}`;
}

function closeDirectoryCursor(cacheFile: string, directoryPath: string): void {
  const key = directoryCursorKey(cacheFile, directoryPath);
  const cursor = directoryCursors.get(key);
  if (!cursor) return;
  directoryCursors.delete(key);
  try {
    cursor.directory.closeSync();
  } catch {
    // The directory may already have disappeared.
  }
}

function closeCacheDirectoryCursors(cacheFile: string): void {
  const prefix = `${path.resolve(cacheFile)}\0`;
  for (const [key, cursor] of directoryCursors) {
    if (!key.startsWith(prefix)) continue;
    directoryCursors.delete(key);
    try {
      cursor.directory.closeSync();
    } catch {
      // The directory may already have disappeared.
    }
  }
}

function markDirectoryTreeMissing(
  database: DatabaseSync,
  directoryPath: string,
  nowMs: number,
  cacheFile: string,
): void {
  closeDirectoryCursor(cacheFile, directoryPath);
  const prefix = `${directoryPath}${path.sep}%`;
  database.prepare(
    'UPDATE discovery_directories SET present = 0, pending = 0, last_checked_ms = ? '
      + 'WHERE path = ? OR path LIKE ?',
  ).run(nowMs, directoryPath, prefix);
  database.prepare(`
    INSERT INTO discovery_source_queue(path, provider, action, priority, queued_at_ms)
    SELECT path, provider, 'remove', -1, ?
    FROM source_files
    WHERE directory_path = ? OR directory_path LIKE ?
    ON CONFLICT(path) DO UPDATE SET
      action = CASE
        WHEN discovery_source_queue.action = 'upsert' THEN 'upsert'
        ELSE 'remove'
      END,
      queued_at_ms = MIN(discovery_source_queue.queued_at_ms, excluded.queued_at_ms)
  `).run(nowMs, directoryPath, prefix);
}

function auditDirectories(
  database: DatabaseSync,
  nowMs: number,
  deadline: number,
  metrics: Metrics,
  cacheFile: string,
): void {
  const rows = database.prepare(`
    SELECT * FROM discovery_directories
    WHERE present = 1
    ORDER BY is_root DESC, last_checked_ms ASC
    LIMIT ?
  `).all(DIRECTORY_AUDIT_BATCH) as Array<Record<string, unknown>>;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    const directoryPath = String(row.path);
    try {
      const stat = fs.statSync(directoryPath);
      const changed = !stat.isDirectory()
        || Number(row.file_dev) !== Number(stat.dev)
        || Number(row.file_ino) !== Number(stat.ino)
        || Number(row.mtime_ms) !== stat.mtimeMs;
      database.prepare(`
        UPDATE discovery_directories SET
          present = ?, pending = CASE WHEN ? THEN 1 ELSE pending END,
          mtime_ms = ?, file_dev = ?, file_ino = ?, last_checked_ms = ?
        WHERE path = ?
      `).run(
        stat.isDirectory() ? 1 : 0,
        changed ? 1 : 0,
        stat.mtimeMs,
        Number(stat.dev),
        Number(stat.ino),
        nowMs,
        directoryPath,
      );
      if (!stat.isDirectory()) {
        markDirectoryTreeMissing(database, directoryPath, nowMs, cacheFile);
      }
    } catch {
      markDirectoryTreeMissing(database, directoryPath, nowMs, cacheFile);
    }
    metrics.audited_directories = Number(metrics.audited_directories) + 1;
  }
}

function scanPendingDirectories(
  database: DatabaseSync,
  nowMs: number,
  deadline: number,
  metrics: Metrics,
  cacheFile: string,
): void {
  const remainingEntryBudget = DIRECTORY_ENTRY_BATCH
    - Number(metrics.enumerated_entries);
  if (remainingEntryBudget <= 0) return;
  const row = database.prepare(`
    SELECT * FROM discovery_directories
    WHERE present = 1 AND pending = 1
    ORDER BY is_root DESC, last_checked_ms ASC
    LIMIT 1
  `).get() as Record<string, unknown> | undefined;
  if (!row || Date.now() >= deadline) return;
  const directoryPath = String(row.path);
  const provider = String(row.provider) as Provider;
  const cursorKey = directoryCursorKey(cacheFile, directoryPath);
  let cursor = directoryCursors.get(cursorKey);
  try {
    if (!cursor) {
      const startStat = fs.statSync(directoryPath);
      const generation = Number(row.scan_generation) + 1;
      cursor = {
        directory: fs.opendirSync(directoryPath),
        startStat,
        generation,
      };
      directoryCursors.set(cursorKey, cursor);
      database.prepare(
        'UPDATE discovery_directories '
          + 'SET scan_generation = ?, last_checked_ms = ? WHERE path = ?',
      ).run(generation, nowMs, directoryPath);
    }
  } catch {
    markDirectoryTreeMissing(database, directoryPath, nowMs, cacheFile);
    return;
  }

  const entries: fs.Dirent[] = [];
  let complete = false;
  try {
    while (entries.length < remainingEntryBudget && Date.now() < deadline) {
      const entry = cursor.directory.readSync();
      if (!entry) {
        complete = true;
        break;
      }
      entries.push(entry);
    }
  } catch {
    closeDirectoryCursor(cacheFile, directoryPath);
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries) {
      const child = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        let childStat: fs.Stats;
        try {
          childStat = fs.statSync(child);
        } catch {
          continue;
        }
        database.prepare(`
          INSERT INTO discovery_directories(
            path, provider, root_path, parent_path, is_root, present, pending,
            scan_generation, parent_generation, mtime_ms, file_dev, file_ino,
            last_checked_ms
          ) VALUES(?, ?, ?, ?, 0, 1, 1, 0, ?, ?, ?, ?, 0)
          ON CONFLICT(path) DO UPDATE SET
            present = 1,
            parent_generation = excluded.parent_generation,
            pending = CASE
              WHEN discovery_directories.file_dev != excluded.file_dev
                OR discovery_directories.file_ino != excluded.file_ino
                OR discovery_directories.mtime_ms != excluded.mtime_ms
              THEN 1 ELSE discovery_directories.pending
            END,
            mtime_ms = excluded.mtime_ms,
            file_dev = excluded.file_dev,
            file_ino = excluded.file_ino
        `).run(
          child,
          provider,
          String(row.root_path),
          directoryPath,
          cursor.generation,
          childStat.mtimeMs,
          Number(childStat.dev),
          Number(childStat.ino),
        );
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = fs.statSync(child);
          const cached = sourceRow(database, child);
          if (cached) {
            database.prepare(
              'UPDATE source_files SET directory_generation = ? WHERE path = ?',
            ).run(cursor.generation, child);
          }
          if (
            !cached
            || Number(cached.size) !== stat.size
            || Number(cached.mtime_ms) !== stat.mtimeMs
            || Number(cached.file_dev) !== Number(stat.dev)
            || Number(cached.file_ino) !== Number(stat.ino)
            || Number(cached.scan_complete) !== 1
          ) {
            queueSource(database, provider, child, 'upsert', stat.mtimeMs, nowMs);
          } else {
            database.prepare(
              'UPDATE source_files SET last_checked_ms = ? WHERE path = ?',
            ).run(nowMs, child);
            metrics.reused_files = Number(metrics.reused_files) + 1;
          }
        } catch {
          // A later directory pass or source audit retries transient entries.
        }
      }
    }

    if (complete) {
      const endStat = fs.statSync(directoryPath);
      const stable = Number(cursor.startStat.dev) === Number(endStat.dev)
        && Number(cursor.startStat.ino) === Number(endStat.ino)
        && cursor.startStat.mtimeMs === endStat.mtimeMs;
      if (stable) {
        const missingChildren = database.prepare(`
          SELECT path FROM discovery_directories
          WHERE parent_path = ? AND present = 1 AND parent_generation < ?
        `).all(directoryPath, cursor.generation) as Array<{ path: string }>;
        for (const child of missingChildren) {
          markDirectoryTreeMissing(database, child.path, nowMs, cacheFile);
        }
        database.prepare(`
          INSERT INTO discovery_source_queue(path, provider, action, priority, queued_at_ms)
          SELECT path, provider, 'remove', -1, ?
          FROM source_files
          WHERE directory_path = ? AND directory_generation < ?
          ON CONFLICT(path) DO UPDATE SET
            action = 'remove',
            priority = -1,
            queued_at_ms = excluded.queued_at_ms
        `).run(nowMs, directoryPath, cursor.generation);
      }
      database.prepare(`
        UPDATE discovery_directories SET
          present = 1, pending = ?, mtime_ms = ?, file_dev = ?, file_ino = ?,
          last_checked_ms = ?
        WHERE path = ?
      `).run(
        stable ? 0 : 1,
        endStat.mtimeMs,
        Number(endStat.dev),
        Number(endStat.ino),
        nowMs,
        directoryPath,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    closeDirectoryCursor(cacheFile, directoryPath);
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      markDirectoryTreeMissing(database, directoryPath, nowMs, cacheFile);
      return;
    }
    throw error;
  } finally {
    if (complete) closeDirectoryCursor(cacheFile, directoryPath);
  }
  metrics.enumerated_entries = Number(metrics.enumerated_entries) + entries.length;
  if (complete) {
    metrics.scanned_directories = Number(metrics.scanned_directories) + 1;
    if (
      Number(metrics.enumerated_entries) < DIRECTORY_ENTRY_BATCH
      && Date.now() < deadline
    ) {
      scanPendingDirectories(database, nowMs, deadline, metrics, cacheFile);
    }
  }
}

function auditSources(
  database: DatabaseSync,
  nowMs: number,
  deadline: number,
  metrics: Metrics,
): void {
  const rows = database.prepare(`
    SELECT * FROM source_files
    ORDER BY last_checked_ms ASC
    LIMIT ?
  `).all(SOURCE_AUDIT_BATCH) as Array<Record<string, unknown>>;
  const recent = database.prepare(`
    SELECT * FROM source_files
    ORDER BY mtime_ms DESC
    LIMIT ?
  `).all(Math.min(32, SOURCE_AUDIT_BATCH)) as Array<Record<string, unknown>>;
  const byPath = new Map([...recent, ...rows].map(row => [String(row.path), row]));
  for (const row of byPath.values()) {
    if (Date.now() >= deadline) break;
    const filePath = String(row.path);
    try {
      const stat = fs.statSync(filePath);
      const changed = stat.size !== Number(row.size)
        || stat.mtimeMs !== Number(row.mtime_ms)
        || Number(stat.dev) !== Number(row.file_dev)
        || Number(stat.ino) !== Number(row.file_ino)
        || Number(row.scan_complete) !== 1;
      if (changed) {
        queueSource(
          database,
          String(row.provider) as Provider,
          filePath,
          'upsert',
          stat.mtimeMs,
          nowMs,
        );
      } else {
        database.prepare(
          'UPDATE source_files SET last_checked_ms = ? WHERE path = ?',
        ).run(nowMs, filePath);
        metrics.reused_files = Number(metrics.reused_files) + 1;
      }
    } catch {
      queueSource(
        database,
        String(row.provider) as Provider,
        filePath,
        'remove',
        -1,
        nowMs,
      );
    }
    metrics.audited_files = Number(metrics.audited_files) + 1;
  }
}

function candidateFromPath(
  database: DatabaseSync,
  provider: Provider,
  filePath: string,
): SourceCandidate {
  const stat = fs.statSync(filePath);
  const cached = sourceRow(database, filePath);
  if (provider === 'codex') {
    let probe: ReturnType<typeof probeCodex>;
    if (cached?.provider === 'codex') {
      try {
        const state = JSON.parse(String(cached.parser_state)) as CodexState;
        probe = {
          sessionId: state.sessionId,
          parentSessionId: state.parentSessionId,
          forkTimestamp: state.forkTimestamp,
          copiedPrefix: state.copiedPrefix,
        };
      } catch {
        probe = probeCodex(filePath);
      }
    } else {
      probe = probeCodex(filePath);
    }
    return { provider, filePath, stat, ...probe, parentBaseline: null };
  }
  return {
    provider,
    filePath,
    stat,
    sessionId: claudeOwnerSession(filePath),
    parentSessionId: null,
    forkTimestamp: null,
    copiedPrefix: false,
    parentBaseline: null,
  };
}

function moveSource(
  database: DatabaseSync,
  row: Record<string, unknown>,
  candidate: SourceCandidate,
): void {
  const oldPath = String(row.path);
  database.prepare(`
    INSERT INTO source_files(
      path, provider, directory_path, directory_generation,
      size, mtime_ms, committed_offset, file_dev, file_ino,
      prefix_sha256, suffix_sha256, parser_state, session_id, scan_complete,
      last_checked_ms
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.filePath,
    candidate.provider,
    path.dirname(candidate.filePath),
    directoryGeneration(database, path.dirname(candidate.filePath)),
    candidate.stat.size,
    candidate.stat.mtimeMs,
    Number(row.committed_offset),
    Number(candidate.stat.dev),
    Number(candidate.stat.ino),
    String(row.prefix_sha256),
    suffixHash(candidate.filePath, candidate.stat.size),
    String(row.parser_state),
    String(row.session_id),
    candidate.stat.size === Number(row.size) && Number(row.scan_complete) === 1 ? 1 : 0,
    Date.now(),
  );
  database.prepare(
    'UPDATE usage_hourly SET source_path = ? WHERE source_path = ?',
  ).run(candidate.filePath, oldPath);
  database.prepare(
    'UPDATE recent_events SET source_path = ? WHERE source_path = ?',
  ).run(candidate.filePath, oldPath);
  database.prepare(
    'UPDATE claude_messages SET source_path = ? WHERE source_path = ?',
  ).run(candidate.filePath, oldPath);
  database.prepare(
    'UPDATE codex_quota_candidates SET source_path = ? WHERE source_path = ?',
  ).run(candidate.filePath, oldPath);
  database.prepare('DELETE FROM source_files WHERE path = ?').run(oldPath);
}

function prepareCodexCandidate(
  database: DatabaseSync,
  candidate: SourceCandidate,
  metrics: Metrics,
): boolean {
  if (sourceRow(database, candidate.filePath)) return true;
  const existing = database.prepare(
    "SELECT * FROM source_files WHERE provider = 'codex' AND session_id = ? AND path != ? "
      + 'ORDER BY mtime_ms DESC LIMIT 1',
  ).get(candidate.sessionId, candidate.filePath) as Record<string, unknown> | undefined;
  if (!existing) return true;
  const sameIdentity = Number(existing.file_dev) === Number(candidate.stat.dev)
    && Number(existing.file_ino) === Number(candidate.stat.ino);
  if (sameIdentity && !fs.existsSync(String(existing.path))) {
    moveSource(database, existing, candidate);
    metrics.moved_files = Number(metrics.moved_files) + 1;
    return true;
  }
  const existingArchived = String(existing.path).includes(`${path.sep}archived_sessions${path.sep}`);
  const candidateArchived = candidate.filePath.includes(`${path.sep}archived_sessions${path.sep}`);
  const candidateWins = (existingArchived && !candidateArchived)
    || (existingArchived === candidateArchived
      && candidate.stat.mtimeMs > Number(existing.mtime_ms));
  if (!candidateWins) return false;
  deleteSource(database, String(existing.path));
  return true;
}

function resolveParentBaselineFromDatabase(
  database: DatabaseSync,
  candidate: SourceCandidate,
  cache: Map<string, Totals | null>,
  metrics: Metrics,
): Totals | null {
  if (!candidate.parentSessionId || !candidate.forkTimestamp) return null;
  const key = `${candidate.parentSessionId}:${candidate.forkTimestamp}`;
  if (cache.has(key)) return cloneTotals(cache.get(key));
  const row = database.prepare(
    "SELECT path FROM source_files WHERE provider = 'codex' AND session_id = ? LIMIT 1",
  ).get(candidate.parentSessionId) as { path?: string } | undefined;
  const baseline = row?.path && row.path !== candidate.filePath
    ? codexRawTotalsAt(row.path, candidate.forkTimestamp, metrics)
    : null;
  cache.set(key, cloneTotals(baseline));
  return baseline;
}

function processSourceQueue(
  database: DatabaseSync,
  recentBoundary: number,
  deadline: number,
  metrics: Metrics,
): void {
  const parentCache = new Map<string, Totals | null>();
  while (Date.now() < deadline) {
    const task = (database.prepare(`
      SELECT * FROM discovery_source_queue
      WHERE action = 'upsert'
      ORDER BY priority ASC, queued_at_ms ASC
      LIMIT 1
    `).get() || database.prepare(`
      SELECT * FROM discovery_source_queue
      WHERE action = 'remove'
      ORDER BY priority ASC, queued_at_ms ASC
      LIMIT 1
    `).get()) as Record<string, unknown> | undefined;
    if (!task) return;
    const filePath = String(task.path);
    if (String(task.action) === 'remove') {
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'DELETE FROM discovery_source_queue WHERE path = ?',
        ).run(filePath);
        try {
          const stat = fs.statSync(filePath);
          queueSource(
            database,
            String(task.provider) as Provider,
            filePath,
            'upsert',
            stat.mtimeMs,
            Date.now(),
          );
        } catch (error) {
          if (
            !error
            || typeof error !== 'object'
            || !('code' in error)
            || error.code !== 'ENOENT'
          ) {
            throw error;
          }
          deleteSource(database, filePath);
          metrics.removed_files = Number(metrics.removed_files) + 1;
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      continue;
    }
    try {
      const candidate = candidateFromPath(
        database,
        String(task.provider) as Provider,
        filePath,
      );
      database.exec('BEGIN IMMEDIATE');
      let complete = false;
      try {
        if (candidate.provider === 'codex') {
          if (!prepareCodexCandidate(database, candidate, metrics)) {
            database.prepare('DELETE FROM discovery_source_queue WHERE path = ?').run(filePath);
            database.exec('COMMIT');
            continue;
          }
          if (
            !sourceRow(database, filePath)
            && candidate.parentSessionId
            && !database.prepare(
              "SELECT 1 FROM source_files WHERE provider = 'codex' AND session_id = ? LIMIT 1",
            ).get(candidate.parentSessionId)
          ) {
            const otherUpsert = database.prepare(
              "SELECT 1 FROM discovery_source_queue "
                + "WHERE action = 'upsert' AND path != ? LIMIT 1",
            ).get(filePath);
            if (otherUpsert) {
              const row = database.prepare(
                "SELECT priority + 1 AS priority FROM discovery_source_queue "
                  + "WHERE action = 'upsert' ORDER BY priority DESC LIMIT 1",
              ).get() as { priority: number };
              database.prepare(
                'UPDATE discovery_source_queue SET priority = ?, queued_at_ms = ? WHERE path = ?',
              ).run(Number(row.priority), Date.now(), filePath);
              database.exec('COMMIT');
              continue;
            }
          }
          if (!sourceRow(database, filePath) && candidate.parentSessionId) {
            candidate.parentBaseline = resolveParentBaselineFromDatabase(
              database,
              candidate,
              parentCache,
              metrics,
            );
          }
        }
        complete = scanFile(database, candidate, recentBoundary, deadline, metrics);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      if (complete) {
        database.prepare('DELETE FROM discovery_source_queue WHERE path = ?').run(filePath);
      } else {
        return;
      }
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === 'ENOENT'
      ) {
        database.exec('BEGIN IMMEDIATE');
        try {
          deleteSource(database, filePath);
          database.prepare(
            'DELETE FROM discovery_source_queue WHERE path = ?',
          ).run(filePath);
          database.exec('COMMIT');
        } catch (cleanupError) {
          database.exec('ROLLBACK');
          throw cleanupError;
        }
        metrics.removed_files = Number(metrics.removed_files) + 1;
        continue;
      }
      metrics.errors = Number(metrics.errors) + 1;
      const errors = metrics.errors_by_provider as Record<Provider, number>;
      errors[String(task.provider) as Provider] += 1;
      return;
    }
  }
}

export function collectUsage(request: CollectRequest): Record<string, unknown> {
  const cacheFile = path.resolve(request.cacheFile);
  const legacyCacheFile = request.legacyCacheFile
    ? path.resolve(request.legacyCacheFile)
    : path.join(path.dirname(cacheFile), 'cc-statistics-usage-v1.sqlite3');
  if (legacyCacheFile !== cacheFile && fs.existsSync(legacyCacheFile)) {
    removeDatabaseFiles(legacyCacheFile);
  }
  const nowMs = request.nowMs || Date.now();
  const retentionDays = Math.max(1, request.retentionDays || DEFAULT_RETENTION_DAYS);
  const recentRawMs = Math.max(60_000, request.recentRawMs || DEFAULT_RECENT_RAW_MS);
  const scanBudgetMs = Math.max(100, request.scanBudgetMs || DEFAULT_SCAN_BUDGET_MS);
  const { database, rebuilt } = openDatabase(cacheFile);
  const deadline = Date.now() + scanBudgetMs;
  const metrics: Metrics = {
    discovered_files: 0,
    scanned_directories: 0,
    audited_directories: 0,
    enumerated_entries: 0,
    audited_files: 0,
    scanned_files: 0,
    partial_files: 0,
    reused_files: 0,
    appended_files: 0,
    rebuilt_files: 0,
    parsed_events: 0,
    bytes_read: 0,
    pruned_events: 0,
    removed_files: 0,
    moved_files: 0,
    errors: 0,
    errors_by_provider: { codex: 0, claude: 0 },
    cache_rebuilt: rebuilt,
    codex_cache_rebuilt: false,
    claude_cache_rebuilt: false,
  };
  let completed = false;

  try {
    const retentionCutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    const recentCutoff = Math.max(retentionCutoff, nowMs - recentRawMs);
    const recentBoundary = localHourMs(recentCutoff);
    database.exec('BEGIN IMMEDIATE');
    try {
      ensureDiscoveryRoots(database, request.roots || {}, nowMs, cacheFile);
      auditDirectories(database, nowMs, deadline, metrics, cacheFile);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    scanPendingDirectories(database, nowMs, deadline, metrics, cacheFile);
    if (Date.now() < deadline) auditSources(database, nowMs, deadline, metrics);
    if (Date.now() < deadline) {
      processSourceQueue(database, recentBoundary, deadline, metrics);
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      let pruned = 0;
      pruned += Number(database.prepare(
        'DELETE FROM usage_hourly WHERE bucket_start_ms < ?',
      ).run(localHourMs(retentionCutoff)).changes);
      database.prepare(
        'DELETE FROM usage_provider_hourly WHERE bucket_start_ms < ?',
      ).run(localHourMs(retentionCutoff));
      pruned += Number(database.prepare(
        'DELETE FROM recent_events WHERE timestamp_ms < ?',
      ).run(recentBoundary).changes);
      pruned += Number(database.prepare(
        'DELETE FROM claude_messages WHERE timestamp_ms < ?',
      ).run(retentionCutoff).changes);
      metrics.pruned_events = pruned;
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const stats = database.prepare(
      'SELECT * FROM cache_stats WHERE singleton = 1',
    ).get() as Record<string, number>;
    const pendingDirectories = Number(stats.pending_directories);
    const pendingFiles = Number(stats.queued_sources);
    const incompleteFiles = Number(stats.codex_incomplete)
      + Number(stats.claude_incomplete);
    const scanComplete = pendingDirectories === 0
      && pendingFiles === 0
      && incompleteFiles === 0
      && Number(metrics.errors) === 0;
    if (scanComplete) setMetadataValue(database, 'discovery_ready', '1');
    const discoveryReady = metadataValue(database, 'discovery_ready') === '1';
    const discovered = {
      codex: Number(stats.codex_files),
      claude: Number(stats.claude_files),
    };
    metrics.discovered_files = discovered.codex + discovered.claude;
    metrics.scan_complete = scanComplete;
    metrics.pending_files = pendingFiles;
    metrics.pending_directories = pendingDirectories;
    metrics.discovery_ready = discoveryReady;
    metrics.hourly_rows = Number(stats.hourly_rows);
    metrics.recent_rows = Number(stats.recent_rows);
    metrics.committed_bytes = Number(stats.committed_bytes);
    metrics.dedupe_rows = Number(stats.dedupe_rows);
    metrics.codex_fingerprint_rows = 0;
    metrics.codex_session_rows = discovered.codex;
    metrics.codex_session_cache_rows = 0;
    const providerComplete = {
      codex: discoveryReady && Number(stats.codex_incomplete) === 0,
      claude: discoveryReady && Number(stats.claude_incomplete) === 0,
    };

    const providers: Record<Provider, Record<string, unknown>> = {
      codex: {},
      claude: {},
    };
    for (const provider of ['codex', 'claude'] as const) {
      const providerErrors = (metrics.errors_by_provider as Record<Provider, number>)[provider];
      const available = discovered[provider] > 0 && providerErrors === 0;
      providers[provider] = {
        source: provider === 'codex'
          ? 'Farming local history · CodexBar 0.45.2-derived'
          : 'Farming local history · cc-statistics 1.1.0-derived',
        events: !providerComplete[provider]
          ? []
          : providerEvents(database, provider, retentionCutoff, recentBoundary),
        quotaCandidates: provider === 'codex' ? latestQuotas(database) : [],
        fileCount: discovered[provider],
        available,
        partial: !providerComplete[provider],
        ...(!available
          ? {
              reason: providerErrors
                ? `${providerErrors} session file(s) could not be parsed.`
                : 'No local session files were found.',
            }
          : {}),
      };
    }
    const result = {
      schemaVersion: SCHEMA_VERSION,
      source: SOURCE_VERSION,
      sampledAt: nowMs,
      retentionDays,
      providers,
      cache: { ...metrics, path: cacheFile },
    };
    completed = true;
    return result;
  } finally {
    if (!completed) closeCacheDirectoryCursors(cacheFile);
    database.close();
  }
}
