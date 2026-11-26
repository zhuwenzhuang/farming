import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  isSafePiSessionId,
  normalizeProvider,
  resolvePiSessionSource,
} from './agent-session-history.cjs';
import type { AgentProvider, AgentSession } from './agent-session-history.cjs';
import { stripCodexInternalContextBlocks } from './codex-transcript-sanitizer.cjs';
import { cleanAgyUserInputText } from './agy-conversation-store.cjs';
import { mainPageAgentSessionKey } from './main-page-session.cjs';

interface SqliteStatementSync {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementSync;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { open?: boolean; readOnly?: boolean; timeout?: number }
  ) => SqliteDatabaseSync;
}

export interface SessionSearchTextRange {
  start: number;
  end: number;
}

export type SessionSearchMatchSource = 'id' | 'title' | 'project' | 'content';

export interface IndexedAgentSessionMatch extends AgentSession {
  searchMatchSource?: SessionSearchMatchSource;
  searchSnippet?: string;
  searchSnippetRanges?: SessionSearchTextRange[];
}

export interface AgentSessionFullTextSearchResult {
  query: string;
  scope: 'id-title-project-content';
  sessions: IndexedAgentSessionMatch[];
  total: number;
}

export interface AgentSessionFullTextSearchOptions {
  limit?: number;
  projectNames?: Record<string, string>;
  syncBudgetMs?: number;
}

export interface AgentSessionSearchIndexOptions {
  dbFile: string;
  maxMessagesPerSession?: number;
  maxTranscriptBytesPerSession?: number;
  sourceCacheTtlMs?: number;
  syncBudgetMs?: number;
}

interface TranscriptSourceFile {
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface ExtractedMessage {
  ordinal: number;
  role: 'user' | 'assistant';
  text: string;
}

interface StoredSessionRow {
  source_mtime_ms: number;
  source_path: string;
  source_size: number;
  title: string;
  updated_at: string;
}

interface CachedHomeFiles {
  expiresAt: number;
  filesBySessionId: Map<string, TranscriptSourceFile>;
}

const SCHEMA_VERSION = '1';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_SYNC_BUDGET_MS = 1_500;
const DEFAULT_SOURCE_CACHE_TTL_MS = 15_000;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 256 * 1024;
const DEFAULT_MAX_MESSAGES_PER_SESSION = 300;
const MAX_RAW_FILE_READ_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_TEXT_CHARS = 8_000;
const SNIPPET_TARGET_LENGTH = 160;
const MAX_QUERY_TOKENS = 8;

const UUID_JSONL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const PI_JSONL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_(.+)\.jsonl$/;
const AGY_TRANSCRIPT_RE = /[/\\]brain[/\\]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/i;
const ASCII_WORD_TOKEN_RE = /^[a-z0-9_]{2,}$/i;

function loadNodeSqlite(): NodeSqliteModule | null {
  try {
    return require('node:sqlite') as NodeSqliteModule;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultHomeForProvider(provider: AgentProvider): string {
  const home = os.homedir();
  switch (provider) {
    case 'codex': return process.env.CODEX_HOME || path.join(home, '.codex');
    case 'claude': return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    case 'pi': return process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent');
    case 'qoder': return path.join(home, '.qoder');
    case 'qwen': return path.join(home, '.qwen');
    case 'agy': return path.join(home, '.gemini', 'antigravity');
    case 'opencode': return '';
  }
}

function normalizeSearchText(value: unknown): string {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSearchTokens(query: string): string[] {
  const normalized = query.normalize('NFKC').trim().toLowerCase();
  if (!normalized) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const part of normalized.split(/\s+/)) {
    if (!part || seen.has(part)) continue;
    seen.add(part);
    tokens.push(part);
    if (tokens.length >= MAX_QUERY_TOKENS) break;
  }
  return tokens;
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildSessionKey(session: AgentSession): string {
  return mainPageAgentSessionKey(
    session.provider || '',
    session.id || '',
    session.providerHomeId || 'default',
  );
}

function extractTextFromContentField(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      chunks.push(item);
      continue;
    }
    if (!isRecord(item)) continue;
    const blockType = typeof item.type === 'string' ? item.type : '';
    if (blockType === 'tool_use' || blockType === 'tool_result' || blockType === 'image' || blockType === 'thinking') {
      continue;
    }
    if (typeof item.text === 'string' && item.text.trim()) {
      chunks.push(item.text);
    } else if (typeof item.content === 'string' && item.content.trim()) {
      chunks.push(item.content);
    }
  }
  return chunks.join('\n');
}

function shouldSkipSystemNoise(text: string): boolean {
  if (!text) return true;
  if (text.startsWith('<command-name>') || text.startsWith('<local-command-')) return true;
  if (text.startsWith('data:image/') && text.length > 256) return true;
  return false;
}

function parseTranscriptLine(
  provider: AgentProvider,
  line: string,
): { role: 'user' | 'assistant'; text: string } | null {
  if (!line || line.length < 2) return null;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record)) return null;

