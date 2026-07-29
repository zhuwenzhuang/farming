import {
  collectRecentJsonlFiles,
  readSessionMetadata,
  sessionIdFromFilePath,
} from './codex-session-history.cjs';

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { isSafeProviderSessionId, isTemporaryProviderSessionId } = require('./provider-session-id.cjs');

const CACHE_TTL_MS = 5_000;
const CONTEXT_TAIL_BYTES = 512 * 1024;
const DEFAULT_SCAN_LIMIT = 800;

interface CodexContextWindow {
  agentId: string;
  available: true;
  cachedInputTokens: number;
  confidence: 'exact';
  limitTokens: number;
  outputTokens: number;
  percentLeft: number;
  percentUsed: number;
  provider: 'codex';
  reasoningOutputTokens: number;
  sessionId: string;
  source: 'codex token_count events';
  updatedAt: string;
  usedTokens: number;
}

interface UnavailableContextWindow {
  agentId: string;
  available: false;
  reason: string;
}

type CodexContextWindowResult = CodexContextWindow | UnavailableContextWindow;

interface CodexContextWindowReaderOptions {
  cacheTtlMs?: number;
  codexHome?: string;
  now?: () => number;
  scanLimit?: number;
}

interface CodexContextWindowAgent extends Record<string, unknown> {
  id?: unknown;
  providerHomePath?: unknown;
  providerSessionId?: unknown;
  providerSessionProvider?: unknown;
}

interface SessionFileCandidate {
  filePath: string;
  mtimeMs: number;
}

interface CachedSessionFile {
  checkedAt: number;
  filePath: string;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function numberOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function unavailable(agentId: string, reason: string): UnavailableContextWindow {
  return {
    agentId,
    available: false,
    reason,
  };
}

function contextWindowFromRecord(
  agentId: string,
  sessionId: string,
  record: unknown,
): CodexContextWindow | null {
  const source = recordValue(record);
  const payload = recordValue(source.payload);
  if (source.type !== 'event_msg' || payload.type !== 'token_count') return null;

  const info = recordValue(payload.info);
  const usage = recordValue(info.last_token_usage);
  const usedTokens = numberOrNull(usage.input_tokens);
  const limitTokens = numberOrNull(payload.model_context_window ?? info.model_context_window);
  if (usedTokens === null || limitTokens === null || usedTokens < 0 || limitTokens <= 0) return null;

  const percentUsed = Math.max(0, Math.min(100, Math.round((usedTokens / limitTokens) * 100)));
  return {
    agentId,
    available: true,
    provider: 'codex',
    sessionId,
    usedTokens,
    limitTokens,
    percentUsed,
    percentLeft: Math.max(0, 100 - percentUsed),
    cachedInputTokens: Math.max(0, numberOrNull(usage?.cached_input_tokens) ?? 0),
    outputTokens: Math.max(0, numberOrNull(usage?.output_tokens) ?? 0),
    reasoningOutputTokens: Math.max(0, numberOrNull(usage?.reasoning_output_tokens) ?? 0),
    updatedAt: typeof source.timestamp === 'string' ? source.timestamp : '',
    source: 'codex token_count events',
    confidence: 'exact',
  };
}

async function readJsonlTail(filePath: string, maxBytes = CONTEXT_TAIL_BYTES): Promise<string> {
  const stat = await fsp.stat(filePath);
  if (stat.size <= 0) return '';

  const bytesToRead = Math.min(stat.size, maxBytes);
  const start = stat.size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fsp.open(filePath, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, start);
  } finally {
    await handle.close();
  }

  let text = buffer.toString('utf8');
  if (start > 0) {
    const newlineIndex = text.indexOf('\n');
    text = newlineIndex >= 0 ? text.slice(newlineIndex + 1) : '';
  }
  return text;
}

async function readLatestCodexContextWindow({
  agentId,
  sessionId,
  filePath,
}: {
  agentId: string;
  sessionId: string;
  filePath: string;
}): Promise<CodexContextWindowResult> {
  const lines = (await readJsonlTail(filePath)).split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record = null;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const contextWindow = contextWindowFromRecord(agentId, sessionId, record);
    if (contextWindow) return contextWindow;
  }
  return unavailable(agentId, 'No Codex token_count event with context window was found.');
}

