const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const { resolveCompatibleCodexExecutable } = require('./executable-discovery');

const execFileAsync = promisify(execFile);

async function runCodexSessionArchiveCommand(action, sessionId, session = {}, options = {}) {
  const resolveExecutable = options.resolveCompatibleCodexExecutable || resolveCompatibleCodexExecutable;
  const runExecFile = options.execFileAsync || execFileAsync;
  const processEnv = options.processEnv || process.env;
  const directoryExists = options.directoryExists || ((directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch {
      return false;
    }
  });
  const codexResolution = resolveExecutable(session.cliVersion || '', processEnv.PATH || '');
  if (!codexResolution.compatible) {
    return {
      error: codexResolution.error || 'Codex CLI is not compatible with this session',
      status: 400,
    };
  }

  try {
    const sessionCwd = session.cwd || session.workspace || '';
    await runExecFile(codexResolution.path || 'codex', [action, sessionId], {
      cwd: sessionCwd && directoryExists(sessionCwd)
        ? sessionCwd
        : (processEnv.HOME || os.homedir()),
      env: session.providerHomePath
        ? { ...processEnv, CODEX_HOME: session.providerHomePath }
        : processEnv,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { [action === 'archive' ? 'archived' : 'unarchived']: true };
  } catch (error) {
    const message = [
      error && error.stdout ? String(error.stdout).trim() : '',
      error && error.stderr ? String(error.stderr).trim() : '',
      error && error.message ? String(error.message).trim() : '',
    ].filter(Boolean).join('\n') || `failed to ${action} Codex session`;
    return {
      error: message,
      status: 409,
    };
  }
}

async function archiveCodexSession(sessionId, session = {}, options = {}) {
  return runCodexSessionArchiveCommand('archive', sessionId, session, options);
}

async function unarchiveCodexSession(sessionId, session = {}, options = {}) {
  return runCodexSessionArchiveCommand('unarchive', sessionId, session, options);
}

module.exports = {
  archiveCodexSession,
  unarchiveCodexSession,
};
