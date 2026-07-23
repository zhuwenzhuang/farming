const EventEmitter = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_READ_BYTES = 512 * 1024;
const USER_MESSAGE_BEGIN = '## My request for Codex:';

function normalizePathValue(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed === path.sep) return trimmed;
  return trimmed.replace(/[\\/]+$/, '');
}

function sessionIdFromFilePath(filePath) {
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match ? match[1] : '';
}

function findCodexRolloutFile(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';

  const codexHome = normalizePathValue(options.codexHome || path.join(os.homedir(), '.codex'));
  const roots = [
    path.join(codexHome, 'sessions'),
    path.join(codexHome, 'archived_sessions'),
  ];

  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (
          entry.isFile()
          && entry.name.endsWith('.jsonl')
          && sessionIdFromFilePath(fullPath) === normalizedSessionId
        ) {
          return fullPath;
        }
      }
    }
  }

  return '';
}

function recentSessionDirectories(root, now = new Date()) {
  const directories = [];
  for (const offsetDays of [-1, 0, 1]) {
    const date = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    directories.push(
      path.join(
        root,
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      ),
      path.join(
        root,
        String(date.getUTCFullYear()),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
      ),
    );
  }
  return [...new Set(directories)];
}

async function findCodexRolloutFileAsync(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) return '';
  const codexHome = normalizePathValue(options.codexHome || path.join(os.homedir(), '.codex'));
  const maxEntries = Number.isFinite(options.maxEntries)
    ? Math.max(1, Math.floor(options.maxEntries))
    : 100_000;
  const deadline = Number.isFinite(options.deadline)
    ? Number(options.deadline)
    : Date.now() + 5_000;
  const sessionsRoot = path.join(codexHome, 'sessions');
  const archivedRoot = path.join(codexHome, 'archived_sessions');
  const preferredDirectories = [
    ...recentSessionDirectories(sessionsRoot),
    ...(options.recentOnly === true ? [] : [archivedRoot]),
  ];
  const visited = new Set();
  let inspectedEntries = 0;

  async function inspectDirectory(directory, descend) {
    if (Date.now() > deadline || inspectedEntries >= maxEntries || visited.has(directory)) return '';
    visited.add(directory);
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      return '';
    }
    const subdirectories = [];
    for (const entry of entries) {
      inspectedEntries += 1;
      if (Date.now() > deadline || inspectedEntries > maxEntries) return '';
      const fullPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && sessionIdFromFilePath(fullPath) === normalizedSessionId) {
        return fullPath;
      }
      if (descend && entry.isDirectory()) subdirectories.push(fullPath);
    }
    return subdirectories;
  }

  for (const directory of preferredDirectories) {
    const found = await inspectDirectory(directory, false);
    if (typeof found === 'string' && found) return found;
  }
  if (options.recentOnly === true) return '';

  const stack = [sessionsRoot, archivedRoot];
  while (stack.length > 0 && Date.now() <= deadline && inspectedEntries < maxEntries) {
    const directory = stack.pop();
    const result = await inspectDirectory(directory, true);
    if (typeof result === 'string') {
      if (result) return result;
      continue;
    }
    stack.push(...result);
  }
  return '';
}

function normalizePreviewText(value, maxLength = 400) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .slice(0, maxLength);
}

function stripUserMessagePrefix(value) {
  const text = String(value || '');
  const index = text.indexOf(USER_MESSAGE_BEGIN);
  return index >= 0 ? text.slice(index + USER_MESSAGE_BEGIN.length).trim() : text.trim();
}

function jsonFieldPreview(value, key, maxLength = 120) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const field = parsed && typeof parsed === 'object' ? parsed[key] : '';
    return normalizePreviewText(field, maxLength).replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

