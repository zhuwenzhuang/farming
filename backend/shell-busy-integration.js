const fs = require('fs');
const os = require('os');
const path = require('path');

const OSC_PREFIX = '\x1b]133;FarmingShellBusy=';
const STATUS_OSC_PREFIX = '\x1b]133;FarmingShellStatus=';
const CWD_OSC_PREFIX = '\x1b]7;file://';
const MARKERS = {
  busy: `${OSC_PREFIX}busy\x07`,
  idle: `${OSC_PREFIX}idle\x07`,
};
const MARKER_PATTERN = /\x1b\]133;FarmingShellBusy=(busy|idle)(?:\x07|\x1b\\)/g;
const STATUS_PATTERN = /\x1b\]133;FarmingShellStatus=(start|finish)(?:;exit=(-?\d+))?(?:\x07|\x1b\\)/g;
const CWD_PATTERN = /\x1b\]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

function shellNameForCommand(command) {
  return path.basename(String(command || '').trim());
}

function shellBusyIntegrationDisabled(env = {}) {
  return env.FARMING_SHELL_BUSY_INTEGRATION === '0';
}

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'farming-shell-busy-'));
}

function cleanupShellBusyIntegration(integration) {
  if (!integration || !integration.tempDir) return;
  fs.rmSync(integration.tempDir, { recursive: true, force: true });
}

function defaultBashArgs(args) {
  return args.length === 0 || (
    args.length === 3 &&
    args[0] === '--noprofile' &&
    args[1] === '--norc' &&
    args[2] === '-i'
  );
}

function defaultZshArgs(args) {
  return args.length === 0 || (
    args.length === 2 &&
    args[0] === '-f' &&
    args[1] === '-i'
  );
}

function writeBashRc(tempDir) {
  const rcPath = path.join(tempDir, 'bashrc');
  fs.writeFileSync(rcPath, [
    '# Farming temporary shell busy integration. Safe to delete.',
    `__farming_shell_busy=${shSingleQuote(MARKERS.busy)}`,
    `__farming_shell_idle=${shSingleQuote(MARKERS.idle)}`,
    `__farming_shell_start=${shSingleQuote(`${STATUS_OSC_PREFIX}start\x07`)}`,
    'FARMING_SHELL_INTEGRATION=1',
    'export FARMING_SHELL_INTEGRATION',
    '__farming_shell_debug() {',
    '  local __farming_previous_status=$?',
    '  case "${BASH_COMMAND:-}" in',
    '    __farming_shell_prompt*|__farming_shell_debug*|printf\\ *FarmingShell*) return "$__farming_previous_status" ;;',
    '  esac',
    '  printf "%s%s" "$__farming_shell_start" "$__farming_shell_busy"',
    '  return "$__farming_previous_status"',
    '}',
    '__farming_shell_prompt() {',
    '  local __farming_status=$?',
    '  printf "\\033]133;FarmingShellStatus=finish;exit=%s\\007" "$__farming_status"',
    '  printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"',
    '  printf "%s" "$__farming_shell_idle"',
    '}',
    'trap \'__farming_shell_debug\' DEBUG',
    'if [ -n "${PROMPT_COMMAND:-}" ]; then',
    '  PROMPT_COMMAND=\'__farming_shell_prompt; \'$PROMPT_COMMAND',
    'else',
    '  PROMPT_COMMAND=\'__farming_shell_prompt\'',
    'fi',
    '',
  ].join('\n'));
  return rcPath;
}

function writeZshFiles(tempDir) {
  fs.writeFileSync(path.join(tempDir, '.zshenv'), [
    '# Farming temporary shell busy integration. Safe to delete.',
    'setopt no_global_rcs',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.zshrc'), [
    '# Farming temporary shell busy integration. Safe to delete.',
    `__farming_shell_busy=${shSingleQuote(MARKERS.busy)}`,
    `__farming_shell_idle=${shSingleQuote(MARKERS.idle)}`,
    `__farming_shell_start=${shSingleQuote(`${STATUS_OSC_PREFIX}start\x07`)}`,
    'FARMING_SHELL_INTEGRATION=1',
    'export FARMING_SHELL_INTEGRATION',
    'preexec() { printf "%s%s" "$__farming_shell_start" "$__farming_shell_busy" }',
    'precmd() {',
    '  local __farming_status=$?',
    '  printf "\\033]133;FarmingShellStatus=finish;exit=%s\\007" "$__farming_status"',
    '  printf "\\033]7;file://%s%s\\007" "${HOST:-localhost}" "$PWD"',
    '  printf "%s" "$__farming_shell_idle"',
    '}',
    '',
  ].join('\n'));
}

