import { getAgentSpec } from './cli-agents.cjs';
import {
  inferProviderTerminalActivity,
  latestProviderTerminalKindCandidate,
  nestedProviderTerminalCommand,
  providerTerminalInputReady,
  providerTerminalKindForCommand,
  providerTerminalKindFromTitle,
} from './provider-terminal-observers.cjs';
import type { ProviderTerminalKind } from './provider-terminal-observers.cjs';

const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish']);

type TerminalKind = ProviderTerminalKind | 'shell' | 'unknown';
type TerminalActivity = 'busy' | 'exited' | 'idle' | 'unknown';
type TerminalStatusSource =
  | 'shell-busy-marker'
  | 'shell-prompt-fallback'
  | 'shell-status-marker'
  | 'terminal-text';

interface TerminalStatusOptions {
  command?: unknown;
  cwd?: unknown;
  previewText?: unknown;
  shellCommand?: unknown;
  shellCommandStartedAt?: unknown;
  shellLastCommand?: unknown;
  shellLastCommandDurationMs?: unknown;
  shellLastCommandFinishedAt?: unknown;
  shellLastCommandStartedAt?: unknown;
  shellLastEvent?: unknown;
  shellLastExitCode?: unknown;
  status?: unknown;
  terminalBusy?: unknown;
  title?: unknown;
}

interface TerminalStatus {
  activity: TerminalActivity;
  busy: boolean;
  cwd: string;
  kind: TerminalKind;
  lastCommand?: string;
  lastCommandDurationMs?: number;
  lastCommandFinishedAt?: number;
  lastCommandStartedAt?: number;
  lastExitCode: number | null;
  runningCommand?: string;
  runningCommandStartedAt?: number;
  source: TerminalStatusSource;
  title: string;
}

function executableName(command: unknown): string {
  const executable = String(command || '')
    .trim()
    .split(/\s+/)
    .find(token => token && token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return (executable || '').split(/[\\/]/).pop() || '';
}

function stripTerminalControlSequences(value: unknown): string {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function terminalStatusCommand(value: unknown): string {
  return stripTerminalControlSequences(value)
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function lastLineIndexMatching(
  text: string,
  predicate: (line: string) => boolean,
): number {
  let offset = 0;
  let lastIndex = -1;
  for (const line of text.split('\n')) {
    if (predicate(line)) lastIndex = offset;
    offset += line.length + 1;
  }
  return lastIndex;
}

function terminalLineLooksLikeIdleShellPrompt(line: string): boolean {
  return /^(?:\s*[│┃]\s*(?:[^$%#\n]+?\s+)?[$%#]|\s*(?:\([^)]+\)\s+)?(?:[\w.-]+@[\w.-]+:)?[~/][\w./~:+-]*\s*[$%#]|\s*[$%#])\s*$/u.test(line);
}

function latestTerminalKindFromText(
  title: unknown,
  previewText: unknown,
): Exclude<TerminalKind, 'process' | 'unknown'> | null {
  const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
  const candidates: Array<{ index: number; kind: Exclude<TerminalKind, 'process' | 'unknown'> }> = [];
  const providerCandidate = latestProviderTerminalKindCandidate(previewText);
  if (providerCandidate) candidates.push(providerCandidate);
  const shellIndex = lastLineIndexMatching(text, terminalLineLooksLikeIdleShellPrompt);
  if (shellIndex >= 0) candidates.push({ kind: 'shell', index: shellIndex });

  const latest = candidates.sort((left, right) => right.index - left.index)[0];
  if (latest) return latest.kind;

  return providerTerminalKindFromTitle(title);
}

function inferKindFromText(
  title: unknown,
  previewText: unknown,
  command: unknown,
): TerminalKind {
  const commandName = executableName(command).toLowerCase();
  if (commandName && !SHELL_COMMANDS.has(commandName)) {
    const providerKind = providerTerminalKindForCommand(commandName);
    if (providerKind === 'process') return 'process';
    if (providerKind) {
      return latestTerminalKindFromText(title, previewText) || providerKind;
    }
    return 'process';
  }
  const terminalKind = latestTerminalKindFromText(title, previewText);
  if (terminalKind) return terminalKind;
  if (SHELL_COMMANDS.has(commandName)) return 'shell';
  return commandName ? 'process' : 'unknown';
}

function terminalTextLooksIdleShellPrompt(previewText: unknown): boolean {
  const lines = stripTerminalControlSequences(previewText)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) return false;

  return terminalLineLooksLikeIdleShellPrompt(lines[lines.length - 1]);
}

function inferGenericActivity(
  previewText: unknown,
  terminalBusy: boolean | null,
): Exclude<TerminalActivity, 'exited'> {
  if (terminalBusy === true) return 'busy';
  if (terminalBusy === false) return 'idle';

  if (terminalTextLooksIdleShellPrompt(previewText)) return 'idle';
  return 'unknown';
}

function deriveTerminalStatus(
  options: TerminalStatusOptions = {},
): TerminalStatus {
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
  let kind: TerminalKind;
  if (launchedFromShell && runningCommandName) {
    activityCommandName = runningCommandName;
    kind = providerTerminalKindForCommand(runningCommandName)
      || (getAgentSpec(runningCommandName)?.category === 'coding' ? 'process' : 'shell');
  } else {
    const nestedProcessCommand = launchedFromShell && !terminalTextLooksIdleShellPrompt(previewText)
      ? nestedProviderTerminalCommand(title)
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
  const providerActivity = inferProviderTerminalActivity(activityCommandName, kind, { title, previewText });
  let activity: TerminalActivity = 'unknown';
  if (options.status === 'exited') {
    activity = 'exited';
  } else if (hasPromptIdleFallback) {
    activity = 'idle';
  } else if (providerActivity?.priority === 'provider-first') {
    activity = providerActivity.activity === 'unknown' && terminalBusy !== null
      ? (terminalBusy ? 'busy' : 'idle')
      : providerActivity.activity;
  } else if (!SHELL_COMMANDS.has(commandName) && terminalBusy !== null) {
    activity = terminalBusy ? 'busy' : 'idle';
  } else {
    activity = providerActivity?.activity
      || inferGenericActivity(previewText, terminalBusy);
  }

  const status: TerminalStatus = {
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

function terminalInputReady(options: TerminalStatusOptions = {}): boolean {
  const status = deriveTerminalStatus(options);
  if (status.activity !== 'idle') return false;

  const previewText = typeof options.previewText === 'string' ? options.previewText : '';
  const providerReady = providerTerminalInputReady(status.kind, previewText);
  if (providerReady !== null) return providerReady;
  if (status.kind === 'shell') {
    return options.terminalBusy === false || terminalTextLooksIdleShellPrompt(previewText);
  }
  return Boolean(stripTerminalControlSequences(previewText).trim());
}

export {
  deriveTerminalStatus,
  terminalInputReady,
  terminalTextLooksIdleShellPrompt,
};
export type {
  TerminalActivity,
  TerminalKind,
  TerminalStatus,
  TerminalStatusOptions,
  TerminalStatusSource,
};
