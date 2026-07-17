const { execFile } = require('child_process');
const os = require('os');
const { promisify } = require('util');
const { resolveCompatibleCodexExecutable } = require('./executable-discovery');

const execFileAsync = promisify(execFile);

async function unarchiveCodexSession(sessionId, session = {}, options = {}) {
  const resolveExecutable = options.resolveCompatibleCodexExecutable || resolveCompatibleCodexExecutable;
  const runExecFile = options.execFileAsync || execFileAsync;
  const processEnv = options.processEnv || process.env;
  const codexResolution = resolveExecutable(session.cliVersion || '', processEnv.PATH || '');
  if (!codexResolution.compatible) {
    return {
      error: codexResolution.error || 'Codex CLI is not compatible with this session',
      status: 400,
    };
  }

  try {
    await runExecFile(codexResolution.path || 'codex', ['unarchive', sessionId], {
      cwd: session.cwd || session.workspace || os.homedir(),
      env: session.providerHomePath
        ? { ...processEnv, CODEX_HOME: session.providerHomePath }
        : processEnv,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { unarchived: true };
  } catch (error) {
    const message = [
      error && error.stdout ? String(error.stdout).trim() : '',
      error && error.stderr ? String(error.stderr).trim() : '',
      error && error.message ? String(error.message).trim() : '',
    ].filter(Boolean).join('\n') || 'failed to unarchive Codex session';
    return {
      error: message,
      status: 409,
    };
  }
}

module.exports = {
  unarchiveCodexSession,
};