class CodexContextWindowReader {
  private readonly cacheTtlMs: number;
  private readonly codexHome: string;
  private readonly fileCache = new Map<string, CachedSessionFile>();
  private readonly now: () => number;
  private readonly scanLimit: number;

  constructor(options: CodexContextWindowReaderOptions = {}) {
    this.codexHome = options.codexHome || path.join(os.homedir(), '.codex');
    this.cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT;
    this.now = options.now || (() => Date.now());
  }

  codexRoots(): string[] {
    return [
      path.join(this.codexHome, 'sessions'),
      path.join(this.codexHome, 'archived_sessions'),
    ];
  }

  async cachedFilePath(sessionId: string): Promise<string> {
    const cached = this.fileCache.get(sessionId);
    if (!cached || this.now() - cached.checkedAt > this.cacheTtlMs) return '';
    if (sessionIdFromFilePath(cached.filePath) !== sessionId) return '';
    try {
      const stat = await fsp.stat(cached.filePath);
      if (stat.isFile()) return cached.filePath;
    } catch {
      // Fall through to a fresh scan.
    }
    return '';
  }

  collectCandidates(): SessionFileCandidate[] {
    return this.codexRoots()
      .flatMap(root => collectRecentJsonlFiles(root, this.scanLimit))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, this.scanLimit);
  }

  async findSessionFile(sessionId: string): Promise<string> {
    const cached = await this.cachedFilePath(sessionId);
    if (cached) return cached;

    const candidates = this.collectCandidates();
    const direct = candidates.find(candidate => sessionIdFromFilePath(candidate.filePath) === sessionId);
    if (direct) {
      this.fileCache.set(sessionId, { filePath: direct.filePath, checkedAt: this.now() });
      return direct.filePath;
    }

    for (const candidate of candidates) {
      const metadata = await readSessionMetadata(candidate.filePath, 40).catch(() => null);
      if (metadata?.id !== sessionId) continue;
      this.fileCache.set(sessionId, { filePath: candidate.filePath, checkedAt: this.now() });
      return candidate.filePath;
    }

    this.fileCache.delete(sessionId);
    return '';
  }

  async readForAgent(agent: CodexContextWindowAgent): Promise<CodexContextWindowResult> {
    const requestedCodexHome = String(agent?.providerHomePath || '').trim();
    if (requestedCodexHome && requestedCodexHome !== this.codexHome) {
      const reader = new CodexContextWindowReader({
        codexHome: requestedCodexHome,
        cacheTtlMs: this.cacheTtlMs,
        scanLimit: this.scanLimit,
        now: this.now,
      });
      return reader.readForAgent({ ...agent, providerHomePath: '' });
    }
    const agentId = String(agent?.id || '');
    if (!agentId) return unavailable('', 'Agent id is empty.');
    if (agent?.providerSessionProvider !== 'codex') return unavailable(agentId, 'Agent is not a Codex session.');

    const sessionId = String(agent.providerSessionId || '').trim();
    if (!sessionId || isTemporaryProviderSessionId(sessionId)) {
      return unavailable(agentId, 'Codex session has not been resolved yet.');
    }
    if (!isSafeProviderSessionId(sessionId)) return unavailable(agentId, 'Codex session id is not safe.');

    const filePath = await this.findSessionFile(sessionId);
    if (!filePath) return unavailable(agentId, 'Codex session log was not found.');

    return readLatestCodexContextWindow({ agentId, sessionId, filePath }).catch(() => (
      unavailable(agentId, 'Failed to read Codex context window.')
    ));
  }

  async readForAgents(agents: unknown): Promise<CodexContextWindowResult[]> {
    const list = Array.isArray(agents) ? agents : [];
    return Promise.all(list.map(agent => this.readForAgent(agent)));
  }
}

export {
  CodexContextWindowReader,
  contextWindowFromRecord,
  readLatestCodexContextWindow,
};
