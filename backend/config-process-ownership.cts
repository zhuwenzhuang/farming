import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { canonicalConfigDir, configInstanceFingerprint } from './config-instance.cjs';
import { readServerProcessIdentity } from './server-process-identity.cjs';
import { acpRuntimeHostSocketPath } from './acp-runtime-host-path.cjs';
import { nativePtyHostSocketPath } from './native-pty-host-path.cjs';

type ProcessIdentity = {
  format?: unknown;
  pid: number;
  processGroupId: number;
  startedAt: string;
};

type OwnershipRecord = ProcessIdentity & {
  configInstanceFingerprint: string;
  role: string;
};

type HardStopOptions = {
  readProcessIdentity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  waitForProcessGroupExit?: (processGroupId: number) => Promise<boolean>;
};

const PROCESS_OWNERSHIP_VERSION = 1;
const HARD_STOP_WAIT_MS = 5_000;

function ownershipDir(configDir: string): string {
  return path.join(canonicalConfigDir(configDir), '.farming-processes');
}

function normalizeIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const pid = Number(candidate.pid);
  const processGroupId = Number(candidate.processGroupId);
  const startedAt = String(candidate.startedAt || '').trim();
  if (
    !Number.isSafeInteger(pid) || pid <= 0
    || !Number.isSafeInteger(processGroupId) || processGroupId <= 0
    || !startedAt
  ) return null;
  return { format: candidate.format, pid, processGroupId, startedAt };
}

function ownershipFilename(role: string, identity: ProcessIdentity): string {
  const roleKey = String(role || 'runtime').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48) || 'runtime';
  const identityKey = crypto.createHash('sha256')
    .update(`${identity.pid}\0${identity.processGroupId}\0${identity.startedAt}`)
    .digest('hex')
    .slice(0, 16);
  return `${roleKey}-${identity.pid}-${identityKey}.json`;
}

function registerConfigProcessGroup(configDir: string, role: string, rawIdentity: unknown): string {
  const identity = normalizeIdentity(rawIdentity);
  if (!identity) throw new Error('Config process ownership requires an exact process identity');
  const directory = ownershipDir(configDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, ownershipFilename(role, identity));
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    version: PROCESS_OWNERSHIP_VERSION,
    role,
    ...identity,
    configInstanceFingerprint: configInstanceFingerprint(configDir),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}

function unregisterConfigProcessGroup(configDir: string, role: string, rawIdentity: unknown): void {
  const identity = normalizeIdentity(rawIdentity);
  if (!identity) return;
  fs.rmSync(path.join(ownershipDir(configDir), ownershipFilename(role, identity)), { force: true });
}

function readOwnershipRecords(configDir: string): Array<{ file: string; record: OwnershipRecord }> {
  const directory = ownershipDir(configDir);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(directory).filter(entry => entry.endsWith('.json'));
  } catch {
    return [];
  }
  const expectedFingerprint = configInstanceFingerprint(configDir);
  return entries.flatMap(entry => {
    const file = path.join(directory, entry);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const identity = normalizeIdentity(value);
      if (!identity || value.configInstanceFingerprint !== expectedFingerprint) return [];
      return [{ file, record: {
        ...identity,
        role: String(value.role || 'runtime'),
        configInstanceFingerprint: expectedFingerprint,
      } }];
    } catch {
      return [];
    }
  });
}

function matchingIdentity(expected: ProcessIdentity, actual: ProcessIdentity | null): boolean {
  return Boolean(
    actual
    && actual.pid === expected.pid
    && actual.processGroupId === expected.processGroupId
    && actual.startedAt === expected.startedAt
  );
}

function processHasConfigEnvironment(pid: number, configDir: string): boolean {
  try {
    const entry = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .find(value => value.startsWith('FARMING_CONFIG_DIR='));
    return Boolean(entry && canonicalConfigDir(entry.slice('FARMING_CONFIG_DIR='.length)) === canonicalConfigDir(configDir));
  } catch {
    return process.platform !== 'linux';
  }
}

