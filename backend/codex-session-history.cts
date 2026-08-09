import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { finished } from 'stream/promises';
import { stripCodexInternalContextBlocks } from './codex-transcript-sanitizer.cjs';

type JsonRecord = Record<string, unknown>;

interface SessionIndexEntry {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  workspace: string;
}

interface AutomationSchedule {
  id: string;
  kind: string;
  name: string;
  status: string;
  rrule: string;
  label: string;
}

interface RecentFileCandidate {
  filePath: string;
  mtimeMs: number;
}

interface SessionMetadata {
  filePath: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  id: string;
  cwd: string;
  source: string;
  cliVersion: string;
  model: string;
  effort: string;
  preview: string;
  firstUserMessage: string;
}

interface CodexSessionIdentity {
  id: string;
  createdAt: string;
  cwd: string;
  workspace: string;
}

interface ListCodexSessionIdentitiesOptions {
  codexHome?: string;
  startedAt?: unknown;
  windowMs?: unknown;
}

interface CodexGlobalState {
  pinnedIds: Set<string>;
  projectlessIds: Set<string>;
  unreadIds: Set<string>;
  workspaceHints: JsonRecord;
  workspaceRoots: string[];
}

interface CodexSession {
  id: string;
  title: string;
  cwd: string;
  workspace: string;
  updatedAt: string;
  createdAt: string;
  archived: boolean;
  pinned: boolean;
  unread: boolean;
  projectless: boolean;
  model: string;
  effort: string;
  cliVersion: string;
  source: string;
  preview: string;
  firstUserMessage: string;
  schedule: AutomationSchedule | undefined;
}

interface ListCodexSessionsOptions {
  codexHome?: string;
  limit?: number;
  scanLimit?: number;
}

function jsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object'
    ? value as JsonRecord
    : null;
}

const DEFAULT_LIMIT = 40;
const DEFAULT_SCAN_LIMIT = 400;
const MAX_SESSION_HISTORY_LIMIT = 5000;
const MAX_SESSION_HISTORY_SCAN_LIMIT = 5000;
const MAX_SCAN_DIRECTORIES = 2000;
const SESSION_INDEX_TAIL_BYTES = 4 * 1024 * 1024;
const RECENT_FILE_CANDIDATE_MULTIPLIER = 4;
const RECENT_FILE_STAT_CONCURRENCY = 32;
const SESSION_METADATA_READ_CONCURRENCY = 16;
const USER_MESSAGE_BEGIN = '## My request for Codex:';
const IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER = '[Image]';
const MAX_PREVIEW_LENGTH = 160;
const ACTIVE_AUTOMATION_STATUS = 'ACTIVE';

async function readJsonFile(filePath: string, fallback: JsonRecord = {}): Promise<JsonRecord> {
  try {
    return jsonRecord(JSON.parse(await fsp.readFile(filePath, 'utf8'))) || fallback;
  } catch {
    return fallback;
  }
}

