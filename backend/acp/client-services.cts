const crypto = require('crypto') as typeof import('crypto');
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const { spawn } = require('child_process') as typeof import('child_process');
import { nodePty } from '../packaged-node-pty.cjs';

const fsp = fs.promises;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_TERMINALS_PER_AGENT = 32;

interface WorkspaceBinding {
  cwd: string;
}

interface AcpClientBinding extends WorkspaceBinding {
  agentId: string;
  sessionId: string;
  env: NodeJS.ProcessEnv;
  exited?: boolean;
}

interface AcpClientParams {
  [key: string]: unknown;
  sessionId?: unknown;
}

interface AcpClientFileSystemOptions {
  maxFileBytes?: number;
}

interface ResolveWorkspacePathOptions {
  allowMissing?: boolean;
}

interface TerminalManagerOptions {
  spawn?: ChildSpawn;
  ptySpawn?: PtySpawn;
}

interface ChildOutputStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

interface SpawnedChild {
  stdout?: ChildOutputStream | null;
  stderr?: ChildOutputStream | null;
  killed: boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

type ChildSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => SpawnedChild;

type PtySpawn = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    name: string;
    cols: number;
    rows: number;
  },
) => PtyChild;

interface PtyChild {
  killed?: boolean;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface TerminalExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface TerminalRecordBase {
  terminalId: string;
  agentId: string;
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  startedAt: number;
  endedAt: number | null;
  output: Buffer;
  outputLimit: number;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  released: boolean;
  waiters: Array<(exitStatus: TerminalExitStatus) => void>;
}

type TerminalRecord = TerminalRecordBase & (
  | { child: PtyChild; interactive: true }
  | { child: SpawnedChild; interactive: false }
);

interface TerminalDisplay {
  command: string;
  args: string[];
  cwd: string;
  output: string;
  truncated: boolean;
  exitStatus: TerminalExitStatus | null;
  released: boolean;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  interactive: boolean;
}

interface TerminalOutput {
  output: string;
  truncated: boolean;
  exitStatus?: TerminalExitStatus;
}

interface RequireTerminalOptions {
  allowReleased?: boolean;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireMatchingSession(
  binding: { sessionId?: unknown } | null | undefined,
  params: AcpClientParams | null | undefined,
): void {
  if (!binding?.sessionId || String(params?.sessionId || '') !== binding.sessionId) {
    throw new Error('ACP client request does not match the active session');
  }
}

function requireOpenBinding(binding: { exited?: unknown } | null | undefined): void {
  if (binding?.exited === true) throw new Error('ACP Agent connection is closed');
}

async function resolveWorkspacePath(
  binding: WorkspaceBinding,
  requestedPath: unknown,
  options: ResolveWorkspacePathOptions = {},
): Promise<string> {
  const value = String(requestedPath || '');
  if (!path.isAbsolute(value)) throw new Error('ACP file and terminal paths must be absolute');
  const logicalRoot = path.resolve(binding.cwd);
  const root = await fsp.realpath(binding.cwd);
  const logicalTarget = path.resolve(value);
  const target = isInside(logicalRoot, logicalTarget)
    ? path.resolve(root, path.relative(logicalRoot, logicalTarget))
    : isInside(root, logicalTarget)
      ? logicalTarget
      : null;
  if (!target) throw new Error('ACP path is outside the Agent workspace');

  if (options.allowMissing === true) {
    const parent = await fsp.realpath(path.dirname(target));
    if (!isInside(root, parent)) throw new Error('ACP path resolves outside the Agent workspace');
    return target;
  }

  const realTarget = await fsp.realpath(target);
  if (!isInside(root, realTarget)) throw new Error('ACP path resolves outside the Agent workspace');
  return realTarget;
}

class AcpClientFileSystem {
  maxFileBytes: number;

  constructor(options: AcpClientFileSystemOptions = {}) {
    this.maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  }

