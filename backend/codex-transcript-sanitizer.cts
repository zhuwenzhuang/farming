interface HeartbeatEnvelope {
  automationId: string;
  currentTimeIso: string;
  instructions: string;
  decision: string;
  message: string;
}

interface CodexInlineVisualizationDirective {
  file: string;
  title?: string;
  mode?: 'wide';
  resourceRoot?: string;
}

interface CodexInlineVisualizationStreamState {
  buffer: string;
  fenceCharacter: string;
  fenceLength: number;
  passthroughLine: boolean;
}

interface CodexInlineVisualizationStreamResult {
  directives: CodexInlineVisualizationDirective[];
  text: string;
}

const CODEX_INLINE_VISUALIZATION_PREFIX = '::codex-inline-vis{';
const CODEX_VISUALIZE_REFERENCE_PREFIX = 'visualize';
const CODEX_VISUALIZE_REFERENCE_SUFFIX = '';
const CODEX_INLINE_VISUALIZATION_PREFIXES = [
  CODEX_INLINE_VISUALIZATION_PREFIX,
  CODEX_VISUALIZE_REFERENCE_PREFIX,
];
const MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES = 16 * 1024;

function normalizeCodexTranscriptText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function escapeRegExp(value: unknown): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CODEX_INTERNAL_CONTEXT_TAGS = [
  'codex_internal_context',
  'goal_context',
  'environment_context',
  'farming-agent-context',
  'app_specific_instructions',
  'app-context',
  'collaboration_mode',
  'apps_instructions',
  'skills_instructions',
  'plugins_instructions',
  'recommended_plugins',
  'oai-mem-citation',
  'permissions instructions',
  'turn_aborted',
  'system-reminder',
  'when_to_save',
  'how_to_use',
  'body_structure',
  'tool_call',
  'tool_response',
  'trajectory',
  'previous-summary',
  'conversation',
  'heartbeat',
];

interface InternalTextSpan {
  start: number;
  end: number;
}

