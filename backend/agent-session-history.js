const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const {
  formatAutomationRRuleLabel,
  hasTemporaryWorkspaceReference,
  isTemporaryWorkspace,
  listCodexSessions,
} = require('./codex-session-history');
const { isSafeProviderSessionId } = require('./provider-session-id');

const DEFAULT_LIMIT = 60;
const DEFAULT_SCAN_LIMIT = 500;
const MAX_AGENT_SESSION_HISTORY_LIMIT = 5000;
const MAX_AGENT_SESSION_SCAN_LIMIT = 5000;
const CLAUDE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const QODER_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_FILE_SCAN_DIRECTORIES = 2000;
const PROVIDERS = new Set(['codex', 'claude', 'opencode', 'qoder']);

function quoteCommandArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function tomlStringAssignment(line, key) {
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

function codexProfileNameForSection(section) {
  const match = String(section || '').trim().match(/^profiles\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
  return match ? (match[1] || match[2] || match[3] || '') : '';
}

function resolveCodexResumeModelProvider(codexHome) {
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
  const profileProviders = new Map();
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

function agentSessionIdentity(session) {
  return [
    String(session?.provider || ''),
    String(session?.providerHomeId || 'default'),
    String(session?.id || ''),
  ].join('\u0000');
}

function compareAgentSessions(a, b) {
  const timeDelta = timestampMs(b?.updatedAt || b?.createdAt) - timestampMs(a?.updatedAt || a?.createdAt);
  return timeDelta || agentSessionIdentity(a).localeCompare(agentSessionIdentity(b));
}

function encodeAgentSessionCursor(session) {
  if (!session?.provider || !session?.id) return '';
  return Buffer.from(JSON.stringify({
    version: 1,
    provider: String(session.provider),
    providerHomeId: String(session.providerHomeId || 'default'),
    id: String(session.id),
    updatedAt: String(session.updatedAt || session.createdAt || ''),
  })).toString('base64url');
}

function decodeAgentSessionCursor(value) {
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

function paginateAgentSessions(sessions, options = {}) {
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const cursorValue = String(options.cursor || '').trim();
  let start = 0;
  if (cursorValue) {
    const cursor = decodeAgentSessionCursor(cursorValue);
    if (!cursor) return { sessions: [], nextCursor: '', hasMore: false, invalidCursor: true };
    const exactIndex = sessions.findIndex(session => agentSessionIdentity(session) === agentSessionIdentity(cursor));
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

function searchAgentSessions(sessions, query, options = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  if (!normalizedQuery) {
    return { sessions: [], total: 0, query: '', scope: 'title-project' };
  }

  const projectNames = options.projectNames && typeof options.projectNames === 'object'
    ? options.projectNames
    : {};
  const matches = sessions.filter(session => {
    const projectPaths = [session?.workspace, session?.cwd];
    return [
      session?.title,
      ...projectPaths,
      ...projectPaths.map(workspace => projectNames[String(workspace || '')]),
    ].some(value => String(value || '').toLowerCase().includes(normalizedQuery));
  });

  return {
    sessions: matches.slice(0, limit),
    total: matches.length,
    query: normalizedQuery,
    scope: 'title-project',
  };
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

function extractQoderModel(event) {
  return firstTrimmedString(
    event?.model,
    event?.message?.model,
    event?.metadata?.model,
    event?.message?.metadata?.model
  );
}

function extractQoderEffort(event) {
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

function isoTimestamp(value) {
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

function qoderTextFromMessage(message) {
  if (typeof message === 'string') return message.trim();
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      return '';
    })
    .join('\n')
    .trim();
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

async function collectRecentFiles(root, extension, limit, acceptFile = () => true) {
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
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
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

function qoderSessionIdFromFilePath(filePath) {
  const match = path.basename(filePath).match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function applyQoderSessionEvent(metadata, event, fileSessionId) {
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

async function readQoderSessionMetadata(filePath, maxLines = 160) {
  const fileSessionId = qoderSessionIdFromFilePath(filePath);
  const metadata = {
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

async function listQoderSessions(options = {}) {
  const qoderHome = options.qoderHome || path.join(os.homedir(), '.qoder');
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const projectsRoot = path.join(qoderHome, 'projects');
  // Child-agent transcripts live deeper under <project>/<session-id>/subagents
  // and may repeat the parent id, so only count direct project session files.
  const sessionFiles = await collectRecentFiles(
    projectsRoot,
    '.jsonl',
    scanLimit,
    filePath => path.relative(projectsRoot, filePath).split(path.sep).length === 2
  );

  const sessions = [];
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

  return sessions
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, limit);
}

function runOpenCodeSessionList(options = {}) {
  const executable = options.opencodeBin || process.env.FARMING_OPENCODE_BIN || 'opencode';
  const maxCount = Number.isFinite(options.maxCount) ? Math.max(1, Math.floor(options.maxCount)) : DEFAULT_SCAN_LIMIT;
  const env = { ...process.env };
  if (options.opencodeHome) env.OPENCODE_CONFIG_DIR = options.opencodeHome;
  return new Promise((resolve, reject) => {
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

async function listOpenCodeSessions(options = {}) {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_AGENT_SESSION_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;
  const listCommand = options.runOpenCodeSessionList || runOpenCodeSessionList;
  let rawSessions = [];
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

  return rawSessions
    .map(raw => {
      const id = firstTrimmedString(raw?.id);
      const cwd = normalizePathValue(raw?.directory || '');
      if (!id || !isSafeProviderSessionId(id)) return null;
      return {
        provider: 'opencode',
        providerName: 'OpenCode',
        id,
        title: firstTrimmedString(raw?.title, 'OpenCode session'),
        cwd,
        workspace: cwd,
        updatedAt: isoTimestamp(raw?.updated),
        createdAt: isoTimestamp(raw?.created),
        archived: false,
        pinned: false,
        unread: false,
        projectless: !cwd,
        source: 'opencode',
        capabilities: ['resume', 'fork'],
      };
    })
    .filter(session => session && isVisibleAgentSession(session))
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
    const modelProvider = String(options.modelProvider || '').trim();
    const providerArgs = modelProvider
      ? ` -c ${quoteCommandArg(`model_provider=${JSON.stringify(modelProvider)}`)}`
      : '';
    const cwdArgs = cwd ? ` -C ${quoteCommandArg(cwd)}` : '';
    return `codex ${options.fork === true ? 'fork' : 'resume'}${providerArgs}${cwdArgs} ${normalizedSessionId}`;
  }

  if (normalizedProvider === 'claude') {
    return options.fork === true
      ? `claude --resume ${normalizedSessionId} --fork-session`
      : `claude --resume ${normalizedSessionId}`;
  }

  if (normalizedProvider === 'qoder') {
    return options.fork === true
      ? `qodercli --resume ${normalizedSessionId} --fork-session`
      : `qodercli --resume ${normalizedSessionId}`;
  }

  if (normalizedProvider === 'opencode') {
    return `opencode --session ${normalizedSessionId}${options.fork === true ? ' --fork' : ''}`;
  }

  return '';
}

async function listAgentSessions(options = {}) {
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const requestedProviders = Array.isArray(options.providers)
    ? options.providers.map(normalizeProvider).filter(Boolean)
    : ['codex', 'claude', 'opencode', 'qoder'];
  const providers = Array.from(new Set(requestedProviders));
  const sessions = [];

  const providerHomes = options.providerHomes && typeof options.providerHomes === 'object'
    ? options.providerHomes
    : {};

  async function listForHomes(provider, homes, fallbackHomeKey, listFn, homeOptionKey, normalize = session => session) {
    const configuredHomes = Array.isArray(homes) && homes.length > 0
      ? homes
      : [{ id: 'default', path: options[fallbackHomeKey] }];
    const perHomeLimit = Number.isFinite(options.providerLimit)
      ? Math.max(0, Math.min(MAX_AGENT_SESSION_HISTORY_LIMIT, Math.floor(options.providerLimit)))
      : limit;
    for (const home of configuredHomes) {
      const providerHomeId = String(home && home.id || 'default').trim() || 'default';
      const providerHomePath = String(home && home.path || '').trim();
      const listOptions = {
        limit: perHomeLimit,
        scanLimit: options.scanLimit,
        opencodeBin: options.opencodeBin,
        runOpenCodeSessionList: options.runOpenCodeSessionList,
      };
      if (providerHomePath) listOptions[homeOptionKey] = providerHomePath;
      const homeSessions = await listFn(listOptions);
      sessions.push(...homeSessions.map(session => normalize({
        ...session,
        providerHomeId,
        providerHomePath,
      })).filter(isVisibleAgentSession));
    }
  }

  if (providers.includes('codex')) {
    await listForHomes('codex', providerHomes.codex, 'codexHome', listCodexSessions, 'codexHome', normalizeCodexSession);
  }

  if (providers.includes('claude')) {
    await listForHomes('claude', providerHomes.claude, 'claudeHome', listClaudeSessions, 'claudeHome');
  }

  if (providers.includes('qoder')) {
    await listForHomes('qoder', providerHomes.qoder, 'qoderHome', listQoderSessions, 'qoderHome');
  }

  if (providers.includes('opencode')) {
    const configuredHomes = Array.isArray(providerHomes.opencode) && providerHomes.opencode.length > 0
      ? providerHomes.opencode
      : [{ id: 'default', path: options.opencodeHome }];
    const home = configuredHomes.find(candidate => String(candidate?.id || '') === 'default') || configuredHomes[0];
    const providerHomeId = String(home?.id || 'default').trim() || 'default';
    const providerHomePath = String(home?.path || '').trim();
    const homeSessions = await listOpenCodeSessions({
      limit: Number.isFinite(options.providerLimit) ? options.providerLimit : limit,
      scanLimit: options.scanLimit,
      opencodeBin: options.opencodeBin,
      opencodeHome: providerHomePath,
      runOpenCodeSessionList: options.runOpenCodeSessionList,
    });
    sessions.push(...homeSessions.map(session => ({
      ...session,
      providerHomeId,
      providerHomePath,
    })));
  }

  return sessions
    .sort(compareAgentSessions)
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
  const requestedHomeId = typeof options.providerHomeId === 'string' ? options.providerHomeId.trim() : '';
  return sessions.find(session => session.id === normalizedSessionId && (!requestedHomeId || (session.providerHomeId || 'default') === requestedHomeId)) || null;
}

module.exports = {
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
  normalizeProvider,
  paginateAgentSessions,
  resolveCodexResumeModelProvider,
  searchAgentSessions,
};
