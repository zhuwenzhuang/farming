interface HeartbeatEnvelope {
  automationId: string;
  currentTimeIso: string;
  instructions: string;
  decision: string;
  message: string;
}

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
  return String(value || '').replace(
    /::(?:code-comment|created-thread|git-(?:stage|commit|create-branch|push|create-pr))\{[^\r\n]*\}/gi,
    '',
  );
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
  stripCodexAppDirectives,
  stripCodexInternalContextBlocks,
};