function applyShellBusyIntegration(options) {
  const normalized = {
    ...options,
    args: [...(options.args || [])],
    env: { ...(options.env || {}) },
  };

  if (normalized.category !== 'other' || shellBusyIntegrationDisabled(normalized.env)) {
    return normalized;
  }

  const shellName = shellNameForCommand(normalized.command);
  if (shellName !== 'bash' && shellName !== 'zsh') {
    return normalized;
  }

  if (shellName === 'bash' && !defaultBashArgs(normalized.args)) {
    return normalized;
  }
  if (shellName === 'zsh' && !defaultZshArgs(normalized.args)) {
    return normalized;
  }

  const tempDir = createTempDir();
  try {
    if (shellName === 'bash') {
      const rcPath = writeBashRc(tempDir);
      normalized.args = ['--rcfile', rcPath, '-i'];
    } else {
      writeZshFiles(tempDir);
      normalized.args = ['-i'];
      normalized.env.ZDOTDIR = tempDir;
    }
    normalized.shellBusyIntegration = {
      shellName,
      tempDir,
    };
    return normalized;
  } catch (error) {
    cleanupShellBusyIntegration({ tempDir });
    throw error;
  }
}

function splitPendingMarker(text) {
  const lastOscIndex = String(text || '').lastIndexOf('\x1b]');
  if (lastOscIndex >= 0) {
    const suffix = text.slice(lastOscIndex);
    const knownPrefixes = [OSC_PREFIX, STATUS_OSC_PREFIX, CWD_OSC_PREFIX];
    const isFarmingMarker = suffix.startsWith(OSC_PREFIX)
      || suffix.startsWith(STATUS_OSC_PREFIX)
      || suffix.startsWith(CWD_OSC_PREFIX)
      || knownPrefixes.some(prefix => suffix.length < prefix.length && prefix.startsWith(suffix));
    const isTerminated = suffix.includes('\x07') || suffix.includes('\x1b\\');
    if (isFarmingMarker && !isTerminated) {
      return {
        data: text.slice(0, lastOscIndex),
        pending: suffix,
      };
    }
  }
  return { data: text, pending: '' };
}

function cwdFromOsc7(value) {
  const raw = String(value || '');
  const slashIndex = raw.indexOf('/');
  if (slashIndex < 0) return '';
  const pathPart = raw.slice(slashIndex);
  try {
    return decodeURIComponent(pathPart);
  } catch {
    return pathPart;
  }
}

function parseShellBusyMarkers(data, previousBusy = null, pending = '') {
  let markerSeen = false;
  let terminalBusy = previousBusy;
  let shellEvent = '';
  let cwd = '';
  let lastExitCode = null;
  const combined = `${pending || ''}${String(data || '')}`;
  const split = splitPendingMarker(combined);
  const statusCleanData = split.data.replace(STATUS_PATTERN, (_match, event, exitCode) => {
    markerSeen = true;
    shellEvent = event;
    if (event === 'start') {
      terminalBusy = true;
    } else if (event === 'finish') {
      terminalBusy = false;
      if (typeof exitCode === 'string' && exitCode.length > 0) {
        lastExitCode = Number(exitCode);
      }
    }
    return '';
  });
  const cwdCleanData = statusCleanData.replace(CWD_PATTERN, (_match, value) => {
    markerSeen = true;
    cwd = cwdFromOsc7(value);
    return '';
  });
  const cleanData = cwdCleanData.replace(MARKER_PATTERN, (_match, state) => {
    markerSeen = true;
    terminalBusy = state === 'busy';
    shellEvent = state === 'busy' ? 'start' : 'finish';
    return '';
  });

  return {
    data: cleanData,
    markerSeen,
    terminalBusy,
    changed: markerSeen && terminalBusy !== previousBusy,
    shellEvent,
    cwd,
    lastExitCode,
    pending: split.pending,
  };
}

module.exports = {
  MARKERS,
  applyShellBusyIntegration,
  cleanupShellBusyIntegration,
  parseShellBusyMarkers,
  shellNameForCommand,
};