function formatFunctionCall(payload) {
  const name = String(payload.name || '').trim();
  if (!name) return '';

  if (name === 'exec_command') {
    const cmd = jsonFieldPreview(payload.arguments, 'cmd');
    return cmd ? `running command: ${cmd}` : 'running command';
  }

  if (name === 'apply_patch') return 'applying patch';
  return `running ${name}`;
}

function formatCodexRolloutEvent(line) {
  let event = null;
  try {
    event = JSON.parse(line);
  } catch {
    return '';
  }

  const payload = event && typeof event.payload === 'object' ? event.payload : null;
  if (!payload) return '';

  if (event.type === 'event_msg') {
    if (payload.type === 'agent_message') {
      const message = normalizePreviewText(payload.message);
      return message ? `[Codex live]\r\n${message.replace(/\n/g, '\r\n')}\r\n` : '';
    }

    if (payload.type === 'user_message') {
      const message = normalizePreviewText(stripUserMessagePrefix(payload.message), 240);
      return message ? `[Codex live] queued user message: ${message.replace(/\n/g, ' ')}\r\n` : '';
    }

    if (payload.type === 'task_complete') {
      return '[Codex live] task complete\r\n';
    }

    return '';
  }

  if (event.type === 'response_item') {
    if (payload.type === 'function_call') {
      const message = formatFunctionCall(payload);
      return message ? `[Codex live] ${message}\r\n` : '';
    }

    return '';
  }

  return '';
}

async function readFileRange(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (length <= 0) return '';

  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await handle.close().catch(() => {});
  }
}

class CodexRolloutFollower extends EventEmitter {
  constructor(sessionId, options = {}) {
    super();
    this.sessionId = String(sessionId || '').trim();
    this.codexHome = options.codexHome;
    this.pollIntervalMs = Number.isFinite(options.pollIntervalMs)
      ? Math.max(250, options.pollIntervalMs)
      : DEFAULT_POLL_INTERVAL_MS;
    this.maxReadBytes = Number.isFinite(options.maxReadBytes)
      ? Math.max(4096, options.maxReadBytes)
      : DEFAULT_MAX_READ_BYTES;
    this.filePath = options.filePath || '';
    this.offset = Number.isFinite(options.offset) ? Math.max(0, options.offset) : 0;
    this.partialLine = '';
    this.timer = null;
    this.stopped = false;
    this.polling = false;
  }

  async start() {
    if (!this.sessionId || this.timer || this.stopped) return;
    this.filePath = this.filePath || findCodexRolloutFile(this.sessionId, {
      codexHome: this.codexHome,
    });
    if (!this.filePath) return;

    if (!this.offset) {
      try {
        this.offset = (await fsp.stat(this.filePath)).size;
      } catch {
        this.offset = 0;
      }
    }

    this.timer = setInterval(() => {
      this.poll().catch(error => this.emit('error', error));
    }, this.pollIntervalMs);
  }

  async poll() {
    if (this.stopped || this.polling || !this.filePath) return;
    this.polling = true;
    try {
      const stat = await fsp.stat(this.filePath);
      if (stat.size < this.offset) {
        this.offset = stat.size;
        this.partialLine = '';
        return;
      }
      if (stat.size === this.offset) return;

      const oldOffset = this.offset;
      const start = Math.max(oldOffset, stat.size - this.maxReadBytes);
      const droppedPrefix = start > oldOffset;
      const chunk = await readFileRange(this.filePath, start, stat.size);
      this.offset = stat.size;

      const text = droppedPrefix ? chunk : this.partialLine + chunk;
      const lines = text.split('\n');
      this.partialLine = lines.pop() || '';
      if (droppedPrefix) {
        lines.shift();
      }

      const formatted = lines
        .map(formatCodexRolloutEvent)
        .filter(Boolean)
        .join('');
      if (formatted) {
        this.emit('data', formatted);
      }
    } finally {
      this.polling = false;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = {
  CodexRolloutFollower,
  findCodexRolloutFile,
  findCodexRolloutFileAsync,
  formatCodexRolloutEvent,
};