function firstStringValue(object: unknown, keys: readonly string[]): string {
  const record = jsonRecord(object);
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function normalizePathValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function isTemporaryWorkspace(workspace: unknown): boolean {
  const value = normalizePathValue(workspace);
  return value === '/tmp'
    || value.startsWith('/tmp/')
    || value === '/private/tmp'
    || value.startsWith('/private/tmp/')
    || value === '/var/tmp'
    || value.startsWith('/var/tmp/')
    || value === '/private/var/tmp'
    || value.startsWith('/private/var/tmp/')
    || value === '/var/folders'
    || value.startsWith('/var/folders/')
    || value === '/private/var/folders'
    || value.startsWith('/private/var/folders/');
}

function hasTemporaryWorkspaceReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /(^|[\s"'`:=])\/(?:tmp|private\/tmp|var\/tmp|private\/var\/tmp|var\/folders|private\/var\/folders)(?:[/\s"'`,}]|$)/.test(value);
}

function isPathInside(root: unknown, target: unknown): boolean {
  const normalizedRoot = normalizePathValue(root);
  const normalizedTarget = normalizePathValue(target);
  if (!normalizedRoot || !normalizedTarget) return false;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function uniqueWorkspaceRoots(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values
    .map(normalizePathValue)
    .filter(Boolean)
    .filter(value => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .sort((a, b) => b.length - a.length);
}

function bestWorkspaceRootForCwd(cwd: string, workspaceRoots: string[]): string {
  return workspaceRoots.find(root => isPathInside(root, cwd)) || '';
}

async function readSessionIndex(codexHome: string): Promise<Map<string, SessionIndexEntry>> {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const entries = new Map<string, SessionIndexEntry>();
  let text = '';
  let handle: fsp.FileHandle | null = null;
  try {
    const stat = await fsp.stat(indexPath);
    const start = Math.max(0, stat.size - SESSION_INDEX_TAIL_BYTES);
    const length = stat.size - start;
    handle = await fsp.open(indexPath, 'r');
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
  } catch {
    return entries;
  } finally {
    await handle?.close().catch(() => {});
  }

  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = jsonRecord(JSON.parse(line));
      if (!entry || typeof entry.id !== 'string') continue;
      entries.set(entry.id, {
        id: entry.id,
        title: typeof entry.thread_name === 'string' ? entry.thread_name : '',
        updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : '',
        cwd: firstStringValue(entry, ['cwd', 'working_directory', 'workingDirectory']),
        workspace: firstStringValue(entry, ['workspace', 'workspace_root', 'workspaceRoot']),
      });
    } catch {
      // Ignore individual corrupt index lines.
    }
  }

  return entries;
}

function parseFlatTomlValue(value: unknown): string | number | boolean {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function parseFlatToml(text: unknown): JsonRecord {
  const result: JsonRecord = {};
  String(text || '').split('\n').forEach(line => {
    const withoutComment = line.replace(/\s+#.*$/, '').trim();
    if (!withoutComment || withoutComment.startsWith('[')) return;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(withoutComment);
    if (!match) return;
    result[match[1]] = parseFlatTomlValue(match[2]);
  });
  return result;
}

function formatAutomationRRuleLabel(rrule: unknown): string {
  const parts = new Map<string, string>();
  String(rrule || '').split(';').forEach(part => {
    const [key, value] = part.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  });

  const freq = parts.get('FREQ') || '';
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') || '1', 10) || 1);
  const unitsByFrequency: Record<string, [string, string] | undefined> = {
    MINUTELY: ['minute', 'minutes'],
    HOURLY: ['hour', 'hours'],
    DAILY: ['day', 'days'],
    WEEKLY: ['week', 'weeks'],
    MONTHLY: ['month', 'months'],
  };
  const units = unitsByFrequency[freq];

  if (!units) return '';
  return interval === 1 ? `Every ${units[0]}` : `Every ${interval} ${units[1]}`;
}

function normalizeAutomationSchedule(raw: unknown): AutomationSchedule | null {
  const record = jsonRecord(raw);
  if (!record) return null;
  const status = typeof record.status === 'string' ? record.status.trim().toUpperCase() : '';
  const targetThreadId = typeof record.target_thread_id === 'string'
    ? record.target_thread_id.trim()
    : '';
  const rrule = typeof record.rrule === 'string' ? record.rrule.trim() : '';
  if (status !== ACTIVE_AUTOMATION_STATUS || !targetThreadId || !rrule) return null;

  return {
    id: typeof record.id === 'string' ? record.id.trim() : '',
    kind: typeof record.kind === 'string' ? record.kind.trim() : '',
    name: typeof record.name === 'string' ? record.name.trim() : '',
    status,
    rrule,
    label: formatAutomationRRuleLabel(rrule),
  };
}

async function readCodexAutomationSchedules(codexHome: string): Promise<Map<string, AutomationSchedule>> {
  const automationsDir = path.join(codexHome, 'automations');
  const schedules = new Map<string, AutomationSchedule>();
  let entries: fs.Dirent[] = [];

  try {
    entries = await fsp.readdir(automationsDir, { withFileTypes: true });
  } catch {
    return schedules;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(automationsDir, entry.name, 'automation.toml');
    let raw: JsonRecord;
    try {
      raw = parseFlatToml(await fsp.readFile(filePath, 'utf8'));
    } catch {
      continue;
    }
    const schedule = normalizeAutomationSchedule(raw);
    const targetThreadId = typeof raw.target_thread_id === 'string'
      ? raw.target_thread_id.trim()
      : '';
    if (schedule && targetThreadId) schedules.set(targetThreadId, schedule);
  }

  return schedules;
}

function sortDirectoryEntriesForRecentScan(entries: fs.Dirent[]): fs.Dirent[] {
  return entries.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return b.name.localeCompare(a.name);
  });
}

function pruneRecentFileCandidates(
  files: RecentFileCandidate[],
  limit: number,
): RecentFileCandidate[] {
  if (files.length <= limit) return files;
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function collectRecentJsonlFiles(root: string, limit: number): RecentFileCandidate[] {
  const candidateLimit = Math.max(limit, limit * RECENT_FILE_CANDIDATE_MULTIPLIER);
  const directories = [root];
  let visitedDirectories = 0;
  let files: RecentFileCandidate[] = [];

  while (directories.length > 0 && visitedDirectories < MAX_SCAN_DIRECTORIES) {
    const directory = directories.pop();
    if (!directory) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirectories += 1;

    const sortedEntries = sortDirectoryEntriesForRecentScan(entries);
    for (let index = sortedEntries.length - 1; index >= 0; index -= 1) {
      const entry = sortedEntries[index];
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
    }

    for (const entry of sortedEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(directory, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(filePath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      files.push({ filePath, mtimeMs });
      if (files.length > candidateLimit * 2) {
        files = pruneRecentFileCandidates(files, candidateLimit);
      }
    }

    if (files.length >= candidateLimit && directories.length > limit) {
      directories.splice(0, directories.length - limit);
    }
  }

  return pruneRecentFileCandidates(files, limit);
}

async function collectRecentJsonlFilesAsync(
  root: string,
  limit: number,
): Promise<RecentFileCandidate[]> {
  const candidateLimit = Math.max(limit, limit * RECENT_FILE_CANDIDATE_MULTIPLIER);
  const directories = [root];
  let visitedDirectories = 0;
  let files: RecentFileCandidate[] = [];

  while (directories.length > 0 && visitedDirectories < MAX_SCAN_DIRECTORIES) {
    const directory = directories.pop();
    if (!directory) break;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirectories += 1;

    const sortedEntries = sortDirectoryEntriesForRecentScan(entries);
    for (let index = sortedEntries.length - 1; index >= 0; index -= 1) {
      const entry = sortedEntries[index];
      if (entry.isDirectory()) directories.push(path.join(directory, entry.name));
    }

    const fileEntries = sortedEntries.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'));
    for (let offset = 0; offset < fileEntries.length; offset += RECENT_FILE_STAT_CONCURRENCY) {
      const candidates = await Promise.all(
        fileEntries.slice(offset, offset + RECENT_FILE_STAT_CONCURRENCY).map(async entry => {
          const filePath = path.join(directory, entry.name);
          try {
            return { filePath, mtimeMs: (await fsp.stat(filePath)).mtimeMs };
          } catch {
            return { filePath, mtimeMs: 0 };
          }
        }),
      );
      files.push(...candidates);
      if (files.length > candidateLimit * 2) {
        files = pruneRecentFileCandidates(files, candidateLimit);
      }
    }

    if (files.length >= candidateLimit && directories.length > limit) {
      directories.splice(0, directories.length - limit);
    }
  }

  return pruneRecentFileCandidates(files, limit);
}

function sessionIdFromFilePath(filePath: string): string {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function normalizePreviewText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW_LENGTH);
}

function stripUserMessagePrefix(value: unknown): string {
  if (typeof value !== 'string') return '';
  const index = value.indexOf(USER_MESSAGE_BEGIN);
  return index >= 0
    ? value.slice(index + USER_MESSAGE_BEGIN.length).trim()
    : value.trim();
}

function eventMessagePreview(event: unknown): string {
  const eventRecord = jsonRecord(event);
  const payload = jsonRecord(eventRecord?.payload);
  if (!payload || typeof payload.type !== 'string') return '';

  if (payload.type === 'user_message') {
    const message = normalizePreviewText(stripCodexInternalContextBlocks(stripUserMessagePrefix(payload.message)));
    if (message) return message;

    const hasRemoteImages = Array.isArray(payload.images) && payload.images.length > 0;
    const hasLocalImages = Array.isArray(payload.local_images) && payload.local_images.length > 0;
    return hasRemoteImages || hasLocalImages ? IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER : '';
  }

  if (payload.type === 'thread_goal_updated') {
    return normalizePreviewText(jsonRecord(payload.goal)?.objective);
  }

  return '';
}

async function readSessionMetadata(
  filePath: string,
  maxLines = 80,
): Promise<SessionMetadata | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const fileSessionId = sessionIdFromFilePath(filePath);
  const metadata = {
    filePath,
    archived: filePath.includes(`${path.sep}archived_sessions${path.sep}`),
    createdAt: '',
    updatedAt: '',
    id: fileSessionId,
    cwd: '',
    source: '',
    cliVersion: '',
    model: '',
    effort: '',
    preview: '',
    firstUserMessage: '',
  };
  let lineCount = 0;

  try {
    for await (const line of reader) {
      if (!line) continue;
      lineCount += 1;

      try {
        const event = jsonRecord(JSON.parse(line));
        if (!event) throw new Error('Codex session event must be an object');
        if (typeof event.timestamp === 'string') {
          metadata.updatedAt = event.timestamp;
        }

        if (event.type === 'session_meta') {
          const payload = jsonRecord(event.payload);
          const payloadId = typeof payload?.id === 'string' ? payload.id : '';
          if (fileSessionId && payloadId && payloadId !== fileSessionId) {
            continue;
          }

          metadata.createdAt = typeof event.timestamp === 'string'
            ? event.timestamp
            : metadata.createdAt;
          metadata.id = payloadId || metadata.id;
          metadata.cwd = typeof payload?.cwd === 'string'
            ? payload.cwd
            : metadata.cwd;
          metadata.source = typeof payload?.source === 'string'
            ? payload.source
            : metadata.source;
          metadata.cliVersion = typeof payload?.cli_version === 'string'
            ? payload.cli_version
            : metadata.cliVersion;
        } else if (event.type === 'turn_context') {
          const payload = jsonRecord(event.payload);
          metadata.cwd = typeof payload?.cwd === 'string'
            ? payload.cwd
            : metadata.cwd;
          metadata.model = typeof payload?.model === 'string'
            ? payload.model
            : metadata.model;
          metadata.effort = typeof payload?.effort === 'string'
            ? payload.effort
            : metadata.effort;
        } else if (event.type === 'event_msg') {
          const preview = eventMessagePreview(event);
          if (preview) {
            if (!metadata.preview) metadata.preview = preview;
            if (
              jsonRecord(event.payload)?.type === 'user_message'
              && !metadata.firstUserMessage
            ) {
              metadata.firstUserMessage = preview;
            }
          }
        }
      } catch {
        // Ignore individual corrupt event lines.
      }

      if (
        lineCount >= maxLines
        || (
          metadata.id
          && metadata.cwd
          && metadata.model
          && metadata.effort
          && metadata.preview
          && metadata.firstUserMessage
        )
      ) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    await finished(stream).catch(() => {});
  }

  return metadata.id ? metadata : null;
}

function codexSessionDateKeys(startedAt: unknown, windowMs: unknown): string[] {
  const center = Number(startedAt);
  const radius = Math.max(0, Number(windowMs) || 0);
  if (!Number.isFinite(center) || center <= 0) return [];
  const cursor = new Date(center - radius);
  cursor.setHours(0, 0, 0, 0);
  const lastDay = new Date(center + radius);
  lastDay.setHours(0, 0, 0, 0);
  const keys: string[] = [];
  while (cursor <= lastDay) {
    keys.push([
      cursor.getFullYear(),
      String(cursor.getMonth() + 1).padStart(2, '0'),
      String(cursor.getDate()).padStart(2, '0'),
    ].join('-'));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

async function readCodexSessionIdentity(filePath: string): Promise<CodexSessionIdentity | null> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(filePath, 'r');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const chunks = [];
    let bytesReadTotal = 0;
    let lineEnd = -1;
    while (bytesReadTotal < 1024 * 1024 && lineEnd < 0) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytesReadTotal);
      if (bytesRead <= 0) break;
      const current = Buffer.from(chunk.subarray(0, bytesRead));
      chunks.push(current);
      const newlineIndex = current.indexOf(0x0a);
      if (newlineIndex >= 0) lineEnd = bytesReadTotal + newlineIndex;
      bytesReadTotal += bytesRead;
    }
    const header = Buffer.concat(chunks);
    const firstLine = header.subarray(0, lineEnd >= 0 ? lineEnd : header.length).toString('utf8').replace(/\r$/, '');
    const fileSessionId = sessionIdFromFilePath(filePath);
    const event = jsonRecord(JSON.parse(firstLine));
    if (event?.type !== 'session_meta') return null;
    const payload = jsonRecord(event.payload) || {};
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!id || (fileSessionId && id !== fileSessionId)) return null;
    const cwd = typeof payload.cwd === 'string' ? normalizePathValue(payload.cwd) : '';
    return {
      id,
      createdAt: typeof event.timestamp === 'string' ? event.timestamp : '',
      cwd,
      workspace: cwd,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function listCodexSessionIdentities(
  options: ListCodexSessionIdentitiesOptions = {},
): Promise<CodexSessionIdentity[]> {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const startedAt = Number(options.startedAt);
  const windowMs = Math.max(0, Number(options.windowMs) || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return [];

  const files: string[] = [];
  for (const dateKey of codexSessionDateKeys(startedAt, windowMs)) {
    const [year, month, day] = dateKey.split('-');
    const directory = path.join(codexHome, 'sessions', year, month, day);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      files.push(path.join(directory, entry.name));
    }
  }

  const identities: CodexSessionIdentity[] = [];
  const batchSize = 32;
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = await Promise.all(
      files.slice(offset, offset + batchSize).map(readCodexSessionIdentity)
    );
    identities.push(...batch.filter(
      (identity): identity is CodexSessionIdentity => identity !== null,
    ));
  }
  return identities;
}

function stringSet(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [],
  );
}

async function getGlobalState(codexHome: string): Promise<CodexGlobalState> {
  const state = await readJsonFile(path.join(codexHome, '.codex-global-state.json'), {});
  const atom = jsonRecord(state['electron-persisted-atom-state']) || {};
  const unreadByHost = jsonRecord(atom['unread-thread-ids-by-host-v1']) || {};
  const workspaceHints = jsonRecord(state['thread-workspace-root-hints']) || {};

  return {
    pinnedIds: stringSet(state['pinned-thread-ids']),
    projectlessIds: stringSet(state['projectless-thread-ids']),
    unreadIds: stringSet(unreadByHost.local),
    workspaceHints,
    workspaceRoots: uniqueWorkspaceRoots([
      ...(Array.isArray(state['active-workspace-roots']) ? state['active-workspace-roots'] : []),
      ...(Array.isArray(state['electron-saved-workspace-roots']) ? state['electron-saved-workspace-roots'] : []),
      ...Object.keys(state['electron-workspace-root-labels'] && typeof state['electron-workspace-root-labels'] === 'object'
        ? state['electron-workspace-root-labels']
        : {}),
      ...Object.values(workspaceHints),
    ]),
  };
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveSessionWorkspace(
  id: string,
  cwd: string,
  indexed: SessionIndexEntry | undefined,
  globalState: CodexGlobalState,
): string {
  const hintedWorkspace = normalizePathValue(globalState.workspaceHints[id]);
  if (hintedWorkspace) return hintedWorkspace;

  const indexedWorkspace = normalizePathValue(indexed?.workspace);
  if (indexedWorkspace) return indexedWorkspace;

  const workspaceRoot = bestWorkspaceRootForCwd(cwd, globalState.workspaceRoots);
  if (workspaceRoot) return workspaceRoot;

  return normalizePathValue(cwd || indexed?.cwd || '');
}

async function listCodexSessions(
  options: ListCodexSessionsOptions = {},
): Promise<CodexSession[]> {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = typeof options.scanLimit === 'number' && Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_SESSION_HISTORY_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;

  const [index, globalState, automationSchedules, sessionFileGroups] = await Promise.all([
    readSessionIndex(codexHome),
    getGlobalState(codexHome),
    readCodexAutomationSchedules(codexHome),
    Promise.all([
      collectRecentJsonlFilesAsync(path.join(codexHome, 'sessions'), scanLimit),
      collectRecentJsonlFilesAsync(path.join(codexHome, 'archived_sessions'), scanLimit),
    ]),
  ]);
  const sessionFiles = sessionFileGroups
    .flat()
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scanLimit);

  const sessions = new Map<string, CodexSession>();
  const skippedTemporaryIds = new Set<string>();
  for (let offset = 0; offset < sessionFiles.length; offset += SESSION_METADATA_READ_CONCURRENCY) {
    const metadataBatch = await Promise.all(
      sessionFiles.slice(offset, offset + SESSION_METADATA_READ_CONCURRENCY).map(async candidate => ({
        candidate,
        metadata: await readSessionMetadata(candidate.filePath),
      })),
    );
    for (const { candidate: { mtimeMs }, metadata } of metadataBatch) {
      if (!metadata) continue;
      const indexed = index.get(metadata.id);
      const cwd = normalizePathValue(metadata.cwd || indexed?.cwd || globalState.workspaceHints[metadata.id] || indexed?.workspace || '');
      const workspace = resolveSessionWorkspace(metadata.id, cwd, indexed, globalState);
      const title = stripCodexInternalContextBlocks(indexed?.title) || metadata.firstUserMessage || metadata.preview || 'Codex session';
      if (isTemporaryWorkspace(cwd) || isTemporaryWorkspace(workspace) || hasTemporaryWorkspaceReference(title)) {
        skippedTemporaryIds.add(metadata.id);
        continue;
      }
      sessions.set(metadata.id, {
        id: metadata.id,
        title,
        cwd,
        workspace,
        updatedAt: indexed?.updatedAt || metadata.updatedAt || new Date(mtimeMs).toISOString(),
        createdAt: metadata.createdAt,
        archived: metadata.archived,
        pinned: globalState.pinnedIds.has(metadata.id),
        unread: globalState.unreadIds.has(metadata.id),
        projectless: globalState.projectlessIds.has(metadata.id),
        model: metadata.model,
        effort: metadata.effort,
        cliVersion: metadata.cliVersion,
        source: metadata.source,
        preview: metadata.preview,
        firstUserMessage: metadata.firstUserMessage,
        schedule: automationSchedules.get(metadata.id),
      });
    }
  }

  for (const [id, indexed] of index.entries()) {
    if (sessions.has(id) || skippedTemporaryIds.has(id)) continue;
    const cwd = normalizePathValue(indexed.cwd || globalState.workspaceHints[id] || indexed.workspace || '');
    const workspace = resolveSessionWorkspace(id, cwd, indexed, globalState);
    const title = stripCodexInternalContextBlocks(indexed.title) || 'Codex session';
    if (isTemporaryWorkspace(cwd) || isTemporaryWorkspace(workspace) || hasTemporaryWorkspaceReference(title)) continue;
    sessions.set(id, {
      id,
      title,
      cwd,
      workspace,
      updatedAt: indexed.updatedAt,
      createdAt: '',
      archived: false,
      pinned: globalState.pinnedIds.has(id),
      unread: globalState.unreadIds.has(id),
      projectless: globalState.projectlessIds.has(id),
      model: '',
      effort: '',
      cliVersion: '',
      source: '',
      preview: '',
      firstUserMessage: '',
      schedule: automationSchedules.get(id),
    });
  }

  return Array.from(sessions.values())
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

export {
  codexSessionDateKeys,
  hasTemporaryWorkspaceReference,
  isTemporaryWorkspace,
  listCodexSessionIdentities,
  listCodexSessions,
  readSessionIndex,
  readSessionMetadata,
  sessionIdFromFilePath,
  eventMessagePreview,
  formatAutomationRRuleLabel,
  readCodexAutomationSchedules,
  collectRecentJsonlFiles,
};
export type {
  AutomationSchedule,
  CodexSession,
  CodexSessionIdentity,
  ListCodexSessionIdentitiesOptions,
  ListCodexSessionsOptions,
  SessionMetadata,
};
