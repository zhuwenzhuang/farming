function executableName(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token && token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return (executable || '').split(/[\\/]/).pop() || '';
}

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
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
  const activity = options.status === 'exited'
    ? 'exited'
    : inferActivityFromText(previewText, terminalBusy);

  return {
    kind: inferKindFromText(title, previewText, options.command),
    activity,
    busy: activity === 'busy',
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    title,
    lastExitCode: typeof options.shellLastExitCode === 'number' ? options.shellLastExitCode : null,
    source: hasShellStatus
      ? 'shell-status-marker'
      : (terminalBusy === null ? 'terminal-text' : 'shell-busy-marker'),
  };
}

module.exports = {
  deriveTerminalStatus,
};
