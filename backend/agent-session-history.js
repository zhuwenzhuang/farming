const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const {
  formatAutomationRRuleLabel,
  hasTemporaryWorkspaceReference,
  isTemporaryWorkspace,
  listCodexSessions,
} = require('./codex-session-history');
const { isSafeProviderSessionId } = require('./provider-session-id');

const DEFAULT_LIMIT = 60;
const DEFAULT_SCAN_LIMIT = 500;
const CLAUDE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_FILE_SCAN_DIRECTORIES = 2000;
const PROVIDERS = new Set(['codex', 'claude']);

function quoteCommandArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAgentManagedWorktree(workspace) {
  const value = normalizePathValue(workspace);
  return value.includes(`${path.sep}.codex${path.sep}worktrees${path.sep}`)
    || value.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`);
}

function isDefaultClaudeSessionTitle(title) {
  return String(title || '').trim().toLowerCase() === 'claude session';
}

function firstTrimmedString(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function extractClaudeModel(event) {
  return firstTrimmedString(
    event?.model,
    event?.message?.model,
    event?.metadata?.model,
    event?.message?.metadata?.model,
    event?.request?.model,
    event?.options?.model
  );
}

function extractClaudeEffort(event) {
  return firstTrimmedString(
    event?.effort,
    event?.message?.effort,
    event?.metadata?.effort,
    event?.message?.metadata?.effort,
    event?.request?.effort,
    event?.options?.effort
  );
}

function isVisibleAgentSession(session) {
  const provider = String(session?.provider || '').trim().toLowerCase();
  if (provider === 'claude') {
    if (isDefaultClaudeSessionTitle(session?.title)) return false;
    if (isAgentManagedWorktree(session?.cwd) || isAgentManagedWorktree(session?.workspace)) return false;
  }

  return !isTemporaryWorkspace(session?.cwd)
    && !isTemporaryWorkspace(session?.workspace)
    && !hasTemporaryWorkspaceReference(session?.title);
}

function activeScheduleFromMetadata(value, sessionId = '') {
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

function scheduleFromClaudeEvent(event, sessionId) {
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

async function collectRecentFiles(root, extension, limit) {
  const directories = [root];
  let files = [];
  let visitedDirectories = 0;

  while (directories.length > 0 && visitedDirectories < MAX_RECENT_FILE_SCAN_DIRECTORIES) {
    const directory = directories.pop();
    let entries = [];
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
        directories.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
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

async function readTextTail(filePath, maxBytes) {
  let handle = null;
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

async function readClaudePromptHistory(claudeHome) {
  const historyPath = path.join(claudeHome, 'history.jsonl');
  const entries = new Map();

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

function claudeSessionIdFromFilePath(filePath) {
  const match = path.basename(filePath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

async function readClaudeSessionMetadata(filePath, promptHistory, maxLines = 160) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const fileSessionId = claudeSessionIdFromFilePath(filePath);
  const metadata = {
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
  }

  if (!metadata.id) return null;

  const indexed = promptHistory.get(metadata.id);
  metadata.title = metadata.title || indexed?.title || 'Claude session';
  metadata.workspace = normalizePathValue(indexed?.workspace || metadata.cwd || '');
  metadata.updatedAt = metadata.updatedAt || indexed?.updatedAt || '';
  metadata.source = metadata.source || 'claude';

  return metadata;
}

async function listClaudeSessions(options = {}) {
  const claudeHome = options.claudeHome || path.join(os.homedir(), '.claude');
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(200, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(1000, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const promptHistory = await readClaudePromptHistory(claudeHome);
  const sessionFiles = await collectRecentFiles(path.join(claudeHome, 'projects'), '.jsonl', scanLimit);

  const sessions = [];
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

  return sessions
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function normalizeCodexSession(session) {
  return {
    provider: 'codex',
    providerName: 'Codex',
    ...session,
    capabilities: ['resume', 'fork'],
  };
}

function normalizeProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  return PROVIDERS.has(normalized) ? normalized : '';
}

function isSafeSessionId(sessionId) {
  return isSafeProviderSessionId(sessionId);
}

function buildAgentSessionResumeCommand(provider, sessionId, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !isSafeSessionId(normalizedSessionId)) return '';

  if (normalizedProvider === 'codex') {
    const cwd = normalizePathValue(options.cwd);
    const cwdArgs = cwd ? ` -C ${quoteCommandArg(cwd)}` : '';
    return `codex ${options.fork === true ? 'fork' : 'resume'}${cwdArgs} ${normalizedSessionId}`;
  }

  if (normalizedProvider === 'claude') {
    return options.fork === true
      ? `claude --resume ${normalizedSessionId} --fork-session`
      : `claude --resume ${normalizedSessionId}`;
  }

  return '';
}

async function listAgentSessions(options = {}) {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(200, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const requestedProviders = Array.isArray(options.providers)
    ? options.providers.map(normalizeProvider).filter(Boolean)
    : ['codex', 'claude'];
  const providers = Array.from(new Set(requestedProviders));
  const sessions = [];

  if (providers.includes('codex')) {
    const codexSessions = await listCodexSessions({
      codexHome: options.codexHome,
      limit: options.providerLimit || limit,
      scanLimit: options.scanLimit,
    });
    sessions.push(...codexSessions.map(normalizeCodexSession).filter(isVisibleAgentSession));
  }

  if (providers.includes('claude')) {
    const claudeSessions = await listClaudeSessions({
      claudeHome: options.claudeHome,
      limit: options.providerLimit || limit,
      scanLimit: options.scanLimit,
    });
    sessions.push(...claudeSessions);
  }

  return sessions
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

async function findAgentSession(provider, sessionId, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedProvider || !isSafeSessionId(normalizedSessionId)) return null;

  const sessions = await listAgentSessions({
    ...options,
    providers: [normalizedProvider],
    limit: options.limit || 200,
    providerLimit: options.providerLimit || 200,
  });
  return sessions.find(session => session.id === normalizedSessionId) || null;
}

module.exports = {
  buildAgentSessionResumeCommand,
  findAgentSession,
  hasTemporaryWorkspaceReference,
  isAgentManagedWorktree,
  isDefaultClaudeSessionTitle,
  isSafeSessionId,
  isTemporaryWorkspace,
  isVisibleAgentSession,
  listAgentSessions,
  listClaudeSessions,
  normalizeProvider,
};
