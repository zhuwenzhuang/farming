const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish']);
const DIRECT_PROCESS_AGENTS = new Set([
  'opencode',
  'qoder',
  'qodercli',
  'qwen',
  'aider',
  'github-copilot-cli',
  'amazon-q',
]);

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

function terminalLines(value) {
  return stripTerminalControlSequences(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
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

function lastMatchIndex(text, pattern) {
  const matches = Array.from(text.matchAll(pattern));
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
  return lastMatch && typeof lastMatch.index === 'number' ? lastMatch.index : -1;
}

function lastIndexOfAny(text, needles) {
  return needles.reduce((last, needle) => Math.max(last, text.lastIndexOf(needle)), -1);
}

function lastLineIndexMatching(text, predicate) {
  let offset = 0;
  let lastIndex = -1;
  for (const line of text.split('\n')) {
    if (predicate(line)) lastIndex = offset;
    offset += line.length + 1;
  }
  return lastIndex;
}

function lastCodexIdleFooterIndex(text) {
  return lastMatchIndex(text, /(?:^|\n)\s*(?:gpt|codex)[^\n]*(?:·|•)\s*(?:~|\/)[^\n]*$/gim);
}

function codexActiveIndex(text) {
  const activeTextIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'reconnecting',
    '/stop to close',
    'background terminal running',
    'messages to be submitted after next tool call',
    'stream disconnected before completion',
  ]);
  const workingIndex = lastMatchIndex(
    text,
    /(?:^|\n)[^\n]*\bworking\b[^\n]*(?:(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt|step\s+\d+\s*\/\s*\d+)/gim
  );
  return Math.max(activeTextIndex, workingIndex);
}

function codexBlockedIndex(text) {
  return lastIndexOfAny(text, [
    'goal blocked',
    'input exceeds the context window',
    'please adjust your input and try again',
  ]);
}

function lineShowsInterrupt(line) {
  return /\b(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt\b/i.test(line);
}

function lineShowsClaudeStatusRow(line, excludeBareWorking = false) {
  const normalized = line.trim().toLowerCase();
  const match = normalized.match(
    /^([＊✳✱✲✶✻✽✢])?\s*([\p{L}\p{M}][\p{L}\p{M}'’-]*)(?:\.{3}|…)?\s*\(([^)]*)\)\s*$/u
  );
  if (!match || !lineShowsInterrupt(match[3])) return false;
  if (excludeBareWorking && !match[1] && match[2] === 'working') return false;

  const interruptOnly = /^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/i.test(match[3].trim());
  const hasElapsedTime = /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/i.test(match[3]);
  return interruptOnly || hasElapsedTime;
}

function lineShowsClaudeActivity(line) {
  const normalized = line.trim().toLowerCase();
  if (/^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/.test(normalized)) return true;
  return lineShowsClaudeStatusRow(normalized);
}

function lineShowsClaudeKindEvidence(line) {
  const normalized = line.trim().toLowerCase();
  if (/^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/.test(normalized)) return true;
  return lineShowsClaudeStatusRow(normalized, true);
}

function terminalLineLooksLikeIdleShellPrompt(line) {
  return /^(?:\s*[│┃]\s*(?:[^$%#\n]+?\s+)?[$%#]|\s*(?:\([^)]+\)\s+)?(?:[\w.-]+@[\w.-]+:)?[~/][\w./~:+-]*\s*[$%#]|\s*[$%#])\s*$/u.test(line);
}

function latestTerminalKindFromText(title, previewText) {
  const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
  const candidates = [];
  const codexIndex = Math.max(lastCodexIdleFooterIndex(text), codexActiveIndex(text));
  if (codexIndex >= 0) candidates.push({ kind: 'codex', index: codexIndex });

  const claudeIndex = lastLineIndexMatching(text, lineShowsClaudeKindEvidence);
  if (claudeIndex >= 0) candidates.push({ kind: 'claude', index: claudeIndex });

  const shellIndex = lastLineIndexMatching(text, terminalLineLooksLikeIdleShellPrompt);
  if (shellIndex >= 0) candidates.push({ kind: 'shell', index: shellIndex });

  const latest = candidates.sort((left, right) => right.index - left.index)[0];
  if (latest) return latest.kind;

  const normalizedTitle = normalizedText(title);
  if (/\bclaude\s+code\b/.test(normalizedTitle)) return 'claude';
  if (/\bcodex\b/.test(normalizedTitle)) return 'codex';
  return null;
}

function inferKindFromText(title, previewText, command) {
  const commandName = executableName(command).toLowerCase();
  if (DIRECT_PROCESS_AGENTS.has(commandName)) return 'process';
  if (commandName && !SHELL_COMMANDS.has(commandName) && commandName !== 'codex' && commandName !== 'claude') return 'process';
  const terminalKind = latestTerminalKindFromText(title, previewText);
  if (terminalKind) return terminalKind;
  if (commandName === 'claude') return 'claude';
  if (commandName === 'codex') return 'codex';
  if (SHELL_COMMANDS.has(commandName)) return 'shell';
  return commandName ? 'process' : 'unknown';
}

function terminalTextLooksIdleShellPrompt(previewText) {
  const lines = stripTerminalControlSequences(previewText)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return false;

  return terminalLineLooksLikeIdleShellPrompt(lines[lines.length - 1]);
}

function terminalTitleShowsCodexActivity(title) {
  return /^[\s]*[\u2800-\u28ff]/u.test(String(title || ''));
}

function inferCodexActivity(title, previewText) {
  if (terminalTitleShowsCodexActivity(title)) return 'busy';

  const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
  if (!text.trim()) return 'unknown';

  const idleIndex = lastCodexIdleFooterIndex(text);
  const blockedIndex = codexBlockedIndex(text);
  const activeIndex = codexActiveIndex(text);
  const inactiveIndex = Math.max(idleIndex, blockedIndex);
  if (activeIndex >= 0) return inactiveIndex > activeIndex ? 'idle' : 'busy';
  if (inactiveIndex >= 0) return 'idle';
  return 'unknown';
}

function inferClaudeActivity(previewText) {
  const lines = terminalLines(previewText);
  if (lines.length === 0) return 'unknown';
  return lines.some(lineShowsClaudeActivity) ? 'busy' : 'idle';
}

function inferOpenCodeActivity(previewText) {
  const lines = terminalLines(previewText);
  if (lines.length === 0) return 'unknown';
  const tail = lines.slice(-8);
  let footerIndex = -1;
  for (let index = 0; index < tail.length; index += 1) {
    if (/(?:•|·)\s*opencode\s+\d+(?:\.\d+){1,2}\b/.test(tail[index])) footerIndex = index;
  }
  if (footerIndex < 0) return 'idle';

  const activeProgress = (line) => (
    /^(?:[│┃]\s*)?[■⬝⭝]{3,}/u.test(line)
    && /\b(?:esc|escape|ctrl\+c|ctrl-c)(?:\s+(?:again\s+)?to)?\s+interrupt\b/.test(line)
  );
  const activeFooter = activeProgress(tail[footerIndex])
    || (footerIndex > 0 && activeProgress(tail[footerIndex - 1]));
  return activeFooter ? 'busy' : 'idle';
}

function inferQoderLikeActivity(title, previewText, commandName) {
  const normalizedTitle = stripTerminalControlSequences(title).trim();
  if (commandName === 'qoder' || commandName === 'qodercli') {
    if (/^✋/u.test(normalizedTitle)) return 'idle';
  }

  const lines = terminalLines(previewText);
  const tail = lines.slice(-8);
  const active = tail.some((line, index) => {
    if (!/^[\u2800-\u28ff]/u.test(line)) return false;
    const loadingWindow = tail.slice(index, index + 3).join(' ');
    return /\besc\b/.test(loadingWindow)
      && /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/.test(loadingWindow);
  });
  if (active) return 'busy';

  if (commandName === 'qoder' || commandName === 'qodercli') {
    if (/^[✦⏲]/u.test(normalizedTitle)) return 'busy';
    if (/^◇/u.test(normalizedTitle)) return 'idle';
  }
  return lines.length > 0 || normalizedTitle ? 'idle' : 'unknown';
}

function inferGenericActivity(previewText, terminalBusy) {
  if (terminalBusy === true) return 'busy';
  if (terminalBusy === false) return 'idle';

  if (terminalTextLooksIdleShellPrompt(previewText)) return 'idle';
  return 'unknown';
}

function nestedProcessCommandFromTitle(title) {
  const normalizedTitle = stripTerminalControlSequences(title).trim();
  if (/^oc\s*\|/i.test(normalizedTitle)) return 'opencode';
  if (/^[◇✋✦⏲]/u.test(normalizedTitle)) return 'qodercli';
  if (/^qwen\b/i.test(normalizedTitle)) return 'qwen';
  return '';
}

function deriveTerminalStatus(options = {}) {
  const title = typeof options.title === 'string' ? options.title : '';
  const previewText = typeof options.previewText === 'string' ? options.previewText : '';
  const terminalBusy = typeof options.terminalBusy === 'boolean' ? options.terminalBusy : null;
  const hasShellStatus = options.shellLastEvent === 'start'
    || options.shellLastEvent === 'finish'
    || typeof options.shellLastExitCode === 'number';
  const commandName = executableName(options.command).toLowerCase();
  const runningCommandName = executableName(options.shellCommand).toLowerCase();
  const launchedFromShell = SHELL_COMMANDS.has(commandName);
  let activityCommandName = commandName;
  let kind;
  if (launchedFromShell && runningCommandName) {
    activityCommandName = runningCommandName;
    if (runningCommandName === 'codex') kind = 'codex';
    else if (runningCommandName === 'claude') kind = 'claude';
    else if (DIRECT_PROCESS_AGENTS.has(runningCommandName)) kind = 'process';
    else kind = 'shell';
  } else {
    const nestedProcessCommand = launchedFromShell && !terminalTextLooksIdleShellPrompt(previewText)
      ? nestedProcessCommandFromTitle(title)
      : '';
    if (nestedProcessCommand) {
      activityCommandName = nestedProcessCommand;
      kind = 'process';
    } else {
      kind = inferKindFromText(title, previewText, options.command);
    }
  }
  const shellActivity = kind === 'shell';
  const hasPromptIdleFallback = options.status !== 'exited'
    && shellActivity
    && terminalBusy === true
    && terminalTextLooksIdleShellPrompt(previewText);
  let activity = 'unknown';
  if (options.status === 'exited') {
    activity = 'exited';
  } else if (hasPromptIdleFallback) {
    activity = 'idle';
  } else if (!SHELL_COMMANDS.has(commandName) && terminalBusy !== null) {
    activity = terminalBusy ? 'busy' : 'idle';
  } else if (kind === 'codex') {
    activity = inferCodexActivity(title, previewText);
  } else if (kind === 'claude') {
    activity = inferClaudeActivity(previewText);
  } else if (activityCommandName === 'opencode') {
    activity = inferOpenCodeActivity(previewText);
  } else if (activityCommandName === 'qoder'
    || activityCommandName === 'qodercli'
    || activityCommandName === 'qwen') {
    activity = inferQoderLikeActivity(title, previewText, activityCommandName);
  } else {
    activity = inferGenericActivity(previewText, terminalBusy);
  }

  const status = {
    kind,
    activity,
    busy: activity === 'busy',
    cwd: typeof options.cwd === 'string' ? options.cwd : '',
    title,
    lastExitCode: typeof options.shellLastExitCode === 'number' ? options.shellLastExitCode : null,
    source: hasPromptIdleFallback
      ? 'shell-prompt-fallback'
      : (shellActivity && hasShellStatus
        ? 'shell-status-marker'
        : (shellActivity && terminalBusy !== null ? 'shell-busy-marker' : 'terminal-text')),
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

function terminalInputReady(options = {}) {
  const status = deriveTerminalStatus(options);
  if (status.activity !== 'idle') return false;

  const previewText = typeof options.previewText === 'string' ? options.previewText : '';
  if (status.kind === 'codex') {
    const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
    return lastCodexIdleFooterIndex(text) >= 0 || codexBlockedIndex(text) >= 0;
  }
  if (status.kind === 'claude') {
    const text = stripTerminalControlSequences(previewText).replace(/\r/g, '');
    return /(?:^|\n)\s*❯(?:\s|$)/u.test(text);
  }
  if (status.kind === 'shell') {
    return options.terminalBusy === false || terminalTextLooksIdleShellPrompt(previewText);
  }
  return Boolean(stripTerminalControlSequences(previewText).trim());
}

module.exports = {
  deriveTerminalStatus,
  terminalInputReady,
  terminalTextLooksIdleShellPrompt,
};
