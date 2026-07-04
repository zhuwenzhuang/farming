function agentKindForCommand(command) {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  const basename = (executable || '').split('/').pop() || '';
  if (basename === 'codex') return 'codex';
  if (basename === 'claude') return 'claude';
  if (['bash', 'zsh', 'sh', 'fish'].includes(basename)) return 'shell';
  return executable ? 'agent' : null;
}

function currentTerminalText(agent) {
  if (!agent) return '';
  const previewText = typeof agent.previewText === 'string' ? agent.previewText : '';
  if (previewText.trim()) return previewText.toLowerCase();
  return String(agent.output || '').slice(-1800).toLowerCase();
}

function lastIndexOfAny(text, needles) {
  return needles.reduce((last, needle) => Math.max(last, text.lastIndexOf(needle)), -1);
}

function lastCodexIdleFooterIndex(text) {
  const matches = Array.from(text.matchAll(/(?:^|\n)\s*(?:gpt|codex)[^\n]*(?:·|•)\s*(?:~|\/)[^\n]*$/gim));
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
  return lastMatch && typeof lastMatch.index === 'number' ? lastMatch.index : -1;
}

function codexActiveIndex(text) {
  const activeTextIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'esc to interrupt',
    'press esc to interrupt',
    'reconnecting',
    '/stop to close',
    'background terminal running',
  ]);
  const workingIndex = /\bworking\b/.test(text) ? text.lastIndexOf('working') : -1;
  const stepMatches = Array.from(text.matchAll(/step\s+\d+\s*\/\s*\d+/g));
  const lastStepMatch = stepMatches.length > 0 ? stepMatches[stepMatches.length - 1] : undefined;
  const stepIndex = lastStepMatch && typeof lastStepMatch.index === 'number' ? lastStepMatch.index : -1;
  return Math.max(activeTextIndex, workingIndex, stepIndex);
}

function codexKindIndex(text) {
  const codexSpecificIndex = lastIndexOfAny(text, [
    'pursuing goal',
    'reconnecting',
    '/stop to close',
    'background terminal running',
    'messages to be submitted after next tool call',
    'stream disconnected before completion',
  ]);
  const workingIndex = /\bworking\b/.test(text) ? text.lastIndexOf('working') : -1;
  const stepMatches = Array.from(text.matchAll(/step\s+\d+\s*\/\s*\d+/g));
  const lastStepMatch = stepMatches.length > 0 ? stepMatches[stepMatches.length - 1] : undefined;
  const stepIndex = lastStepMatch && typeof lastStepMatch.index === 'number' ? lastStepMatch.index : -1;
  return Math.max(codexSpecificIndex, workingIndex, stepIndex);
}

function codexBlockedIndex(text) {
  return lastIndexOfAny(text, [
    'goal blocked',
    'input exceeds the context window',
    'please adjust your input and try again',
  ]);
}

function titleWithoutActivityPrefix(title) {
  return String(title || '')
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function activeTerminalTitleKind(agent) {
  const title = typeof agent.sessionTitle === 'string' ? agent.sessionTitle.trim() : '';
  if (/^[\u2800-\u28ff]/u.test(title)) return 'codex';
  return null;
}

function genericTerminalTitleKind(agent) {
  const normalized = titleWithoutActivityPrefix(agent && agent.sessionTitle);
  if (!normalized) return null;
  if (/\bclaude(?:\s+code)?\b/.test(normalized)) return 'claude';
  if (/\bcodex\b/.test(normalized)) return 'codex';
  if (/^(?:bash|zsh|sh|fish)(?:\s|$)/.test(normalized)) return 'shell';
  return null;
}

function lastMatchIndex(text, pattern) {
  const matches = Array.from(text.matchAll(pattern));
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
  return lastMatch && typeof lastMatch.index === 'number' ? lastMatch.index : -1;
}

function latestTerminalOutputKind(text) {
  const candidates = [];
  const codexIndex = Math.max(
    lastCodexIdleFooterIndex(text),
    codexKindIndex(text),
    lastMatchIndex(text, /(?:^|\n)\s*›\s/g)
  );
  if (codexIndex >= 0) candidates.push({ kind: 'codex', index: codexIndex });

  const claudeIndex = Math.max(
    lastIndexOfAny(text, ['claude code']),
    lastMatchIndex(text, /(?:thinking|claude)[\s\S]*(?:esc|escape|ctrl\+c|ctrl-c) to interrupt/g)
  );
  if (claudeIndex >= 0) candidates.push({ kind: 'claude', index: claudeIndex });

  const shellIndex = lastMatchIndex(text, /(?:^|\n)\s*(?:[\w./~:@-]+\s*)?[$%#]\s*$/gm);
  if (shellIndex >= 0) candidates.push({ kind: 'shell', index: shellIndex });

  const latest = candidates.sort((a, b) => b.index - a.index)[0];
  return latest ? latest.kind : null;
}

function inferAgentKind(agent) {
  if (!agent) return null;
  return activeTerminalTitleKind(agent)
    || latestTerminalOutputKind(currentTerminalText(agent))
    || (agent.terminalBusy === true ? 'shell' : null)
    || genericTerminalTitleKind(agent)
    || agentKindForCommand(agent.command);
}

function isCodexRestartBlocking(agent) {
  const output = currentTerminalText(agent);
  if (!output) return false;
  if (output.includes('messages to be submitted after next tool call')) return true;

  const activeIndex = codexActiveIndex(output);
  if (activeIndex < 0) return false;

  const blockedIndex = codexBlockedIndex(output);
  if (blockedIndex >= activeIndex) return false;

  return lastCodexIdleFooterIndex(output) <= activeIndex;
}

function isClaudeRestartBlocking(agent) {
  const output = currentTerminalText(agent);
  return (
    output.includes('esc to interrupt') ||
    output.includes('escape to interrupt') ||
    output.includes('ctrl+c to interrupt') ||
    output.includes('ctrl-c to interrupt') ||
    output.includes('press esc to interrupt')
  );
}

function isRecoverableEngineAgent(agent) {
  return agent && agent.engineName === 'native';
}

function isRestartBlockingAgent(agent) {
  if (!agent || agent.isMain === true || agent.archived === true) return false;
  if (agent.status === 'pending') return true;
  if (agent.status !== 'running') return false;
  if (isRecoverableEngineAgent(agent)) return false;
  if (agent.terminalBusy === true) return true;

  const kind = inferAgentKind(agent);
  if (kind === 'shell') return false;
  if (kind === 'codex') return isCodexRestartBlocking(agent);
  if (kind === 'claude') return isClaudeRestartBlocking(agent);
  return true;
}

module.exports = {
  agentKindForCommand,
  isRecoverableEngineAgent,
  isRestartBlockingAgent,
};
