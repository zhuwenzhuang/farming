const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  matchingProcessIdentity,
  readServerProcessIdentity,
} = require('./server-process-identity.cjs');

type NpmUpdateAction = 'prepare' | 'apply';

interface ProcessIdentityInput {
  pid?: unknown;
  processGroupId?: unknown;
  startedAt?: unknown;
}

interface NpmUpdatePayload {
  action: NpmUpdateAction;
  packageName: string;
  targetVersion: string;
  previousVersion: string;
  startedAt?: string;
  preparedAt?: string;
  stateFile: string;
  logPath: string;
  cliPath: string;
  packageRoot: string;
  configDir: string;
  stagingPrefix: string;
  stagingPackageRoot: string;
  nodePath: string;
  npmCommand?: string;
  npmPrefix?: string;
  npmFallbackRegistryUrl?: string;
  serverPid?: number | string;
  serverProcessIdentity?: ProcessIdentityInput | null;
  port: number | string;
  basePath: string;
  serverHome?: string;
  disableAuth?: boolean;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPath: string;
}

interface NpmUpdateState extends Record<string, unknown> {
  method: 'npm';
  phase: string;
  version: string;
  previousVersion: string;
  packageName: string;
  startedAt?: string;
  logPath: string;
  stagingPrefix: string;
  stagingPackageRoot: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorCode(error: unknown): string {
  return isObject(error) ? String(error.code || '') : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function appendLog(logPath: string, message: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function runCommand(command: string, args: string[], options: CommandOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const logFd = fs.openSync(options.logPath, 'a');
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error: Error) => {
      fs.closeSync(logFd);
      reject(error);
    });
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      fs.closeSync(logFd);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

function isProcessRunning(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES') return true;
    return false;
  }
}

async function stopProcess(
  pid: number,
  expectedIdentity: ProcessIdentityInput | null | undefined,
  timeoutMs = 15_000,
): Promise<void> {
  if (!isProcessRunning(pid)) return;
  const currentIdentity = await readServerProcessIdentity(pid);
  if (!matchingProcessIdentity(expectedIdentity, currentIdentity)) {
    throw new Error(`Refusing to stop Farming server ${pid}: process identity changed`);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error: unknown) {
    if (errorCode(error) === 'EPERM' || errorCode(error) === 'EACCES') {
      throw new Error(
        `Farming cannot stop server ${pid} because the update helper lacks permission. `
        + 'Use the operating-system user that owns this process (or an administrator) to stop and restart Farming, then retry the update.',
        { cause: error },
      );
    }
    if (errorCode(error) !== 'ESRCH') throw error;
  }
  const startedAt = Date.now();
  while (matchingProcessIdentity(expectedIdentity, await readServerProcessIdentity(pid))) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Farming server ${pid} did not exit after SIGKILL. `
        + 'Stop and restart Farming manually, then retry the update.',
      );
    }
    await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
}

function validatePayload(payload: unknown): NpmUpdatePayload {
  if (!payload || typeof payload !== 'object') throw new Error('Missing npm update payload');
  const candidate = payload as Record<string, unknown>;
  if (!['prepare', 'apply'].includes(String(candidate.action))) throw new Error('Invalid npm update action');
  if (!/^[A-Za-z0-9@/._-]+$/.test(String(candidate.packageName || ''))) throw new Error('Invalid npm package name');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(candidate.targetVersion || ''))) throw new Error('Invalid npm target version');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(candidate.previousVersion || ''))) throw new Error('Invalid npm previous version');
  for (const key of ['stateFile', 'logPath', 'cliPath', 'packageRoot', 'configDir', 'stagingPrefix', 'stagingPackageRoot']) {
    if (!path.isAbsolute(String(candidate[key] || ''))) throw new Error(`Invalid npm update ${key}`);
  }
  if (candidate.npmPrefix && !path.isAbsolute(String(candidate.npmPrefix))) {
    throw new Error('Invalid npm update npmPrefix');
  }
  if (candidate.npmFallbackRegistryUrl) {
    let registry;
    try {
      registry = new URL(String(candidate.npmFallbackRegistryUrl));
    } catch {
      throw new Error('Invalid npm update registry');
    }
    if (!['http:', 'https:'].includes(registry.protocol)) {
      throw new Error('Invalid npm update registry');
    }
  }
  const expectedStagingRoot = path.join(
    String(candidate.stagingPrefix),
    'lib',
    'node_modules',
    String(candidate.packageName),
  );
  if (path.resolve(String(candidate.stagingPackageRoot)) !== path.resolve(expectedStagingRoot)) {
    throw new Error('Invalid npm update stagingPackageRoot');
  }
  if (path.resolve(String(candidate.stagingPackageRoot)) === path.resolve(String(candidate.packageRoot))) {
    throw new Error('npm update staging root must differ from the running package root');
  }
  return payload as NpmUpdatePayload;
}

function stateFor(
  payload: NpmUpdatePayload,
  phase: string,
  extra: Record<string, unknown> = {},
): NpmUpdateState {
  return {
    method: 'npm',
    phase,
    version: payload.targetVersion,
    previousVersion: payload.previousVersion,
    packageName: payload.packageName,
    startedAt: payload.startedAt,
    logPath: payload.logPath,
    stagingPrefix: payload.stagingPrefix,
    stagingPackageRoot: payload.stagingPackageRoot,
    ...extra,
  };
}

function startArguments(payload: NpmUpdatePayload): string[] {
  const args = [
    payload.cliPath,
    'daemon',
    '--port', String(payload.port),
    '--base-path', payload.basePath,
    '--config-dir', payload.configDir,
  ];
  if (payload.serverHome) args.push('--home', payload.serverHome);
  if (payload.disableAuth) args.push('--no-auth');
  return args;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.FARMING_NPM_UPDATE_PAYLOAD;
  delete env.FARMING_RUN_SERVER;
  delete env.FARMING_RUN_NATIVE_PTY_HOST;
  return env;
}

async function installPackage(
  payload: NpmUpdatePayload,
  version: string,
  npmPrefix = payload.npmPrefix,
): Promise<void> {
  const packageSpec = `${payload.packageName}@${version}`;
  return installPackageFromRegistry(payload, packageSpec, '', npmPrefix);
}

function verifyInstalledVersion(
  payload: NpmUpdatePayload,
  expectedVersion: string,
  packageRoot = payload.packageRoot,
): void {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  let metadata: unknown;
  try {
    metadata = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (error: unknown) {
    throw new Error(
      `Installed ${payload.packageName} package metadata is unreadable: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const actualVersion = String(isObject(metadata) ? metadata.version || '' : '');
  if (actualVersion !== expectedVersion) {
    throw new Error(`Installed ${payload.packageName} version mismatch: expected ${expectedVersion}, found ${actualVersion || 'missing'}`);
  }
}

function logSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function logSince(filePath: string, offset: number): string {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(offset);
  } catch {
    return '';
  }
}

