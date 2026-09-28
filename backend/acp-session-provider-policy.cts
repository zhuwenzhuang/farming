import { visibleUserMessageText } from './codex-transcript.cjs';
import {
  isCodexContextCompactionMessage,
  isCodexInjectedContextMessage,
  parseHeartbeatEnvelope,
  stripCodexInternalContextBlocks,
} from './codex-transcript-sanitizer.cjs';
import type { AcpEntry, AcpUpdate } from './acp-session-state.cjs';

type InternalUserScope = 'entry' | 'turn' | null;

interface AcpSessionProviderPolicy {
  contextCompactionText(content: unknown): boolean;
  isInternalEntry(entries: AcpEntry[], targetEntry: AcpEntry | null | undefined): boolean;
  isMirroredUserMessage(
    existing: AcpEntry | null | undefined,
    update: AcpUpdate,
    role: string,
    type: string,
  ): boolean;
  isMirroredAssistantMessage(
    existing: AcpEntry | null | undefined,
    update: AcpUpdate,
    role: string,
    type: string,
  ): boolean;
  messagePhase(entryOrUpdate: AcpEntry | AcpUpdate | null | undefined): string;
  normalizeUpdate(update: AcpUpdate): AcpUpdate;
  sanitizeEntries(entries: AcpEntry[], sourceEntries: AcpEntry[], safeStart: number): AcpEntry[];
  transcriptTurnStart(entry: AcpEntry | null | undefined): boolean;
}

function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text')
    .map(block => String(block.text || ''))
    .join('');
}

function isSteerMessage(entry: AcpEntry | null | undefined): boolean {
  return entry?.type === 'message'
    && entry.role === 'user'
    && (
      entry?._meta?.farming?.steer === true
      || entry?._meta?.codex?.steer === true
    );
}

function genericTranscriptTurnStart(entry: AcpEntry | null | undefined): boolean {
  return entry?.type === 'message'
    && entry.role === 'user'
    && !isSteerMessage(entry);
}

