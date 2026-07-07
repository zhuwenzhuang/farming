const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SHELL_ENV_BEGIN = '__FARMING_AGENT_ENV_BEGIN__';
const SHELL_ENV_END = '__FARMING_AGENT_ENV_END__';
const DEFAULT_SHELL_ENV_TIMEOUT_MS = 2500;

function isCatPager(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^(?:\/[^\s]+\/)?cat(?:\s|$)/.test(text);
}

function scrubNonInteractivePagerEnv(env) {
  const next = env || {};
  if (next.FARMING_PRESERVE_AGENT_CAT_PAGER === '1') {
    return next;
  }

  if (isCatPager(next.PAGER)) delete next.PAGER;
  if (isCatPager(next.GIT_PAGER)) delete next.GIT_PAGER;
  return next;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function normalizeTimeoutMs(value, fallback = DEFAULT_SHELL_ENV_TIMEOUT_MS) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(250, Math.min(parsed, 15000));
}

function defaultShell(processEnv = process.env) {
  if (processEnv.SHELL) return processEnv.SHELL;
  if (process.platform === 'win32') return '';
  if (fsExists('/bin/bash')) return '/bin/bash';
  return '/bin/sh';
}

function fsExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function shellEnvArgs(shell, command) {
  const name = path.basename(String(shell || '')).toLowerCase();
  if (name === 'bash' || name === 'zsh' || name === 'fish' || name === 'ksh') {
    return ['-lic', command];
  }
  if (process.platform === 'win32' && (name === 'cmd.exe' || name === 'cmd')) {
    return ['/d', '/s', '/c', command];
  }
  return ['-lc', command];
}

function buildShellEnvCommand(nodePath = process.execPath) {
  const script = 'process.stdout.write(JSON.stringify(process.env))';
  return [
    `printf '\\n${SHELL_ENV_BEGIN}\\n'`,
    `${shellQuote(nodePath)} -e ${shellQuote(script)}`,
    `printf '\\n${SHELL_ENV_END}\\n'`,
  ].join('; ');
}

function parseShellEnvOutput(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  const start = text.indexOf(SHELL_ENV_BEGIN);
  const end = text.lastIndexOf(SHELL_ENV_END);
  if (start < 0 || end <= start) return null;

  const jsonText = text.slice(start + SHELL_ENV_BEGIN.length, end).trim();
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([key, value]) => typeof key === 'string' && typeof value === 'string')
    );
  } catch {
    return null;
  }
}

function resolveUserShellEnvSync(options = {}) {
  const processEnv = options.processEnv || process.env;
  if (String(processEnv.FARMING_AGENT_SHELL_ENV || '').toLowerCase() === '0' ||
      String(processEnv.FARMING_AGENT_SHELL_ENV || '').toLowerCase() === 'false') {
    return null;
  }

  const shell = options.shell || defaultShell(processEnv);
  if (!shell) return null;

  const command = options.command || buildShellEnvCommand(options.nodePath || process.execPath);
  const args = options.args || shellEnvArgs(shell, command);
  const timeout = normalizeTimeoutMs(options.timeoutMs ?? processEnv.FARMING_AGENT_SHELL_ENV_TIMEOUT_MS);
  const env = {
    ...processEnv,
    FARMING_COLLECT_AGENT_SHELL_ENV: '1',
  };

  const result = spawnSync(shell, args, {
    cwd: options.cwd || processEnv.HOME || os.homedir(),
    env,
    input: '',
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout,
    windowsHide: true,
  });

  if (result.error || result.signal === 'SIGTERM' || result.status === 124) {
    return null;
  }

  return parseShellEnvOutput(result.stdout);
}

const PROCESS_ENV_EXACT_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ALL_PROXY',
  'all_proxy',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CURL_CA_BUNDLE',
  'DASHSCOPE_API_KEY',
  'EDITOR',
  'FARMING_ANONYMIZE_SHELL_PROMPT',
  'FARMING_PRESERVE_AGENT_CAT_PAGER',
  'FARMING_SHELL_CONTROLLED_PROMPT',
  'GEMINI_API_KEY',
  'GIT_ASKPASS',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'GPG_TTY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_PROXY',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'REQUESTS_CA_BUNDLE',
  'SHELL',
  'SSH_AGENT_PID',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'VISUAL',
]);

const PROCESS_ENV_PREFIXES = [
  'ANTHROPIC_',
  'AWS_',
  'AZURE_OPENAI_',
  'CLAUDE_CODE_',
  'DASHSCOPE_',
  'GEMINI_',
  'GITHUB_',
  'GITLAB_',
  'GOOGLE_API_',
  'GOOGLE_CLOUD_',
  'LANGCHAIN_',
  'LC_',
  'NPM_CONFIG_',
  'OPENAI_',
  'PIP_',
  'QWEN_',
  'UV_',
  'npm_config_',
];

function shouldOverlayProcessEnv(key) {
  return PROCESS_ENV_EXACT_KEYS.has(key) || PROCESS_ENV_PREFIXES.some(prefix => key.startsWith(prefix));
}

function buildInteractiveAgentBaseEnv(options = {}) {
  const processEnv = options.processEnv || process.env;
  const shellEnv = options.shellEnv && typeof options.shellEnv === 'object' ? options.shellEnv : null;
  const env = shellEnv ? { ...shellEnv } : { ...processEnv };

  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value !== 'string') continue;
    if (!shouldOverlayProcessEnv(key)) continue;
    if (key in env && env[key] !== '') continue;
    env[key] = value;
  }

  if (!env.HOME) env.HOME = processEnv.HOME || os.homedir();
  if (!env.USER && processEnv.USER) env.USER = processEnv.USER;
  if (!env.LOGNAME && processEnv.LOGNAME) env.LOGNAME = processEnv.LOGNAME;
  if (!env.PATH && processEnv.PATH) env.PATH = processEnv.PATH;

  return env;
}

function normalizeInteractiveTerminalEnv(env, options = {}) {
  const next = env || {};

  if (options.stripRuntimeShims !== false) {
    delete next.LD_LIBRARY_PATH;
    delete next.GLIBC_DIR;
  }
  if (options.stripNodeOptions !== false) {
    delete next.NODE_OPTIONS;
  }

  delete next.NO_COLOR;
  scrubNonInteractivePagerEnv(next);

  if (!next.TERM || String(next.TERM).toLowerCase() === 'dumb') {
    next.TERM = 'xterm-256color';
  }
  next.COLORTERM = 'truecolor';
  next.CLICOLOR = next.CLICOLOR || '1';
  next.TERM_PROGRAM = 'farming';
  next.TERM_PROGRAM_VERSION = process.env.npm_package_version || '';
  return next;
}

module.exports = {
  SHELL_ENV_BEGIN,
  SHELL_ENV_END,
  buildInteractiveAgentBaseEnv,
  buildShellEnvCommand,
  isCatPager,
  normalizeInteractiveTerminalEnv,
  parseShellEnvOutput,
  resolveUserShellEnvSync,
  scrubNonInteractivePagerEnv,
  shellEnvArgs,
};
