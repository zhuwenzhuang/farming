const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_LIMIT = 12;
const MAX_PROJECT_DIRS_PER_AGENT = 80;
const MAX_FILES_PER_PROJECT = 8;
const MAX_JSONL_LINES = 40;
const MAX_JSON_BYTES = 128 * 1024;
const AGENT_CONFIG_DIRS = new Set(['.claude', '.qwen', '.codex']);
const DISCOVERABLE_AGENT_NAMES = new Set(['claude', 'qwen', 'codex']);

function normalizeWorkspacePath(workspace) {
  if (typeof workspace !== 'string') return '';
  const value = workspace.trim();
  if (!value || value.startsWith('/var')) return '';

  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;

  try {
    const resolved = fs.realpathSync(expanded);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return '';
    if (isTemporaryWorkspace(resolved)) return '';

    const basename = path.basename(resolved);
    if (AGENT_CONFIG_DIRS.has(basename)) {
      const parent = path.dirname(resolved);
      return fs.statSync(parent).isDirectory() ? parent : '';
    }

    return resolved;
  } catch {
    return '';
  }
}

function isTemporaryWorkspace(workspace) {
  return workspace === '/tmp'
    || workspace.startsWith('/tmp/')
    || workspace === '/private/tmp'
    || workspace.startsWith('/private/tmp/')
    || workspace === '/var/tmp'
    || workspace.startsWith('/var/tmp/')
    || workspace === '/private/var/tmp'
    || workspace.startsWith('/private/var/tmp/')
    || workspace === '/var/folders'
    || workspace.startsWith('/var/folders/')
    || workspace === '/private/var/folders'
    || workspace.startsWith('/private/var/folders/');
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

function collectJsonLikeFiles(rootDir, limit = MAX_FILES_PER_PROJECT) {
  const result = [];
  const queue = sortedDirectoryEntries(rootDir).filter(item => item.entry.isDirectory() || item.entry.isFile());

  while (queue.length && result.length < limit) {
    const item = queue.shift();
    if (!item) break;

    if (item.entry.isDirectory()) {
      queue.push(...sortedDirectoryEntries(item.path));
      queue.sort((a, b) => b.mtimeMs - a.mtimeMs);
      continue;
    }

    if (item.entry.isFile() && /\.(jsonl|json)$/i.test(item.entry.name)) {
      result.push(item.path);
    }
  }

  return result;
}

function extractCwdFromObject(value) {
  if (!value || typeof value !== 'object') return '';
  const direct = value.cwd || value.workdir || value.workspace;
  if (typeof direct === 'string') return direct;

  const payload = value.payload || value.session || value.message || value.metadata || value.meta;
  if (payload && typeof payload === 'object') {
    return extractCwdFromObject(payload);
  }

  return '';
}

function readCwdFromJsonFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';

    if (filePath.endsWith('.json')) {
      if (stat.size > MAX_JSON_BYTES) return '';
      return extractCwdFromObject(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_JSON_BYTES));
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      const lines = content.split('\n').slice(0, MAX_JSONL_LINES);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const cwd = extractCwdFromObject(JSON.parse(line));
          if (cwd) return cwd;
        } catch {
          // Ignore malformed or partial JSONL rows.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }

  return '';
}

