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

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing bundle update payload');
  for (const key of ['stateFile', 'logPath', 'releaseDir', 'installer']) {
    if (!path.isAbsolute(String(payload[key] || ''))) throw new Error(`Invalid bundle update ${key}`);
  }
  if (!/^[0-9A-Za-z.+-]+$/.test(String(payload.version || ''))) {
    throw new Error('Invalid bundle update version');
  }
  return payload;
}

function stateFor(payload, phase, extra = {}) {
  return {
    method: payload.method,
    targetMethod: payload.targetMethod,
    phase,
    version: payload.version,
    previousVersion: payload.previousVersion,
    startedAt: payload.startedAt,
    logPath: payload.logPath,
    ...extra,
  };
}

function commandEnvironment() {
  const env = { ...process.env };
  delete env.FARMING_BUNDLE_UPDATE_PAYLOAD;
  delete env.FARMING_RUN_SERVER;
  delete env.FARMING_RUN_NATIVE_PTY_HOST;
  return env;
}

function runInstaller(payload) {
  return new Promise((resolve, reject) => {
    const logFd = fs.openSync(payload.logPath, 'a');
    const child = spawn('bash', [payload.installer, 'install'], {
      cwd: payload.releaseDir,
      env: commandEnvironment(),
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
      reject(new Error(`bundle installer exited with ${signal || code}`));
    });
  });
}

async function runBundleUpdate(rawPayload) {
  const payload = validatePayload(rawPayload);
  writeJsonAtomic(payload.stateFile, stateFor(payload, 'installing'));
  await new Promise(resolve => setTimeout(resolve, 1_000));
  try {
    await runInstaller(payload);
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'succeeded', {
      completedAt: new Date().toISOString(),
    }));
    appendLog(payload.logPath, `Farming updated to ${payload.version}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    writeJsonAtomic(payload.stateFile, stateFor(payload, 'failed', {
      error: message,
      completedAt: new Date().toISOString(),
    }));
    appendLog(payload.logPath, `Update failed: ${message}`);
  }
}

if (require.main === module) {
  let payload;
  try {
    payload = JSON.parse(process.env.FARMING_BUNDLE_UPDATE_PAYLOAD || '');
  } catch {
    console.error('Invalid FARMING_BUNDLE_UPDATE_PAYLOAD');
    process.exit(1);
  }
  runBundleUpdate(payload).catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  runBundleUpdate,
  validatePayload,
};
