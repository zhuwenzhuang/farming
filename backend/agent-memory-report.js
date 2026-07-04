const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PERIOD = 'today';
const MAX_FILES_PER_SOURCE = 120;
const MAX_TOTAL_FILES = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EVENTS = 5000;
const MAX_EVENTS_PER_FILE = 250;
const MAX_TEXT_LENGTH = 260;
const MAX_HIGHLIGHTS = 14;
const MAX_WORKSPACES = 10;

const AGENT_SOURCES = [
  {
    agent: 'claude',
    source: 'claude-projects',
    rootParts: ['.claude', 'projects'],
    extensions: new Set(['.jsonl']),
  },
  {
    agent: 'claude',
    source: 'claude-history',
    rootParts: ['.claude'],
    fileNames: new Set(['history.jsonl']),
    extensions: new Set(['.jsonl']),
  },
  {
    agent: 'codex',
    source: 'codex-sessions',
    rootParts: ['.codex', 'sessions'],
    extensions: new Set(['.jsonl']),
  },
  {
    agent: 'qwen',
    source: 'qwen-projects',
    rootParts: ['.qwen', 'projects'],
    extensions: new Set(['.jsonl']),
  },
  {
    agent: 'qwen',
    source: 'qwen-logs',
    rootParts: ['.qwen', 'tmp'],
    extensions: new Set(['.json']),
  },
  {
    agent: 'qwen',
    source: 'qwen-todos',
    rootParts: ['.qwen', 'todos'],
    extensions: new Set(['.json']),
  },
];

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfLocalWeek(date) {
  const start = startOfLocalDay(date);
  const day = start.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + mondayOffset);
  return start;
}