function normalizeEncodedSegment(segment) {
  return segment
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function resolveEncodedProjectDirectory(projectName) {
  const encoded = normalizeEncodedSegment(projectName);
  if (!encoded) return '';

  let currentDir = path.parse(process.cwd()).root;
  let remaining = encoded;

  while (remaining) {
    const children = sortedDirectoryEntries(currentDir).filter(item => item.entry.isDirectory());
    const match = children
      .map(child => ({ child, childSlug: normalizeEncodedSegment(child.entry.name) }))
      .filter(({ childSlug }) => childSlug && (remaining === childSlug || remaining.startsWith(`${childSlug}-`)))
      .sort((a, b) => b.childSlug.length - a.childSlug.length)[0];

    if (!match) return '';

    currentDir = match.child.path;
    const childSlug = match.childSlug;
    remaining = remaining === childSlug ? '' : remaining.slice(childSlug.length + 1);
  }

  return normalizeWorkspacePath(currentDir);
}

function addWorkspace(resultByPath, workspace, details) {
  const normalized = normalizeWorkspacePath(workspace);
  if (!normalized) return;

  const existing = resultByPath.get(normalized) || {
    path: normalized,
    agents: [],
    sources: [],
    confidence: details.confidence || 'medium',
    lastSeen: 0,
  };

  if (!existing.agents.includes(details.agent)) existing.agents.push(details.agent);
  if (!existing.sources.includes(details.source)) existing.sources.push(details.source);
  existing.lastSeen = Math.max(existing.lastSeen || 0, details.lastSeen || 0);
  if (details.confidence === 'high') existing.confidence = 'high';

  resultByPath.set(normalized, existing);
}

function scanProjectHistory({ homeDir, agent, projectRoot, resultByPath }) {
  const root = path.join(homeDir, projectRoot);
  if (!fs.existsSync(root)) return;

  const projects = sortedDirectoryEntries(root)
    .filter(item => item.entry.isDirectory())
    .slice(0, MAX_PROJECT_DIRS_PER_AGENT);

  projects.forEach((project) => {
    const files = collectJsonLikeFiles(project.path, MAX_FILES_PER_PROJECT);
    let fileWithCwd = '';
    let cwd = '';
    for (const file of files) {
      cwd = readCwdFromJsonFile(file);
      if (cwd) {
        fileWithCwd = file;
        break;
      }
    }

    if (cwd) {
      addWorkspace(resultByPath, cwd, {
        agent,
        source: `${agent}-metadata`,
        confidence: 'high',
        lastSeen: getMtimeMs(fileWithCwd),
      });
      return;
    }

    const decoded = resolveEncodedProjectDirectory(project.entry.name);
    if (decoded) {
      addWorkspace(resultByPath, decoded, {
        agent,
        source: `${agent}-project-dir`,
        confidence: 'medium',
        lastSeen: project.mtimeMs,
      });
    }
  });
}

function scanCodexSessions({ homeDir, resultByPath }) {
  const root = path.join(homeDir, '.codex', 'sessions');
  if (!fs.existsSync(root)) return;

  const files = [];
  const queue = [root];

  while (queue.length && files.length < 120) {
    const current = queue.shift();
    if (!current) break;

    sortedDirectoryEntries(current).forEach((item) => {
      if (item.entry.isDirectory()) {
        queue.push(item.path);
      } else if (item.entry.isFile() && item.entry.name.endsWith('.jsonl')) {
        files.push(item.path);
      }
    });
    files.sort((a, b) => getMtimeMs(b) - getMtimeMs(a));
  }

  files.slice(0, 80).forEach((file) => {
    const cwd = readCwdFromJsonFile(file);
    if (!cwd) return;
    addWorkspace(resultByPath, cwd, {
      agent: 'codex',
      source: 'codex-session-meta',
      confidence: 'high',
      lastSeen: getMtimeMs(file),
    });
  });
}

function discoverAgentWorkspaces(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
  const requestedAgent = typeof options.agent === 'string' ? options.agent.trim().toLowerCase() : '';
  const agentFilter = DISCOVERABLE_AGENT_NAMES.has(requestedAgent) ? requestedAgent : '';
  const resultByPath = new Map();

  scanProjectHistory({
    homeDir,
    agent: 'claude',
    projectRoot: path.join('.claude', 'projects'),
    resultByPath,
  });
  scanProjectHistory({
    homeDir,
    agent: 'qwen',
    projectRoot: path.join('.qwen', 'projects'),
    resultByPath,
  });
  scanCodexSessions({ homeDir, resultByPath });

  return [...resultByPath.values()]
    .filter(item => !agentFilter || item.agents.includes(agentFilter))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, Math.max(0, limit))
    .map(item => ({
      ...item,
      exists: true,
    }));
}

module.exports = {
  discoverAgentWorkspaces,
  isTemporaryWorkspace,
  normalizeWorkspacePath,
  resolveEncodedProjectDirectory,
};
