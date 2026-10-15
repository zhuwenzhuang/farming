import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const DEFAULT_LIMIT = 12;
const MAX_PROJECT_DIRS_PER_AGENT = 80;
const MAX_FILES_PER_PROJECT = 8;
const MAX_JSONL_LINES = 40;
const MAX_JSON_BYTES = 128 * 1024;
const MAX_HISTORY_DIRECTORIES = 4096;

type WorkspaceConfidence = 'high' | 'medium';

interface DirectoryEntry {
  entry: import('fs').Dirent;
  path: string;
  mtimeMs: number;
}

interface DiscoveredWorkspace {
  path: string;
  agents: string[];
  sources: string[];
  confidence: WorkspaceConfidence;
  lastSeen: number;
  exists?: boolean;
}

interface WorkspaceDetails {
  agent: string;
  source: string;
  confidence?: WorkspaceConfidence;
  lastSeen?: number;
}

interface ProjectHistoryScanOptions {
  homeDir: string;
  agent: string;
  projectRoot: string;
  resultByPath: Map<string, DiscoveredWorkspace>;
}

interface CodexSessionScanOptions {
  agent: string;
  homeDir: string;
  resultByPath: Map<string, DiscoveredWorkspace>;
}

interface DiscoverAgentWorkspacesOptions {
  homeDir?: string;
  limit?: number;
  agent?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

async function normalizeWorkspacePath(workspace: unknown): Promise<string> {
  if (typeof workspace !== 'string') return '';
  const value = workspace.trim();
  if (!value || value.startsWith('/var')) return '';

  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;

  try {
    const resolved = await fs.realpath(expanded);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) return '';
    if (isTemporaryWorkspace(resolved)) return '';

    const basename = path.basename(resolved);
    if (AGENT_CONFIG_DIRS.has(basename)) {
      const parent = path.dirname(resolved);
      return (await fs.stat(parent)).isDirectory() ? parent : '';
    }

    return resolved;
  } catch {
    return '';
  }
}

function isTemporaryWorkspace(workspace: string): boolean {
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

async function getMtimeMs(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function sortedDirectoryEntries(dirPath: string): Promise<DirectoryEntry[]> {
  try {
    const entries: DirectoryEntry[] = [];
    for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
      entries.push({
        entry,
        path: path.join(dirPath, entry.name),
        mtimeMs: await getMtimeMs(path.join(dirPath, entry.name)),
      });
    }
    return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}

async function collectJsonLikeFiles(rootDir: string, limit = MAX_FILES_PER_PROJECT): Promise<string[]> {
  const result: string[] = [];
  const queue = (await sortedDirectoryEntries(rootDir)).filter(item => item.entry.isDirectory() || item.entry.isFile());
  let directories = 1;

  while (queue.length && result.length < limit) {
    const item = queue.shift();
    if (!item) break;

    if (item.entry.isDirectory()) {
      if (++directories > MAX_HISTORY_DIRECTORIES) throw new Error('Workspace discovery exceeded its history directory limit.');
      queue.push(...await sortedDirectoryEntries(item.path));
      queue.sort((a, b) => b.mtimeMs - a.mtimeMs);
      continue;
    }

    if (item.entry.isFile() && /\.(jsonl|json)$/i.test(item.entry.name)) {
      result.push(item.path);
    }
  }

  return result;
}

function extractCwdFromObject(value: unknown): string {
  if (!isRecord(value)) return '';
  const direct = value.cwd || value.workdir || value.workspace;
  if (typeof direct === 'string') return direct;

  const payload = value.payload || value.session || value.message || value.metadata || value.meta;
  if (isRecord(payload)) {
    return extractCwdFromObject(payload);
  }

  return '';
}

async function readCwdFromJsonFile(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return '';

    if (filePath.endsWith('.json')) {
      if (stat.size > MAX_JSON_BYTES) return '';
      return extractCwdFromObject(JSON.parse(await fs.readFile(filePath, 'utf8')));
    }

    const fd = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_JSON_BYTES));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
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
      await fd.close();
    }
  } catch {
    return '';
  }

  return '';
}

