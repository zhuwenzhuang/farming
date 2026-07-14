const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function appendLog(logPath, message) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const logFd = fs.openSync(options.logPath, 'a');
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', logFd, logFd],
    });
    child.once('error', error => {
      fs.closeSync(logFd);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      fs.closeSync(logFd);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(pid, timeoutMs = 15_000) {
  if (!isProcessRunning(pid)) return;
  process.kill(pid, 'SIGTERM');
  const startedAt = Date.now();
  while (isProcessRunning(pid)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Farming server ${pid} did not stop before timeout`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing npm update payload');
  if (!/^[A-Za-z0-9@/._-]+$/.test(String(payload.packageName || ''))) throw new Error('Invalid npm package name');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(payload.targetVersion || ''))) throw new Error('Invalid npm target version');
  if (!/^[0-9A-Za-z.+-]+$/.test(String(payload.previousVersion || ''))) throw new Error('Invalid npm previous version');
  for (const key of ['stateFile', 'logPath', 'cliPath', 'configDir']) {
    if (!path.isAbsolute(String(payload[key] || ''))) throw new Error(`Invalid npm update ${key}`);
  }
  if (payload.npmPrefix && !path.isAbsolute(String(payload.npmPrefix))) {
    throw new Error('Invalid npm update npmPrefix');
  }
  return payload;
}

function stateFor(payload, phase, extra = {}) {
  return {
    method: 'npm',
    phase,
    version: payload.targetVersion,
    previousVersion: payload.previousVersion,
    packageName: payload.packageName,
    startedAt: payload.startedAt,
    logPath: payload.logPath,
    ...extra,
  };
}

function startArguments(payload) {
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

function commandEnvironment() {
  const env = { ...process.env };
  delete env.FARMING_NPM_UPDATE_PAYLOAD;
  return env;
}

async function installPackage(payload, version) {
  const packageSpec = `${payload.packageName}@${version}`;
  appendLog(payload.logPath, `Installing ${packageSpec}`);
  const args = ['install', '--global'];
  if (payload.npmPrefix) args.push('--prefix', payload.npmPrefix);
  args.push(packageSpec, '--no-audit', '--no-fund');
  await runCommand(payload.npmCommand || 'npm', args, {
    env: commandEnvironment(),
    logPath: payload.logPath,
  });
}

async function startServer(payload, version = payload.targetVersion) {
  appendLog(payload.logPath, `Starting Farming ${version}`);
  await runCommand(payload.nodePath, startArguments(payload), {
    env: commandEnvironment(),
    logPath: payload.logPath,
  });
}

async function runNpmUpdate(rawPayload) {
  const payload = validatePayload(rawPayload);
  try {
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'installing'));
    await installPackage(payload, payload.targetVersion);

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'restarting'));
    await stopProcess(Number(payload.serverPid));
    await startServer(payload);

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'succeeded', {
      completedAt: new Date().toISOString(),
    }));
    appendLog(payload.logPath, `Farming updated to ${payload.targetVersion}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    appendLog(payload.logPath, `Update failed: ${message}`);

    if (!isProcessRunning(Number(payload.serverPid))) {
      try {
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'rolling-back', { error: message }));
        await installPackage(payload, payload.previousVersion);
        await startServer(payload, payload.previousVersion);
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'rolled-back', {
          version: payload.previousVersion,
          attemptedVersion: payload.targetVersion,
          error: message,
          completedAt: new Date().toISOString(),
        }));
        appendLog(payload.logPath, `Rolled back to ${payload.previousVersion}`);
        return;
      } catch (rollbackError) {
        const rollbackMessage = rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError);
        writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
          error: `${message}; rollback failed: ${rollbackMessage}`,
          completedAt: new Date().toISOString(),
        }));
        return;
      }
    }

    writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
      error: message,
      completedAt: new Date().toISOString(),
    }));
  }
}

if (require.main === module) {
  let payload;
  try {
    payload = JSON.parse(process.env.FARMING_NPM_UPDATE_PAYLOAD || '');
  } catch {
    console.error('Invalid FARMING_NPM_UPDATE_PAYLOAD');
    process.exit(1);
  }
  runNpmUpdate(payload).catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  isProcessRunning,
  runNpmUpdate,
  stopProcess,
  validatePayload,
  writeJsonAtomic,
};
