function normalizeCodexTranscriptText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripXmlishBlock(text, tagName) {
  const escapedTag = escapeRegExp(tagName);
  return text.replace(new RegExp(`(^|\\n)\\s*<${escapedTag}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escapedTag}>\\s*(?=\\n|$)`, 'gi'), '$1');
}

function xmlishTagValue(text, tagName) {
  const escapedTag = escapeRegExp(tagName);
  const match = String(text || '').match(new RegExp(`<${escapedTag}(?:\\s+[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i'));
  return match ? normalizeCodexTranscriptText(match[1]) : '';
}

function parseHeartbeatEnvelope(value) {
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

function heartbeatUserMessage(value) {
  const heartbeat = parseHeartbeatEnvelope(value);
  if (!heartbeat) return '';
  return [
    'Automation heartbeat',
    heartbeat.automationId,
    heartbeat.currentTimeIso,
  ].filter(Boolean).join(' · ');
}

function heartbeatAssistantMessage(value) {
  const heartbeat = parseHeartbeatEnvelope(value);
  if (!heartbeat) return '';
  if (heartbeat.decision && heartbeat.decision.toUpperCase() === 'DONT_NOTIFY') return '';
  return heartbeat.message || '';
}

function stripCodexInternalContextBlocks(value) {
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

  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isCodexInjectedContextMessage(value) {
  const text = normalizeCodexTranscriptText(value);
  return Boolean(text) && !stripCodexInternalContextBlocks(text);
}

module.exports = {
  heartbeatAssistantMessage,
  heartbeatUserMessage,
  isCodexInjectedContextMessage,
  parseHeartbeatEnvelope,
  stripCodexInternalContextBlocks,
};
