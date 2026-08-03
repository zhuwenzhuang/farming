'use strict';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function agentNotificationSummary(value: unknown, limit = 240): string {
  const normalized = String(value || '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[^\n]*/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`]+/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|[-+>])\s+/gm, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(normalized);
  if (characters.length <= limit) return normalized;
  const prefix = characters.slice(0, limit).join('');
  const sentence = prefix.match(/^(.{40,220}?[。！？.!?])(?:\s|$)/u)?.[1];
  return sentence || `${characters.slice(0, limit - 1).join('')}…`;
}

function acpLastAssistantNotificationSummary(transcript: unknown): string {
  if (!isRecord(transcript) || !Array.isArray(transcript.entries)) return '';
  for (let index = transcript.entries.length - 1; index >= 0; index -= 1) {
    const entry = transcript.entries[index];
    if (
      !isRecord(entry)
      || entry.type !== 'message'
      || entry.role !== 'assistant'
      || entry.internal === true
      || !Array.isArray(entry.content)
    ) continue;
    const text = entry.content
      .filter(isRecord)
      .filter(content => content.type === 'text')
      .map(content => String(content.text || ''))
      .join(' ');
    const summary = agentNotificationSummary(text);
    if (summary) return summary;
  }
  return '';
}

function acpTurnHandleIsNewer(candidate: unknown, current: unknown): boolean {
  const next = String(candidate || '');
  const previous = String(current || '');
  if (!next || next === previous) return false;
  if (!previous) return true;
  const nextSeparator = next.lastIndexOf(':');
  const previousSeparator = previous.lastIndexOf(':');
  if (nextSeparator <= 0 || previousSeparator <= 0) return true;
  const nextEpoch = next.slice(0, nextSeparator);
  const previousEpoch = previous.slice(0, previousSeparator);
  if (nextEpoch !== previousEpoch) return true;
  const nextSequence = Number(next.slice(nextSeparator + 1));
  const previousSequence = Number(previous.slice(previousSeparator + 1));
  if (!Number.isSafeInteger(nextSequence) || !Number.isSafeInteger(previousSequence)) return true;
  return nextSequence > previousSequence;
}

export { acpLastAssistantNotificationSummary, acpTurnHandleIsNewer, agentNotificationSummary };
