function executableName(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token && token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return (executable || '').split(/[\\/]/).pop() || '';
}

function normalizedText(value) {
  return stripTerminalControlSequences(value).replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripTerminalControlSequences(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function terminalStatusCommand(value) {
  return stripTerminalControlSequences(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function inferKindFromText(title, previewText, command) {
  const combined = normalizedText(`${title}\n${previewText}`);
  if (/\bclaude(?:\s+code)?\b/.test(combined)) return 'claude';
  if (/\bcodex\b/.test(combined) || /(?:^|\s)›\s/.test(String(previewText || ''))) return 'codex';

  const commandName = executableName(command).toLowerCase();
  if (commandName === 'claude') return 'claude';
  if (commandName === 'codex') return 'codex';
  if (['bash', 'zsh', 'sh', 'fish'].includes(commandName)) return 'shell';
  return commandName ? 'process' : 'unknown';
}

function terminalTextLooksIdleShellPrompt(previewText) {
  const lines = stripTerminalControlSequences(previewText)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return false;

  const tail = lines.slice(-3).join('\n');
  return /(?:^|\n).{0,180}(?:[$%#])\s*$/.test(tail);
}

function inferActivityFromText(previewText, terminalBusy) {
  if (terminalBusy === true) return 'busy';
  if (terminalBusy === false) return 'idle';

  const text = normalizedText(previewText);
  if (!text) return 'unknown';
  if (
    text.includes('esc to interrupt') ||
    text.includes('escape to interrupt') ||
    text.includes('ctrl+c to interrupt') ||
    text.includes('ctrl-c to interrupt') ||
    text.includes('working') ||
    text.includes('thinking')
  ) {
    return 'busy';
  }
  if (/(?:^|\s)(?:[$%#]|›)\s*$/.test(String(previewText || '').trim())) return 'idle';
  return 'unknown';
}

function deriveTerminalStatus(options = {}) {
  const title = typeof options.title === 'string' ? options.title : '';
  const previewText = typeof options.previewText === 'string' ? options.previewText : '';
  const terminalBusy = typeof options.terminalBusy === 'boolean' ? options.terminalBusy : null;
  const hasShellStatus = options.shellLastEvent === 'start'
    || options.shellLastEvent === 'finish'
    || typeof options.shellLastExitCode === 'number';
  const commandName = executableName(options.command).toLowerCase();
  const kind = hasShellStatus && ['bash', 'zsh', 'sh', 'fish'].includes(commandName)
    ? 'shell'
    : inferKindFromText(title, previewText, options.command);
  const hasPromptIdleFallback = options.status !== 'exited'
    && kind === 'shell'
    && terminalBusy === true
    && terminalTextLooksIdleShellPrompt(previewText);
  const activity = options.status === 'exited'
    ? 'exited'
    : (hasPromptIdleFallback ? 'idle' : inferActivityFromText(previewText, terminalBusy));

  const status = {
    kind,
    activity,
    busy: activity === 'busy',
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    title,
    lastExitCode: typeof options.shellLastExitCode === 'number' ? options.shellLastExitCode : null,
    source: hasPromptIdleFallback
      ? 'shell-prompt-fallback'
      : (
        hasShellStatus
          ? 'shell-status-marker'
          : (terminalBusy === null ? 'terminal-text' : 'shell-busy-marker')
      ),
  };
  const runningCommand = terminalStatusCommand(options.shellCommand);
  const lastCommand = terminalStatusCommand(options.shellLastCommand);
  const runningCommandStartedAt = finiteNumber(options.shellCommandStartedAt);
  const lastCommandStartedAt = finiteNumber(options.shellLastCommandStartedAt);
  const lastCommandFinishedAt = finiteNumber(options.shellLastCommandFinishedAt);
  const lastCommandDurationMs = finiteNumber(options.shellLastCommandDurationMs);
  if (runningCommand) {
    status.runningCommand = runningCommand;
  }
  if (runningCommandStartedAt !== null) {
    status.runningCommandStartedAt = runningCommandStartedAt;
  }
  if (lastCommand) {
    status.lastCommand = lastCommand;
  }
  if (lastCommandStartedAt !== null) {
    status.lastCommandStartedAt = lastCommandStartedAt;
  }
  if (lastCommandFinishedAt !== null) {
    status.lastCommandFinishedAt = lastCommandFinishedAt;
  }
  if (lastCommandDurationMs !== null) {
    status.lastCommandDurationMs = lastCommandDurationMs;
  }
  return status;
}

module.exports = {
  deriveTerminalStatus,
  terminalTextLooksIdleShellPrompt,
};