async function installPackageFromRegistry(
  payload: NpmUpdatePayload,
  packageSpec: string,
  registryUrl = '',
  npmPrefix = payload.npmPrefix,
): Promise<void> {
  appendLog(payload.logPath, `Installing ${packageSpec}${registryUrl ? ' from the update-status registry' : ''}`);
  const args = ['install', '--global'];
  if (npmPrefix) args.push('--prefix', npmPrefix);
  if (registryUrl) args.push('--registry', registryUrl);
  args.push(packageSpec, '--no-audit', '--no-fund');
  const offset = logSize(payload.logPath);
  try {
    await runCommand(payload.npmCommand || 'npm', args, {
      cwd: payload.configDir,
      env: commandEnvironment(),
      logPath: payload.logPath,
    });
  } catch (error: unknown) {
    if (!registryUrl && payload.npmFallbackRegistryUrl && /(?:ETARGET|No matching version found)/.test(logSince(payload.logPath, offset))) {
      appendLog(payload.logPath, `Configured npm registry has no ${packageSpec}; retrying from the update-status registry`);
      return installPackageFromRegistry(payload, packageSpec, payload.npmFallbackRegistryUrl, npmPrefix);
    }
    throw error;
  }
}

async function startServer(
  payload: NpmUpdatePayload,
  version = payload.targetVersion,
): Promise<void> {
  appendLog(payload.logPath, `Starting Farming ${version}`);
  await runCommand(payload.nodePath, startArguments(payload), {
    cwd: payload.configDir,
    env: commandEnvironment(),
    logPath: payload.logPath,
  });
}

async function prepareNpmUpdate(payload: NpmUpdatePayload): Promise<void> {
  try {
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'installing'));
    fs.mkdirSync(payload.stagingPrefix, { recursive: true });
    await installPackage(payload, payload.targetVersion, payload.stagingPrefix);
    verifyInstalledVersion(payload, payload.targetVersion, payload.stagingPackageRoot);
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'preparing-runtimes'));
    appendLog(payload.logPath, `Preparing Farming ${payload.targetVersion} startup dependencies`);
    await runCommand(payload.nodePath, [
      path.join(payload.stagingPackageRoot, 'bin', 'farming'),
      'runtime',
      'prepare',
      '--config-dir',
      payload.configDir,
    ], {
      cwd: payload.configDir,
      env: commandEnvironment(),
      logPath: payload.logPath,
    });
    const preparedAt = new Date().toISOString();
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'ready-to-restart', {
      preparedAt,
      runtimePreparedAt: preparedAt,
    }));
    appendLog(payload.logPath, `Farming ${payload.targetVersion} is ready to restart`);
  } catch (error: unknown) {
    const message = errorMessage(error);
    appendLog(payload.logPath, `Update preparation failed: ${message}`);
    try {
      fs.rmSync(payload.stagingPrefix, { recursive: true, force: true });
    } catch (cleanupError: unknown) {
      appendLog(payload.logPath, `Update preparation cleanup failed: ${errorMessage(cleanupError)}`);
    }
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
      error: message,
      completedAt: new Date().toISOString(),
    }));
  }
}