  if (provider === 'codex') {
    const recordType = typeof record.type === 'string' ? record.type : '';
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) return null;
    if (recordType === 'event_msg') {
      const payloadType = typeof payload.type === 'string' ? payload.type : '';
      if (payloadType === 'user_message' && typeof payload.message === 'string') {
        const cleaned = normalizeSearchText(stripCodexInternalContextBlocks(payload.message));
        return cleaned && !shouldSkipSystemNoise(cleaned) ? { role: 'user', text: cleaned } : null;
      }
      if (payloadType === 'agent_message' && typeof payload.message === 'string') {
        const cleaned = normalizeSearchText(payload.message);
        return cleaned ? { role: 'assistant', text: cleaned } : null;
      }
      return null;
    }
    if (recordType === 'response_item' && payload.type === 'message') {
      const role = payload.role === 'user' || payload.role === 'assistant' ? payload.role : null;
      if (!role) return null;
      const raw = extractTextFromContentField(payload.content);
      const stripped = role === 'user' ? stripCodexInternalContextBlocks(raw) : raw;
      const cleaned = normalizeSearchText(stripped);
      return cleaned && !shouldSkipSystemNoise(cleaned) ? { role, text: cleaned } : null;
    }
    return null;
  }

  if (provider === 'agy') {
    const rawRole = typeof record.role === 'string' ? record.role.toLowerCase() : '';
    if (rawRole === 'user') {
      const raw = typeof record.text === 'string'
        ? record.text
        : extractTextFromContentField(record.content ?? record.parts);
      const cleaned = normalizeSearchText(cleanAgyUserInputText(raw));
      return cleaned && !shouldSkipSystemNoise(cleaned) ? { role: 'user', text: cleaned } : null;
    }
    if (rawRole === 'assistant' || rawRole === 'model') {
      const raw = typeof record.text === 'string'
        ? record.text
        : extractTextFromContentField(record.content ?? record.parts);
      const cleaned = normalizeSearchText(raw);
      return cleaned ? { role: 'assistant', text: cleaned } : null;
    }
    if (typeof record.userInput === 'string') {
      const cleaned = normalizeSearchText(cleanAgyUserInputText(record.userInput));
      return cleaned ? { role: 'user', text: cleaned } : null;
    }
    if (typeof record.response === 'string') {
      const cleaned = normalizeSearchText(record.response);
      return cleaned ? { role: 'assistant', text: cleaned } : null;
    }
    return null;
  }

  // Claude, Pi, Qoder, Qwen share JSONL message envelopes.
  const messageObj = isRecord(record.message) ? record.message : null;
  const roleCandidate = (typeof messageObj?.role === 'string' ? messageObj.role : '')
    || (typeof record.role === 'string' ? record.role : '')
    || (typeof record.type === 'string' ? record.type : '');
  const role = roleCandidate === 'user' || roleCandidate === 'assistant' ? roleCandidate : null;
  if (!role) return null;
  if (record.isMeta === true || record.isSidechain === true) return null;

  const rawText = extractTextFromContentField(
    messageObj?.content !== undefined ? messageObj.content : record.content,
  );
  const cleaned = normalizeSearchText(rawText);
  if (!cleaned || shouldSkipSystemNoise(cleaned)) return null;
  return { role, text: cleaned };
}

async function readBoundedFileText(filePath: string, fileSize: number): Promise<string> {
  if (fileSize <= 0) return '';
  if (fileSize <= MAX_RAW_FILE_READ_BYTES) {
    return await fsp.readFile(filePath, 'utf8');
  }
  // For very large transcripts, read both the head (initial user prompt & context)
  // and the tail (latest turns) so search stays bounded in time and memory.
  const half = Math.floor(MAX_RAW_FILE_READ_BYTES / 2);
  const handle = await fsp.open(filePath, 'r');
  try {
    const headBuf = Buffer.alloc(half);
    const tailBuf = Buffer.alloc(half);
    const headRead = await handle.read(headBuf, 0, half, 0);
    const tailStart = Math.max(half, fileSize - half);
    const tailRead = await handle.read(tailBuf, 0, half, tailStart);
    const headText = headBuf.subarray(0, headRead.bytesRead).toString('utf8');
    let tailText = tailBuf.subarray(0, tailRead.bytesRead).toString('utf8');
    const firstNewline = tailText.indexOf('\n');
    if (firstNewline >= 0) tailText = tailText.slice(firstNewline + 1);
    return `${headText}\n${tailText}`;
  } finally {
    await handle.close();
  }
}