function normalizeEncodedSegment(segment: string): string {
  return segment
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function resolveEncodedProjectDirectory(projectName: string): Promise<string> {
  const encoded = normalizeEncodedSegment(projectName);
  if (!encoded) return '';

  let currentDir = path.parse(process.cwd()).root;
  let remaining = encoded;

  while (remaining) {
    let children: import('node:fs').Dirent[];
    try {
      children = (await fs.readdir(currentDir, { withFileTypes: true })).filter(entry => entry.isDirectory());
    } catch {
      return '';
    }
    const matches = children
      .map(child => ({ child, childSlug: normalizeEncodedSegment(child.name) }))
      .filter(({ childSlug }) => childSlug && (remaining === childSlug || remaining.startsWith(`${childSlug}-`)))
      .sort((a, b) => b.childSlug.length - a.childSlug.length);

    let match = matches[0];
    if (!match) return '';
    // Preserve the newest-directory tie break without stat-ing unrelated siblings.
    if (matches[1]?.childSlug.length === match.childSlug.length) {
      let newest = await getMtimeMs(path.join(currentDir, match.child.name));
      for (const candidate of matches.slice(1)) {
        if (candidate.childSlug.length !== match.childSlug.length) break;
        const mtime = await getMtimeMs(path.join(currentDir, candidate.child.name));
        if (mtime > newest) { match = candidate; newest = mtime; }
      }
    }

    currentDir = path.join(currentDir, match.child.name);
    const childSlug = match.childSlug;
    remaining = remaining === childSlug ? '' : remaining.slice(childSlug.length + 1);
  }

  return normalizeWorkspacePath(currentDir);
}

async function addWorkspace(
  resultByPath: Map<string, DiscoveredWorkspace>,
  workspace: unknown,
  details: WorkspaceDetails
): Promise<void> {
  const normalized = await normalizeWorkspacePath(workspace);
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

async function scanProjectHistory({
  homeDir,
  agent,
  projectRoot,
  resultByPath,
}: ProjectHistoryScanOptions): Promise<void> {
  const root = path.join(homeDir, projectRoot);

  const projects = (await sortedDirectoryEntries(root))
    .filter(item => item.entry.isDirectory())
    .slice(0, MAX_PROJECT_DIRS_PER_AGENT);

  for (const project of projects) {
    const files = await collectJsonLikeFiles(project.path, MAX_FILES_PER_PROJECT);
    let fileWithCwd = '';
    let cwd = '';
    for (const file of files) {
      cwd = await readCwdFromJsonFile(file);
      if (cwd) {
        fileWithCwd = file;
        break;
      }
    }

    if (cwd) {
      await addWorkspace(resultByPath, cwd, {
        agent,
        source: `${agent}-metadata`,
        confidence: 'high',
        lastSeen: await getMtimeMs(fileWithCwd),
      });
      continue;
    }

    const decoded = await resolveEncodedProjectDirectory(project.entry.name);
    if (decoded) {
      await addWorkspace(resultByPath, decoded, {
        agent,
        source: `${agent}-project-dir`,
        confidence: 'medium',
        lastSeen: project.mtimeMs,
      });
    }
  }
}

async function scanCodexSessions({ agent, homeDir, resultByPath }: CodexSessionScanOptions): Promise<void> {
  const root = path.join(homeDir, '.codex', 'sessions');

  const files: DirectoryEntry[] = [];
  const queue: string[] = [root];
  let directories = 0;

  while (queue.length && files.length < 120) {
    const current = queue.shift();
    if (!current) break;

    if (++directories > MAX_HISTORY_DIRECTORIES) throw new Error('Workspace discovery exceeded its history directory limit.');
    for (const item of await sortedDirectoryEntries(current)) {
      if (item.entry.isDirectory()) {
        queue.push(item.path);
      } else if (item.entry.isFile() && item.entry.name.endsWith('.jsonl')) {
        files.push(item);
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  for (const file of files.slice(0, 80)) {
    const cwd = await readCwdFromJsonFile(file.path);
    if (!cwd) continue;
    await addWorkspace(resultByPath, cwd, {
      agent,
      source: `${agent}-session-meta`,
      confidence: 'high',
      lastSeen: file.mtimeMs,
    });
  }
}

interface WorkspaceDiscoveryDefinition {
  configDirectory: string;
  id: string;
  scan(homeDir: string, resultByPath: Map<string, DiscoveredWorkspace>): Promise<void>;
}

const WORKSPACE_DISCOVERY_DEFINITIONS: readonly WorkspaceDiscoveryDefinition[] = [
  {
    id: 'claude',
    configDirectory: '.claude',
    scan: (homeDir, resultByPath) => scanProjectHistory({
      homeDir,
      agent: 'claude',
      projectRoot: path.join('.claude', 'projects'),
      resultByPath,
    }),
  },
  {
    id: 'qwen',
    configDirectory: '.qwen',
    scan: (homeDir, resultByPath) => scanProjectHistory({
      homeDir,
      agent: 'qwen',
      projectRoot: path.join('.qwen', 'projects'),
      resultByPath,
    }),
  },
  {
    id: 'codex',
    configDirectory: '.codex',
    scan: (homeDir, resultByPath) => scanCodexSessions({ agent: 'codex', homeDir, resultByPath }),
  },
];

const AGENT_CONFIG_DIRS = new Set(
  WORKSPACE_DISCOVERY_DEFINITIONS.map(definition => definition.configDirectory),
);
const DISCOVERABLE_AGENT_NAMES = new Set(
  WORKSPACE_DISCOVERY_DEFINITIONS.map(definition => definition.id),
);

async function discoverAgentWorkspaces(
  options: DiscoverAgentWorkspacesOptions = {}
): Promise<DiscoveredWorkspace[]> {
  const homeDir = options.homeDir || os.homedir();
  const limit = typeof options.limit === 'number' && Number.isFinite(options.limit)
    ? options.limit
    : DEFAULT_LIMIT;
  const requestedAgent = typeof options.agent === 'string' ? options.agent.trim().toLowerCase() : '';
  const agentFilter = DISCOVERABLE_AGENT_NAMES.has(requestedAgent) ? requestedAgent : '';
  const resultByPath = new Map<string, DiscoveredWorkspace>();

  for (const definition of WORKSPACE_DISCOVERY_DEFINITIONS) await definition.scan(homeDir, resultByPath);

  return [...resultByPath.values()]
    .filter(item => !agentFilter || item.agents.includes(agentFilter))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, Math.max(0, limit))
    .map(item => ({
      ...item,
      exists: true,
    }));
}

export {
  discoverAgentWorkspaces,
  isTemporaryWorkspace,
  normalizeWorkspacePath,
  resolveEncodedProjectDirectory,
};
