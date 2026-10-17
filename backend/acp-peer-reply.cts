/** Extract the last assistant text in the exact admitted turn, never a notification summary. */
export function acpPeerReplyText(entries: readonly unknown[], inputEntryId: string): string {
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const start = entries.findIndex(entry => isRecord(entry) && entry.id === inputEntryId);
  if (start < 0) throw new Error('Peer request transcript anchor is unavailable');
  for (let index = entries.length - 1; index > start; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== 'message' || entry.role !== 'assistant' || entry.internal === true || entry.sessionMessage === true || !Array.isArray(entry.content)) continue;
    const text = entry.content.filter(isRecord).filter(part => part.type === 'text')
      .map(part => typeof part.text === 'string' ? part.text : '').join('');
    if (text) return text;
  }
  return '';
}
