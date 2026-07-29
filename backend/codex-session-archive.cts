const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');
const { resolveCompatibleCodexExecutable } = require('./executable-discovery');

type CodexArchiveAction = 'archive' | 'unarchive';

interface CodexArchiveSession {
  cliVersion?: string;
  cwd?: string;
  providerHomePath?: string;
  workspace?: string;
}

interface CodexExecutableResolution {
  compatible: boolean;
  error?: string;
  path?: string;
}

interface ExecFileResult {
  stderr?: unknown;
  stdout?: unknown;
}

type ExecFileAsync = (
  executable: string,
  args: string[],
  options: Record<string, unknown>,
) => Promise<ExecFileResult>;

interface CodexSessionArchiveOptions {
  directoryExists?: (directory: string) => boolean;
  execFileAsync?: ExecFileAsync;
  processEnv?: NodeJS.ProcessEnv;
  resolveCompatibleCodexExecutable?: (
    version: string,
    pathValue: string,
  ) => CodexExecutableResolution;
}

interface CodexArchiveResult extends Record<string, unknown> {
  error?: string;
  status?: number;
}

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

async function runCodexSessionArchiveCommand(
  action: CodexArchiveAction,
  sessionId: string,
  session: CodexArchiveSession = {},
  options: CodexSessionArchiveOptions = {},
): Promise<CodexArchiveResult> {
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
  } catch (error: unknown) {
    const details = error && typeof error === 'object'
      ? error as ExecFileResult & { message?: unknown }
      : {};
    const message = [
      details.stdout ? String(details.stdout).trim() : '',
      details.stderr ? String(details.stderr).trim() : '',
      details.message ? String(details.message).trim() : '',
    ].filter(Boolean).join('\n') || `failed to ${action} Codex session`;
    return {
      error: message,
      status: 409,
    };
  }
}

async function archiveCodexSession(
  sessionId: string,
  session: CodexArchiveSession = {},
  options: CodexSessionArchiveOptions = {},
): Promise<CodexArchiveResult> {
  return runCodexSessionArchiveCommand('archive', sessionId, session, options);
}

async function unarchiveCodexSession(
  sessionId: string,
  session: CodexArchiveSession = {},
  options: CodexSessionArchiveOptions = {},
): Promise<CodexArchiveResult> {
  return runCodexSessionArchiveCommand('unarchive', sessionId, session, options);
}

export {
  archiveCodexSession,
  unarchiveCodexSession,
};