export async function extractMessagesFromTranscript(
  provider: AgentProvider,
  filePath: string,
  fileSize: number,
  maxBytes = DEFAULT_MAX_TRANSCRIPT_BYTES,
  maxMessages = DEFAULT_MAX_MESSAGES_PER_SESSION,
): Promise<ExtractedMessage[]> {
  let raw = '';
  try {
    raw = await readBoundedFileText(filePath, fileSize);
  } catch {
    return [];
  }
  if (!raw) return [];

  const messages: ExtractedMessage[] = [];
  const seenText = new Set<string>();
  let totalChars = 0;
  let ordinal = 0;

  for (const line of raw.split('\n')) {
    if (messages.length >= maxMessages || totalChars >= maxBytes) break;
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    const parsed = parseTranscriptLine(provider, trimmedLine);
    if (!parsed) continue;
    const text = parsed.text.length > MAX_MESSAGE_TEXT_CHARS
      ? parsed.text.slice(0, MAX_MESSAGE_TEXT_CHARS)
      : parsed.text;
    // Codex logs often emit both event_msg and response_item for the same turn; dedupe consecutive/exact duplicates.
    const dedupeKey = `${parsed.role}:${text.slice(0, 200)}:${text.length}`;
    if (seenText.has(dedupeKey)) continue;
    seenText.add(dedupeKey);
    messages.push({
      ordinal: ordinal++,
      role: parsed.role,
      text,
    });
    totalChars += text.length;
  }

  return messages;
}

function mergeSnippetRanges(ranges: SessionSearchTextRange[]): SessionSearchTextRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SessionSearchTextRange[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i];
    const current = merged[merged.length - 1];
    if (next.start <= current.end) {
      if (next.end > current.end) current.end = next.end;
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

export function buildSearchSnippet(
  text: string,
  tokens: readonly string[],
  maxLength = SNIPPET_TARGET_LENGTH,
): { ranges: SessionSearchTextRange[]; snippet: string } {
  const clean = normalizeSearchText(text);
  if (!clean) return { snippet: '', ranges: [] };
  const lower = clean.toLowerCase();

  let anchor = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx !== -1 && (anchor === -1 || idx < anchor)) {
      anchor = idx;
    }
  }
  if (anchor === -1) anchor = 0;

  let start = Math.max(0, anchor - Math.floor(maxLength * 0.35));
  let end = Math.min(clean.length, start + maxLength);
  if (end - start < maxLength && start > 0) {
    start = Math.max(0, end - maxLength);
  }

  // Nudge start/end to word boundaries when nearby for cleaner excerpts.
  if (start > 0) {
    const spaceAfter = clean.indexOf(' ', start);
    if (spaceAfter !== -1 && spaceAfter < anchor && spaceAfter - start <= 16) {
      start = spaceAfter + 1;
    }
  }
  if (end < clean.length) {
    const spaceBefore = clean.lastIndexOf(' ', end);
    if (spaceBefore > anchor && end - spaceBefore <= 16) {
      end = spaceBefore;
    }
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  const slice = clean.slice(start, end);
  const snippet = `${prefix}${slice}${suffix}`;
  const lowerSnippet = snippet.toLowerCase();

  const ranges: SessionSearchTextRange[] = [];
  for (const token of tokens) {
    if (!token) continue;
    let cursor = 0;
    while (cursor < lowerSnippet.length) {
      const matchIndex = lowerSnippet.indexOf(token, cursor);
      if (matchIndex === -1) break;
      ranges.push({ start: matchIndex, end: matchIndex + token.length });
      cursor = matchIndex + token.length;
      if (ranges.length >= 24) break;
    }
  }

  return {
    snippet,
    ranges: mergeSnippetRanges(ranges),
  };
}

function sessionIdFromFilename(provider: AgentProvider, fileName: string, fullPath: string): string {
  if (provider === 'pi') {
    const match = fileName.match(PI_JSONL_RE);
    const id = String(match?.[1] || '').trim();
    return isSafePiSessionId(id) ? id : '';
  }
  if (provider === 'agy') {
    return fullPath.match(AGY_TRANSCRIPT_RE)?.[1] || '';
  }
  return fileName.match(UUID_JSONL_RE)?.[1] || '';
}

