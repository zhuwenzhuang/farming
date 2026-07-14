const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nodePty = require('../packaged-node-pty');

const fsp = fs.promises;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINAL_OUTPUT_BYTES = 1024 * 1024;
const MAX_TERMINAL_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_TERMINALS_PER_AGENT = 32;

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireMatchingSession(binding, params) {
  if (!binding?.sessionId || String(params?.sessionId || '') !== binding.sessionId) {
    throw new Error('ACP client request does not match the active session');
  }
}

async function resolveWorkspacePath(binding, requestedPath, options = {}) {
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
  constructor(options = {}) {
    this.maxFileBytes = options.maxFileBytes || DEFAULT_MAX_FILE_BYTES;
  }

  async readTextFile(binding, params) {
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

  async writeTextFile(binding, params) {
    requireMatchingSession(binding, params);
    const content = String(params.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > this.maxFileBytes) {
      throw new Error('ACP text file is too large to write');
    }
    const target = await resolveWorkspacePath(binding, params.path, { allowMissing: true });
    let mode = 0o666;
    try {
      const existing = await fsp.realpath(target);
      const root = await fsp.realpath(binding.cwd);
      if (!isInside(root, existing)) throw new Error('ACP path resolves outside the Agent workspace');
      const stat = await fsp.stat(existing);
      if (!stat.isFile()) throw new Error('ACP write path must be a file');
      mode = stat.mode;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.farming-acp-${process.pid}-${Date.now()}.tmp`);
    try {
      await fsp.writeFile(temporary, content, { mode });
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return {};
  }
}

function boundedOutputLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TERMINAL_OUTPUT_BYTES;
  return Math.min(MAX_TERMINAL_OUTPUT_BYTES, Math.max(1, Math.floor(parsed)));
}

function trimUtf8Start(buffer, limit) {
  if (buffer.length <= limit) return { buffer, truncated: false };
  let start = buffer.length - limit;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
  return { buffer: buffer.subarray(start), truncated: true };
}

class AcpClientTerminalManager {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.ptySpawn = typeof options.ptySpawn === 'function'
      ? options.ptySpawn
      : typeof options.spawn === 'function'
        ? null
        : nodePty.spawn;
    this.sequence = 0;
    this.terminals = new Map();
  }

  activeCount(agentId) {
    let count = 0;
    for (const record of this.terminals.values()) {
      if (record.agentId === agentId && !record.released && !record.exitStatus) count += 1;
    }
    return count;
  }

  async create(binding, params) {
    requireMatchingSession(binding, params);
    if (this.activeCount(binding.agentId) >= MAX_ACTIVE_TERMINALS_PER_AGENT) {
      throw new Error('ACP terminal limit reached for this Agent');
    }
    const command = String(params.command || '').trim();
    if (!command) throw new Error('ACP terminal command is required');
    const cwd = params.cwd
      ? await resolveWorkspacePath(binding, params.cwd)
      : await fsp.realpath(binding.cwd);
    const env = { ...binding.env };
    for (const item of Array.isArray(params.env) ? params.env : []) {
      const name = String(item?.name || '');
      if (!name || name.includes('=') || name.includes('\0')) throw new Error('Invalid ACP terminal environment variable');
      env[name] = String(item?.value ?? '');
    }
    const terminalId = `acp-terminal-${++this.sequence}`;
    const args = Array.isArray(params.args) ? params.args.map(String) : [];
    const child = this.ptySpawn
      ? this.ptySpawn(command, args, {
          cwd,
          env,
          name: 'xterm-256color',
          cols: 80,
          rows: 24,
        })
      : this.spawn(command, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    const record = {
      terminalId,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      command,
      args,
      cwd,
      startedAt: Date.now(),
      endedAt: null,
      child,
      output: Buffer.alloc(0),
      outputLimit: boundedOutputLimit(params.outputByteLimit),
      truncated: false,
      exitStatus: null,
      released: false,
      waiters: [],
      interactive: Boolean(this.ptySpawn),
    };
    this.terminals.set(terminalId, record);
    const append = chunk => {
      const next = Buffer.concat([record.output, Buffer.from(chunk)]);
      const bounded = trimUtf8Start(next, record.outputLimit);
      record.output = bounded.buffer;
      record.truncated = record.truncated || bounded.truncated;
    };
    if (record.interactive) {
      child.onData(append);
      child.onExit(event => this.finish(record, {
        exitCode: Number.isInteger(event?.exitCode) ? event.exitCode : null,
        signal: Number.isInteger(event?.signal) && event.signal > 0 ? String(event.signal) : null,
      }));
    } else {
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

  require(binding, params, options = {}) {
    requireMatchingSession(binding, params);
    const record = this.terminals.get(String(params.terminalId || ''));
    if (!record || record.agentId !== binding.agentId || record.sessionId !== binding.sessionId) {
      throw new Error('Unknown ACP terminal');
    }
    if (record.released && options.allowReleased !== true) throw new Error('ACP terminal has been released');
    return record;
  }

  finish(record, exitStatus) {
    if (record.exitStatus) return;
    record.exitStatus = exitStatus;
    record.endedAt = Date.now();
    const waiters = record.waiters.splice(0);
    waiters.forEach(resolve => resolve({ ...exitStatus }));
  }

  output(binding, params) {
    const record = this.require(binding, params);
    return {
      output: record.output.toString('utf8'),
      truncated: record.truncated,
      ...(record.exitStatus ? { exitStatus: { ...record.exitStatus } } : {}),
    };
  }

  waitForExit(binding, params) {
    const record = this.require(binding, params);
    if (record.exitStatus) return { ...record.exitStatus };
    return new Promise(resolve => record.waiters.push(resolve));
  }

  input(binding, params) {
    const record = this.require(binding, params);
    if (!record.interactive) throw new Error('ACP terminal does not accept interactive input');
    if (record.exitStatus) throw new Error('ACP terminal has already exited');
    const input = String(params.input ?? '');
    if (Buffer.byteLength(input, 'utf8') > 64 * 1024) throw new Error('ACP terminal input is too large');
    record.child.write(input);
    return {};
  }

  resize(binding, params) {
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

  kill(binding, params) {
    const record = this.require(binding, params);
    if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
    return {};
  }

  release(binding, params) {
    const record = this.require(binding, params);
    if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
    record.released = true;
    return {};
  }

  display(terminalId) {
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

  cleanupAgent(agentId) {
    for (const [terminalId, record] of this.terminals) {
      if (record.agentId !== agentId) continue;
      if (!record.exitStatus && !record.child.killed) record.child.kill('SIGTERM');
      this.terminals.delete(terminalId);
      this.finish(record, { exitCode: null, signal: 'SIGTERM' });
    }
  }
}

module.exports = {
  AcpClientFileSystem,
  AcpClientTerminalManager,
  resolveWorkspacePath,
};