function parseDateInput(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    if (endOfDay) date.setDate(date.getDate() + 1);
    return date;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveReportRange(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const period = options.period || DEFAULT_PERIOD;
  let start;
  let end = now;
  let label = period;

  if (period === 'today') {
    start = startOfLocalDay(now);
    label = '今日';
  } else if (period === 'yesterday') {
    end = startOfLocalDay(now);
    start = new Date(end);
    start.setDate(start.getDate() - 1);
    label = '昨日';
  } else if (period === 'week') {
    start = startOfLocalWeek(now);
    label = '本周';
  } else {
    throw new Error(`Unknown period: ${period}`);
  }

  const since = parseDateInput(options.since, false);
  const until = parseDateInput(options.until, true);
  if (since) {
    start = since;
    label = '自定义';
  }
  if (until) {
    end = until;
    label = '自定义';
  }

  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new Error('Invalid report start time');
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid report end time');
  }
  if (start.getTime() >= end.getTime()) {
    throw new Error('Report start time must be before end time');
  }

  return {
    period,
    label,
    start,
    end,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}

function getMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function sortedDirectoryEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .map(entry => ({
        entry,
        path: path.join(dirPath, entry.name),
        mtimeMs: getMtimeMs(path.join(dirPath, entry.name)),
      }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

function shouldSkipDirectory(name) {
  return name === 'node_modules'
    || name === '.git'
    || name === 'cache'
    || name === 'telemetry'
    || name === 'plugins';
}

function collectSourceFiles({ homeDir, source, range }) {
  const root = path.join(homeDir, ...source.rootParts);
  if (!fs.existsSync(root)) return [];

  const result = [];
  const queue = sortedDirectoryEntries(root);

  while (queue.length && result.length < MAX_FILES_PER_SOURCE) {
    const item = queue.shift();
    if (!item) break;

    if (item.entry.isDirectory()) {
      if (shouldSkipDirectory(item.entry.name)) continue;
      queue.push(...sortedDirectoryEntries(item.path));
      queue.sort((a, b) => b.mtimeMs - a.mtimeMs);
      continue;
    }

    if (!item.entry.isFile()) continue;
    if (item.mtimeMs < range.startMs) continue;

    const extension = path.extname(item.entry.name).toLowerCase();
    if (!source.extensions.has(extension)) continue;
    if (source.fileNames && !source.fileNames.has(item.entry.name)) continue;

    result.push({
      ...source,
      filePath: item.path,
      mtimeMs: item.mtimeMs,
      extension,
    });
  }

  return result;
}

function readFileLimited(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return '';
  const bytesToRead = Math.min(stat.size, MAX_FILE_BYTES);
  const start = Math.max(0, stat.size - bytesToRead);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function parseJsonlRecords(filePath) {
  const content = readFileLimited(filePath);
  return content
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function flattenJsonRecords(value, limit = 500) {
  const result = [];
  const seen = new Set();

  function visit(item) {
    if (result.length >= limit || !item || typeof item !== 'object') return;
    if (seen.has(item)) return;
    seen.add(item);

    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    result.push(item);
    ['messages', 'logs', 'events', 'items', 'entries', 'history', 'conversation'].forEach((key) => {
      if (Array.isArray(item[key])) visit(item[key]);
    });
  }

  visit(value);
  return result;
}

function parseJsonRecords(filePath) {
  try {
    const content = readFileLimited(filePath);
    const parsed = JSON.parse(content);
    return flattenJsonRecords(parsed);
  } catch {
    return [];
  }
}

function stripAnsi(value) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function normalizeText(value, limit = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return '';
  const normalized = stripAnsi(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(none|null|undefined)$/i.test(normalized)) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function collectTextParts(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];

  if (Array.isArray(value)) {
    return value.flatMap(item => collectTextParts(item, depth + 1));
  }

  const parts = [];
  ['text', 'summary', 'prompt', 'input', 'output'].forEach((key) => {
    if (typeof value[key] === 'string') parts.push(value[key]);
  });

  if (typeof value.content === 'string') {
    parts.push(value.content);
  } else if (Array.isArray(value.content)) {
    parts.push(...collectTextParts(value.content, depth + 1));
  }

  ['message', 'item', 'payload', 'data', 'delta'].forEach((key) => {
    if (value[key] && typeof value[key] === 'object') {
      parts.push(...collectTextParts(value[key], depth + 1));
    }
  });

  return parts;
}

function extractText(record) {
  return normalizeText(collectTextParts(record).join(' '));
}

function extractRole(record) {
  const candidates = [
    record.role,
    record.type,
    record.message && record.message.role,
    record.item && record.item.role,
    record.payload && record.payload.role,
  ].filter(Boolean).map(value => String(value).toLowerCase());

  if (candidates.some(value => value.includes('user'))) return 'user';
  if (candidates.some(value => value.includes('assistant'))) return 'assistant';
  if (candidates.some(value => value.includes('tool'))) return 'tool';
  if (candidates.some(value => value.includes('system'))) return 'system';
  return candidates[0] || 'event';
}

function parseTimestampValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 100000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return parseTimestampValue(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function extractTimestamp(record, fallbackMs) {
  const directKeys = ['timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'time', 'date', 'ts'];
  for (const key of directKeys) {
    const parsed = parseTimestampValue(record[key]);
    if (parsed) return parsed;
  }

  const nested = [record.message, record.item, record.payload, record.metadata, record.meta, record.session]
    .filter(value => value && typeof value === 'object');
  for (const value of nested) {
    for (const key of directKeys) {
      const parsed = parseTimestampValue(value[key]);
      if (parsed) return parsed;
    }
  }

  return fallbackMs || 0;
}

function expandHome(value, homeDir) {
  if (value === '~') return homeDir;
  if (typeof value === 'string' && value.startsWith('~/')) return path.join(homeDir, value.slice(2));
  return value;
}

function normalizeWorkspace(value, homeDir) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const expanded = expandHome(trimmed, homeDir);
  try {
    return fs.realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

function extractWorkspace(record, homeDir, depth = 0) {
  if (!record || typeof record !== 'object' || depth > 5) return '';
  const direct = record.cwd || record.workdir || record.workspace || record.rootPath || record.projectPath;
  if (typeof direct === 'string') return normalizeWorkspace(direct, homeDir);

  const nested = [record.payload, record.session, record.message, record.metadata, record.meta, record.context, record.item]
    .filter(value => value && typeof value === 'object');

  for (const value of nested) {
    const workspace = extractWorkspace(value, homeDir, depth + 1);
    if (workspace) return workspace;
  }

  return '';
}

function recordsFromFile(file) {
  if (file.extension === '.jsonl') return parseJsonlRecords(file.filePath);
  if (file.extension === '.json') return parseJsonRecords(file.filePath);
  return [];
}

function collectMemoryEvents(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const range = resolveReportRange(options);
  const files = AGENT_SOURCES
    .flatMap(source => collectSourceFiles({ homeDir, source, range }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_TOTAL_FILES);

  const events = [];
  for (const file of files) {
    if (events.length >= MAX_EVENTS) break;

    const records = recordsFromFile(file);
    let fileWorkspace = '';
    let fileEvents = 0;
    for (const record of records) {
      if (events.length >= MAX_EVENTS) break;
      if (fileEvents >= MAX_EVENTS_PER_FILE) break;
      const timestampMs = extractTimestamp(record, file.mtimeMs);
      if (timestampMs < range.startMs || timestampMs >= range.endMs) continue;

      const text = extractText(record);
      const explicitWorkspace = extractWorkspace(record, homeDir);
      if (explicitWorkspace) fileWorkspace = explicitWorkspace;
      const workspace = explicitWorkspace || fileWorkspace;
      if (!text && !workspace) continue;

      events.push({
        agent: file.agent,
        source: file.source,
        filePath: file.filePath,
        timestampMs,
        time: new Date(timestampMs).toISOString(),
        role: extractRole(record),
        workspace,
        text,
      });
      fileEvents++;
    }
  }

  events.sort((a, b) => a.timestampMs - b.timestampMs);
  return { homeDir, range, files, events };
}

function addCount(map, key, makeValue) {
  const normalized = key || 'unknown';
  if (!map.has(normalized)) map.set(normalized, makeValue(normalized));
  return map.get(normalized);
}

function isReportableTextEvent(event) {
  if (!event.text) return false;
  if (event.role !== 'user' && event.role !== 'assistant') return false;
  return !/^(Chunk ID:|Wall time:|Exit code:|Original token count:|Output:)/.test(event.text);
}

function buildMemoryReport(options = {}) {
  const collected = collectMemoryEvents(options);
  const { range, events, files } = collected;
  const agents = new Map();
  const workspaces = new Map();

  events.forEach((event) => {
    const agent = addCount(agents, event.agent, name => ({ name, events: 0, userMessages: 0, assistantMessages: 0 }));
    agent.events++;
    if (event.role === 'user') agent.userMessages++;
    if (event.role === 'assistant') agent.assistantMessages++;

    const workspace = addCount(workspaces, event.workspace || '(unknown workspace)', value => ({
      path: value,
      events: 0,
      agents: new Set(),
      lastActivityMs: 0,
      samples: [],
    }));
    workspace.events++;
    workspace.agents.add(event.agent);
    workspace.lastActivityMs = Math.max(workspace.lastActivityMs, event.timestampMs);
    if (isReportableTextEvent(event) && workspace.samples.length < 3) {
      workspace.samples.push(event.text);
    }
  });

  const highlights = [];
  const seenHighlightText = new Set();
  events
    .filter(isReportableTextEvent)
    .slice()
    .reverse()
    .forEach((event) => {
      if (highlights.length >= MAX_HIGHLIGHTS) return;
      const textId = event.text.toLowerCase();
      if (seenHighlightText.has(textId)) return;
      seenHighlightText.add(textId);
      highlights.push(event);
    });

  const workspaceSummaries = [...workspaces.values()]
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs || b.events - a.events)
    .slice(0, MAX_WORKSPACES)
    .map(item => ({
      path: item.path,
      events: item.events,
      agents: [...item.agents].sort(),
      lastActivity: item.lastActivityMs ? new Date(item.lastActivityMs).toISOString() : '',
      samples: item.samples,
    }));

  return {
    title: `Farming ${range.label}记忆报告`,
    range: {
      period: range.period,
      label: range.label,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    },
    stats: {
      filesScanned: files.length,
      events: events.length,
      truncated: events.length >= MAX_EVENTS,
      agents: agents.size,
      workspaces: workspaces.size,
    },
    agents: [...agents.values()].sort((a, b) => b.events - a.events),
    workspaces: workspaceSummaries,
    highlights,
  };
}

function formatDateTime(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatMemoryReport(report) {
  const lines = [
    `# ${report.title}`,
    '',
    `时间范围：${formatDateTime(report.range.start)} - ${formatDateTime(report.range.end)}`,
    `统计：扫描 ${report.stats.filesScanned} 个文件，找到 ${report.stats.events} 条活动线索，覆盖 ${report.stats.agents} 类 agent、${report.stats.workspaces} 个 workspace。${report.stats.truncated ? '已达到本次扫描上限。' : ''}`,
    '',
  ];

  if (report.stats.events === 0) {
    lines.push('没有找到指定时间范围内的 Claude/Qwen/Codex 本地记忆线索。');
    return lines.join('\n');
  }

  lines.push('## Agent 活动');
  report.agents.forEach((agent) => {
    lines.push(`- ${agent.name}: ${agent.events} 条线索（用户 ${agent.userMessages}，助手 ${agent.assistantMessages}）`);
  });
  lines.push('');

  lines.push('## 主要工作区');
  report.workspaces.forEach((workspace) => {
    const agents = workspace.agents.join(', ');
    lines.push(`- ${workspace.path}: ${workspace.events} 条线索，agent: ${agents}，最后活动 ${formatDateTime(workspace.lastActivity)}`);
    if (workspace.samples[0]) lines.push(`  线索：${workspace.samples[0]}`);
  });
  lines.push('');

  lines.push('## 最近活动线索');
  report.highlights.forEach((event) => {
    const workspace = event.workspace ? ` @ ${event.workspace}` : '';
    lines.push(`- ${formatDateTime(event.time)} ${event.agent}/${event.role}${workspace}: ${event.text}`);
  });

  return lines.join('\n');
}

module.exports = {
  buildMemoryReport,
  collectMemoryEvents,
  formatMemoryReport,
  resolveReportRange,
};