async function scanProviderHomeTranscripts(
  provider: AgentProvider,
  homePath: string,
): Promise<Map<string, TranscriptSourceFile>> {
  const result = new Map<string, TranscriptSourceFile>();
  if (!homePath || provider === 'opencode') return result;

  let roots: string[] = [];
  let maxDepth = 1;
  if (provider === 'codex') {
    roots = [path.join(homePath, 'sessions'), path.join(homePath, 'archived_sessions')];
    maxDepth = 3;
  } else if (provider === 'claude' || provider === 'qoder') {
    roots = [path.join(homePath, 'projects')];
    maxDepth = 1;
  } else if (provider === 'qwen') {
    roots = [path.join(homePath, 'projects')];
    maxDepth = 2;
  } else if (provider === 'pi') {
    const source = await resolvePiSessionSource(homePath).catch(() => null);
    roots = source?.root ? [source.root] : [path.join(homePath, 'sessions')];
    maxDepth = source?.layout === 'custom' ? 0 : 1;
  } else if (provider === 'agy') {
    const brainRoot = path.join(homePath, 'brain');
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(brainRoot, { withFileTypes: true });
    } catch {
      return result;
    }
    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory()) return;
      const transcriptPath = path.join(brainRoot, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = await fsp.stat(transcriptPath);
        if (stat.isFile() && stat.size > 0) {
          result.set(entry.name, { filePath: transcriptPath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // Ignore missing transcript.
      }
    }));
    return result;
  }

  let visited = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || visited >= 30_000) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= 30_000) return;
      visited += 1;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const sessionId = sessionIdFromFilename(provider, entry.name, fullPath);
      if (!sessionId) continue;
      try {
        const stat = await fsp.stat(fullPath);
        const existing = result.get(sessionId);
        if (!existing || stat.mtimeMs >= existing.mtimeMs) {
          result.set(sessionId, { filePath: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        }
      } catch {
        // Ignore transient ENOENT.
      }
    }
  };

  await Promise.all(roots.map(root => visit(root, 0)));
  return result;
}

function escapeFtsPrefixToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"*`;
}

export class AgentSessionSearchIndex {
  private readonly dbFile: string;
  private readonly maxMessagesPerSession: number;
  private readonly maxTranscriptBytesPerSession: number;
  private readonly sourceCacheTtlMs: number;
  private readonly defaultSyncBudgetMs: number;
  private db: SqliteDatabaseSync | null = null;
  private sqliteUnavailable = false;
  private disposed = false;
  private syncQueue: Promise<void> = Promise.resolve();
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly homeFilesCache = new Map<string, CachedHomeFiles>();

  constructor(options: AgentSessionSearchIndexOptions) {
    this.dbFile = options.dbFile;
    this.maxMessagesPerSession = options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
    this.maxTranscriptBytesPerSession = options.maxTranscriptBytesPerSession ?? DEFAULT_MAX_TRANSCRIPT_BYTES;
    this.sourceCacheTtlMs = options.sourceCacheTtlMs ?? DEFAULT_SOURCE_CACHE_TTL_MS;
    this.defaultSyncBudgetMs = options.syncBudgetMs ?? DEFAULT_SYNC_BUDGET_MS;
  }

  invalidateSourceCache(): void {
    this.homeFilesCache.clear();
  }