function requestHostPing(socketPath: string): Promise<Record<string, unknown> | null> {
  if (process.platform === 'win32') return Promise.resolve(null);
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => finish(null), 500);
    const finish = (value: Record<string, unknown> | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.once('error', () => finish(null));
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 1, method: 'ping', params: {} })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        finish(response.result && typeof response.result === 'object'
          ? response.result as Record<string, unknown>
          : null);
      } catch {
        finish(null);
      }
    });
  });
}

async function discoverConfigHostProcesses(configDir: string): Promise<OwnershipRecord[]> {
  const fingerprint = configInstanceFingerprint(configDir);
  const candidates = await Promise.all([
    requestHostPing(acpRuntimeHostSocketPath(configDir)).then(ping => ({ role: 'acp-runtime-host', ping })),
    requestHostPing(nativePtyHostSocketPath(configDir)).then(ping => ({ role: 'native-pty-host', ping })),
  ]);
  const records: OwnershipRecord[] = [];
  for (const candidate of candidates) {
    const pid = Number(candidate.ping?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !processHasConfigEnvironment(pid, configDir)) continue;
    if (
      candidate.role === 'acp-runtime-host'
      && candidate.ping?.configInstanceFingerprint !== fingerprint
    ) continue;
    const identity = await readServerProcessIdentity(pid);
    if (!identity) continue;
    records.push({ ...identity, role: candidate.role, configInstanceFingerprint: fingerprint });
  }
  return records;
}

function persistedProcessRecords(configDir: string): OwnershipRecord[] {
  const fingerprint = configInstanceFingerprint(configDir);
  const records: OwnershipRecord[] = [];
  const files = [
    ...safeJsonFiles(path.join(configDir, 'sessions'), file => file.endsWith('.state.json')),
    path.join(configDir, 'browsers', 'resources.json'),
  ];
  for (const file of files) {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const candidates = file.endsWith('resources.json')
      ? ((value as Record<string, unknown>)?.resources as unknown[] || []).map(resource => ({
          role: 'browser',
          identity: (resource as Record<string, unknown>)?.processIdentity,
        }))
      : [{
          role: 'acp-provider',
          identity: (value as Record<string, unknown>)?.privateMetadata
            ? ((value as Record<string, unknown>).privateMetadata as Record<string, unknown>).structuredRuntimeProcess
            : (value as Record<string, unknown>)?.structuredRuntimeProcess,
        }];
    for (const candidate of candidates) {
      const identity = normalizeIdentity(candidate.identity);
      if (!identity) continue;
      const persistedFingerprint = String((candidate.identity as Record<string, unknown>)?.configInstanceFingerprint || '');
      if (persistedFingerprint && persistedFingerprint !== fingerprint) continue;
      records.push({ ...identity, role: candidate.role, configInstanceFingerprint: fingerprint });
    }
  }
  return records;
}

function safeJsonFiles(directory: string, accept: (file: string) => boolean): string[] {
  try {
    return fs.readdirSync(directory).filter(accept).map(file => path.join(directory, file));
  } catch {
    return [];
  }
}

