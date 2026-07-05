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

function writeBashRc(tempDir, options = {}) {
  const rcPath = path.join(tempDir, 'bashrc');
  const controlledPrompt = options.controlledPrompt === true;
  const sourceLoginProfile = options.sourceLoginProfile === true;
  const userStartupSource = sourceLoginProfile
    ? [
      'if [ -r "$HOME/.bash_profile" ]; then',
      '  . "$HOME/.bash_profile"',
      'elif [ -r "$HOME/.bash_login" ]; then',
      '  . "$HOME/.bash_login"',
      'elif [ -r "$HOME/.profile" ]; then',
      '  . "$HOME/.profile"',
      'elif [ -r "$HOME/.bashrc" ]; then',
      '  . "$HOME/.bashrc"',
      'fi',
    ].join('\n')
    : 'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi';
  fs.writeFileSync(rcPath, [
    '# Farming temporary shell busy integration. Safe to delete.',
    `__farming_shell_busy=${shSingleQuote(MARKERS.busy)}`,
    `__farming_shell_idle=${shSingleQuote(MARKERS.idle)}`,
    `__farming_shell_start=${shSingleQuote(`${STATUS_OSC_PREFIX}start\x07`)}`,
    'FARMING_SHELL_INTEGRATION=1',
    'export FARMING_SHELL_INTEGRATION',
    controlledPrompt
      ? '# Controlled prompt mode skips user shell startup files.'
      : userStartupSource,
    '__farming_restore_exit_code() { return "$1"; }',
    '__farming_get_trap() {',
    '  local -a __farming_terms',
    '  eval "__farming_terms=( $(trap -p "${1:-DEBUG}") )"',
    '  printf "%s" "${__farming_terms[2]:-}"',
    '}',
    'if [ -n "${PROMPT_COMMAND+x}" ]; then',
    '  __farming_original_prompt_command=("${PROMPT_COMMAND[@]}")',
    'else',
    '  __farming_original_prompt_command=()',
    'fi',
    '__farming_original_debug_trap="$(__farming_get_trap DEBUG)"',
    '__farming_shell_debug() {',
    '  local __farming_previous_status=$?',
    '  if [ "${__farming_in_prompt:-0}" = "1" ]; then return "$__farming_previous_status"; fi',
    '  case "${BASH_COMMAND:-}" in',
    '    __farming_shell_prompt*|__farming_shell_debug*|__farming_restore_exit_code*|__farming_get_trap*|printf\\ *FarmingShell*) return "$__farming_previous_status" ;;',
    '  esac',
    '  printf "%s%s" "$__farming_shell_start" "$__farming_shell_busy"',
    '  if [ -n "${__farming_original_debug_trap:-}" ]; then',
    '    eval "$__farming_original_debug_trap"',
    '  fi',
    '  return "$__farming_previous_status"',
    '}',
    '__farming_shell_prompt() {',
    '  local __farming_status=$?',
    '  __farming_in_prompt=1',
    '  local __farming_cmd',
    '  for __farming_cmd in "${__farming_original_prompt_command[@]}"; do',
    '    __farming_restore_exit_code "$__farming_status"',
    '    eval "${__farming_cmd:-}"',
    '  done',
    '  __farming_restore_exit_code "$__farming_status"',
    '  printf "\\033]133;FarmingShellStatus=finish;exit=%s\\007" "$__farming_status"',
    '  printf "\\033]7;file://%s%s\\007" "${HOSTNAME:-localhost}" "$PWD"',
    '  printf "%s" "$__farming_shell_idle"',
    '  __farming_in_prompt=0',
    '  return "$__farming_status"',
    '}',
    'trap \'__farming_shell_debug\' DEBUG',
    'PROMPT_COMMAND=__farming_shell_prompt',
    '',
  ].join('\n'));
  return rcPath;
}

function writeZshFiles(tempDir, options = {}) {
  const controlledPrompt = options.controlledPrompt === true;
  fs.writeFileSync(path.join(tempDir, '.zshenv'), [
    '# Farming temporary shell busy integration. Safe to delete.',
    'setopt no_global_rcs',
    'if [ -z "${USER_ZDOTDIR:-}" ]; then export USER_ZDOTDIR="${ZDOTDIR:-$HOME}"; fi',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(tempDir, '.zshrc'), [
    '# Farming temporary shell busy integration. Safe to delete.',
    `__farming_shell_busy=${shSingleQuote(MARKERS.busy)}`,
    `__farming_shell_idle=${shSingleQuote(MARKERS.idle)}`,
    `__farming_shell_start=${shSingleQuote(`${STATUS_OSC_PREFIX}start\x07`)}`,
    'FARMING_SHELL_INTEGRATION=1',
    'export FARMING_SHELL_INTEGRATION',
    controlledPrompt
      ? '# Controlled prompt mode skips user shell startup files.'
      : [
        'if [ -r "${USER_ZDOTDIR:-$HOME}/.zshrc" ]; then',
        '  __farming_saved_zdotdir="${ZDOTDIR:-}"',
        '  ZDOTDIR="${USER_ZDOTDIR:-$HOME}"',
        '  . "${USER_ZDOTDIR:-$HOME}/.zshrc"',
        '  ZDOTDIR="$__farming_saved_zdotdir"',
        '  unset __farming_saved_zdotdir',
        'fi',
      ].join('\n'),
    'autoload -Uz add-zsh-hook',
    '__farming_shell_preexec() { printf "%s%s" "$__farming_shell_start" "$__farming_shell_busy" }',
    '__farming_shell_precmd() {',
    '  local __farming_status=$?',
    '  printf "\\033]133;FarmingShellStatus=finish;exit=%s\\007" "$__farming_status"',
    '  printf "\\033]7;file://%s%s\\007" "${HOST:-localhost}" "$PWD"',
    '  printf "%s" "$__farming_shell_idle"',
    '  return "$__farming_status"',
    '}',
    'if (( $+functions[add-zsh-hook] )); then',
    '  add-zsh-hook preexec __farming_shell_preexec',
    '  add-zsh-hook precmd __farming_shell_precmd',
    'else',
    '  preexec_functions+=(__farming_shell_preexec)',
    '  precmd_functions+=(__farming_shell_precmd)',
    'fi',
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
    const controlledPrompt = normalized.env.FARMING_SHELL_CONTROLLED_PROMPT === '1'
      || normalized.env.FARMING_ANONYMIZE_SHELL_PROMPT === '1';
    if (shellName === 'bash') {
      const rcPath = writeBashRc(tempDir, {
        controlledPrompt,
        sourceLoginProfile: os.platform() === 'darwin',
      });
      normalized.args = ['--rcfile', rcPath, '-i'];
    } else {
      writeZshFiles(tempDir, { controlledPrompt });
      normalized.args = ['-i'];
      normalized.env.USER_ZDOTDIR = normalized.env.ZDOTDIR || normalized.env.HOME || os.homedir();
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
