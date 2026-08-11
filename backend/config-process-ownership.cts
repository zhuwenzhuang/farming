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
  discoverLegacyProcesses?: () => Promise<OwnershipRecord[]>;
  readProcessIdentity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  isProcessZombie?: (pid: number) => boolean;
  signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
  waitForProcessGroupExit?: (processGroupId: number) => Promise<boolean>;
};

const PROCESS_OWNERSHIP_VERSION = 1;
const HARD_STOP_WAIT_MS = 5_000;
const PROC_READ_LIMIT = 256 * 1024;

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
    return false;
  }
}

function processIsZombie(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  const stat = readBoundedFile(`/proc/${pid}/stat`, 64 * 1024)?.toString('utf8') || '';
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return false;
  return stat.slice(commandEnd + 2).trim().split(/\s+/, 1)[0] === 'Z';
}

function readBoundedFile(file: string, limit = PROC_READ_LIMIT): Buffer | null {
  let descriptor = -1;
  try {
    descriptor = fs.openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(limit + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > limit) return null;
    return buffer.subarray(0, bytes);
  } catch {
    return null;
  } finally {
    if (descriptor >= 0) fs.closeSync(descriptor);
  }
}

function procEnvironment(procDir: string): Map<string, string> | null {
  const content = readBoundedFile(path.join(procDir, 'environ'));
  if (!content) return null;
  return new Map(content.toString('utf8').split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function procCommandLine(procDir: string): string[] | null {
  const content = readBoundedFile(path.join(procDir, 'cmdline'), 64 * 1024);
  if (!content) return null;
  const args = content.toString('utf8').split('\0').filter(Boolean);
  return args.length > 0 ? args : null;
}

function procStatus(procDir: string): { parentPid: number; uid: number } | null {
  const content = readBoundedFile(path.join(procDir, 'status'), 64 * 1024)?.toString('utf8') || '';
  const uid = content.match(/^Uid:\s+(\d+)/m);
  const parentPid = content.match(/^PPid:\s+(\d+)/m);
  if (!uid || !parentPid) return null;
  return { uid: Number(uid[1]), parentPid: Number(parentPid[1]) };
}

function procProcessGroupId(procDir: string, expectedPid: number): number | null {
  const stat = readBoundedFile(path.join(procDir, 'stat'), 64 * 1024)?.toString('utf8') || '';
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const prefix = stat.slice(0, stat.indexOf(' '));
  const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
  if (Number(prefix) !== expectedPid || fields.length < 3) return null;
  const processGroupId = Number(fields[2]);
  return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
}

function exactManagedRootCarrier(
  args: string[],
  environment: Map<string, string>,
  relativeCarrier: string,
): boolean {
  const roots = [
    environment.get('FARMING_ACTIVE_PACKAGE_ROOT'),
    environment.get('FARMING_MANAGED_PACKAGE_ROOT'),
  ].filter((value): value is string => Boolean(value));
  return roots.some(root => args.includes(path.join(path.resolve(root), relativeCarrier)));
}

function legacyCarrierRole(
  args: string[],
  environment: Map<string, string>,
  configDir: string,
): string {
  if (
    exactManagedRootCarrier(args, environment, path.join('backend', 'acp-runtime-host-process.cjs'))
    || (
      args.includes('--acp-runtime-host')
      && exactManagedRootCarrier(args, environment, path.join('bin', 'farming'))
    )
  ) return 'legacy-acp-runtime-host';
  if (
    exactManagedRootCarrier(args, environment, path.join('backend', 'native-pty-host.cjs'))
    || (
      args.includes('--native-pty-host')
      && exactManagedRootCarrier(args, environment, path.join('bin', 'farming'))
    )
  ) return 'legacy-native-pty-host';

  const expectedBrowser = environment.get('FARMING_AGENT_BROWSER_BIN')
    || environment.get('FARMING_AGENT_BROWSER_EXECUTABLE')
    || '';
  let browserPath = '';
  try {
    browserPath = canonicalConfigDir(args[0] || '');
  } catch {
    return '';
  }
  let canonicalExpectedBrowser = '';
  try {
    canonicalExpectedBrowser = expectedBrowser ? canonicalConfigDir(expectedBrowser) : '';
  } catch {
    return '';
  }
  const browserRoot = path.join(canonicalConfigDir(configDir), 'runtimes', 'agentBrowser');
  if (
    expectedBrowser
    && browserPath === canonicalExpectedBrowser
    && path.basename(browserPath) === 'agent-browser'
    && browserPath.startsWith(`${browserRoot}${path.sep}`)
  ) return 'legacy-browser';
  return '';
}

async function discoverLegacyConfigProcesses(
  configDir: string,
  options: {
    currentUid?: number;
    procRoot?: string;
    readProcessIdentity?: (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;
  } = {},
): Promise<OwnershipRecord[]> {
  if (process.platform !== 'linux' && !options.procRoot) return [];
  const procRoot = options.procRoot || '/proc';
  const currentUid = options.currentUid ?? (process.geteuid ? process.geteuid() : process.getuid?.());
  if (!Number.isSafeInteger(currentUid) || Number(currentUid) < 0) return [];
  const canonicalDir = canonicalConfigDir(configDir);
  const fingerprint = configInstanceFingerprint(canonicalDir);
  const readIdentity = options.readProcessIdentity || readServerProcessIdentity;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(procRoot).filter(entry => /^\d+$/.test(entry));
  } catch {
    return [];
  }
  const records: OwnershipRecord[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    const procDir = path.join(procRoot, entry);
    const status = procStatus(procDir);
    if (!status || status.uid !== currentUid) continue;
    const environment = procEnvironment(procDir);
    if (!environment) continue;
    const observedConfigDir = environment.get('FARMING_CONFIG_DIR') || '';
    try {
      if (!observedConfigDir || canonicalConfigDir(observedConfigDir) !== canonicalDir) continue;
    } catch {
      continue;
    }
    const args = procCommandLine(procDir);
    if (!args) continue;
    const role = legacyCarrierRole(args, environment, canonicalDir);
    if (!role) continue;
    const processGroupId = procProcessGroupId(procDir, pid);
    if (processGroupId !== pid) continue;
    const identity = await readIdentity(pid);
    if (!identity || identity.pid !== pid || identity.processGroupId !== processGroupId) continue;
    records.push({ ...identity, role, configInstanceFingerprint: fingerprint });
  }
  return records;
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
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const claimedFingerprint = String(candidate.ping?.configInstanceFingerprint || '');
    const configOwned = claimedFingerprint
      ? claimedFingerprint === fingerprint
      : candidate.role === 'native-pty-host' && processHasConfigEnvironment(pid, configDir);
    if (!configOwned) continue;
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
      if (persistedFingerprint !== fingerprint) continue;
      records.push({ ...identity, role: candidate.role, configInstanceFingerprint: persistedFingerprint });
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
  const isZombie = options.isProcessZombie || processIsZombie;
  const signal = options.signalProcessGroup || ((processGroupId, value) => process.kill(-processGroupId, value));
  const waitForExit = options.waitForProcessGroupExit || defaultWaitForProcessGroupExit;
  const registered = readOwnershipRecords(configDir);
  const discovered = options.readProcessIdentity
    && !options.discoverLegacyProcesses
    ? []
    : [
        ...await discoverConfigHostProcesses(configDir),
        ...persistedProcessRecords(configDir),
        ...(options.discoverLegacyProcesses
          ? await options.discoverLegacyProcesses()
          : await discoverLegacyConfigProcesses(configDir)),
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
      // A zombie has already terminated and cannot execute or be killed. Its
      // environment is no longer reliable on Linux, so treating it as an
      // unowned live process creates a false refusal during hard-stop races.
      if (isZombie(item.record.pid)) continue;
      observedLiveIdentity = true;
      if (matchingIdentity(item.record, actual)) {
        record = item.record;
        break;
      }
    }
    if (!record) {
      if (observedLiveIdentity) {
        let stillLive = false;
        for (const item of items) {
          const reconciled = await readIdentity(item.record.pid);
          if (!reconciled || isZombie(item.record.pid)) continue;
          stillLive = true;
          break;
        }
        if (stillLive) {
          refused += 1;
        } else {
          // Identity and environment reads are separate observations. A
          // Config-owned process can finish exiting between them; reconcile
          // that terminal state before treating it as an ownership refusal.
          files.forEach(file => fs.rmSync(file, { force: true }));
        }
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
  discoverLegacyConfigProcesses,
  registerConfigProcessGroup,
  unregisterConfigProcessGroup,
};