async function defaultWaitForProcessGroupExit(processGroupId: number): Promise<boolean> {
  const deadline = Date.now() + HARD_STOP_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      process.kill(-processGroupId, 0);
    } catch (error) {
      if (['ESRCH', 'EPERM'].includes(String((error as NodeJS.ErrnoException).code || ''))) return true;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

async function hardStopConfigProcesses(configDir: string, options: HardStopOptions = {}) {
  const readIdentity = options.readProcessIdentity || readServerProcessIdentity;
  const signal = options.signalProcessGroup || ((processGroupId, value) => process.kill(-processGroupId, value));
  const waitForExit = options.waitForProcessGroupExit || defaultWaitForProcessGroupExit;
  const registered = readOwnershipRecords(configDir);
  const discovered = options.readProcessIdentity
    ? []
    : [
        ...await discoverConfigHostProcesses(configDir),
        ...persistedProcessRecords(configDir),
      ].map(record => ({ file: '', record }));
  const unique = new Map<number, Array<{ file: string; record: OwnershipRecord }>>();
  for (const item of [...registered, ...discovered]) {
    const current = unique.get(item.record.processGroupId) || [];
    current.push(item);
    unique.set(item.record.processGroupId, current);
  }
  let stopped = 0;
  let refused = 0;
  for (const items of unique.values()) {
    const files = items.map(item => item.file).filter(Boolean);
    let record: OwnershipRecord | null = null;
    let observedLiveIdentity = false;
    for (const item of items) {
      const actual = await readIdentity(item.record.pid);
      if (!actual) continue;
      observedLiveIdentity = true;
      const configMatches = options.readProcessIdentity
        ? true
        : processHasConfigEnvironment(item.record.pid, configDir);
      if (matchingIdentity(item.record, actual) && configMatches) {
        record = item.record;
        break;
      }
    }
    if (!record) {
      if (observedLiveIdentity) {
        refused += 1;
      } else {
        // A persisted PID/PGID is only an ownership hint. Once the exact
        // process identity is gone, the numeric process group may be reused by
        // an unrelated process and must never be signalled.
        files.forEach(file => fs.rmSync(file, { force: true }));
      }
      continue;
    }
    try {
      signal(record.processGroupId, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      files.forEach(file => fs.rmSync(file, { force: true }));
      continue;
    }
    if (!await waitForExit(record.processGroupId)) {
      throw new Error(`Config-owned ${record.role} process group ${record.processGroupId} did not stop after SIGKILL`);
    }
    stopped += 1;
    files.forEach(file => fs.rmSync(file, { force: true }));
  }
  return { stopped, refused };
}

function hardStopConfigComputerContainers(configDir: string): { stopped: number; refused: number } {
  const file = path.join(configDir, 'computers', 'resources.json');
  let resources: unknown[] = [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    resources = Array.isArray(value.resources) ? value.resources : [];
  } catch {
    return { stopped: 0, refused: 0 };
  }
  const fingerprint = configInstanceFingerprint(configDir);
  let stopped = 0;
  let refused = 0;
  for (const raw of resources) {
    const resource = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const containerId = String(resource.containerId || '');
    if (!/^[a-f0-9]{12,64}$/i.test(containerId)) continue;
    let inspect: Record<string, unknown>;
    try {
      const parsed = JSON.parse(execFileSync('docker', ['inspect', containerId], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      }));
      inspect = Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such object|no such container/i.test(message)) continue;
      throw new Error(`Could not verify Config-owned Computer container ${containerId}`, { cause: error });
    }
    const labels = inspect.Config && typeof inspect.Config === 'object'
      ? ((inspect.Config as Record<string, unknown>).Labels as Record<string, unknown> || {})
      : {};
    if (
      String(inspect.Id || '') !== containerId
      || labels['farming.dev/kind'] !== 'computer'
      || labels['farming.dev/config'] !== fingerprint
      || labels['farming.dev/resource'] !== String(resource.id || '')
      || labels['farming.dev/owner-agent'] !== String(resource.ownerAgentId || '')
    ) {
      refused += 1;
      continue;
    }
    const containerState = inspect.State && typeof inspect.State === 'object'
      ? inspect.State as Record<string, unknown>
      : {};
    if (containerState.Running !== true) continue;
    execFileSync('docker', ['kill', '--signal', 'KILL', containerId], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    });
    stopped += 1;
  }
  return { stopped, refused };
}

export {
  hardStopConfigProcesses,
  hardStopConfigComputerContainers,
  registerConfigProcessGroup,
  unregisterConfigProcessGroup,
};