  dispose(): void {
    this.disposed = true;
    if (this.backgroundTimer) {
      clearTimeout(this.backgroundTimer);
      this.backgroundTimer = null;
    }
    this.homeFilesCache.clear();
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors during shutdown.
      }
      this.db = null;
    }
  }

  getIndexedSessionCount(): number {
    const db = this.ensureDb();
    if (!db) return 0;
    const row = db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
    return Number(row?.count || 0);
  }

  async syncSessions(
    sessions: readonly AgentSession[],
    options: { budgetMs?: number; scheduleRemainder?: boolean } = {},
  ): Promise<{ indexed: number; remaining: number }> {
    if (this.disposed) return { indexed: 0, remaining: 0 };
    const result = await this.enqueueSync(() => this.performSync(sessions, options.budgetMs ?? this.defaultSyncBudgetMs));
    if (result.remaining > 0 && options.scheduleRemainder !== false && !this.disposed) {
      this.scheduleBackgroundSync(sessions);
    }
    return result;
  }

  async search(
    sessions: readonly AgentSession[],
    query: unknown,
    options: AgentSessionFullTextSearchOptions = {},
  ): Promise<AgentSessionFullTextSearchResult> {
    const rawQuery = String(query || '').trim();
    const normalizedQuery = rawQuery.toLowerCase();
    const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(options.limit)))
      : DEFAULT_LIMIT;
    if (!normalizedQuery) {
      return {
        sessions: [],
        total: 0,
        query: '',
        scope: 'id-title-project-content',
      };
    }

    const tokens = parseSearchTokens(rawQuery);
    if (tokens.length === 0) {
      return {
        sessions: [],
        total: 0,
        query: normalizedQuery,
        scope: 'id-title-project-content',
      };
    }

    const projectNames = options.projectNames && typeof options.projectNames === 'object'
      ? options.projectNames
      : {};

    // Index new/changed sessions incrementally within bounded budget so searches stay fast.
    if (!this.disposed) {
      try {
        await this.syncSessions(sessions, {
          budgetMs: options.syncBudgetMs ?? this.defaultSyncBudgetMs,
          scheduleRemainder: true,
        });
      } catch {
        // Metadata search still succeeds even if SQLite/filesystem sync encounters an error.
      }
    }

    const sessionByKey = new Map<string, AgentSession>();
    for (const session of sessions) {
      const key = buildSessionKey(session);
      if (key) sessionByKey.set(key, session);
    }

    // 1. Metadata matches across ALL authoritative sessions (multi-token AND).
    const metadataMatches = new Map<string, {
      rank: number;
      source: SessionSearchMatchSource;
    }>();
    for (const [key, session] of sessionByKey.entries()) {
      const idText = String(session.id || '').toLowerCase();
      const titleText = String(session.title || '').toLowerCase();
      const workspaceText = String(session.workspace || '').toLowerCase();
      const cwdText = String(session.cwd || '').toLowerCase();
      const projectNameText = [
        projectNames[String(session.workspace || '')],
        projectNames[String(session.cwd || '')],
      ].filter(Boolean).join(' ').toLowerCase();
      const combined = `${idText}\n${titleText}\n${projectNameText}\n${workspaceText}\n${cwdText}`;

      if (!tokens.every(token => combined.includes(token))) continue;

      let source: SessionSearchMatchSource = 'project';
      let rank = 20;
      if (tokens.every(token => idText.includes(token))) {
        source = 'id';
        rank = idText === normalizedQuery ? 0 : 2;
      } else if (tokens.every(token => titleText.includes(token))) {
        source = 'title';
        rank = titleText === normalizedQuery ? 1 : (titleText.startsWith(normalizedQuery) ? 4 : 8);
      } else if (tokens.every(token => projectNameText.includes(token))) {
        source = 'project';
        rank = 14;
      }
      metadataMatches.set(key, { rank, source });
    }

    // 2. Full-text content matches from SQLite FTS5 + CJK/punctuation hybrid filter.
    const contentHits = this.queryContentMatches(tokens, sessionByKey, Math.max(limit * 3, 120));

    // 3. Merge metadata + content matches with deterministic ranking.
    interface RankedCandidate {
      rank: number;
      session: IndexedAgentSessionMatch;
      updatedAtMs: number;
    }
    const merged: RankedCandidate[] = [];
    const includedKeys = new Set<string>();

    for (const [key, meta] of metadataMatches.entries()) {
      const session = sessionByKey.get(key);
      if (!session) continue;
      includedKeys.add(key);
      const contentHit = contentHits.get(key);
      merged.push({
        rank: meta.rank,
        updatedAtMs: timestampMs(session.updatedAt || session.createdAt),
        session: {
          ...session,
          searchMatchSource: meta.source,
          ...(contentHit ? {
            searchSnippet: contentHit.snippet,
            searchSnippetRanges: contentHit.ranges,
          } : {}),
        },
      });
    }

    for (const [key, contentHit] of contentHits.entries()) {
      if (includedKeys.has(key)) continue;
      const session = sessionByKey.get(key);
      if (!session) continue;
      includedKeys.add(key);
      merged.push({
        rank: 50 + contentHit.rankOffset,
        updatedAtMs: timestampMs(session.updatedAt || session.createdAt),
        session: {
          ...session,
          searchMatchSource: 'content',
          searchSnippet: contentHit.snippet,
          searchSnippetRanges: contentHit.ranges,
        },
      });
    }

    merged.sort((left, right) => (
      left.rank - right.rank
      || right.updatedAtMs - left.updatedAtMs
      || String(left.session.id || '').localeCompare(String(right.session.id || ''))
    ));

    return {
      sessions: merged.slice(0, limit).map(entry => entry.session),
      total: merged.length,
      query: normalizedQuery,
      scope: 'id-title-project-content',
    };
  }

  private queryContentMatches(
    tokens: readonly string[],
    sessionByKey: ReadonlyMap<string, AgentSession>,
    candidateLimit: number,
  ): Map<string, { ranges: SessionSearchTextRange[]; rankOffset: number; snippet: string }> {
    const results = new Map<string, { ranges: SessionSearchTextRange[]; rankOffset: number; snippet: string }>();
    const db = this.ensureDb();
    if (!db || tokens.length === 0) return results;

    const ftsTokens: string[] = [];
    const likeTokens: string[] = [];
    for (const token of tokens) {
      if (ASCII_WORD_TOKEN_RE.test(token)) {
        ftsTokens.push(token);
      } else {
        likeTokens.push(token);
      }
    }

    const recordCandidate = (sessionKey: string, text: string, rankOffset: number) => {
      if (!sessionByKey.has(sessionKey)) return;
      if (results.has(sessionKey)) return;
      const { snippet, ranges } = buildSearchSnippet(text, tokens);
      if (!snippet) return;
      results.set(sessionKey, { snippet, ranges, rankOffset });
    };

    try {
      // Phase A: Single-message match (highest relevance — all tokens appear in the same message).
      if (ftsTokens.length > 0) {
        const ftsQuery = ftsTokens.map(escapeFtsPrefixToken).join(' ');
        const likeClauses = likeTokens.map(() => 'instr(m.lower_text, ?) > 0').join(' AND ');
        const sql = `
          SELECT m.session_key, m.text, bm25(session_messages_fts) AS bm25_score
          FROM session_messages_fts
          JOIN session_messages m ON m.id = session_messages_fts.rowid
          JOIN sessions s ON s.session_key = m.session_key
          WHERE session_messages_fts MATCH ?
            ${likeClauses ? `AND ${likeClauses}` : ''}
          ORDER BY bm25_score ASC, s.updated_at DESC
          LIMIT ?
        `;
        const rows = db.prepare(sql).all(ftsQuery, ...likeTokens, candidateLimit * 2);
        let order = 0;
        for (const row of rows) {
          const key = String(row.session_key || '');
          const text = String(row.text || '');
          recordCandidate(key, text, order * 0.01);
          order += 1;
          if (results.size >= candidateLimit) break;
        }
      } else {
        // Pure CJK / short / punctuation query: use bounded instr() scan ordered by recency.
        const likeClauses = likeTokens.map(() => 'instr(m.lower_text, ?) > 0').join(' AND ');
        const sql = `
          SELECT m.session_key, m.text
          FROM session_messages m
          JOIN sessions s ON s.session_key = m.session_key
          WHERE ${likeClauses}
          ORDER BY s.updated_at DESC, m.ordinal ASC
          LIMIT ?
        `;
        const rows = db.prepare(sql).all(...likeTokens, candidateLimit * 2);
        let order = 0;
        for (const row of rows) {
          const key = String(row.session_key || '');
          const text = String(row.text || '');
          recordCandidate(key, text, order * 0.01);
          order += 1;
          if (results.size >= candidateLimit) break;
        }
      }

      // Phase B: Cross-message session match for multi-token queries (e.g. token A in turn 1, token B in turn 4).
      if (tokens.length > 1 && results.size < candidateLimit) {
        const anchorToken = ftsTokens[0] || likeTokens[0];
        const anchorRows = ftsTokens.length > 0
          ? db.prepare(`
              SELECT DISTINCT m.session_key, m.text, s.updated_at
              FROM session_messages_fts
              JOIN session_messages m ON m.id = session_messages_fts.rowid
              JOIN sessions s ON s.session_key = m.session_key
              WHERE session_messages_fts MATCH ?
              ORDER BY s.updated_at DESC
              LIMIT ?
            `).all(escapeFtsPrefixToken(anchorToken), candidateLimit * 4)
          : db.prepare(`
              SELECT DISTINCT m.session_key, m.text, s.updated_at
              FROM session_messages m
              JOIN sessions s ON s.session_key = m.session_key
              WHERE instr(m.lower_text, ?) > 0
              ORDER BY s.updated_at DESC
              LIMIT ?
            `).all(anchorToken, candidateLimit * 4);

        const checkTokenStmt = db.prepare(
          'SELECT 1 AS found FROM session_messages WHERE session_key = ? AND instr(lower_text, ?) > 0 LIMIT 1',
        );
        const checkedSessions = new Set<string>();
        let crossOrder = 0;
        for (const row of anchorRows) {
          const key = String(row.session_key || '');
          if (!key || results.has(key) || checkedSessions.has(key) || !sessionByKey.has(key)) continue;
          checkedSessions.add(key);
          const allMatch = tokens.every(token => Boolean(checkTokenStmt.get(key, token)));
          if (allMatch) {
            recordCandidate(key, String(row.text || ''), 25 + crossOrder * 0.01);
            crossOrder += 1;
            if (results.size >= candidateLimit) break;
          }
        }
      }
    } catch {
      // Never fail a session search on transient SQLite query edge cases.
    }

    return results;
  }

  private enqueueSync<T>(work: () => Promise<T>): Promise<T> {
    const next = this.syncQueue.then(work, work);
    this.syncQueue = next.then(() => {}, () => {});
    return next;
  }

  private scheduleBackgroundSync(sessions: readonly AgentSession[]): void {
    if (this.disposed || this.backgroundTimer) return;
    const snapshot = [...sessions];
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      if (this.disposed) return;
      void this.syncSessions(snapshot, {
        budgetMs: 800,
        scheduleRemainder: true,
      }).catch(() => {});
    }, 150);
    this.backgroundTimer.unref?.();
  }

  private async resolveHomeFiles(
    provider: AgentProvider,
    homePath: string,
  ): Promise<Map<string, TranscriptSourceFile>> {
    const cacheKey = `${provider}\u0000${homePath}`;
    const now = Date.now();
    const cached = this.homeFilesCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.filesBySessionId;
    }
    const filesBySessionId = await scanProviderHomeTranscripts(provider, homePath);
    this.homeFilesCache.set(cacheKey, {
      expiresAt: now + this.sourceCacheTtlMs,
      filesBySessionId,
    });
    return filesBySessionId;
  }

  private async performSync(
    sessions: readonly AgentSession[],
    budgetMs: number,
  ): Promise<{ indexed: number; remaining: number }> {
    const db = this.ensureDb();
    if (!db || this.disposed) return { indexed: 0, remaining: 0 };

    const deadline = Date.now() + Math.max(50, budgetMs);

    // Collect distinct (provider, homePath) pairs and scan their transcript directories in parallel.
    const homeTargets = new Map<string, { homePath: string; provider: AgentProvider }>();
    for (const session of sessions) {
      const provider = normalizeProvider(session.provider);
      if (!provider || provider === 'opencode') continue;
      const homePath = String(session.providerHomePath || '').trim() || defaultHomeForProvider(provider);
      if (!homePath) continue;
      homeTargets.set(`${provider}\u0000${homePath}`, { provider, homePath });
    }
    const homeFileMaps = new Map<string, Map<string, TranscriptSourceFile>>();
    await Promise.all(Array.from(homeTargets.entries()).map(async ([key, target]) => {
      homeFileMaps.set(key, await this.resolveHomeFiles(target.provider, target.homePath));
    }));
    if (this.disposed) return { indexed: 0, remaining: 0 };

    // Load current stored metadata in one fast query.
    const storedByKey = new Map<string, StoredSessionRow>();
    for (const row of db.prepare(
      'SELECT session_key, title, updated_at, source_path, source_mtime_ms, source_size FROM sessions',
    ).all()) {
      storedByKey.set(String(row.session_key || ''), {
        title: String(row.title || ''),
        updated_at: String(row.updated_at || ''),
        source_path: String(row.source_path || ''),
        source_mtime_ms: Number(row.source_mtime_ms || 0),
        source_size: Number(row.source_size || 0),
      });
    }

    const activeKeys = new Set<string>();
    const dirtySessions: Array<{
      key: string;
      provider: AgentProvider;
      session: AgentSession;
      source: TranscriptSourceFile | null;
      updatedAtMs: number;
    }> = [];

    for (const session of sessions) {
      const provider = normalizeProvider(session.provider);
      if (!provider || !session.id) continue;
      const key = buildSessionKey(session);
      if (!key) continue;
      activeKeys.add(key);

      const homePath = String(session.providerHomePath || '').trim() || defaultHomeForProvider(provider);
      const source = homePath
        ? (homeFileMaps.get(`${provider}\u0000${homePath}`)?.get(session.id) ?? null)
        : null;
      const stored = storedByKey.get(key);
      const sourcePath = source?.filePath || '';
      const sourceMtimeMs = source?.mtimeMs || 0;
      const sourceSize = source?.size || 0;
      const title = String(session.title || '');
      const updatedAt = String(session.updatedAt || session.createdAt || '');

      const unchanged = stored
        && stored.source_path === sourcePath
        && stored.source_mtime_ms === sourceMtimeMs
        && stored.source_size === sourceSize
        && stored.title === title
        && stored.updated_at === updatedAt;
      if (!unchanged) {
        dirtySessions.push({
          key,
          provider,
          session,
          source,
          updatedAtMs: timestampMs(updatedAt),
        });
      }
    }

    // Prune deleted sessions.
    const removedKeys: string[] = [];
    for (const storedKey of storedByKey.keys()) {
      if (!activeKeys.has(storedKey)) removedKeys.push(storedKey);
    }
    if (removedKeys.length > 0) {
      const deleteMessagesStmt = db.prepare('DELETE FROM session_messages WHERE session_key = ?');
      const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE session_key = ?');
      db.exec('BEGIN');
      try {
        for (const key of removedKeys) {
          deleteMessagesStmt.run(key);
          deleteSessionStmt.run(key);
        }
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    }

    if (dirtySessions.length === 0) {
      return { indexed: 0, remaining: 0 };
    }

    // Prioritize most recently updated sessions first.
    dirtySessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

    const upsertSessionStmt = db.prepare(`
      INSERT INTO sessions (
        session_key, provider, provider_home_id, session_id, title,
        workspace, cwd, updated_at, source_path, source_mtime_ms, source_size, indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        title = excluded.title,
        workspace = excluded.workspace,
        cwd = excluded.cwd,
        updated_at = excluded.updated_at,
        source_path = excluded.source_path,
        source_mtime_ms = excluded.source_mtime_ms,
        source_size = excluded.source_size,
        indexed_at = excluded.indexed_at
    `);
    const deleteMessagesStmt = db.prepare('DELETE FROM session_messages WHERE session_key = ?');
    const insertMessageStmt = db.prepare(
      'INSERT INTO session_messages (session_key, ordinal, role, text, lower_text) VALUES (?, ?, ?, ?, ?)',
    );

    let indexed = 0;
    for (let index = 0; index < dirtySessions.length; index += 1) {
      if (this.disposed) break;
      if (indexed > 0 && Date.now() >= deadline) break;

      const item = dirtySessions[index];
      const messages = item.source
        ? await extractMessagesFromTranscript(
            item.provider,
            item.source.filePath,
            item.source.size,
            this.maxTranscriptBytesPerSession,
            this.maxMessagesPerSession,
          )
        : [];
      if (this.disposed) break;

      const now = Date.now();
      db.exec('BEGIN');
      try {
        upsertSessionStmt.run(
          item.key,
          item.provider,
          String(item.session.providerHomeId || 'default'),
          String(item.session.id || ''),
          String(item.session.title || ''),
          String(item.session.workspace || ''),
          String(item.session.cwd || ''),
          String(item.session.updatedAt || item.session.createdAt || ''),
          item.source?.filePath || '',
          item.source?.mtimeMs || 0,
          item.source?.size || 0,
          now,
        );
        deleteMessagesStmt.run(item.key);
        for (const msg of messages) {
          insertMessageStmt.run(
            item.key,
            msg.ordinal,
            msg.role,
            msg.text,
            msg.text.toLowerCase(),
          );
        }
        db.exec('COMMIT');
        indexed += 1;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    }

    return {
      indexed,
      remaining: Math.max(0, dirtySessions.length - indexed),
    };
  }

  private ensureDb(): SqliteDatabaseSync | null {
    if (this.disposed || this.sqliteUnavailable) return null;
    if (this.db) return this.db;
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      this.sqliteUnavailable = true;
      return null;
    }

    try {
      fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
      const db = new sqlite.DatabaseSync(this.dbFile, { timeout: 3000 });
      this.initializeSchema(db);
      this.db = db;
      return db;
    } catch {
      // Derived cache DB: recreate cleanly on corruption or schema drift.
      try {
        for (const suffix of ['', '-wal', '-shm']) {
          const candidate = `${this.dbFile}${suffix}`;
          if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
        }
        const db = new sqlite.DatabaseSync(this.dbFile, { timeout: 3000 });
        this.initializeSchema(db);
        this.db = db;
        return db;
      } catch {
        this.sqliteUnavailable = true;
        return null;
      }
    }
  }

  private initializeSchema(db: SqliteDatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA temp_store = MEMORY;');

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (versionRow && String(versionRow.value) !== SCHEMA_VERSION) {
      db.exec(`
        DROP TRIGGER IF EXISTS session_messages_ai;
        DROP TRIGGER IF EXISTS session_messages_ad;
        DROP TRIGGER IF EXISTS session_messages_au;
        DROP TABLE IF EXISTS session_messages_fts;
        DROP TABLE IF EXISTS session_messages;
        DROP TABLE IF EXISTS sessions;
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_home_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        cwd TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_mtime_ms REAL NOT NULL,
        source_size INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at
        ON sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        lower_text TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_key
        ON session_messages(session_key);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts
        USING fts5(text, content='session_messages', content_rowid='id', tokenize='unicode61');

      CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO session_messages_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
  }
}
