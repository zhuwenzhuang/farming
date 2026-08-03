interface HeartbeatEnvelope {
  automationId: string;
  currentTimeIso: string;
  instructions: string;
  decision: string;
  message: string;
}

interface CodexInlineVisualizationDirective {
  file: string;
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

function normalizeCodexTranscriptText(value: unknown): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function escapeRegExp(value: unknown): string {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripXmlishBlock(text: string, tagName: string): string {
  const escapedTag = escapeRegExp(tagName);
  return text.replace(new RegExp(`(^|\\n)\\s*<${escapedTag}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>\\s*(?=\\n|$)`, 'gi'), '$1');
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
  if (!trimmed.startsWith(CODEX_INLINE_VISUALIZATION_PREFIX) || !trimmed.endsWith('}')) return '';
  const attributes = trimmed.slice(CODEX_INLINE_VISUALIZATION_PREFIX.length, -1).trim();
  const match = attributes.match(/^file="([^"]+)"$/);
  return String(match?.[1] || '');
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
    if (!trimmed.startsWith(CODEX_INLINE_VISUALIZATION_PREFIX)) {
      text += `${line}${newline}`;
      return;
    }
    const file = directiveFile(line);
    if (file) directives.push({ file });
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
    const couldBecomeDirective = CODEX_INLINE_VISUALIZATION_PREFIX.startsWith(trimmedStart)
      || trimmedStart.startsWith(CODEX_INLINE_VISUALIZATION_PREFIX);
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
    if (trimmedStart.endsWith('}')) {
      const line = state.buffer;
      state.buffer = '';
      consumeLine(line, '');
    }
    break;
  }

  return { directives, text };
}

function stripCodexInternalContextBlocks(value: unknown): string {
  let text = normalizeCodexTranscriptText(value);
  if (!text) return '';

  [
    'codex_internal_context',
    'goal_context',
    'environment_context',
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
  ].forEach(tagName => {
    text = stripXmlishBlock(text, tagName);
  });

  text = text.replace(/(^|\n)\s*# AGENTS\.md instructions for[^\n]*\n[\s\S]*?<\/INSTRUCTIONS>\s*(?=\n|$)/gi, '$1');
  text = stripCodexAppDirectives(text);

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
};