function codexInternalUserScope(entry: AcpEntry | null | undefined): InternalUserScope {
  if (entry?.type !== 'message' || entry.role !== 'user') return null;
  const hasAttachment = (entry.content || []).some(content => content.type !== 'text');
  if (hasAttachment) return null;
  const text = contentText(entry.content);
  if (!isCodexInjectedContextMessage(text)) return null;
  return parseHeartbeatEnvelope(text) ? 'turn' : 'entry';
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readAirMetadata(entryOrUpdate: AcpEntry | AcpUpdate | null | undefined): Record<string, unknown> | null {
  const jetbrains = dataRecord(entryOrUpdate?._meta?.jetbrains);
  const air = dataRecord(jetbrains?.air);
  return air?.version === 1 ? air : null;
}

function normalizeAirUpdate(update: AcpUpdate): AcpUpdate {
  const air = readAirMetadata(update);
  if (!air) return update;
  const metadata = { ...update._meta };
  if (Object.prototype.hasOwnProperty.call(air, 'goal')) metadata.goal = air.goal;
  if (dataRecord(air.contextCompaction)?.version === 1) {
    metadata.contextCompaction = true;
    if (update.sessionUpdate === 'agent_message_chunk') metadata.context_compaction = {};
  }
  return { ...update, _meta: metadata };
}

function normalizeCodexUpdate(update: AcpUpdate): AcpUpdate {
  const normalized = normalizeAirUpdate(update);
  const phase = readAirMetadata(update)?.phase;
  if (phase !== 'commentary' && phase !== 'final_answer') return normalized;
  return {
    ...normalized,
    _meta: { ...normalized._meta, codex: { ...normalized._meta?.codex, phase } },
  };
}

function codexMessagePhase(entryOrUpdate: AcpEntry | AcpUpdate | null | undefined): string {
  const phase = readAirMetadata(entryOrUpdate)?.phase;
  return phase === 'commentary' || phase === 'final_answer'
    ? phase
    : String(entryOrUpdate?._meta?.codex?.phase || '');
}

function isCodexMirroredAssistantMessage(
  existing: AcpEntry | null | undefined,
  update: AcpUpdate,
  role: string,
  type: string,
): boolean {
  if (role !== 'assistant' || type !== 'message') return false;
  if (!existing || existing.type !== type || existing.role !== role) return false;
  if (codexMessagePhase(existing) !== codexMessagePhase(update)) return false;
  const existingId = String(existing.messageId || '');
  const incomingId = String(update?.messageId || '');
  // The App Server thread item has an id while the JSONL response-item
  // fallback does not. If both have ids, keep distinct protocol messages.
  if (existingId && incomingId) return false;
  const existingText = stripCodexInternalContextBlocks(contentText(existing.content));
  const incomingText = stripCodexInternalContextBlocks(contentText([update?.content]));
  return Boolean(existingText) && existingText === incomingText;
}

function isCodexMirroredUserMessage(
  existing: AcpEntry | null | undefined,
  update: AcpUpdate,
  role: string,
  type: string,
): boolean {
  if (role !== 'user' || type !== 'message') return false;
  if (!existing || existing.type !== type || existing.role !== role) return false;
  if (update?._meta?.farming?.steer === true || update?._meta?.codex?.steer === true) return false;
  if (String(update.messageId || '')) return false;
  const renderedAttachmentKinds = (existing.content || [])
    .filter(content => content?.type === 'image')
    .map(() => 'image');
  if (renderedAttachmentKinds.length === 0 || update.content?.type !== 'text') return false;
  const incomingText = contentText([update.content]);
  return Boolean(incomingText) && visibleUserMessageText(incomingText, {
    renderedAttachmentKinds,
  }) === '';
}

function sanitizeCodexEntries(
  entries: AcpEntry[],
  sourceEntries: AcpEntry[],
  safeStart: number,
): AcpEntry[] {
  let internalTurn = false;
  for (let index = 0; index < safeStart; index += 1) {
    const entry = sourceEntries[index];
    if (entry?.type !== 'message' || entry.role !== 'user') continue;
    const scope = codexInternalUserScope(entry);
    if (scope === 'turn') internalTurn = true;
    else if (scope === null) internalTurn = false;
  }
  for (const entry of entries) {
    delete entry.internalScope;
    if (entry.type === 'message' && entry.role === 'user') {
      const scope = codexInternalUserScope(entry);
      if (scope === 'turn') internalTurn = true;
      else if (scope === null) internalTurn = false;
      entry.internal = scope === 'entry' || internalTurn;
      if (scope) entry.internalScope = scope;
    } else {
      entry.internal = internalTurn;
      if (internalTurn) entry.internalScope = 'turn';
    }
    if (!['message', 'thought'].includes(entry.type as string)) continue;
    const renderedAttachmentKinds = [];
    if (
      entry.type === 'message'
      && entry.role === 'user'
      && (entry.content || []).some(content => content?.type === 'image')
    ) {
      renderedAttachmentKinds.push('image');
    }
    for (const content of entry.content || []) {
      if (content.type !== 'text') continue;
      content.text = entry.type === 'message' && entry.role === 'user' && entry.internal !== true
        ? visibleUserMessageText(content.text, { renderedAttachmentKinds })
        : stripCodexInternalContextBlocks(content.text);
    }
  }
  return entries;
}

function isCodexInternalEntry(
  entries: AcpEntry[],
  targetEntry: AcpEntry | null | undefined,
): boolean {
  if (!targetEntry) return false;
  let internalTurn = false;
  for (const entry of entries) {
    if (entry.type === 'message' && entry.role === 'user') {
      const scope = codexInternalUserScope(entry);
      if (scope === 'turn') internalTurn = true;
      else if (scope === null) internalTurn = false;
      if (entry === targetEntry) return scope === 'entry' || internalTurn;
    }
    if (entry === targetEntry) return internalTurn;
  }
  return false;
}

const DEFAULT_ACP_SESSION_PROVIDER_POLICY: AcpSessionProviderPolicy = {
  contextCompactionText: () => false,
  isInternalEntry: () => false,
  isMirroredUserMessage: () => false,
  isMirroredAssistantMessage: () => false,
  messagePhase: () => '',
  normalizeUpdate: update => update,
  sanitizeEntries: entries => entries,
  transcriptTurnStart: genericTranscriptTurnStart,
};

const ACP_SESSION_PROVIDER_POLICIES: Readonly<Record<string, AcpSessionProviderPolicy>> = {
  claude: { ...DEFAULT_ACP_SESSION_PROVIDER_POLICY, normalizeUpdate: normalizeAirUpdate },
  codex: {
    contextCompactionText: content => isCodexContextCompactionMessage(contentText(content)),
    isInternalEntry: isCodexInternalEntry,
    isMirroredUserMessage: isCodexMirroredUserMessage,
    isMirroredAssistantMessage: isCodexMirroredAssistantMessage,
    messagePhase: codexMessagePhase,
    normalizeUpdate: normalizeCodexUpdate,
    sanitizeEntries: sanitizeCodexEntries,
    transcriptTurnStart: entry => genericTranscriptTurnStart(entry) && codexInternalUserScope(entry) !== 'entry',
  },
};

function acpSessionProviderPolicy(provider: unknown): Readonly<AcpSessionProviderPolicy> {
  return ACP_SESSION_PROVIDER_POLICIES[String(provider || '').trim().toLowerCase()]
    || DEFAULT_ACP_SESSION_PROVIDER_POLICY;
}

export { acpSessionProviderPolicy };
export type { AcpSessionProviderPolicy };