  async readTextFile(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Promise<{ content: string }> {
    requireMatchingSession(binding, params);
    const target = await resolveWorkspacePath(binding, params.path);
    const stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('ACP read path must be a file');
    if (stat.size > this.maxFileBytes) throw new Error('ACP text file is too large to read');
    const content = await fsp.readFile(target, 'utf8');
    const requestedLine = params.line == null ? 1 : Number(params.line);
    const requestedLimit = params.limit == null ? null : Number(params.limit);
    if (!Number.isInteger(requestedLine) || requestedLine < 1) throw new Error('ACP read line must be a positive integer');
    if (requestedLimit !== null && (!Number.isInteger(requestedLimit) || requestedLimit < 0)) {
      throw new Error('ACP read limit must be a non-negative integer');
    }
    if (requestedLine === 1 && requestedLimit === null) return { content };
    const lines = content.split('\n');
    const start = requestedLine - 1;
    const end = requestedLimit === null ? lines.length : start + requestedLimit;
    return { content: lines.slice(start, end).join('\n') };
  }

  async writeTextFile(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Promise<Record<string, never>> {
    requireMatchingSession(binding, params);
    const content = String(params.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new Error('ACP text file is too large to write');
    }
    const target = await resolveWorkspacePath(binding, params.path, { allowMissing: true });
    requireOpenBinding(binding);
    let mode = 0o666;
    try {
      const existing = await fsp.realpath(target);
      const root = await fsp.realpath(binding.cwd);
      if (!isInside(root, existing)) throw new Error('ACP path resolves outside the Agent workspace');
      const stat = await fsp.stat(existing);
      if (!stat.isFile()) throw new Error('ACP write path must be a file');
      mode = stat.mode;
    } catch (error) {
      if (
        !error
        || typeof error !== 'object'
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) {
        throw error;
      }
    }
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.farming-acp-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    try {
      requireOpenBinding(binding);
      await fsp.writeFile(temporary, content, { mode });
      requireOpenBinding(binding);
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return {};
  }
}

function boundedOutputLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TERMINAL_OUTPUT_BYTES;
  return Math.min(MAX_TERMINAL_OUTPUT_BYTES, Math.max(1, Math.floor(parsed)));
}

function trimUtf8Start(
  buffer: Buffer,
  limit: number,
): { buffer: Buffer; truncated: boolean } {
  if (buffer.length <= limit) return { buffer, truncated: false };
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return { buffer: buffer.subarray(start), truncated: true };
}

class AcpClientTerminalManager {
  spawn: ChildSpawn;
  ptySpawn: PtySpawn | null;
  terminals: Map<string, TerminalRecord>;
  pendingCreates: Map<string, number>;

  constructor(options: TerminalManagerOptions = {}) {
    this.spawn = options.spawn || ((command, args, spawnOptions) => (
      spawn(command, args, spawnOptions)
    ));
    this.ptySpawn = typeof options.ptySpawn === 'function'
      ? options.ptySpawn
      : typeof options.spawn === 'function'
        ? null
        : nodePty.spawn;
    this.terminals = new Map();
    this.pendingCreates = new Map();
  }

  activeCount(agentId: string): number {
    let count = 0;
    for (const record of this.terminals.values()) {
      if (record.agentId === agentId && !record.released && !record.exitStatus) count += 1;
    }
    return count;
  }

  reserveCreate(agentId: string): void {
    const pending = this.pendingCreates.get(agentId) || 0;
    if (this.activeCount(agentId) + pending >= MAX_ACTIVE_TERMINALS_PER_AGENT) {
      throw new Error('ACP terminal limit reached for this Agent');
    }
    this.pendingCreates.set(agentId, pending + 1);
  }

  releaseCreate(agentId: string): void {
    const pending = this.pendingCreates.get(agentId) || 0;
    if (pending <= 1) this.pendingCreates.delete(agentId);
    else this.pendingCreates.set(agentId, pending - 1);
  }

  async create(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Promise<{ terminalId: string }> {
    requireMatchingSession(binding, params);
    this.reserveCreate(binding.agentId);
    try {
      return await this.createReserved(binding, params);
    } finally {
      this.releaseCreate(binding.agentId);
    }
  }

  async createReserved(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Promise<{ terminalId: string }> {
    const command = String(params.command || '').trim();
    if (!command) throw new Error('ACP terminal command is required');
    const cwd = params.cwd
      ? await resolveWorkspacePath(binding, params.cwd)
      : await fsp.realpath(binding.cwd);
    requireOpenBinding(binding);
    const env = { ...binding.env };
    for (const item of Array.isArray(params.env) ? params.env : []) {
      const name = String(item?.name || '');
      if (!name || name.includes('=') || name.includes('\0')) throw new Error('Invalid ACP terminal environment variable');
      env[name] = String(item?.value ?? '');
    }
    const terminalId = `acp-terminal-${crypto.randomUUID()}`;
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const baseRecord: TerminalRecordBase = {
      terminalId,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      command,
      args,
      cwd,
      startedAt: Date.now(),
      endedAt: null,
      output: Buffer.alloc(0),
      outputLimit: boundedOutputLimit(params.outputByteLimit),
      truncated: false,
      exitStatus: null,
      released: false,
      waiters: [],
    };
    let record: TerminalRecord;
    const append = (chunk: Buffer | string): void => {
      const next = Buffer.concat([record.output, Buffer.from(chunk)]);
      const bounded = trimUtf8Start(next, record.outputLimit);
      record.output = bounded.buffer;
      record.truncated = record.truncated || bounded.truncated;
    };
    if (this.ptySpawn) {
      const child = this.ptySpawn(command, args, {
          cwd,
          env,
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
      });
      record = { ...baseRecord, child, interactive: true };
      this.terminals.set(terminalId, record);
      child.onData(append);
      child.onExit(event => this.finish(record, {
        exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null,
        signal: typeof event?.signal === 'number' && Number.isInteger(event.signal) && event.signal > 0
          ? String(event.signal)
          : null,
      }));
    } else {
      const child = this.spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      record = { ...baseRecord, child, interactive: false };
      this.terminals.set(terminalId, record);
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      child.on('error', error => {
        append(`${error.message || error}\n`);
        this.finish(record, { exitCode: null, signal: 'spawn-error' });
      });
      child.on('close', (code, signal) => this.finish(record, {
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal ? String(signal) : null,
      }));
    }
    return { terminalId };
  }

  require(
    binding: AcpClientBinding,
    params: AcpClientParams,
    options: RequireTerminalOptions = {},
  ): TerminalRecord {
    requireMatchingSession(binding, params);
    const record = this.terminals.get(String(params.terminalId || ''));
    if (!record || record.agentId !== binding.agentId || record.sessionId !== binding.sessionId) {
      throw new Error('Unknown ACP terminal');
    }
    if (record.released && options.allowReleased !== true) throw new Error('ACP terminal has been released');
    return record;
  }

  finish(record: TerminalRecord, exitStatus: TerminalExitStatus): void {
    if (record.exitStatus) return;
    record.exitStatus = exitStatus;
    record.endedAt = Date.now();
    const waiters = record.waiters.splice(0);
    waiters.forEach(resolve => resolve({ ...exitStatus }));
  }

  output(binding: AcpClientBinding, params: AcpClientParams): TerminalOutput {
    const record = this.require(binding, params);
    return {
      output: record.output.toString('utf8'),
      truncated: record.truncated,
      ...(record.exitStatus ? { exitStatus: { ...record.exitStatus } } : {}),
    };
  }

  waitForExit(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): TerminalExitStatus | Promise<TerminalExitStatus> {
    const record = this.require(binding, params);
    if (record.exitStatus) return { ...record.exitStatus };
    return new Promise<TerminalExitStatus>(resolve => record.waiters.push(resolve));
  }

  input(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Record<string, never> {
    const record = this.require(binding, params);
    if (!record.interactive) throw new Error('ACP terminal does not accept interactive input');
    if (record.exitStatus) throw new Error('ACP terminal has already exited');
    const input = String(params.input ?? '');
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024) throw new Error('ACP terminal input is too large');
    record.child.write(input);
    return {};
  }

  resize(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Record<string, never> {
    const record = this.require(binding, params);
    if (!record.interactive) return {};
    const cols = Number(params.cols);
    const rows = Number(params.rows);
    if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) {
      throw new Error('ACP terminal size is invalid');
    }
    if (!record.exitStatus) record.child.resize(cols, rows);
    return {};
  }

  kill(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Record<string, never> {
    const record = this.require(binding, params);
    if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
    return {};
  }

  release(
    binding: AcpClientBinding,
    params: AcpClientParams,
  ): Record<string, never> {
    const record = this.require(binding, params);
    if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
    record.released = true;
    return {};
  }

  display(terminalId: unknown): TerminalDisplay | null {
    const record = this.terminals.get(String(terminalId || ''));
    if (!record) return null;
    return {
      command: record.command,
      args: [...record.args],
      cwd: record.cwd,
      output: record.output.toString('utf8'),
      truncated: record.truncated,
      exitStatus: record.exitStatus ? { ...record.exitStatus } : null,
      released: record.released,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: Math.max(0, (record.endedAt || Date.now()) - record.startedAt),
      interactive: record.interactive,
    };
  }

  cleanupAgent(agentId: string): void {
    for (const [terminalId, record] of this.terminals) {
      if (record.agentId !== agentId) continue;
      if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
      this.terminals.delete(terminalId);
      this.finish(record, { exitCode: null, signal: 'SIGTERM' });
    }
  }
}

export {
  AcpClientFileSystem,
  AcpClientTerminalManager,
  resolveWorkspacePath,
};
