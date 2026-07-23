const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { stripCodexInternalContextBlocks } = require('./codex-transcript-sanitizer');

const DEFAULT_LIMIT = 40;
const DEFAULT_SCAN_LIMIT = 400;
const MAX_SESSION_HISTORY_LIMIT = 1000;
const MAX_SESSION_HISTORY_SCAN_LIMIT = 5000;
const MAX_SCAN_DIRECTORIES = 2000;
const SESSION_INDEX_TAIL_BYTES = 4 * 1024 * 1024;
const RECENT_FILE_CANDIDATE_MULTIPLIER = 4;
const USER_MESSAGE_BEGIN = '## My request for Codex:';
const IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER = '[Image]';
const MAX_PREVIEW_LENGTH = 160;
const ACTIVE_AUTOMATION_STATUS = 'ACTIVE';

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function firstStringValue(object, keys) {
  if (!object || typeof object !== 'object') return '';
  for (const key of keys) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  return '';
}

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function isTemporaryWorkspace(workspace) {
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

function hasTemporaryWorkspaceReference(value) {
  if (typeof value !== 'string') return false;
  return /(^|[\s"'`:=])\/(?:tmp|private\/tmp|var\/tmp|private\/var\/tmp|var\/folders|private\/var\/folders)(?:[/\s"'`,}]|$)/.test(value);
}

function isPathInside(root, target) {
  const normalizedRoot = normalizePathValue(root);
  const normalizedTarget = normalizePathValue(target);
  if (!normalizedRoot || !normalizedTarget) return false;
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function uniqueWorkspaceRoots(values) {
  const seen = new Set();
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

function bestWorkspaceRootForCwd(cwd, workspaceRoots) {
  return workspaceRoots.find(root => isPathInside(root, cwd)) || '';
}

function readSessionIndex(codexHome) {
  const indexPath = path.join(codexHome, 'session_index.jsonl');
  const entries = new Map();

  if (!fs.existsSync(indexPath)) return entries;

  let text = '';
  try {
    const stat = fs.statSync(indexPath);
    const start = Math.max(0, stat.size - SESSION_INDEX_TAIL_BYTES);
    const length = stat.size - start;
    const fd = fs.openSync(indexPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      text = buffer.toString('utf8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return entries;
  }

  const lines = text.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
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

function parseFlatTomlValue(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function parseFlatToml(text) {
  const result = {};
  String(text || '').split('\n').forEach(line => {
    const withoutComment = line.replace(/\s+#.*$/, '').trim();
    if (!withoutComment || withoutComment.startsWith('[')) return;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(withoutComment);
    if (!match) return;
    result[match[1]] = parseFlatTomlValue(match[2]);
  });
  return result;
}

function formatAutomationRRuleLabel(rrule) {
  const parts = new Map();
  String(rrule || '').split(';').forEach(part => {
    const [key, value] = part.split('=');
    if (key && value) parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  });

  const freq = parts.get('FREQ') || '';
  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') || '1', 10) || 1);
  const units = {
    MINUTELY: ['minute', 'minutes'],
    HOURLY: ['hour', 'hours'],
    DAILY: ['day', 'days'],
    WEEKLY: ['week', 'weeks'],
    MONTHLY: ['month', 'months'],
  }[freq];

  if (!units) return '';
  return interval === 1 ? `Every ${units[0]}` : `Every ${interval} ${units[1]}`;
}

function normalizeAutomationSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : '';
  const targetThreadId = typeof raw.target_thread_id === 'string' ? raw.target_thread_id.trim() : '';
  const rrule = typeof raw.rrule === 'string' ? raw.rrule.trim() : '';
  if (status !== ACTIVE_AUTOMATION_STATUS || !targetThreadId || !rrule) return null;

  return {
    id: typeof raw.id === 'string' ? raw.id.trim() : '',
    kind: typeof raw.kind === 'string' ? raw.kind.trim() : '',
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    status,
    rrule,
    label: formatAutomationRRuleLabel(rrule),
  };
}

function readCodexAutomationSchedules(codexHome) {
  const automationsDir = path.join(codexHome, 'automations');
  const schedules = new Map();
  let entries = [];

  try {
    entries = fs.readdirSync(automationsDir, { withFileTypes: true });
  } catch {
    return schedules;
  }

  entries.forEach(entry => {
    if (!entry.isDirectory()) return;
    const filePath = path.join(automationsDir, entry.name, 'automation.toml');
    let raw = null;
    try {
      raw = parseFlatToml(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return;
    }
    const schedule = normalizeAutomationSchedule(raw);
    if (schedule) schedules.set(raw.target_thread_id.trim(), schedule);
  });

  return schedules;
}

function sortDirectoryEntriesForRecentScan(entries) {
  return entries.slice().sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return b.name.localeCompare(a.name);
  });
}

function pruneRecentFileCandidates(files, limit) {
  if (files.length <= limit) return files;
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function collectRecentJsonlFiles(root, limit) {
  const candidateLimit = Math.max(limit, limit * RECENT_FILE_CANDIDATE_MULTIPLIER);
  const directories = [root];
  let visitedDirectories = 0;
  let files = [];

  while (directories.length > 0 && visitedDirectories < MAX_SCAN_DIRECTORIES) {
    const directory = directories.pop();
    let entries = [];
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

function sessionIdFromFilePath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function normalizePreviewText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PREVIEW_LENGTH);
}

function stripUserMessagePrefix(value) {
  if (typeof value !== 'string') return '';
  const index = value.indexOf(USER_MESSAGE_BEGIN);
  return index >= 0
    ? value.slice(index + USER_MESSAGE_BEGIN.length).trim()
    : value.trim();
}

function eventMessagePreview(event) {
  const payload = event && event.payload && typeof event.payload === 'object'
    ? event.payload
    : null;
  if (!payload || typeof payload.type !== 'string') return '';

  if (payload.type === 'user_message') {
    const message = normalizePreviewText(stripCodexInternalContextBlocks(stripUserMessagePrefix(payload.message)));
    if (message) return message;

    const hasRemoteImages = Array.isArray(payload.images) && payload.images.length > 0;
    const hasLocalImages = Array.isArray(payload.local_images) && payload.local_images.length > 0;
    return hasRemoteImages || hasLocalImages ? IMAGE_ONLY_USER_MESSAGE_PLACEHOLDER : '';
  }

  if (payload.type === 'thread_goal_updated') {
    return normalizePreviewText(payload.goal && payload.goal.objective);
  }

  return '';
}

async function readSessionMetadata(filePath, maxLines = 80) {
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
        const event = JSON.parse(line);
        if (typeof event.timestamp === 'string') {
          metadata.updatedAt = event.timestamp;
        }

        if (event.type === 'session_meta') {
          const payloadId = event.payload && typeof event.payload.id === 'string' ? event.payload.id : '';
          if (fileSessionId && payloadId && payloadId !== fileSessionId) {
            continue;
          }

          metadata.createdAt = event.timestamp || metadata.createdAt;
          metadata.id = payloadId || metadata.id;
          metadata.cwd = event.payload && typeof event.payload.cwd === 'string'
            ? event.payload.cwd
            : metadata.cwd;
          metadata.source = event.payload && typeof event.payload.source === 'string'
            ? event.payload.source
            : metadata.source;
          metadata.cliVersion = event.payload && typeof event.payload.cli_version === 'string'
            ? event.payload.cli_version
            : metadata.cliVersion;
        } else if (event.type === 'turn_context') {
          metadata.cwd = event.payload && typeof event.payload.cwd === 'string'
            ? event.payload.cwd
            : metadata.cwd;
          metadata.model = event.payload && typeof event.payload.model === 'string'
            ? event.payload.model
            : metadata.model;
          metadata.effort = event.payload && typeof event.payload.effort === 'string'
            ? event.payload.effort
            : metadata.effort;
        } else if (event.type === 'event_msg') {
          const preview = eventMessagePreview(event);
          if (preview) {
            if (!metadata.preview) metadata.preview = preview;
            if (event.payload && event.payload.type === 'user_message' && !metadata.firstUserMessage) {
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
  }

  return metadata.id ? metadata : null;
}

function codexSessionDateKeys(startedAt, windowMs) {
  const center = Number(startedAt);
  const radius = Math.max(0, Number(windowMs) || 0);
  if (!Number.isFinite(center) || center <= 0) return [];
  const cursor = new Date(center - radius);
  cursor.setHours(0, 0, 0, 0);
  const lastDay = new Date(center + radius);
  lastDay.setHours(0, 0, 0, 0);
  const keys = [];
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

async function readCodexSessionIdentity(filePath) {
  let handle;
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
    const event = JSON.parse(firstLine);
    if (event?.type !== 'session_meta') return null;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
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

async function listCodexSessionIdentities(options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const startedAt = Number(options.startedAt);
  const windowMs = Math.max(0, Number(options.windowMs) || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return [];

  const files = [];
  for (const dateKey of codexSessionDateKeys(startedAt, windowMs)) {
    const [year, month, day] = dateKey.split('-');
    const directory = path.join(codexHome, 'sessions', year, month, day);
    let entries;
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

  const identities = [];
  const batchSize = 32;
  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = await Promise.all(
      files.slice(offset, offset + batchSize).map(readCodexSessionIdentity)
    );
    identities.push(...batch.filter(Boolean));
  }
  return identities;
}

function getGlobalState(codexHome) {
  const state = readJsonFile(path.join(codexHome, '.codex-global-state.json'), {});
  const atom = state['electron-persisted-atom-state'] || {};
  const unreadByHost = atom['unread-thread-ids-by-host-v1'] || {};
  const workspaceHints = state['thread-workspace-root-hints'] && typeof state['thread-workspace-root-hints'] === 'object'
    ? state['thread-workspace-root-hints']
    : {};

  return {
    pinnedIds: new Set(Array.isArray(state['pinned-thread-ids']) ? state['pinned-thread-ids'] : []),
    projectlessIds: new Set(Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : []),
    unreadIds: new Set(Array.isArray(unreadByHost.local) ? unreadByHost.local : []),
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

function timestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveSessionWorkspace(id, cwd, indexed, globalState) {
  const hintedWorkspace = normalizePathValue(globalState.workspaceHints[id]);
  if (hintedWorkspace) return hintedWorkspace;

  const indexedWorkspace = normalizePathValue(indexed?.workspace);
  if (indexedWorkspace) return indexedWorkspace;

  const workspaceRoot = bestWorkspaceRootForCwd(cwd, globalState.workspaceRoots);
  if (workspaceRoot) return workspaceRoot;

  return normalizePathValue(cwd || indexed?.cwd || '');
}

async function listCodexSessions(options = {}) {
  const codexHome = options.codexHome || path.join(os.homedir(), '.codex');
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.min(MAX_SESSION_HISTORY_LIMIT, Math.floor(options.limit)))
    : DEFAULT_LIMIT;
  const scanLimit = Number.isFinite(options.scanLimit)
    ? Math.max(limit, Math.min(MAX_SESSION_HISTORY_SCAN_LIMIT, Math.floor(options.scanLimit)))
    : DEFAULT_SCAN_LIMIT;

  const index = readSessionIndex(codexHome);
  const globalState = getGlobalState(codexHome);
  const automationSchedules = readCodexAutomationSchedules(codexHome);
  const sessionFiles = [
    ...collectRecentJsonlFiles(path.join(codexHome, 'sessions'), scanLimit),
    ...collectRecentJsonlFiles(path.join(codexHome, 'archived_sessions'), scanLimit),
  ]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, scanLimit);

  const sessions = new Map();
  const skippedTemporaryIds = new Set();
  for (const { filePath, mtimeMs } of sessionFiles) {
    const metadata = await readSessionMetadata(filePath);
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

module.exports = {
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