function findCodexInternalBlockRuns(text: string): InternalTextSpan[] {
  const spans: InternalTextSpan[] = [];
  for (const tagName of CODEX_INTERNAL_CONTEXT_TAGS) {
    const escapedTag = escapeRegExp(tagName);
    const pattern = new RegExp(`<${escapedTag}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>`, 'gi');
    for (const match of text.matchAll(pattern)) {
      if (typeof match.index === 'number') {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  const instructionsPattern = /(^|\n)([ \t]*# AGENTS\.md instructions for[^\n]*\n[\s\S]*?<\/INSTRUCTIONS>)(?=[ \t]*(?:\n|$))/gi;
  for (const match of text.matchAll(instructionsPattern)) {
    if (typeof match.index === 'number') {
      const start = match.index + match[1].length;
      spans.push({ start, end: start + match[2].length });
    }
  }
  if (spans.length === 0) return [];
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const runs: InternalTextSpan[] = [];
  for (const span of spans) {
    const previous = runs[runs.length - 1];
    if (!previous) {
      runs.push({ ...span });
      continue;
    }
    if (span.start <= previous.end || /^\s*$/.test(text.slice(previous.end, span.start))) {
      previous.end = Math.max(previous.end, span.end);
      continue;
    }
    runs.push({ ...span });
  }
  return runs;
}

function splitLeftEnvelopeWhitespace(segment: string): { rest: string; envelope: string } {
  const match = segment.match(/[ \t\n]+$/);
  if (!match) return { rest: segment, envelope: '' };
  return {
    rest: segment.slice(0, segment.length - match[0].length),
    envelope: match[0],
  };
}

function splitRightEnvelopeWhitespace(segment: string): { envelope: string; rest: string } {
  const newlineMatch = segment.match(/^[ \t]*(?:\n[ \t]*)*\n/);
  if (newlineMatch) {
    return {
      envelope: newlineMatch[0],
      rest: segment.slice(newlineMatch[0].length),
    };
  }
  const spaceMatch = segment.match(/^[ \t]+/);
  if (spaceMatch) {
    return {
      envelope: spaceMatch[0],
      rest: segment.slice(spaceMatch[0].length),
    };
  }
  return { envelope: '', rest: segment };
}

function joinInternalEnvelopeGap(leftEnvelope: string, rightEnvelope: string): string {
  if (/\n[ \t]*\n/.test(leftEnvelope) || /\n[ \t]*\n/.test(rightEnvelope)) {
    return '\n\n';
  }
  if (leftEnvelope.includes('\n') || rightEnvelope.includes('\n')) {
    return '\n';
  }
  if (leftEnvelope.length > 0 && rightEnvelope.length > 0) {
    return ' ';
  }
  return leftEnvelope || rightEnvelope;
}

function stripCodexInternalBlockEnvelopes(text: string): string {
  const runs = findCodexInternalBlockRuns(text);
  if (runs.length === 0) return text;

  const segments: string[] = [];
  let cursor = 0;
  for (const run of runs) {
    segments.push(text.slice(cursor, run.start));
    cursor = run.end;
  }
  segments.push(text.slice(cursor));

  const firstVisible = segments.findIndex(segment => /\S/.test(segment));
  if (firstVisible < 0) return '';
  let lastVisible = segments.length - 1;
  while (lastVisible > firstVisible && !/\S/.test(segments[lastVisible])) {
    lastVisible -= 1;
  }

  let output = '';
  for (let index = firstVisible; index <= lastVisible; index += 1) {
    let current = segments[index];
    let rightEnvelope = '';
    if (index > 0) {
      const splitRight = splitRightEnvelopeWhitespace(current);
      rightEnvelope = splitRight.envelope;
      current = splitRight.rest;
    }
    if (index > firstVisible) {
      const previousLeft = splitLeftEnvelopeWhitespace(output);
      output = previousLeft.rest + joinInternalEnvelopeGap(previousLeft.envelope, rightEnvelope) + current;
    } else {
      output = current;
    }
  }
  if (lastVisible < segments.length - 1) {
    output = splitLeftEnvelopeWhitespace(output).rest;
  }
  return output;
}

function xmlishTagValue(text: unknown, tagName: string): string {
  const escapedTag = escapeRegExp(tagName);
  const match = String(text || '').match(new RegExp(`<${escapedTag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i'));
  return match ? normalizeCodexTranscriptText(match[1]) : '';
}

function parseHeartbeatEnvelope(value: unknown): HeartbeatEnvelope | null {
  const text = normalizeCodexTranscriptText(value);
  if (!text || !/^<heartbeat(?:\s+[^>]*)?>[\s\S]*<\/heartbeat>$/i.test(text)) return null;
  return {
    automationId: xmlishTagValue(text, 'automation_id'),
    currentTimeIso: xmlishTagValue(text, 'current_time_iso'),
    instructions: xmlishTagValue(text, 'instructions'),
    decision: xmlishTagValue(text, 'decision'),
    message: xmlishTagValue(text, 'message'),
  };
}

function heartbeatUserMessage(value: unknown): string {
  const heartbeat = parseHeartbeatEnvelope(value);
  if (!heartbeat) return '';
  return [
    'Automation heartbeat',
    heartbeat.automationId,
    heartbeat.currentTimeIso,
  ].filter(Boolean).join(' · ');
}

function heartbeatAssistantMessage(value: unknown): string {
  const heartbeat = parseHeartbeatEnvelope(value);
  if (!heartbeat) return '';
  if (heartbeat.decision && heartbeat.decision.toUpperCase() === 'DONT_NOTIFY') return '';
  return heartbeat.message || '';
}

function stripCodexAppDirectives(value: unknown): string {
  // These directives are private transport hints consumed by the Codex app.
  // Farming does not implement their native cards, so rendering them as
  // Markdown leaks protocol syntax and local paths into otherwise clean Chat.
  const withoutMutationDirectives = String(value || '').replace(
    /::(?:code-comment|created-thread|git-(?:stage|commit|create-branch|push|create-pr))\{[^\r\n]*\}/gi,
    '',
  );
  return consumeCodexInlineVisualizationStream(
    { buffer: '', fenceCharacter: '', fenceLength: 0, passthroughLine: false },
    withoutMutationDirectives,
    true,
  ).text;
}

function codexInlineVisualizationDirectives(value: unknown): CodexInlineVisualizationDirective[] {
  return consumeCodexInlineVisualizationStream(
    { buffer: '', fenceCharacter: '', fenceLength: 0, passthroughLine: false },
    String(value || ''),
    true,
  ).directives;
}

function createCodexInlineVisualizationStreamState(): CodexInlineVisualizationStreamState {
  return { buffer: '', fenceCharacter: '', fenceLength: 0, passthroughLine: false };
}

function directiveFile(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith(CODEX_INLINE_VISUALIZATION_PREFIX) && trimmed.endsWith('}')) {
    const attributes = trimmed.slice(CODEX_INLINE_VISUALIZATION_PREFIX.length, -1).trim();
    const match = attributes.match(/^file="([^"]+)"$/);
    return String(match?.[1] || '');
  }
  if (
    !trimmed.startsWith(CODEX_VISUALIZE_REFERENCE_PREFIX)
    || !trimmed.endsWith(CODEX_VISUALIZE_REFERENCE_SUFFIX)
  ) return '';
  try {
    const payload = JSON.parse(trimmed.slice(
      CODEX_VISUALIZE_REFERENCE_PREFIX.length,
      -CODEX_VISUALIZE_REFERENCE_SUFFIX.length,
    ));
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && typeof payload.path === 'string'
      ? payload.path
      : '';
  } catch {
    return '';
  }
}

function startsWithVisualizationDirective(value: string): boolean {
  return CODEX_INLINE_VISUALIZATION_PREFIXES.some(prefix => value.startsWith(prefix));
}

function couldBecomeVisualizationDirective(value: string): boolean {
  return CODEX_INLINE_VISUALIZATION_PREFIXES.some(prefix => (
    prefix.startsWith(value) || value.startsWith(prefix)
  ));
}

function isCompleteVisualizationDirective(value: string): boolean {
  return (
    value.startsWith(CODEX_INLINE_VISUALIZATION_PREFIX) && value.endsWith('}')
  ) || (
    value.startsWith(CODEX_VISUALIZE_REFERENCE_PREFIX)
    && value.endsWith(CODEX_VISUALIZE_REFERENCE_SUFFIX)
  );
}

function fenceMarker(line: string) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  return { character: match[1][0], length: match[1].length, tail: match[2] };
}

function consumeCodexInlineVisualizationStream(
  state: CodexInlineVisualizationStreamState,
  value: unknown,
  final = false,
): CodexInlineVisualizationStreamResult {
  state.buffer += String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const directives: CodexInlineVisualizationDirective[] = [];
  let text = '';

  const consumeLine = (line: string, newline: string) => {
    const marker = fenceMarker(line);
    if (state.fenceCharacter) {
      text += `${line}${newline}`;
      if (
        marker
        && marker.character === state.fenceCharacter
        && marker.length >= state.fenceLength
        && marker.tail.trim() === ''
      ) {
        state.fenceCharacter = '';
        state.fenceLength = 0;
      }
      return;
    }
    if (marker) {
      text += `${line}${newline}`;
      state.fenceCharacter = marker.character;
      state.fenceLength = marker.length;
      return;
    }
    if (/^(?: {4}|\t)/.test(line)) {
      text += `${line}${newline}`;
      return;
    }
    const trimmed = line.trim();
    if (!startsWithVisualizationDirective(trimmed)) {
      text += `${line}${newline}`;
      return;
    }
    const file = directiveFile(line);
    if (file) {
      const directive: CodexInlineVisualizationDirective = { file };
      if (trimmed.startsWith(CODEX_VISUALIZE_REFERENCE_PREFIX)) {
        const payload = JSON.parse(trimmed.slice(CODEX_VISUALIZE_REFERENCE_PREFIX.length, -CODEX_VISUALIZE_REFERENCE_SUFFIX.length));
        if (typeof payload.title === 'string') directive.title = payload.title.slice(0, 256);
        if (payload.mode === 'wide') directive.mode = 'wide';
        if (typeof payload.resourceRoot === 'string') directive.resourceRoot = payload.resourceRoot;
      }
      directives.push(directive);
    }
    // A complete malformed directive and an incomplete streaming directive are
    // both host-only syntax. The caller renders an explicit unavailable
    // resource for a valid directive whose file cannot be resolved.
    text += newline;
  };

  while (state.buffer) {
    if (state.passthroughLine) {
      const newlineIndex = state.buffer.indexOf('\n');
      if (newlineIndex < 0) {
        text += state.buffer;
        state.buffer = '';
        break;
      }
      text += state.buffer.slice(0, newlineIndex + 1);
      state.buffer = state.buffer.slice(newlineIndex + 1);
      state.passthroughLine = false;
      continue;
    }

    const newlineIndex = state.buffer.indexOf('\n');
    if (newlineIndex >= 0) {
      const line = state.buffer.slice(0, newlineIndex);
      state.buffer = state.buffer.slice(newlineIndex + 1);
      consumeLine(line, '\n');
      continue;
    }

    if (final) {
      const line = state.buffer;
      state.buffer = '';
      consumeLine(line, '');
      break;
    }

    const trimmedStart = state.buffer.trimStart();
    const couldBecomeDirective = couldBecomeVisualizationDirective(trimmedStart);
    const couldBecomeFence = /^ {0,3}(?:`+|~+)/.test(state.buffer);
    const couldCloseFence = Boolean(state.fenceCharacter)
      && new RegExp(`^ {0,3}${state.fenceCharacter === '`' ? '`' : '~'}{${state.fenceLength},}`).test(state.buffer);
    if (
      (state.fenceCharacter && !couldCloseFence)
      || /^(?: {4}|\t)/.test(state.buffer)
      || (!state.fenceCharacter && !couldBecomeDirective && !couldBecomeFence)
    ) {
      text += state.buffer;
      state.buffer = '';
      state.passthroughLine = true;
      break;
    }
    // The line is a partial or complete directive. A closing brace makes it
    // stable enough to normalize immediately; otherwise keep it invisible
    // until the next chunk completes it.
    if (isCompleteVisualizationDirective(trimmedStart)) {
      const line = state.buffer;
      state.buffer = '';
      consumeLine(line, '');
    }
    if (Buffer.byteLength(state.buffer, 'utf8') > MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES) {
      text += state.buffer;
      state.buffer = '';
      state.passthroughLine = true;
    }
    break;
  }

  return { directives, text };
}

function stripCodexInternalContextBlocks(value: unknown, options: { preserveWhitespace?: boolean } = {}): string {
  let text = options.preserveWhitespace
    ? String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    : normalizeCodexTranscriptText(value);
  if (!text) return '';

  text = stripCodexInternalBlockEnvelopes(text);
  text = stripCodexAppDirectives(text);

  if (options.preserveWhitespace) return text;
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripCodexAppDirectivesFromFragments(fragments: string[]): string[] {
  const joined = fragments.join('');
  if (!joined) return fragments;

  const keep = new Uint8Array(joined.length);
  keep.fill(1);

  const mutationRegex = /::(?:code-comment|created-thread|git-(?:stage|commit|create-branch|push|create-pr))\{[^\r\n]*\}/gi;
  let match: RegExpExecArray | null;
  while ((match = mutationRegex.exec(joined)) !== null) {
    keep.fill(0, match.index, match.index + match[0].length);
  }

  let afterMutation = '';
  const originIndex: number[] = [];
  for (let index = 0; index < joined.length; index += 1) {
    if (keep[index]) {
      afterMutation += joined[index]!;
      originIndex.push(index);
    }
  }

  let fenceCharacter = '';
  let fenceLength = 0;
  let lineStart = 0;
  for (let index = 0; index <= afterMutation.length; index += 1) {
    if (index < afterMutation.length && afterMutation[index] !== '\n') continue;
    const line = afterMutation.slice(lineStart, index);
    const marker = fenceMarker(line);
    if (fenceCharacter) {
      if (
        marker
        && marker.character === fenceCharacter
        && marker.length >= fenceLength
        && marker.tail.trim() === ''
      ) {
        fenceCharacter = '';
        fenceLength = 0;
      }
    } else if (marker) {
      fenceCharacter = marker.character;
      fenceLength = marker.length;
    } else if (!/^(?: {4}|\t)/.test(line) && startsWithVisualizationDirective(line.trim())) {
      for (let pos = lineStart; pos < index; pos += 1) {
        keep[originIndex[pos]!] = 0;
      }
    }
    lineStart = index + 1;
  }

  const out: string[] = [];
  let cursor = 0;
  for (const part of fragments) {
    const end = cursor + part.length;
    let slice = '';
    for (let index = cursor; index < end; index += 1) {
      if (keep[index]) slice += joined[index]!;
    }
    out.push(slice);
    cursor = end;
  }
  return out;
}

function stripCodexInternalContextBlocksFromFragments(fragments: string[]): string[] {
  const normalized = fragments.map(item => String(item || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
  const joined = normalized.join('');
  if (!joined) return normalized;

  const runs = findCodexInternalBlockRuns(joined);
  if (runs.length === 0) {
    return stripCodexAppDirectivesFromFragments(normalized);
  }

  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  let offset = 0;
  for (const part of normalized) {
    startOffsets.push(offset);
    offset += part.length;
    endOffsets.push(offset);
  }
  const fragmentIndexForOffset = (pos: number): number => {
    for (let index = 0; index < normalized.length; index += 1) {
      if (pos >= startOffsets[index]! && pos < endOffsets[index]!) return index;
    }
    return normalized.length - 1;
  };

  const segments: Array<{ start: number; end: number; text: string }> = [];
  let cursor = 0;
  for (const run of runs) {
    segments.push({ start: cursor, end: run.start, text: joined.slice(cursor, run.start) });
    cursor = run.end;
  }
  segments.push({ start: cursor, end: joined.length, text: joined.slice(cursor) });

  const firstVisible = segments.findIndex(segment => /\S/.test(segment.text));
  if (firstVisible < 0) return normalized.map(() => '');
  let lastVisible = segments.length - 1;
  while (lastVisible > firstVisible && !/\S/.test(segments[lastVisible]!.text)) {
    lastVisible -= 1;
  }

  const result = normalized.map(() => '');
  let previousLeftEnvelope = '';
  let previousKeepEnd = 0;
  for (let index = firstVisible; index <= lastVisible; index += 1) {
    const seg = segments[index]!;
    let current = seg.text;
    let rightEnvelope = '';
    if (index > 0) {
      const splitRight = splitRightEnvelopeWhitespace(current);
      rightEnvelope = splitRight.envelope;
      current = splitRight.rest;
    }
    const keepStart = seg.start + rightEnvelope.length;
    let leftEnvelope = '';
    let keepEnd = seg.end;
    if (index < segments.length - 1) {
      const splitLeft = splitLeftEnvelopeWhitespace(current);
      leftEnvelope = splitLeft.envelope;
      keepEnd = keepStart + splitLeft.rest.length;
    }
    if (index > firstVisible) {
      const gap = joinInternalEnvelopeGap(previousLeftEnvelope, rightEnvelope);
      if (gap) {
        const ownerIndex = previousKeepEnd > 0 ? fragmentIndexForOffset(previousKeepEnd - 1) : 0;
        result[ownerIndex] += gap;
      }
    }
    for (let fragIndex = 0; fragIndex < normalized.length; fragIndex += 1) {
      const sliceStart = Math.max(startOffsets[fragIndex]!, keepStart);
      const sliceEnd = Math.min(endOffsets[fragIndex]!, keepEnd);
      if (sliceEnd > sliceStart) {
        result[fragIndex] += joined.slice(sliceStart, sliceEnd);
      }
    }
    previousLeftEnvelope = leftEnvelope;
    previousKeepEnd = keepEnd;
  }

  return stripCodexAppDirectivesFromFragments(result);
}

function isCodexInjectedContextMessage(value: unknown): boolean {
  const text = normalizeCodexTranscriptText(value);
  return Boolean(text) && !stripCodexInternalContextBlocks(text);
}

function isCodexContextCompactionMessage(value: unknown): boolean {
  const text = normalizeCodexTranscriptText(value);
  if (!text) return false;
  return /^\*?Context compacted(?: to fit the model's context window)?\.?\*?$/i.test(text)
    || /^(?:#{1,3}\s*)?(?:\*{1,2}|_{1,2})?Handoff Summary(?:\*{1,2}|_{1,2})?(?:[ \t]*:|[ \t]*(?:\n|$))/i.test(text)
    || /^Another language model started to solve this problem and produced a summary\b/i.test(text);
}

export {
  MAX_CODEX_INLINE_VISUALIZATION_BUFFER_BYTES,
  heartbeatAssistantMessage,
  heartbeatUserMessage,
  isCodexContextCompactionMessage,
  isCodexInjectedContextMessage,
  parseHeartbeatEnvelope,
  codexInlineVisualizationDirectives,
  consumeCodexInlineVisualizationStream,
  createCodexInlineVisualizationStreamState,
  stripCodexAppDirectives,
  stripCodexInternalContextBlocks,
  stripCodexInternalContextBlocksFromFragments,
};