async function applyNpmUpdate(payload: NpmUpdatePayload): Promise<void> {
  const backupRoot = path.join(
    path.dirname(payload.packageRoot),
    `.${path.basename(payload.packageRoot)}.backup-${process.pid}`,
  );
  let stoppedOldServer = false;
  let movedOldPackage = false;
  let movedNewPackage = false;
  try {
    verifyInstalledVersion(payload, payload.previousVersion, payload.packageRoot);
    verifyInstalledVersion(payload, payload.targetVersion, payload.stagingPackageRoot);
    if (fs.existsSync(backupRoot)) throw new Error(`npm update backup already exists: ${backupRoot}`);

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'restarting', {
      preparedAt: payload.preparedAt,
    }));
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    await stopProcess(Number(payload.serverPid), payload.serverProcessIdentity);
    stoppedOldServer = true;
    fs.renameSync(payload.packageRoot, backupRoot);
    movedOldPackage = true;
    fs.renameSync(payload.stagingPackageRoot, payload.packageRoot);
    movedNewPackage = true;
    await startServer(payload);

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'succeeded', {
      preparedAt: payload.preparedAt,
      completedAt: new Date().toISOString(),
    }));
    appendLog(payload.logPath, `Farming updated to ${payload.targetVersion}`);
    try {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      fs.rmSync(payload.stagingPrefix, { recursive: true, force: true });
    } catch (cleanupError: unknown) {
      appendLog(payload.logPath, `Update cleanup failed: ${errorMessage(cleanupError)}`);
    }
  } catch (error: unknown) {
    const message = errorMessage(error);
    appendLog(payload.logPath, `Update apply failed: ${message}`);

    if (stoppedOldServer || !isProcessRunning(Number(payload.serverPid))) {
      try {
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'rolling-back', {
          preparedAt: payload.preparedAt,
          error: message,
        }));
        if (movedNewPackage && fs.existsSync(payload.packageRoot)) {
          fs.mkdirSync(path.dirname(payload.stagingPackageRoot), { recursive: true });
          fs.renameSync(payload.packageRoot, payload.stagingPackageRoot);
        }
        if (movedOldPackage && fs.existsSync(backupRoot)) {
          fs.renameSync(backupRoot, payload.packageRoot);
        }
        verifyInstalledVersion(payload, payload.previousVersion, payload.packageRoot);
        await startServer(payload, payload.previousVersion);
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'rolled-back', {
          version: payload.previousVersion,
          attemptedVersion: payload.targetVersion,
          preparedAt: payload.preparedAt,
          error: message,
          completedAt: new Date().toISOString(),
        }));
        appendLog(payload.logPath, `Rolled back to ${payload.previousVersion}`);
        try {
          fs.rmSync(payload.stagingPrefix, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          appendLog(payload.logPath, `Rollback cleanup failed: ${errorMessage(cleanupError)}`);
        }
        return;
      } catch (rollbackError: unknown) {
        const rollbackMessage = errorMessage(rollbackError);
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
          error: `${message}; rollback failed: ${rollbackMessage}`,
          completedAt: new Date().toISOString(),
        }));
        return;
      }
    }

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
      preparedAt: payload.preparedAt,
      error: message,
      completedAt: new Date().toISOString(),
    }));
  }
}

async function runNpmUpdate(rawPayload: unknown): Promise<void> {
  const payload = validatePayload(rawPayload);
  if (payload.action === 'prepare') return prepareNpmUpdate(payload);
  return applyNpmUpdate(payload);
}

if (require.main === module) {
  let payload: unknown;
  try {
    payload = JSON.parse(process.env.FARMING_NPM_UPDATE_PAYLOAD || '');
  } catch {
    console.error('Invalid FARMING_NPM_UPDATE_PAYLOAD');
    process.exit(1);
  }
  runNpmUpdate(payload).catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exit(1);
  });
}

export {
  isProcessRunning,
  runNpmUpdate,
  stopProcess,
  validatePayload,
  verifyInstalledVersion,
  writeJsonAtomic,
};
