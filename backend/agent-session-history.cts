import { execFile } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { finished } from 'stream/promises';
import {
  formatAutomationRRuleLabel,
  hasTemporaryWorkspaceReference,
  isTemporaryWorkspace,
  listCodexSessions,
} from './codex-session-history.cjs';
import { isSafeProviderSessionId } from './provider-session-id.cjs';

const DEFAULT_LIMIT = 60;
const DEFAULT_SCAN_LIMIT = 500;
const MAX_AGENT_SESSION_HISTORY_LIMIT = 5000;
const MAX_AGENT_SESSION_SCAN_LIMIT = 5000;
const CLAUDE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const QODER_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const QWEN_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_FILE_SCAN_DIRECTORIES = 2000;
const AGENT_PROVIDER_IDS = ['codex', 'claude', 'opencode', 'qoder', 'qwen'] as const;
type AgentProvider = typeof AGENT_PROVIDER_IDS[number];
const PROVIDERS = new Set<string>(AGENT_PROVIDER_IDS);

interface HistoryRecord extends Record<string, unknown> {
  automation?: HistoryRecord;
  message?: HistoryRecord;
  metadata?: HistoryRecord;
  options?: HistoryRecord;
  request?: HistoryRecord;
  schedule?: HistoryRecord;
  systemPayload?: HistoryRecord;
}

interface ActiveSchedule {
  id: string;
  kind: string;
  label: string;
  name: string;
  rrule: string;
  status: string;
}

interface AgentSession {
  archived?: boolean;
  capabilities?: string[];
  cliVersion?: string;
  createdAt?: string;
  cwd?: string;
  effort?: string;
  id?: string;
  model?: string;
  pinned?: boolean;
  projectless?: boolean;
  provider?: string;
  providerHomeId?: string;
  providerHomePath?: string;
  providerName?: string;
  schedule?: ActiveSchedule;
  source?: string;
  title?: string;
  unread?: boolean;
  updatedAt?: string;
  workspace?: string;
}

interface AgentSessionCursor extends AgentSession {
  id: string;
  provider: string;
  providerHomeId: string;
  updatedAt: string;
}

interface PaginationOptions {
  cursor?: unknown;
  limit?: number;
}

interface AgentSessionPage {
  hasMore: boolean;
  invalidCursor: boolean;
  nextCursor: string;
  sessions: AgentSession[];
}

interface SearchOptions {
  limit?: number;
  projectNames?: Record<string, string>;
}

interface AgentSessionSearchResult {
  query: string;
  scope: 'id-title-project';
  sessions: AgentSession[];
  total: number;
}

interface RecentFile {
  filePath: string;
  mtimeMs: number;
}

interface ClaudePromptHistoryEntry {
  title: string;
  updatedAt: string;
  workspace: string;
}

interface ClaudeSessionMetadata {
  createdAt: string;
  cwd: string;
  effort: string;
  filePath: string;
  id: string;
  model: string;
  schedule: ActiveSchedule | null;
  source: string;
  title: string;
  updatedAt: string;
  workspace: string;
}

interface QoderSessionMetadata {
  cliVersion: string;
  createdAt: string;
  cwd: string;
  effort: string;
  filePath: string;
  firstPrompt: string;
  id: string;
  lastPrompt: string;
  model: string;
  source: string;
  title: string;
  updatedAt: string;
  workspace: string;
}

interface QwenSessionMetadata {
  cliVersion: string;
  createdAt: string;
  cwd: string;
  filePath: string;
  firstPrompt: string;
  id: string;
  model: string;
  source: string;
  title: string;
  updatedAt: string;
  workspace: string;
}

interface ProviderHome {
  id?: unknown;
  path?: unknown;
}

type OpenCodeListRunner = (options: OpenCodeListOptions) => unknown | PromiseLike<unknown>;

interface ProviderListOptions {
  claudeHome?: string;
  codexHome?: string;
  limit?: number;
  opencodeBin?: string;
  opencodeHome?: string;
  qoderHome?: string;
  qwenHome?: string;
  runOpenCodeSessionList?: OpenCodeListRunner;
  scanLimit?: number;
}

interface OpenCodeListOptions {
  maxCount?: number;
  opencodeBin?: string;
  opencodeHome?: string;
}

interface AgentSessionHistoryOptions extends ProviderListOptions {
  providerHomeId?: string;
  providerHomes?: Partial<Record<AgentProvider, ProviderHome[]>>;
  providerSessionBindings?: ProviderSessionHomeBinding[];
  providerLimit?: number;
  providers?: unknown[];
}

interface ProviderSessionHomeBinding {
  provider: string;
  providerHomeId: string;
  providerHomePath: string;
  providerSessionId: string;
}

interface ResumeCommandOptions {
  cwd?: unknown;
  fork?: boolean;
  modelProvider?: unknown;
  providerHomePath?: unknown;
}

type ProviderListFunction = (options?: ProviderListOptions) => Promise<AgentSession[]>;
type SessionNormalizer = (session: AgentSession) => AgentSession;
type ProviderHomeOptionKey = 'claudeHome' | 'codexHome' | 'qoderHome' | 'qwenHome';

interface ProviderHistoryListContext {
  limit: number;
  options: AgentSessionHistoryOptions;
  providerHomes: Partial<Record<AgentProvider, ProviderHome[]>>;
}

interface ProviderHistoryDefinition {
  id: AgentProvider;
  buildResumeCommand: (sessionId: string, options: ResumeCommandOptions) => string;
  isVisible?: (session: AgentSession) => boolean;
  listSessions: (context: ProviderHistoryListContext) => Promise<AgentSession[]>;
  staleAutoResumeErrorPatterns?: readonly RegExp[];
  supportsUnarchive?: boolean;
}

