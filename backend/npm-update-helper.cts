const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
import { matchingProcessIdentity, readServerProcessIdentity } from './server-process-identity.cjs';
import {
  activatePackageImage,
  initializeCurrentPackageImage,
  packageImageForPointer,
  publishPreparedPackageImage,
  publishRunningPackageImage,
  readCurrentPackagePointer,
  readPackageImageRef,
  resolvePackageInstallationContext,
} from './package-installation.cjs';
import type { ActivatePackageImageResult, PackageInstallationContext } from './package-installation.cjs';
import { canonicalConfigDir } from './config-instance.cjs';
import {
  acquireUpdateStateLock,
  commitUpdateOperationState,
  readUpdateOperationOwnership,
  releaseUpdateStateLock,
  writeJsonAtomic,
} from './update-operation-state.cjs';

type NpmUpdateAction = 'prepare' | 'apply';

interface ProcessIdentityInput {
  pid?: unknown;
  processGroupId?: unknown;
  startedAt?: unknown;
}

interface NpmUpdatePayload {
  action: NpmUpdateAction;
  operationId: string;
  packageName: string;
  targetVersion: string;
  previousVersion: string;
  startedAt?: string;
  preparedAt?: string;
  restartingAt?: string;
  targetIntegrity: string;
  stateFile: string;
  logPath: string;
  activePackageRoot: string;
  installationId: string;
  installationRoot: string;
  bootstrapPackageRoot: string;
  configDir: string;
  stagingPrefix?: string;
  stagingPackageRoot?: string;
  runningPackageRoot?: string;
  runningImageId?: string;
  targetPackageRoot?: string;
  targetImageId?: string;
  expectedCurrentImageId?: string;
  nodePath: string;
  npmCommand?: string;
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
  format: 'farming-update-operation-v1';
  operationId: string;
  method: 'npm';
  phase: string;
  version: string;
  previousVersion: string;
  packageName: string;
  startedAt?: string;
  restartingAt?: string;
  logPath: string;
  stagingPrefix?: string;
  stagingPackageRoot?: string;
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

class SupersededUpdateOperationError extends Error {}

const UPDATE_OPERATION_STATE_FORMAT = 'farming-update-operation-v1';

function expectedOwnership(payload: NpmUpdatePayload): { format: string; operationId: string } {
  return { format: UPDATE_OPERATION_STATE_FORMAT, operationId: payload.operationId };
}

function operationOwnsState(payload: NpmUpdatePayload, expectedPhase?: string): boolean {
  const ownership = readUpdateOperationOwnership(payload.stateFile);
  return Boolean(
    ownership
    && ownership.format === UPDATE_OPERATION_STATE_FORMAT
    && ownership.operationId === payload.operationId
    && (expectedPhase === undefined || ownership.phase === expectedPhase),
  );
}

// Irreversible effects cannot be repaired by rejecting a later state commit.
// Hold the same exact-identity claim from ownership validation through the
// effect so a Server timeout cannot revoke the operation in between.
async function runWhileOperationOwned<T>(
  payload: NpmUpdatePayload,
  expectedPhase: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const claim = acquireUpdateStateLock(payload.stateFile);
  let result: T | undefined;
  let actionFailed = false;
  let actionError: unknown;
  try {
    if (!operationOwnsState(payload, expectedPhase)) {
      throw new SupersededUpdateOperationError(`Update operation ${payload.operationId} is no longer current`);
    }
    result = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  try {
    if (!releaseUpdateStateLock(payload.stateFile, claim)) {
      releaseFailed = true;
      releaseError = new Error(
        `Update operation ${payload.operationId} could not release its ownership claim after a protected effect`,
      );
    }
  } catch (error) {
    releaseFailed = true;
    releaseError = error;
  }
  if (actionFailed && releaseFailed) {
    throw new AggregateError(
      [actionError, releaseError],
      `Update operation ${payload.operationId} failed and could not release its ownership claim`,
    );
  }
  if (actionFailed) throw actionError;
  if (releaseFailed) throw releaseError;
  return result as T;
}

// Ownership observation and state publication form one atomic decision under
// the shared update-state claim, so a superseded operation can never publish
// over the operation that replaced it.
function writeOperationState(
  payload: NpmUpdatePayload,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  if (!commitUpdateOperationState(payload.stateFile, expectedOwnership(payload), stateFor(payload, phase, extra))) {
    throw new SupersededUpdateOperationError(`Update operation ${payload.operationId} is no longer current`);
  }
}

function writeOperationStateIfOwned(
  payload: NpmUpdatePayload,
  phase: string,
  extra: Record<string, unknown> = {},
): boolean {
  return commitUpdateOperationState(payload.stateFile, expectedOwnership(payload), stateFor(payload, phase, extra));
}

function appendLog(logPath: string, message: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function runCommand(command: string, args: string[], options: CommandOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const logFd = fs.openSync(options.logPath, 'a');
    let spawnError: Error | null = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', (error: Error) => {
      spawnError = error;
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      fs.closeSync(logFd);
      if (spawnError) {
        reject(spawnError);
        return;
      }
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
  if (!/^[0-9a-f-]{16,64}$/i.test(String(candidate.operationId || ''))) throw new Error('Invalid npm update operation id');
  if (!/^[A-Za-z0-9@/._-]+$/.test(String(candidate.packageName || ''))) throw new Error('Invalid npm package name');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(candidate.targetVersion || ''))) throw new Error('Invalid npm target version');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(candidate.previousVersion || ''))) throw new Error('Invalid npm previous version');
  if (!String(candidate.targetIntegrity || '').trim()) throw new Error('Invalid npm target integrity');
  if (!/^[a-f0-9]{16}$/.test(String(candidate.installationId || ''))) throw new Error('Invalid npm installation id');
  for (const key of [
    'stateFile',
    'logPath',
    'activePackageRoot',
    'installationRoot',
    'bootstrapPackageRoot',
    'configDir',
  ]) {
    if (!path.isAbsolute(String(candidate[key] || ''))) throw new Error(`Invalid npm update ${key}`);
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
  if (candidate.action === 'prepare') {
    for (const key of ['stagingPrefix', 'stagingPackageRoot']) {
      if (!path.isAbsolute(String(candidate[key] || ''))) throw new Error(`Invalid npm update ${key}`);
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
  } else {
    for (const key of ['runningPackageRoot', 'targetPackageRoot']) {
      if (!path.isAbsolute(String(candidate[key] || ''))) throw new Error(`Invalid npm update ${key}`);
    }
    for (const key of ['runningImageId', 'targetImageId', 'expectedCurrentImageId']) {
      if (!/^[a-f0-9]{16}$/.test(String(candidate[key] || ''))) throw new Error(`Invalid npm update ${key}`);
    }
  }
  return payload as NpmUpdatePayload;
}

function stateFor(
  payload: NpmUpdatePayload,
  phase: string,
  extra: Record<string, unknown> = {},
): NpmUpdateState {
  return {
    format: UPDATE_OPERATION_STATE_FORMAT,
    operationId: payload.operationId,
    method: 'npm',
    phase,
    version: payload.targetVersion,
    previousVersion: payload.previousVersion,
    packageName: payload.packageName,
    targetIntegrity: payload.targetIntegrity,
    startedAt: payload.startedAt,
    restartingAt: payload.restartingAt,
    logPath: payload.logPath,
    stagingPrefix: payload.stagingPrefix,
    stagingPackageRoot: payload.stagingPackageRoot,
    installationId: payload.installationId,
    installationRoot: payload.installationRoot,
    bootstrapPackageRoot: payload.bootstrapPackageRoot,
    runningPackageRoot: payload.runningPackageRoot,
    runningImageId: payload.runningImageId,
    targetPackageRoot: payload.targetPackageRoot,
    targetImageId: payload.targetImageId,
    expectedCurrentImageId: payload.expectedCurrentImageId,
    ...extra,
  };
}

function startArguments(payload: NpmUpdatePayload, packageRoot: string): string[] {
  const args = [
    path.join(packageRoot, 'bin', 'farming'),
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
  delete env.FARMING_ACTIVE_PACKAGE_ROOT;
  delete env.FARMING_MANAGED_PACKAGE_ROOT;
  return env;
}

async function installPackage(
  payload: NpmUpdatePayload,
  version: string,
): Promise<void> {
  const packageSpec = `${payload.packageName}@${version}`;
  try {
    await installPackageFromRegistry(payload, packageSpec);
  } catch (configuredRegistryError: unknown) {
    if (!payload.npmFallbackRegistryUrl) throw configuredRegistryError;
    if (!operationOwnsState(payload)) {
      throw new SupersededUpdateOperationError(`Update operation ${payload.operationId} is no longer current`);
    }
    appendLog(
      payload.logPath,
      `Configured npm install failed for ${packageSpec}; retrying from the authoritative update registry`,
    );
    fs.rmSync(String(payload.stagingPrefix), { recursive: true, force: true });
    fs.mkdirSync(String(payload.stagingPrefix), { recursive: true });
    try {
      await installPackageFromRegistry(payload, packageSpec, payload.npmFallbackRegistryUrl);
    } catch (authoritativeRegistryError: unknown) {
      throw new Error(
        `Both configured and authoritative npm installs failed; ${errorMessage(authoritativeRegistryError)}`,
        { cause: authoritativeRegistryError },
      );
    }
  }
}

function verifyInstalledVersion(
  payload: NpmUpdatePayload,
  expectedVersion: string,
  packageRoot: string,
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

function commandFailureMessage(error: unknown, logPath: string, offset: number): string {
  const output = logSince(logPath, offset).trim().replace(/\s+/g, ' ');
  if (!output) return errorMessage(error);
  const detail = output.length > 1200 ? `…${output.slice(-1200)}` : output;
  return `${errorMessage(error)}: ${detail}`;
}

async function installPackageFromRegistry(
  payload: NpmUpdatePayload,
  packageSpec: string,
  registryUrl = '',
): Promise<void> {
  appendLog(payload.logPath, `Installing ${packageSpec}${registryUrl ? ' from the update-status registry' : ''}`);
  const args = ['install', '--global'];
  args.push('--prefix', String(payload.stagingPrefix));
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
    throw new Error(commandFailureMessage(error, payload.logPath, offset), { cause: error });
  }
}

async function startServer(
  payload: NpmUpdatePayload,
  packageRoot: string,
  version = payload.targetVersion,
): Promise<void> {
  appendLog(payload.logPath, `Starting Farming ${version}`);
  await runCommand(payload.nodePath, startArguments(payload, packageRoot), {
    cwd: payload.configDir,
    env: commandEnvironment(),
    logPath: payload.logPath,
  });
}

function installationContext(payload: NpmUpdatePayload): PackageInstallationContext {
  const context = resolvePackageInstallationContext(payload.activePackageRoot, {
    ...process.env,
    FARMING_PACKAGE_INSTALLATION_ID: payload.installationId,
    FARMING_PACKAGE_INSTALLATION_ROOT: payload.installationRoot,
    FARMING_BOOTSTRAP_PACKAGE_ROOT: payload.bootstrapPackageRoot,
  });
  if (
    !context
    || context.installationId !== payload.installationId
    || canonicalConfigDir(context.installationRoot) !== canonicalConfigDir(payload.installationRoot)
  ) throw new Error('Farming package installation identity changed during update');
  return context;
}

async function prepareNpmUpdate(payload: NpmUpdatePayload): Promise<void> {
  try {
    const context = installationContext(payload);
    writeOperationState(payload, 'installing');
    const runningImage = publishRunningPackageImage(context, payload.activePackageRoot);
    const initialCurrent = initializeCurrentPackageImage(context, runningImage);
    fs.mkdirSync(String(payload.stagingPrefix), { recursive: true });
    await installPackage(payload, payload.targetVersion);
    verifyInstalledVersion(payload, payload.targetVersion, String(payload.stagingPackageRoot));
    writeOperationState(payload, 'preparing-runtimes');
    appendLog(payload.logPath, `Preparing Farming ${payload.targetVersion} startup dependencies`);
    await runCommand(payload.nodePath, [
      path.join(String(payload.stagingPackageRoot), 'bin', 'farming'),
      'runtime',
      'prepare',
      '--config-dir',
      payload.configDir,
      '--no-activate',
    ], {
      cwd: payload.configDir,
      env: commandEnvironment(),
      logPath: payload.logPath,
    });
    const targetImage = await runWhileOperationOwned(
      payload,
      'preparing-runtimes',
      () => publishPreparedPackageImage(
        context,
        String(payload.stagingPackageRoot),
        payload.targetVersion,
        payload.targetIntegrity,
      ),
    );
    fs.rmSync(String(payload.stagingPrefix), { recursive: true, force: true });
    const preparedAt = new Date().toISOString();
    writeOperationState(payload, 'ready-to-restart', {
      preparedAt,
      runtimePreparedAt: preparedAt,
      runningPackageRoot: runningImage.packageRoot,
      runningImageId: runningImage.imageId,
      targetPackageRoot: targetImage.packageRoot,
      targetImageId: targetImage.imageId,
      expectedCurrentImageId: initialCurrent.imageId,
      stagingPrefix: undefined,
      stagingPackageRoot: undefined,
    });
    appendLog(payload.logPath, `Farming ${payload.targetVersion} is ready to restart`);
  } catch (error: unknown) {
    if (error instanceof SupersededUpdateOperationError) {
      appendLog(payload.logPath, error.message);
      try {
        fs.rmSync(payload.stagingPrefix, { recursive: true, force: true });
      } catch (cleanupError: unknown) {
        appendLog(payload.logPath, `Superseded update cleanup failed: ${errorMessage(cleanupError)}`);
      }
      return;
    }
    const message = errorMessage(error);
    appendLog(payload.logPath, `Update preparation failed: ${message}`);
    try {
      fs.rmSync(payload.stagingPrefix, { recursive: true, force: true });
    } catch (cleanupError: unknown) {
      appendLog(payload.logPath, `Update preparation cleanup failed: ${errorMessage(cleanupError)}`);
    }
    writeOperationStateIfOwned(payload, 'failed', {
      error: message,
      completedAt: new Date().toISOString(),
    });
  }
}

async function applyNpmUpdate(payload: NpmUpdatePayload): Promise<void> {
  const transition: {
    stoppedOldServer: boolean;
    activation: ActivatePackageImageResult | null;
  } = { stoppedOldServer: false, activation: null };
  try {
    const context = installationContext(payload);
    const runningImage = readPackageImageRef(String(payload.runningPackageRoot));
    const targetImage = readPackageImageRef(String(payload.targetPackageRoot));
    if (!runningImage || runningImage.imageId !== payload.runningImageId) {
      throw new Error('Farming rollback package image is missing or changed');
    }
    if (!targetImage || targetImage.imageId !== payload.targetImageId) {
      throw new Error('Farming target package image is missing or changed');
    }
    verifyInstalledVersion(payload, payload.previousVersion, runningImage.packageRoot);
    verifyInstalledVersion(payload, payload.targetVersion, targetImage.packageRoot);

    payload.restartingAt = payload.restartingAt || new Date().toISOString();
    writeOperationState(payload, 'restarting', {
      preparedAt: payload.preparedAt,
    });
    await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    await runWhileOperationOwned(payload, 'restarting', async () => {
      await stopProcess(Number(payload.serverPid), payload.serverProcessIdentity);
      transition.stoppedOldServer = true;
      transition.activation = activatePackageImage(context, targetImage, String(payload.expectedCurrentImageId));
      await startServer(payload, targetImage.packageRoot);
    });

    writeOperationStateIfOwned(payload, 'succeeded', {
      preparedAt: payload.preparedAt,
      activatedImageId: targetImage.imageId,
      completedAt: new Date().toISOString(),
    });
    appendLog(payload.logPath, `Farming updated to ${payload.targetVersion}`);
  } catch (error: unknown) {
    const message = errorMessage(error);
    appendLog(payload.logPath, `Update apply failed: ${message}`);

    if (transition.stoppedOldServer || !isProcessRunning(Number(payload.serverPid))) {
      try {
        const context = installationContext(payload);
        const runningImage = readPackageImageRef(String(payload.runningPackageRoot));
        if (!runningImage || runningImage.imageId !== payload.runningImageId) {
          throw new Error('Farming rollback package image is unavailable', { cause: error });
        }
        writeOperationStateIfOwned(payload, 'rolling-back', {
          preparedAt: payload.preparedAt,
          error: message,
        });
        let selectionRollbackError = '';
        if (transition.activation?.changed && transition.activation.previous) {
          try {
            const previousImage = packageImageForPointer(context, transition.activation.previous);
            if (!previousImage) throw new Error('Previous Farming package selection is unavailable', { cause: error });
            activatePackageImage(context, previousImage, String(payload.targetImageId));
          } catch (selectionError: unknown) {
            const selected = readCurrentPackagePointer(context);
            if (selected?.imageId === payload.targetImageId || !selected) {
              selectionRollbackError = errorMessage(selectionError);
            } else {
              appendLog(
                payload.logPath,
                `Package selection moved independently to ${selected.imageId}; leaving it unchanged`,
              );
            }
          }
        }
        verifyInstalledVersion(payload, payload.previousVersion, runningImage.packageRoot);
        await startServer(payload, runningImage.packageRoot, payload.previousVersion);
        if (selectionRollbackError) {
          writeOperationStateIfOwned(payload, 'failed', {
            version: payload.previousVersion,
            attemptedVersion: payload.targetVersion,
            preparedAt: payload.preparedAt,
            error: `${message}; package selection rollback failed: ${selectionRollbackError}; `
              + `this Config restarted on ${payload.previousVersion}`,
            completedAt: new Date().toISOString(),
          });
          appendLog(
            payload.logPath,
            `Restarted this Config on ${payload.previousVersion}, but the package selection could not be rolled back`,
          );
          return;
        }
        writeOperationStateIfOwned(payload, 'rolled-back', {
          version: payload.previousVersion,
          attemptedVersion: payload.targetVersion,
          preparedAt: payload.preparedAt,
          error: message,
          completedAt: new Date().toISOString(),
        });
        appendLog(payload.logPath, `Rolled back to ${payload.previousVersion}`);
        return;
      } catch (rollbackError: unknown) {
        const rollbackMessage = errorMessage(rollbackError);
        writeOperationStateIfOwned(payload, 'failed', {
          error: `${message}; rollback failed: ${rollbackMessage}`,
          completedAt: new Date().toISOString(),
        });
        return;
      }
    }

    writeOperationStateIfOwned(payload, 'ready-to-restart', {
      preparedAt: payload.preparedAt,
      error: message,
    });
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
