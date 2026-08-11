type ProviderTerminalKind = 'claude' | 'codex' | 'process';
type ProviderTerminalActivity = 'busy' | 'idle' | 'unknown';

interface ProviderTerminalKindCandidate {
  index: number;
  kind: Exclude<ProviderTerminalKind, 'process'>;
}

interface ProviderTerminalObserverInput {
  commandName: string;
  previewText: unknown;
  title: unknown;
}

interface ProviderTerminalObserver {
  activityPriority?: 'provider-first' | 'terminal-busy-first';
  commands: readonly string[];
  inferActivity(input: ProviderTerminalObserverInput): ProviderTerminalActivity;
  inputReady?: (previewText: unknown) => boolean;
  kind: ProviderTerminalKind;
  kindEvidenceIndex?: (previewText: unknown) => number;
  nestedTitlePattern?: RegExp;
  titlePattern?: RegExp;
}

function stripTerminalControlSequences(value: unknown): string {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function terminalLines(value: unknown): string[] {
  return stripTerminalControlSequences(value)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter(Boolean);
}

function lastMatchIndex(text: string, pattern: RegExp): number {
  const matches = Array.from(text.matchAll(pattern));
  const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
  return lastMatch && typeof lastMatch.index === 'number' ? lastMatch.index : -1;
}

function lastIndexOfAny(text: string, needles: string[]): number {
  return needles.reduce((last, needle) => Math.max(last, text.lastIndexOf(needle)), -1);
}

function lastLineIndexMatching(text: string, predicate: (line: string) => boolean): number {
  let offset = 0;
  let lastIndex = -1;
  for (const line of text.split('\n')) {
    if (predicate(line)) lastIndex = offset;
    offset += line.length + 1;
  }
  return lastIndex;
}

function lastCodexIdleFooterIndex(text: string): number {
  return lastMatchIndex(text, /(?:^|\n)\s*(?:gpt|codex)[^\n]*(?:·|•)\s*(?:~|\/)[^\n]*$/gim);
}

function codexActiveIndex(text: string): number {
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
    /(?:^|\n)[^\n]*\bworking\b[^\n]*(?:(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt|step\s+\d+\s*\/\s*\d+)/gim,
  );
  return Math.max(activeTextIndex, workingIndex);
}

function codexBlockedIndex(text: string): number {
  return lastIndexOfAny(text, [
    'goal blocked',
    'input exceeds the context window',
    'please adjust your input and try again',
  ]);
}

function lineShowsInterrupt(line: string): boolean {
  return /\b(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt\b/i.test(line);
}

function lineShowsClaudeStatusRow(line: string, excludeBareWorking = false): boolean {
  const normalized = line.trim().toLowerCase();
  const match = normalized.match(
    /^([＊✳✱✲✶✻✽✢])?\s*([\p{L}\p{M}][\p{L}\p{M}'’-]*)(?:\.{3}|…)?\s*\(([^)]*)\)\s*$/u,
  );
  if (!match || !lineShowsInterrupt(match[3])) return false;
  if (excludeBareWorking && !match[1] && match[2] === 'working') return false;

  const interruptOnly = /^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/i.test(match[3].trim());
  const hasElapsedTime = /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/i.test(match[3]);
  return interruptOnly || hasElapsedTime;
}

function lineShowsClaudeActivity(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (/^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/.test(normalized)) return true;
  return lineShowsClaudeStatusRow(normalized);
}

function lineShowsClaudeKindEvidence(line: string): boolean {
  const normalized = line.trim().toLowerCase();
  if (/^(?:press\s+)?(?:esc|escape|ctrl\+c|ctrl-c)\s+to\s+interrupt$/.test(normalized)) return true;
  return lineShowsClaudeStatusRow(normalized, true);
}

function inferCodexActivity({ title, previewText }: ProviderTerminalObserverInput): ProviderTerminalActivity {
  if (/^[\s]*[\u2800-\u28ff]/u.test(String(title || ''))) return 'busy';

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

function inferClaudeActivity({ previewText }: ProviderTerminalObserverInput): ProviderTerminalActivity {
  const lines = terminalLines(previewText);
  if (lines.length === 0) return 'unknown';
  return lines.some(lineShowsClaudeActivity) ? 'busy' : 'idle';
}

function inferOpenCodeActivity({ previewText }: ProviderTerminalObserverInput): ProviderTerminalActivity {
  const lines = terminalLines(previewText);
  if (lines.length === 0) return 'unknown';
  const tail = lines.slice(-8);
  let footerIndex = -1;
  for (let index = 0; index < tail.length; index += 1) {
    if (/(?:•|·)\s*opencode\s+\d+(?:\.\d+){1,2}\b/.test(tail[index])) footerIndex = index;
  }
  if (footerIndex < 0) return 'idle';

  const activeProgress = (line: string): boolean => (
    /^(?:[│┃]\s*)?[■⬝⭝]{3,}/u.test(line)
    && /\b(?:esc|escape|ctrl\+c|ctrl-c)(?:\s+(?:again\s+)?to)?\s+interrupt\b/.test(line)
  );
  return activeProgress(tail[footerIndex])
    || (footerIndex > 0 && activeProgress(tail[footerIndex - 1]))
    ? 'busy'
    : 'idle';
}

function inferQoderLikeActivity({ title, previewText, commandName }: ProviderTerminalObserverInput): ProviderTerminalActivity {
  const normalizedTitle = stripTerminalControlSequences(title).trim();
  if ((commandName === 'qoder' || commandName === 'qodercli') && /^✋/u.test(normalizedTitle)) return 'idle';

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

function inferQwenActivity({ previewText }: ProviderTerminalObserverInput): ProviderTerminalActivity {
  const lines = terminalLines(previewText);
  const tail = lines.slice(-10);

  // Qwen Code renders this footer only while StreamingState.Responding.
  // Ctrl+Q is intentionally left untranslated in every locale.
  if (tail.some(line => /\bctrl\+q\b/.test(line))) return 'busy';

  // LoadingIndicator is absent in Idle. Its normal and narrow layouts both
  // keep the spinner, elapsed duration, and Esc cancellation affordance, even
  // when those pieces wrap onto adjacent lines.
  const active = tail.some((_line, index) => {
    const loadingWindow = tail.slice(index, index + 3).join(' ');
    return /\besc\b/.test(loadingWindow)
      && /\b\d+(?:\.\d+)?\s*(?:ms|s|m|h)\b/.test(loadingWindow);
  });
  if (active) return 'busy';

  // The current screen is an authoritative Ink projection. Once a previously
  // rendered Responding marker is gone, Qwen has left Responding (Idle or an
  // input-required state); both are attention boundaries for Farming.
  return lines.length > 0 ? 'idle' : 'unknown';
}

const PROVIDER_TERMINAL_OBSERVERS: readonly ProviderTerminalObserver[] = [
  {
    activityPriority: 'provider-first',
    commands: ['codex'],
    kind: 'codex',
    kindEvidenceIndex: previewText => {
      const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
      return Math.max(lastCodexIdleFooterIndex(text), codexActiveIndex(text));
    },
    titlePattern: /\bcodex\b/,
    inferActivity: inferCodexActivity,
    inputReady: previewText => {
      const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
      return lastCodexIdleFooterIndex(text) >= 0 || codexBlockedIndex(text) >= 0;
    },
  },
  {
    commands: ['claude'],
    kind: 'claude',
    kindEvidenceIndex: previewText => {
      const text = stripTerminalControlSequences(previewText).replace(/\r/g, '').toLowerCase();
      return lastLineIndexMatching(text, lineShowsClaudeKindEvidence);
    },
    titlePattern: /\bclaude\s+code\b/,
    inferActivity: inferClaudeActivity,
    inputReady: previewText => /(?:^|\n)\s*❯(?:\s|$)/u.test(
      stripTerminalControlSequences(previewText).replace(/\r/g, ''),
    ),
  },
  {
    commands: ['opencode'],
    kind: 'process',
    nestedTitlePattern: /^oc\s*\|/i,
    inferActivity: inferOpenCodeActivity,
  },
  {
    commands: ['qoder', 'qodercli'],
    kind: 'process',
    nestedTitlePattern: /^[◇✋✦⏲]/u,
    inferActivity: inferQoderLikeActivity,
  },
  {
    activityPriority: 'provider-first',
    commands: ['qwen'],
    kind: 'process',
    nestedTitlePattern: /^qwen\b/i,
    inferActivity: inferQwenActivity,
  },
];

const OBSERVER_BY_COMMAND = new Map(PROVIDER_TERMINAL_OBSERVERS.flatMap(observer => (
  observer.commands.map(command => [command, observer] as const)
)));

function providerTerminalKindForCommand(commandName: string): ProviderTerminalKind | null {
  return OBSERVER_BY_COMMAND.get(commandName)?.kind || null;
}

function latestProviderTerminalKindCandidate(previewText: unknown): ProviderTerminalKindCandidate | null {
  const candidates = PROVIDER_TERMINAL_OBSERVERS.flatMap(observer => {
    const index = observer.kindEvidenceIndex?.(previewText) ?? -1;
    return index >= 0 && observer.kind !== 'process'
      ? [{ index, kind: observer.kind }]
      : [];
  });
  return candidates.sort((left, right) => right.index - left.index)[0] || null;
}

function providerTerminalKindFromTitle(title: unknown): Exclude<ProviderTerminalKind, 'process'> | null {
  const normalizedTitle = stripTerminalControlSequences(title).replace(/\s+/g, ' ').trim().toLowerCase();
  const observer = PROVIDER_TERMINAL_OBSERVERS.find(candidate => (
    candidate.kind !== 'process' && candidate.titlePattern?.test(normalizedTitle)
  ));
  return observer?.kind === 'process' ? null : observer?.kind || null;
}

function nestedProviderTerminalCommand(title: unknown): string {
  const normalizedTitle = stripTerminalControlSequences(title).trim();
  const observer = PROVIDER_TERMINAL_OBSERVERS.find(candidate => candidate.nestedTitlePattern?.test(normalizedTitle));
  return observer?.commands[0] || '';
}

function inferProviderTerminalActivity(
  commandName: string,
  kind: ProviderTerminalKind | 'shell' | 'unknown',
  input: Omit<ProviderTerminalObserverInput, 'commandName'>,
): { activity: ProviderTerminalActivity; priority: 'provider-first' | 'terminal-busy-first' } | null {
  const observer = OBSERVER_BY_COMMAND.get(commandName)
    || PROVIDER_TERMINAL_OBSERVERS.find(candidate => candidate.kind !== 'process' && candidate.kind === kind);
  return observer
    ? {
        activity: observer.inferActivity({ ...input, commandName }),
        priority: observer.activityPriority || 'terminal-busy-first',
      }
    : null;
}

function providerTerminalInputReady(
  kind: ProviderTerminalKind | 'shell' | 'unknown',
  previewText: unknown,
): boolean | null {
  const observer = PROVIDER_TERMINAL_OBSERVERS.find(candidate => candidate.kind !== 'process' && candidate.kind === kind);
  return observer?.inputReady ? observer.inputReady(previewText) : null;
}

export {
  inferProviderTerminalActivity,
  latestProviderTerminalKindCandidate,
  nestedProviderTerminalCommand,
  providerTerminalInputReady,
  providerTerminalKindForCommand,
  providerTerminalKindFromTitle,
};
export type {
  ProviderTerminalActivity,
  ProviderTerminalKind,
  ProviderTerminalKindCandidate,
};