function isHistoryRecord(value: unknown): value is HistoryRecord {
  return typeof value === 'object' && value !== null;
}

function isAgentProvider(value: string): value is AgentProvider {
  return PROVIDERS.has(value);
}

function quoteCommandArg(value: unknown): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tomlStringAssignment(line: unknown, key: string): string {
  const match = String(line || '').match(new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*(?:#.*)?$`));
  if (!match) return '';
  const literal = match[1];
  if (literal.startsWith('"')) {
    try {
      return JSON.parse(literal).trim();
    } catch {
      return '';
    }
  }
  return literal.slice(1, -1).trim();
}

function codexProfileNameForSection(section: unknown): string {
  const match = String(section || '').trim().match(/^profiles\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function resolveCodexResumeModelProvider(codexHome: unknown): string {
  const home = normalizePathValue(codexHome)
    || normalizePathValue(process.env.CODEX_HOME)
    || path.join(os.homedir(), '.codex');
  let config = '';
  try {
    config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return 'openai';
  }

  let section = '';
  let activeProfile = '';
  let topLevelProvider = '';
  const profileProviders = new Map<string, string>();
  for (const line of config.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (!section) {
      activeProfile = tomlStringAssignment(line, 'profile') || activeProfile;
      topLevelProvider = tomlStringAssignment(line, 'model_provider') || topLevelProvider;
      continue;
    }
    const profileName = codexProfileNameForSection(section);
    if (profileName) {
      const provider = tomlStringAssignment(line, 'model_provider');
      if (provider) profileProviders.set(profileName, provider);
    }
  }

  return (activeProfile && profileProviders.get(activeProfile)) || topLevelProvider || 'openai';
}

function normalizePathValue(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function timestampMs(value: unknown): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentSessionIdentity(session: AgentSession | null | undefined): string {
  return [
    String(session?.provider || ''),
    String(session?.providerHomeId || 'default'),
    String(session?.id || ''),
  ].join('\u0000');
}

function compareAgentSessions(a: AgentSession, b: AgentSession): number {
  const timeDelta = timestampMs(b?.updatedAt || b?.createdAt) - timestampMs(a?.updatedAt || a?.createdAt);
  return timeDelta || agentSessionIdentity(a).localeCompare(agentSessionIdentity(b));
}

function dedupeAgentSessions(sessions: AgentSession[]): AgentSession[] {
  const sessionsByIdentity = new Map<string, AgentSession>();
  for (const session of sessions) {
    const identity = agentSessionIdentity(session);
    const current = sessionsByIdentity.get(identity);
    if (!current || timestampMs(session?.updatedAt || session?.createdAt) > timestampMs(current?.updatedAt || current?.createdAt)) {
      sessionsByIdentity.set(identity, session);
    }
  }
  return Array.from(sessionsByIdentity.values());
}

function encodeAgentSessionCursor(session: AgentSession | null | undefined): string {
  if (!session?.provider || !session?.id) return '';
  return Buffer.from(JSON.stringify({
    version: 1,
    provider: String(session.provider),
    providerHomeId: String(session.providerHomeId || 'default'),
    id: String(session.id),
    updatedAt: String(session.updatedAt || session.createdAt || ''),
  })).toString('base64url');
}

function decodeAgentSessionCursor(value: unknown): AgentSessionCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    if (parsed?.version !== 1 || !parsed.provider || !parsed.id) return null;
    return {
      provider: String(parsed.provider),
      providerHomeId: String(parsed.providerHomeId || 'default'),
      id: String(parsed.id),
      updatedAt: String(parsed.updatedAt || ''),
    };
  } catch {
    return null;
  }
}

function paginateAgentSessions(
  sessions: AgentSession[],
  options: PaginationOptions = {},
): AgentSessionPage {
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const cursorValue = String(options.cursor || '').trim();
  let start = 0;
  if (cursorValue) {
    const cursor = decodeAgentSessionCursor(cursorValue);
    if (!cursor) return { sessions: [], nextCursor: '', hasMore: false, invalidCursor: true };
    const exactIndex = sessions.findIndex(session => (
      agentSessionIdentity(session) === agentSessionIdentity(cursor)
      && String(session.updatedAt || session.createdAt || '') === cursor.updatedAt
    ));
    if (exactIndex >= 0) {
      start = exactIndex + 1;
    } else {
      const nextIndex = sessions.findIndex(session => compareAgentSessions(session, cursor) > 0);
      start = nextIndex >= 0 ? nextIndex : sessions.length;
    }
  }
  const page = sessions.slice(start, start + limit);
  const hasMore = start + page.length < sessions.length;
  return {
    sessions: page,
    nextCursor: hasMore && page.length > 0 ? encodeAgentSessionCursor(page[page.length - 1]) : '',
    hasMore,
    invalidCursor: false,
  };
}

function searchAgentSessions(
  sessions: AgentSession[],
  query: unknown,
  options: SearchOptions = {},
): AgentSessionSearchResult {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(1, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  if (!normalizedQuery) {
    return { sessions: [], total: 0, query: '', scope: 'id-title-project' };
  }

  const projectNames = options.projectNames && typeof options.projectNames === 'object'
    ? options.projectNames
    : {};
  const matches = sessions.filter(session => {
    const projectPaths = [session?.workspace, session?.cwd];
    return [
      session?.id,
      session?.title,
      ...projectPaths,
      ...projectPaths.map(workspace => projectNames[String(workspace || '')]),
    ].some(value => String(value || '').toLowerCase().includes(normalizedQuery));
  });

  return {
    sessions: matches.slice(0, limit),
    total: matches.length,
    query: normalizedQuery,
    scope: 'id-title-project',
  };
}

function isAgentManagedWorktree(workspace: unknown): boolean {
  const value = normalizePathValue(workspace);
  return value.includes(`${path.sep}.codex${path.sep}worktrees${path.sep}`)
    || value.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
}

function isDefaultClaudeSessionTitle(title: unknown): boolean {
  return String(title || '').trim().toLowerCase() === 'claude session';
}

function firstTrimmedString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function extractClaudeModel(event: HistoryRecord | null | undefined): string {
  return firstTrimmedString(
    event?.model,
    event?.message?.model,
    event?.metadata?.model,
    event?.message?.metadata?.model,
    event?.request?.model,
    event?.options?.model
  );
}

function extractClaudeEffort(event: HistoryRecord | null | undefined): string {
  return firstTrimmedString(
    event?.effort,
    event?.message?.effort,
    event?.metadata?.effort,
    event?.message?.metadata?.effort,
    event?.request?.effort,
    event?.options?.effort
  );
}

function extractQoderModel(event: HistoryRecord | null | undefined): string {
  return firstTrimmedString(
    event?.model,
    event?.message?.model,
    event?.metadata?.model,
    event?.message?.metadata?.model
  );
}

function extractQoderEffort(event: HistoryRecord | null | undefined): string {
  return firstTrimmedString(
    event?.reasoningEffort,
    event?.reasoning_effort,
    event?.effort,
    event?.metadata?.reasoningEffort,
    event?.metadata?.reasoning_effort,
    event?.message?.metadata?.reasoningEffort,
    event?.message?.metadata?.reasoning_effort
  );
}

function isoTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    try {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toISOString() : '';
    } catch {
      return '';
    }
  }
  return '';
}

function qoderTextFromMessage(message: unknown): string {
  if (typeof message === 'string') return message.trim();
  if (!isHistoryRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (!isHistoryRecord(part)) return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .join('\n')
    .trim();
}

function qwenTextFromMessage(message: unknown): string {
  if (typeof message === 'string') return message.trim();
  if (!isHistoryRecord(message)) return '';
  const parts = Array.isArray(message.parts)
    ? message.parts
    : Array.isArray(message.content)
      ? message.content
      : [];
  return parts
    .map(part => {
      if (typeof part === 'string') return part;
      if (!isHistoryRecord(part)) return '';
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('\n')
    .trim();
}

function isVisibleAgentSession(session: AgentSession | null | undefined): boolean {
  if (!session) return true;
  if (
    isTemporaryWorkspace(session.cwd)
    || isTemporaryWorkspace(session.workspace)
    || hasTemporaryWorkspaceReference(session.title)
  ) return false;
  const provider = normalizeProvider(session.provider);
  return !provider || PROVIDER_HISTORY_BY_ID.get(provider)?.isVisible?.(session) !== false;
}

function activeScheduleFromMetadata(
  value: HistoryRecord | null | undefined,
  sessionId = '',
): ActiveSchedule | null {
  if (!value || typeof value !== 'object') return null;
  const rrule = typeof value.rrule === 'string' ? value.rrule.trim() : '';
  if (!rrule) return null;

  const targetThreadId = typeof value.target_thread_id === 'string'
    ? value.target_thread_id.trim()
    : typeof value.targetThreadId === 'string'
      ? value.targetThreadId.trim()
      : '';
  if (targetThreadId && sessionId && targetThreadId !== sessionId) return null;

  const rawStatus = typeof value.status === 'string' ? value.status.trim().toUpperCase() : '';
  const enabled = value.enabled !== false && value.active !== false;
  if (rawStatus && !['ACTIVE', 'ENABLED'].includes(rawStatus)) return null;
  if (!enabled) return null;

  return {
    id: typeof value.id === 'string' ? value.id.trim() : '',
    kind: typeof value.kind === 'string' ? value.kind.trim() : '',
    name: typeof value.name === 'string' ? value.name.trim() : '',
    status: rawStatus || 'ACTIVE',
    rrule,
    label: formatAutomationRRuleLabel(rrule),
  };
}

function scheduleFromClaudeEvent(
  event: HistoryRecord | null | undefined,
  sessionId: string,
): ActiveSchedule | null {
  const candidates = [
    event?.automation,
    event?.schedule,
    event?.metadata?.automation,
    event?.metadata?.schedule,
    event?.message?.metadata?.automation,
    event?.message?.metadata?.schedule,
  ];

  for (const candidate of candidates) {
    const schedule = activeScheduleFromMetadata(candidate, sessionId);
    if (schedule) return schedule;
  }

  return null;
}

async function collectRecentFiles(
  root: string,
  extension: string,
  limit: number,
  acceptFile: (filePath: string) => boolean = () => true,
  descendDirectory: (directoryPath: string) => boolean = () => true,
): Promise<RecentFile[]> {
  const directories: string[] = [root];
  let files: RecentFile[] = [];
  let visitedDirectories = 0;

  while (directories.length > 0 && visitedDirectories < MAX_RECENT_FILE_SCAN_DIRECTORIES) {
    const directory = directories.pop();
    if (!directory) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    visitedDirectories += 1;
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (descendDirectory(fullPath)) directories.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(extension) && acceptFile(fullPath)) {
        let mtimeMs = 0;
        try {
          mtimeMs = (await fsp.stat(fullPath)).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        files.push({ filePath: fullPath, mtimeMs });
        if (files.length > limit * 2) {
          files = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
        }
      }
    }
  }

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

async function readTextTail(filePath: string, maxBytes: number): Promise<string> {
  let handle: fsp.FileHandle | null = null;
  try {
    const stat = await fsp.stat(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    handle = await fsp.open(filePath, 'r');
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    return start > 0 ? text.replace(/^[^\n]*(\n|$)/, '') : text;
  } catch {
    return '';
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

async function readClaudePromptHistory(
  claudeHome: string,
): Promise<Map<string, ClaudePromptHistoryEntry>> {
  const historyPath = path.join(claudeHome, 'history.jsonl');
  const entries = new Map<string, ClaudePromptHistoryEntry>();

  const lines = (await readTextTail(historyPath, CLAUDE_HISTORY_TAIL_BYTES)).split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.sessionId !== 'string') continue;
      entries.set(entry.sessionId, {
        title: typeof entry.display === 'string' ? entry.display.trim() : '',
        workspace: typeof entry.project === 'string' ? normalizePathValue(entry.project) : '',
        updatedAt: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      });
    } catch {
      // Ignore individual corrupt prompt history lines.
    }
  }

  return entries;
}

function claudeSessionIdFromFilePath(filePath: string): string {
  const match = path.basename(filePath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

async function readClaudeSessionMetadata(
  filePath: string,
  promptHistory: Map<string, ClaudePromptHistoryEntry>,
  maxLines = 160,
): Promise<ClaudeSessionMetadata | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const fileSessionId = claudeSessionIdFromFilePath(filePath);
  const metadata: ClaudeSessionMetadata = {
    filePath,
    id: fileSessionId,
    title: '',
    cwd: '',
    workspace: '',
    createdAt: '',
    updatedAt: '',
    model: '',
    effort: '',
    source: '',
    schedule: null,
  };
  let lineCount = 0;

  try {
    for await (const line of reader) {
      if (!line) continue;
      lineCount += 1;

      try {
        const event = JSON.parse(line);
        if (typeof event.sessionId === 'string') {
          metadata.id = event.sessionId;
        }
        if (typeof event.timestamp === 'string') {
          metadata.updatedAt = event.timestamp;
          metadata.createdAt = metadata.createdAt || event.timestamp;
        }
        if (typeof event.cwd === 'string' && event.cwd.trim()) {
          metadata.cwd = normalizePathValue(event.cwd);
        }
        if (typeof event.entrypoint === 'string' && event.entrypoint.trim()) {
          metadata.source = event.entrypoint.trim();
        }
        if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
          metadata.title = event.aiTitle.trim();
        }
        metadata.model = extractClaudeModel(event) || metadata.model;
        metadata.effort = extractClaudeEffort(event) || metadata.effort;
        if (!metadata.schedule) {
          metadata.schedule = scheduleFromClaudeEvent(event, metadata.id || fileSessionId);
        }
      } catch {
        // Ignore individual corrupt session lines.
      }

      if (lineCount >= maxLines || (metadata.id && metadata.title && metadata.cwd && metadata.model)) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    await finished(stream).catch(() => {});
  }

  if (!metadata.id) return null;

  const indexed = promptHistory.get(metadata.id);
  metadata.title = metadata.title || indexed?.title || 'Claude session';
  metadata.workspace = normalizePathValue(indexed?.workspace || metadata.cwd || '');
  metadata.updatedAt = metadata.updatedAt || indexed?.updatedAt || '';
  metadata.source = metadata.source || 'claude';

  return metadata;
}

async function listClaudeSessions(
  options: ProviderListOptions = {},
): Promise<AgentSession[]> {
  const claudeHome = options.claudeHome || path.join(os.homedir(), '.claude');
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = typeof options.scanLimit === 'number' && Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const promptHistory = await readClaudePromptHistory(claudeHome);
  const projectsRoot = path.join(claudeHome, 'projects');
  // Claude child-agent transcripts live below <project>/<session-id>/subagents
  // and inherit the parent session id. Only direct project session files are
  // resumable roots and should count as History entries.
  const sessionFiles = await collectRecentFiles(
    projectsRoot,
    '.jsonl',
    scanLimit,
    filePath => path.relative(projectsRoot, filePath).split(path.sep).length === 2,
    directoryPath => path.relative(projectsRoot, directoryPath).split(path.sep).length === 1
  );

  const sessions: AgentSession[] = [];
  for (const { filePath, mtimeMs } of sessionFiles) {
    const metadata = await readClaudeSessionMetadata(filePath, promptHistory);
    if (!metadata) continue;
    const mtimeIso = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '';
    const updatedAt = timestampMs(mtimeIso) > timestampMs(metadata.updatedAt)
      ? mtimeIso
      : (metadata.updatedAt || mtimeIso);
    const session = {
      provider: 'claude',
      providerName: 'Claude',
      id: metadata.id,
      title: metadata.title,
      cwd: metadata.cwd,
      workspace: metadata.workspace,
      updatedAt,
      createdAt: metadata.createdAt,
      archived: false,
      pinned: false,
      unread: false,
      projectless: !metadata.workspace,
      model: metadata.model,
      effort: metadata.effort,
      source: metadata.source,
      schedule: metadata.schedule || undefined,
      capabilities: ['resume', 'fork'],
    };
    if (isVisibleAgentSession(session)) {
      sessions.push(session);
    }
  }

  return dedupeAgentSessions(sessions)
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function qoderSessionIdFromFilePath(filePath: string): string {
  const match = path.basename(filePath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function applyQoderSessionEvent(
  metadata: QoderSessionMetadata,
  event: HistoryRecord | null | undefined,
  fileSessionId: string,
): void {
  if (!event || typeof event !== 'object') return;
  const eventSessionId = typeof event.sessionId === 'string'
    ? event.sessionId
    : typeof event.session_id === 'string'
      ? event.session_id
      : '';
  if (eventSessionId && isSafeProviderSessionId(eventSessionId)) {
    metadata.id = eventSessionId;
  }

  const timestamp = isoTimestamp(event.timestamp);
  if (timestamp) {
    metadata.updatedAt = timestamp;
    metadata.createdAt = metadata.createdAt || timestamp;
  }

  if (typeof event.cwd === 'string' && event.cwd.trim()) {
    metadata.cwd = normalizePathValue(event.cwd);
  }
  if (typeof event.entrypoint === 'string' && event.entrypoint.trim()) {
    metadata.source = event.entrypoint.trim();
  }
  if (event.type === 'system' && typeof event.qodercli_version === 'string') {
    metadata.cliVersion = event.qodercli_version.trim();
  }
  if (typeof event.version === 'string' && event.version.trim()) {
    metadata.cliVersion = event.version.trim();
  }
  if (event.type === 'runtime-config' && typeof event.version === 'string') {
    metadata.cliVersion = event.version.trim();
  }
  if (event.type === 'ai-title' && typeof event.aiTitle === 'string' && event.aiTitle.trim()) {
    metadata.title = event.aiTitle.trim();
  }
  if (event.type === 'last-prompt' && typeof event.lastPrompt === 'string' && event.lastPrompt.trim()) {
    metadata.lastPrompt = event.lastPrompt.trim();
  }
  if (!metadata.firstPrompt && event.type === 'user') {
    metadata.firstPrompt = qoderTextFromMessage(event.message);
  }

  metadata.model = extractQoderModel(event) || metadata.model;
  metadata.effort = extractQoderEffort(event) || metadata.effort;

  if (!metadata.id && fileSessionId) {
    metadata.id = fileSessionId;
  }
}

async function readQoderSessionMetadata(
  filePath: string,
  maxLines = 160,
): Promise<QoderSessionMetadata | null> {
  const fileSessionId = qoderSessionIdFromFilePath(filePath);
  const metadata: QoderSessionMetadata = {
    filePath,
    id: fileSessionId,
    title: '',
    lastPrompt: '',
    firstPrompt: '',
    cwd: '',
    workspace: '',
    createdAt: '',
    updatedAt: '',
    model: '',
    effort: '',
    source: '',
    cliVersion: '',
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;

  try {
    for await (const line of reader) {
      if (!line) continue;
      lineCount += 1;
      try {
        applyQoderSessionEvent(metadata, JSON.parse(line), fileSessionId);
      } catch {
        // Ignore individual corrupt session lines.
      }
      if (lineCount >= maxLines || (metadata.id && metadata.cwd && metadata.model && metadata.title)) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    await finished(stream).catch(() => {});
  }

  const tail = await readTextTail(filePath, QODER_HISTORY_TAIL_BYTES);
  for (const line of tail.split('\n').filter(Boolean)) {
    try {
      applyQoderSessionEvent(metadata, JSON.parse(line), fileSessionId);
    } catch {
      // Ignore individual corrupt session lines.
    }
  }

  if (!metadata.id || !isSafeProviderSessionId(metadata.id)) return null;
  metadata.title = firstTrimmedString(metadata.title, metadata.lastPrompt, metadata.firstPrompt, 'Qoder session');
  metadata.workspace = normalizePathValue(metadata.cwd || '');
  metadata.source = metadata.source || 'qodercli';

  return metadata;
}

async function listQoderSessions(
  options: ProviderListOptions = {},
): Promise<AgentSession[]> {
  const qoderHome = options.qoderHome || path.join(os.homedir(), '.qoder');
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = typeof options.scanLimit === 'number' && Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const projectsRoot = path.join(qoderHome, 'projects');
  // Child-agent transcripts live deeper under <project>/<session-id>/subagents
  // and may repeat the parent id, so only count direct project session files.
  const sessionFiles = await collectRecentFiles(
    projectsRoot,
    '.jsonl',
    scanLimit,
    filePath => path.relative(projectsRoot, filePath).split(path.sep).length === 2,
    directoryPath => path.relative(projectsRoot, directoryPath).split(path.sep).length === 1
  );

  const sessions: AgentSession[] = [];
  for (const { filePath, mtimeMs } of sessionFiles) {
    const metadata = await readQoderSessionMetadata(filePath);
    if (!metadata) continue;
    const mtimeIso = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '';
    const updatedAt = timestampMs(mtimeIso) > timestampMs(metadata.updatedAt)
      ? mtimeIso
      : (metadata.updatedAt || mtimeIso);
    const session = {
      provider: 'qoder',
      providerName: 'Qoder',
      id: metadata.id,
      title: metadata.title,
      cwd: metadata.cwd,
      workspace: metadata.workspace,
      updatedAt,
      createdAt: metadata.createdAt,
      archived: false,
      pinned: false,
      unread: false,
      projectless: !metadata.workspace,
      model: metadata.model,
      effort: metadata.effort,
      source: metadata.source,
      cliVersion: metadata.cliVersion,
      capabilities: ['resume', 'fork'],
    };
    if (isVisibleAgentSession(session)) {
      sessions.push(session);
    }
  }

  return dedupeAgentSessions(sessions)
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function qwenSessionIdFromFilePath(filePath: string): string {
  const match = path.basename(filePath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function applyQwenSessionEvent(
  metadata: QwenSessionMetadata,
  event: HistoryRecord | null | undefined,
  fileSessionId: string,
): void {
  if (!event || typeof event !== 'object') return;
  const eventSessionId = typeof event.sessionId === 'string' ? event.sessionId : '';
  if (eventSessionId && isSafeProviderSessionId(eventSessionId)) {
    metadata.id = eventSessionId;
  }

  const timestamp = isoTimestamp(event.timestamp);
  if (timestamp) {
    metadata.updatedAt = timestamp;
    metadata.createdAt = metadata.createdAt || timestamp;
  }
  if (typeof event.cwd === 'string' && event.cwd.trim()) {
    metadata.cwd = normalizePathValue(event.cwd);
  }
  if (typeof event.version === 'string' && event.version.trim()) {
    metadata.cliVersion = event.version.trim();
  }
  if (typeof event.model === 'string' && event.model.trim()) {
    metadata.model = event.model.trim();
  }
  if (
    event.type === 'system'
    && event.subtype === 'custom_title'
    && typeof event.systemPayload?.customTitle === 'string'
    && event.systemPayload.customTitle.trim()
  ) {
    metadata.title = event.systemPayload.customTitle.trim();
  }
  if (!metadata.firstPrompt && event.type === 'user') {
    metadata.firstPrompt = qwenTextFromMessage(event.message);
  }
  if (!metadata.id && fileSessionId) metadata.id = fileSessionId;
}

async function readQwenSessionMetadata(
  filePath: string,
  maxLines = 160,
): Promise<QwenSessionMetadata | null> {
  const fileSessionId = qwenSessionIdFromFilePath(filePath);
  const metadata: QwenSessionMetadata = {
    filePath,
    id: fileSessionId,
    title: '',
    firstPrompt: '',
    cwd: '',
    workspace: '',
    createdAt: '',
    updatedAt: '',
    model: '',
    source: 'qwen',
    cliVersion: '',
  };

  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  try {
    for await (const line of reader) {
      if (!line) continue;
      lineCount += 1;
      try {
        applyQwenSessionEvent(metadata, JSON.parse(line), fileSessionId);
      } catch {
        // Ignore individual corrupt session lines.
      }
      if (lineCount >= maxLines || (metadata.id && metadata.cwd && metadata.firstPrompt && metadata.model)) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
    await finished(stream).catch(() => {});
  }

  const tail = await readTextTail(filePath, QWEN_HISTORY_TAIL_BYTES);
  for (const line of tail.split('\n').filter(Boolean)) {
    try {
      applyQwenSessionEvent(metadata, JSON.parse(line), fileSessionId);
    } catch {
      // Ignore individual corrupt session lines.
    }
  }

  if (!metadata.id || !isSafeProviderSessionId(metadata.id)) return null;
  metadata.title = firstTrimmedString(metadata.title, metadata.firstPrompt, 'Qwen Code session');
  metadata.workspace = normalizePathValue(metadata.cwd || '');
  return metadata;
}

async function listQwenSessions(
  options: ProviderListOptions = {},
): Promise<AgentSession[]> {
  const qwenHome = options.qwenHome || path.join(os.homedir(), '.qwen');
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = typeof options.scanLimit === 'number' && Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const projectsRoot = path.join(qwenHome, 'projects');
  const sessionFiles = await collectRecentFiles(
    projectsRoot,
    '.jsonl',
    scanLimit,
    filePath => {
      const relativeParts = path.relative(projectsRoot, filePath).split(path.sep);
      return relativeParts.length === 3 && relativeParts[1] === 'chats';
    },
    directoryPath => {
      const relativeParts = path.relative(projectsRoot, directoryPath).split(path.sep);
      return relativeParts.length === 1
        || (relativeParts.length === 2 && relativeParts[1] === 'chats');
    }
  );

  const sessions: AgentSession[] = [];
  for (const { filePath, mtimeMs } of sessionFiles) {
    const metadata = await readQwenSessionMetadata(filePath);
    if (!metadata) continue;
    const mtimeIso = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : '';
    const updatedAt = timestampMs(mtimeIso) > timestampMs(metadata.updatedAt)
      ? mtimeIso
      : (metadata.updatedAt || mtimeIso);
    const session = {
      provider: 'qwen',
      providerName: 'Qwen Code',
      id: metadata.id,
      title: metadata.title,
      cwd: metadata.cwd,
      workspace: metadata.workspace,
      updatedAt,
      createdAt: metadata.createdAt,
      archived: false,
      pinned: false,
      unread: false,
      projectless: !metadata.workspace,
      model: metadata.model,
      effort: '',
      source: metadata.source,
      cliVersion: metadata.cliVersion,
      capabilities: ['resume'],
    };
    if (isVisibleAgentSession(session)) sessions.push(session);
  }

  return dedupeAgentSessions(sessions)
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function runOpenCodeSessionList(options: OpenCodeListOptions = {}): Promise<string | Buffer> {
  const executable = options.opencodeBin || process.env.FARMING_OPENCODE_BIN || 'opencode';
  const maxCount = typeof options.maxCount === 'number' && Number.isFinite(options.maxCount)
    ? Math.max(1, Math.floor(options.maxCount))
    : DEFAULT_SCAN_LIMIT;
  const env = { ...process.env };
  if (options.opencodeHome) env.OPENCODE_CONFIG_DIR = options.opencodeHome;
  return new Promise<string | Buffer>((resolve, reject) => {
    execFile(executable, ['session', 'list', '--format', 'json', '--max-count', String(maxCount)], {
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function listOpenCodeSessions(
  options: ProviderListOptions = {},
): Promise<AgentSession[]> {
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = typeof options.scanLimit === 'number' && Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const listCommand = options.runOpenCodeSessionList || runOpenCodeSessionList;
  let rawSessions: unknown[] = [];
  try {
    const output = await listCommand({
      maxCount: scanLimit,
      opencodeBin: options.opencodeBin,
      opencodeHome: options.opencodeHome,
    });
    rawSessions = JSON.parse(String(output || '[]'));
  } catch {
    return [];
  }
  if (!Array.isArray(rawSessions)) return [];

  return dedupeAgentSessions(rawSessions
    .map<AgentSession | null>(raw => {
      if (!isHistoryRecord(raw)) return null;
      const id = firstTrimmedString(raw.id);
      const cwd = normalizePathValue(raw.directory || '');
      if (!id || !isSafeProviderSessionId(id)) return null;
      return {
        provider: 'opencode',
        providerName: 'OpenCode',
        id,
        title: firstTrimmedString(raw.title, 'OpenCode session'),
        cwd,
        workspace: cwd,
        updatedAt: isoTimestamp(raw.updated),
        createdAt: isoTimestamp(raw.created),
        archived: false,
        pinned: false,
        unread: false,
        projectless: !cwd,
        source: 'opencode',
        capabilities: ['resume', 'fork'],
      };
    })
    .filter((session): session is AgentSession => session !== null && isVisibleAgentSession(session)))
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function normalizeCodexSession(session: AgentSession): AgentSession {
  return {
    provider: 'codex',
    providerName: 'Codex',
    ...session,
    capabilities: ['resume', 'fork'],
  };
}

async function listHomeBackedProviderSessions(
  context: ProviderHistoryListContext,
  definition: {
    id: AgentProvider;
    fallbackHomeKey: ProviderHomeOptionKey;
    homeOptionKey: ProviderHomeOptionKey;
    list: ProviderListFunction;
    normalize?: SessionNormalizer;
  },
): Promise<AgentSession[]> {
  const { limit, options, providerHomes } = context;
  const homes = providerHomes[definition.id];
  const configuredHomes = Array.isArray(homes) && homes.length > 0
    ? homes
    : [{ id: 'default', path: options[definition.fallbackHomeKey] }];
  const perHomeLimit = typeof options.providerLimit === 'number' && Number.isFinite(options.providerLimit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.providerLimit)))
    : limit;
  const sessions: AgentSession[] = [];
  for (const home of configuredHomes) {
    const providerHomeId = String(home && home.id || 'default').trim() || 'default';
    const providerHomePath = String(home && home.path || '').trim();
    const listOptions: ProviderListOptions = {
      limit: perHomeLimit,
      scanLimit: options.scanLimit,
      opencodeBin: options.opencodeBin,
      runOpenCodeSessionList: options.runOpenCodeSessionList,
    };
    if (providerHomePath) listOptions[definition.homeOptionKey] = providerHomePath;
    const homeSessions = await definition.list(listOptions);
    const normalize = definition.normalize || ((session: AgentSession) => session);
    sessions.push(...homeSessions.map(session => normalize({
      ...session,
      providerHomeId,
      providerHomePath,
    })).filter(isVisibleAgentSession));
  }
  return sessions;
}

async function listOpenCodeProviderSessions(
  context: ProviderHistoryListContext,
): Promise<AgentSession[]> {
  const { limit, options, providerHomes } = context;
  const configuredHomes = Array.isArray(providerHomes.opencode) && providerHomes.opencode.length > 0
    ? providerHomes.opencode
    : [{ id: 'default', path: options.opencodeHome }];
  const home = configuredHomes.find(candidate => String(candidate?.id || '') === 'default') || configuredHomes[0];
  const providerHomeId = String(home?.id || 'default').trim() || 'default';
  const providerHomePath = String(home?.path || '').trim();
  const homeSessions = await listOpenCodeSessions({
    limit: typeof options.providerLimit === 'number' && Number.isFinite(options.providerLimit)
      ? options.providerLimit
      : limit,
    scanLimit: options.scanLimit,
    opencodeBin: options.opencodeBin,
    opencodeHome: providerHomePath,
    runOpenCodeSessionList: options.runOpenCodeSessionList,
  });
  const bindingsBySession = new Map<string, ProviderSessionHomeBinding[]>();
  for (const binding of options.providerSessionBindings || []) {
    if (normalizeProvider(binding?.provider) !== 'opencode') continue;
    const sessionId = String(binding?.providerSessionId || '').trim();
    if (!sessionId) continue;
    const bindings = bindingsBySession.get(sessionId) || [];
    bindings.push(binding);
    bindingsBySession.set(sessionId, bindings);
  }
  return homeSessions.map(session => {
    const bindings = bindingsBySession.get(String(session.id || '')) || [];
    const exactBindings = new Map(bindings.map(binding => [
      `${binding.providerHomeId}\0${binding.providerHomePath}`,
      binding,
    ]));
    const binding = exactBindings.size === 1 ? [...exactBindings.values()][0] : null;
    return {
      ...session,
      providerHomeId: binding?.providerHomeId || providerHomeId,
      providerHomePath: binding?.providerHomePath || providerHomePath,
    };
  });
}

const PROVIDER_HISTORY_DEFINITIONS: readonly ProviderHistoryDefinition[] = [
  {
    id: 'codex',
    supportsUnarchive: true,
    buildResumeCommand: (sessionId, options) => {
      const cwd = normalizePathValue(options.cwd);
      const modelProvider = String(
        options.modelProvider
        || (Object.prototype.hasOwnProperty.call(options, 'providerHomePath')
          ? resolveCodexResumeModelProvider(options.providerHomePath)
          : '')
      ).trim();
      const providerArgs = modelProvider
        ? ` -c ${quoteCommandArg(`model_provider=${JSON.stringify(modelProvider)}`)}`
        : '';
      const cwdArgs = cwd ? ` -C ${quoteCommandArg(cwd)}` : '';
      return `codex ${options.fork === true ? 'fork' : 'resume'}${providerArgs}${cwdArgs} ${sessionId}`;
    },
    listSessions: context => listHomeBackedProviderSessions(context, {
      id: 'codex',
      fallbackHomeKey: 'codexHome',
      homeOptionKey: 'codexHome',
      list: listCodexSessions,
      normalize: normalizeCodexSession,
    }),
  },
  {
    id: 'claude',
    isVisible: session => (
      !isDefaultClaudeSessionTitle(session.title)
      && !isAgentManagedWorktree(session.cwd)
      && !isAgentManagedWorktree(session.workspace)
    ),
    buildResumeCommand: (sessionId, options) => options.fork === true
      ? `claude --resume ${sessionId} --fork-session`
      : `claude --resume ${sessionId}`,
    listSessions: context => listHomeBackedProviderSessions(context, {
      id: 'claude',
      fallbackHomeKey: 'claudeHome',
      homeOptionKey: 'claudeHome',
      list: listClaudeSessions,
    }),
  },
  {
    id: 'opencode',
    buildResumeCommand: (sessionId, options) => (
      `opencode --session ${sessionId}${options.fork === true ? ' --fork' : ''}`
    ),
    listSessions: listOpenCodeProviderSessions,
  },
  {
    id: 'qoder',
    staleAutoResumeErrorPatterns: [/invalid session identifier/i],
    buildResumeCommand: (sessionId, options) => options.fork === true
      ? `qodercli --resume ${sessionId} --fork-session`
      : `qodercli --resume ${sessionId}`,
    listSessions: context => listHomeBackedProviderSessions(context, {
      id: 'qoder',
      fallbackHomeKey: 'qoderHome',
      homeOptionKey: 'qoderHome',
      list: listQoderSessions,
    }),
  },
  {
    id: 'qwen',
    buildResumeCommand: (sessionId, options) => options.fork === true ? '' : `qwen --resume ${sessionId}`,
    listSessions: context => listHomeBackedProviderSessions(context, {
      id: 'qwen',
      fallbackHomeKey: 'qwenHome',
      homeOptionKey: 'qwenHome',
      list: listQwenSessions,
    }),
  },
];

const PROVIDER_HISTORY_BY_ID = new Map(
  PROVIDER_HISTORY_DEFINITIONS.map(definition => [definition.id, definition] as const),
);

function providerHistorySupportsUnarchive(provider: unknown): boolean {
  const normalized = normalizeProvider(provider);
  return Boolean(normalized && PROVIDER_HISTORY_BY_ID.get(normalized)?.supportsUnarchive === true);
}

function providerHistoryAutoResumeErrorIsStale(provider: unknown, error: unknown): boolean {
  const normalized = normalizeProvider(provider);
  const patterns = normalized
    ? PROVIDER_HISTORY_BY_ID.get(normalized)?.staleAutoResumeErrorPatterns || []
    : [];
  const message = String(error || '');
  return patterns.some(pattern => pattern.test(message));
}

function agentSessionHistoryProviders(): AgentProvider[] {
  return PROVIDER_HISTORY_DEFINITIONS.map(definition => definition.id);
}

function normalizeProvider(provider: unknown): AgentProvider | '' {
  const normalized = String(provider || '').trim().toLowerCase();
  return isAgentProvider(normalized) ? normalized : '';
}

function isSafeSessionId(sessionId: unknown): boolean {
  return isSafeProviderSessionId(sessionId);
}

function buildAgentSessionResumeCommand(
  provider: unknown,
  sessionId: unknown,
  options: ResumeCommandOptions = {},
): string {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !isSafeSessionId(normalizedSessionId)) return '';
  return PROVIDER_HISTORY_BY_ID.get(normalizedProvider)?.buildResumeCommand(normalizedSessionId, options) || '';
}

async function listAgentSessions(
  options: AgentSessionHistoryOptions = {},
): Promise<AgentSession[]> {
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const requestedProviders = Array.isArray(options.providers)
    ? options.providers
      .map(normalizeProvider)
      .filter((provider): provider is AgentProvider => Boolean(provider))
    : [...AGENT_PROVIDER_IDS];
  const providers = Array.from(new Set(requestedProviders));
  const sessions: AgentSession[] = [];

  const providerHomes = options.providerHomes && typeof options.providerHomes === 'object'
    ? options.providerHomes
    : {};

  const context = { limit, options, providerHomes };
  for (const definition of PROVIDER_HISTORY_DEFINITIONS) {
    if (!providers.includes(definition.id)) continue;
    sessions.push(...await definition.listSessions(context));
  }

  return dedupeAgentSessions(sessions)
    .sort(compareAgentSessions)
    .slice(0, limit);
}

async function findAgentSession(
  provider: unknown,
  sessionId: unknown,
  options: AgentSessionHistoryOptions = {},
): Promise<AgentSession | null> {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !isSafeSessionId(normalizedSessionId)) return null;

  const sessions = await listAgentSessions({
    ...options,
    providers: [normalizedProvider],
    limit: options.limit || 200,
    providerLimit: options.providerLimit || 200,
  });
  const requestedHomeId = typeof options.providerHomeId === 'string' ? options.providerHomeId.trim() : '';
  return sessions.find(session => session.id === normalizedSessionId && (!requestedHomeId || (session.providerHomeId || 'default') === requestedHomeId)) || null;
}

export {
  agentSessionHistoryProviders,
  buildAgentSessionResumeCommand,
  compareAgentSessions,
  findAgentSession,
  hasTemporaryWorkspaceReference,
  isAgentManagedWorktree,
  isDefaultClaudeSessionTitle,
  isSafeSessionId,
  isTemporaryWorkspace,
  isVisibleAgentSession,
  listAgentSessions,
  listClaudeSessions,
  listOpenCodeSessions,
  listQoderSessions,
  listQwenSessions,
  normalizeProvider,
  paginateAgentSessions,
  providerHistoryAutoResumeErrorIsStale,
  providerHistorySupportsUnarchive,
  resolveCodexResumeModelProvider,
  searchAgentSessions,
};
export type {
  ActiveSchedule,
  AgentProvider,
  AgentSession,
  AgentSessionHistoryOptions,
  AgentSessionPage,
  AgentSessionSearchResult,
  ProviderHome,
  ProviderListOptions,
  ProviderSessionHomeBinding,
  ResumeCommandOptions,
};
