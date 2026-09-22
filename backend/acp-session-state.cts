const MAX_ACP_UPDATES = 2_000;
const MAX_ACP_UPDATE_LOG_VALUE_CHARS = 32 * 1024;
const MAX_CODEX_SUBAGENTS = 128;
const MAX_CODEX_SUBAGENT_ID_CHARS = 160;
const MAX_CODEX_SUBAGENT_NAME_CHARS = 120;
import { createHash } from 'node:crypto';
import { acpSessionProviderPolicy } from './acp-session-provider-policy.cjs';

type DataRecord = Record<string, unknown>;

interface AcpContent extends DataRecord {
  type?: unknown;
  text?: unknown;
}

interface AcpMeta extends DataRecord {
  farming?: {
    steer?: unknown;
    turnId?: unknown;
  };
  codex?: {
    phase?: unknown;
    steer?: unknown;
    subagents?: unknown;
  };
  context_compaction?: {
    summary?: unknown;
    id?: unknown;
    status?: unknown;
  };
  contextCompaction?: unknown;
  subagent_session_info?: {
    session_id?: unknown;
  };
  farming_patch_decisions?: Record<string, unknown>;
}

export interface AcpEntry extends DataRecord {
  id?: unknown;
  type?: unknown;
  role?: unknown;
  messageId?: unknown;
  optimistic?: unknown;
  content?: AcpContent[];
  _meta?: AcpMeta;
  _revision?: unknown;
  turnStartedAt?: unknown;
  turnCompletedAt?: unknown;
  turnDurationMs?: unknown;
  status?: unknown;
  title?: unknown;
  rawOutput?: unknown;
  lastActivityAt?: unknown;
  plan?: unknown;
  internal?: boolean;
  internalScope?: 'entry' | 'turn';
}

export interface AcpUpdate extends DataRecord {
  sessionUpdate?: unknown;
  toolCallId?: unknown;
  messageId?: unknown;
  content?: AcpContent;
  _meta?: AcpMeta;
  compactionId?: unknown;
  id?: unknown;
  entries?: unknown;
  plan?: unknown;
  availableCommands?: unknown;
  currentModeId?: unknown;
  configOptions?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  status?: unknown;
  summary?: unknown;
}

export interface AcpSessionSnapshot extends DataRecord {
  entries: AcpEntry[];
  sessionId: string;
}

interface AcpPromptSuggestion {
  text: string;
  promptId: string;
}

interface AcpNotification {
  sessionId?: unknown;
  update?: unknown;
}

interface AcpApplyOptions {
  receivedAt?: number | null;
}

interface AcpSessionStateOptions {
  provider?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  maxUpdates?: number;
  revisionBase?: unknown;
  resetBeforeRevision?: unknown;
}

interface AcceptedSteerOptions {
  messageId?: unknown;
  turnId?: unknown;
  insertionIndex?: unknown;
}

export interface TranscriptSliceOptions {
  entryPatches?: boolean;
  cursor?: string;
  maxTurns?: unknown;
  sinceRevision?: unknown;
}

interface SanitizedEntriesOptions {
  endIndex?: number;
  forTranscript?: boolean;
}

export interface SnapshotOptions {
  includeEntries?: boolean;
  includeUpdates?: boolean;
}

interface CodexSubagent {
  threadId: string;
  parentThreadId: string | null;
  name?: string;
  status: string;
}

interface CodexSubagentUpdate {
  version: 1;
  rootThreadId: string;
  revision: number;
  kind: 'delta' | 'snapshot';
  agents: CodexSubagent[];
}

interface CodexSubagents {
  version: 1;
  rootThreadId: string;
  revision: number;
  agents: CodexSubagent[];
}

export interface AcpUpdateLog {
  sequence: number;
  at: string;
  update: unknown;
}

interface AcpCheckpoint extends DataRecord {
  version?: unknown;
  provider?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  sequence?: unknown;
  revision?: unknown;
  resetBeforeRevision?: unknown;
  entries?: unknown;
  activePlanEntryId?: unknown;
  plan?: unknown;
  usage?: unknown;
  availableCommands?: unknown;
  currentModeId?: unknown;
  configOptions?: unknown;
  title?: unknown;
  updatedAt?: unknown;
  codexSubagents?: unknown;
  truncated?: unknown;
}

function clone<T>(value: T): T {
  return value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T;
}

function boundedSubagentId(value: unknown): string {
  return String(value || '').trim().slice(0, MAX_CODEX_SUBAGENT_ID_CHARS);
}

function normalizeCodexSubagentStatus(value: unknown): string {
  const status = String(value || '');
  return [
    'pendingInit',
    'running',
    'completed',
    'interrupted',
    'errored',
    'shutdown',
    'notFound',
  ].includes(status) ? status : '';
}

function normalizeCodexSubagentUpdate(
  raw: unknown,
  sessionId: string,
): CodexSubagentUpdate | null {
  const source = raw && typeof raw === 'object' ? raw as DataRecord : null;
  if (!source || source.version !== 1 || !Array.isArray(source.agents)) return null;
  const rootThreadId = boundedSubagentId(source.rootThreadId);
  if (!rootThreadId || rootThreadId !== sessionId) return null;
  const agents: CodexSubagent[] = [];
  const seen = new Set<string>();
  for (const candidateValue of source.agents.slice(0, MAX_CODEX_SUBAGENTS)) {
    const candidate = candidateValue && typeof candidateValue === 'object'
      ? candidateValue as DataRecord
      : null;
    const threadId = boundedSubagentId(candidate?.threadId);
    const status = normalizeCodexSubagentStatus(candidate?.status);
    if (!threadId || threadId === rootThreadId || !status || seen.has(threadId)) continue;
    seen.add(threadId);
    const parentThreadId = boundedSubagentId(candidate?.parentThreadId);
    const name = String(candidate?.name || '').trim().slice(0, MAX_CODEX_SUBAGENT_NAME_CHARS);
    agents.push({
      threadId,
      parentThreadId: parentThreadId && parentThreadId !== threadId ? parentThreadId : null,
      ...(name ? { name } : {}),
      status,
    });
  }
  return {
    version: 1,
    rootThreadId,
    revision: Number.isFinite(Number(source.revision))
      ? Math.max(0, Math.floor(Number(source.revision)))
      : 0,
    kind: source.kind === 'delta' ? 'delta' : 'snapshot',
    agents,
  };
}

function compactUpdateForLog(update: AcpUpdate): unknown {
  let serialized = '';
  try {
    serialized = JSON.stringify(update);
  } catch {
    return { sessionUpdate: String(update?.sessionUpdate || ''), truncated: true };
  }
  if (serialized.length <= MAX_ACP_UPDATE_LOG_VALUE_CHARS) return clone(update);
  return {
    sessionUpdate: String(update?.sessionUpdate || ''),
    toolCallId: String(update?.toolCallId || ''),
    messageId: String(update?.messageId || ''),
    truncated: true,
    originalChars: serialized.length,
  };
}

function appendContent(blocks: AcpContent[], content: unknown): void {
  if (!content || typeof content !== 'object') return;
  const next = clone(content) as AcpContent;
  const previous = blocks[blocks.length - 1];
  if (previous?.type === 'text' && next.type === 'text') {
    previous.text = `${previous.text || ''}${next.text || ''}`;
    return;
  }
  blocks.push(next);
}

function canMergeMessageIds(existing: unknown, incoming: unknown): boolean {
  return !existing || !incoming || existing === incoming;
}

function canMergeMessageChunks(
  provider: string,
  existing: AcpEntry | null | undefined,
  update: AcpUpdate,
): boolean {
  const existingId = String(existing?.messageId || '');
  const incomingId = String(update?.messageId || '');
  // A user Prompt and a later Steer are separate mutations even when the
  // optimistic Prompt has not received a provider id yet. The exact-content
  // reconciliation above owns that one missing-id case; adjacency must not.
  if (existing?.role === 'user') {
    return Boolean(existingId && incomingId && existingId === incomingId);
  }
  if (!canMergeMessageIds(existing?.messageId, String(update?.messageId || ''))) return false;
  const policy = acpSessionProviderPolicy(provider);
  return policy.messagePhase(existing) === policy.messagePhase(update);
}

interface ForkOrigin {
  sourceSessionId: string;
  userTurnCount: number;
  userPrefixHash: string;
}

class AcpSessionState {
  private entryIds = new Set<string>();
  provider: string;
  sessionId: string;
  cwd: string;
  maxUpdates: number;
  entries: AcpEntry[];
  updates: AcpUpdateLog[];
  toolEntries: Map<string, AcpEntry>;
  compactionEntries: Map<string, AcpEntry>;
  activePlanEntry: AcpEntry | null;
  plan: unknown;
  usage: unknown;
  availableCommands: unknown[];
  currentModeId: string;
  configOptions: unknown[];
  title: string;
  updatedAt: string;
  promptSuggestion: AcpPromptSuggestion | null;
  codexSubagents: CodexSubagents | null;
  truncated: boolean;
  sequence: number;
  revision: number;
  resetBeforeRevision: number;
  forkOrigin: ForkOrigin | null = null;
  forkOriginAnchor: { status: 'ready' | 'unavailable'; afterEntryId: string } | null = null;

  constructor(options: AcpSessionStateOptions = {}) {
    this.provider = String(options.provider || '');
    this.sessionId = String(options.sessionId || '');
    this.cwd = String(options.cwd || '');
    this.maxUpdates = Number.isFinite(options.maxUpdates)
      ? Math.max(1, Math.floor(Number(options.maxUpdates)))
      : MAX_ACP_UPDATES;
    // ACP history replay and live session/update notifications both reduce
    // into this one ordered entry stream. There is deliberately no synthetic
    // turn model here.
    this.entries = [];
    this.updates = [];
    this.toolEntries = new Map();
    this.compactionEntries = new Map();
    this.activePlanEntry = null;
    this.plan = null;
    this.usage = null;
    this.availableCommands = [];
    this.currentModeId = '';
    this.configOptions = [];
    this.title = '';
    this.updatedAt = '';
    this.promptSuggestion = null;
    this.codexSubagents = null;
    this.truncated = false;
    this.sequence = 0;
    this.revision = Number.isFinite(Number(options.revisionBase))
      ? Math.max(0, Math.floor(Number(options.revisionBase)))
      : 0;
    this.resetBeforeRevision = Number.isFinite(Number(options.resetBeforeRevision))
      ? Math.max(0, Math.floor(Number(options.resetBeforeRevision)))
      : 0;
  }

  setSessionId(sessionId: unknown): void {
    this.sessionId = String(sessionId || this.sessionId);
  }

  static fromCheckpoint(
    checkpoint: unknown,
    options: AcpSessionStateOptions = {},
  ): AcpSessionState | null {
    const source = checkpoint && typeof checkpoint === 'object'
      ? checkpoint as AcpCheckpoint
      : null;
    if (!source || source.version !== 1 || !Array.isArray(source.entries)) return null;
    const state = new AcpSessionState({
      provider: options.provider || source.provider,
      sessionId: options.sessionId || source.sessionId,
      cwd: options.cwd || source.cwd,
      maxUpdates: options.maxUpdates,
      revisionBase: source.revision,
      resetBeforeRevision: source.resetBeforeRevision,
    });
    state.entries = clone(source.entries) as AcpEntry[];
    state.toolEntries.clear();
    state.compactionEntries.clear();
    let maximumRevision = 0;
    for (const entry of state.entries) {
      maximumRevision = Math.max(maximumRevision, Number(entry?._revision || 0));
      if (entry?.type === 'tool' && entry.id) state.toolEntries.set(String(entry.id), entry);
      if (entry?.type === 'compaction' && entry.id) state.compactionEntries.set(String(entry.id), entry);
    }
    state.revision = Math.max(state.revision, maximumRevision);
    state.sequence = Math.max(0, Math.floor(Number(source.sequence || 0)));
    // Older checkpoints could reuse a provider message id after a Steer/tool
    // split. Preserve both ordered segments, but invalidate old delta cursors.
    let repaired = false;
    for (const entry of state.entries) {
      const id = String(entry.id || '');
      if ((entry.type === 'message' || entry.type === 'thought') && state.entryIds.has(id)) {
        entry.id = state.uniqueMessageEntryId(id, String(entry.type));
        state.touchEntry(entry);
        repaired = true;
      }
      state.entryIds.add(String(entry.id));
    }
    if (repaired) state.resetBeforeRevision = state.revision;
    state.activePlanEntry = source.activePlanEntryId
      ? state.entries.find(entry => entry?.id === source.activePlanEntryId) || null
      : null;
    state.plan = clone(source.plan ?? state.activePlanEntry?.plan ?? null);
    state.usage = clone(source.usage ?? null);
    state.availableCommands = clone(source.availableCommands || []) as unknown[];
    state.currentModeId = String(source.currentModeId || '');
    state.configOptions = clone(source.configOptions || []) as unknown[];
    state.title = String(source.title || '');
    state.updatedAt = String(source.updatedAt || '');
    state.codexSubagents = clone(source.codexSubagents ?? null) as CodexSubagents | null;
    state.truncated = source.truncated === true;
    state.restoreForkOrigin(source.forkOrigin);
    return state;
  }

  private forkUserTurns(): AcpEntry[] {
    const policy = acpSessionProviderPolicy(this.provider);
    const users = clone(this.entries.filter(entry => entry.type === 'message' && entry.role === 'user'));
    return policy.sanitizeEntries(users, this.entries, 0)
      .filter(entry => policy.transcriptTurnStart(entry) && !entry.internal);
  }

  private forkPrefixHash(turns: AcpEntry[]): string {
    // Provider replays may regenerate entry/tool IDs. Verify the ordered user
    // prefix before rebinding the immutable boundary to this replay's IDs.
    return createHash('sha256').update(JSON.stringify(turns.map(entry => entry.content || []))).digest('hex');
  }

  captureForkOrigin(sourceSessionId: string): void {
    const turns = this.forkUserTurns();
    this.restoreForkOrigin({
      sourceSessionId,
      userTurnCount: turns.length,
      userPrefixHash: this.forkPrefixHash(turns),
    });
  }

  restoreForkOrigin(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const origin = value as Partial<ForkOrigin>;
    if (typeof origin.sourceSessionId !== 'string' || !origin.sourceSessionId
      || !Number.isSafeInteger(origin.userTurnCount) || Number(origin.userTurnCount) < 0
      || typeof origin.userPrefixHash !== 'string') return;
    this.forkOrigin = {
      sourceSessionId: origin.sourceSessionId,
      userTurnCount: Number(origin.userTurnCount),
      userPrefixHash: origin.userPrefixHash,
    };
    const turns = this.forkUserTurns();
    const count = this.forkOrigin.userTurnCount;
    const verified = turns.length >= count
      && this.forkPrefixHash(turns.slice(0, count)) === this.forkOrigin.userPrefixHash;
    this.forkOriginAnchor = {
      status: verified ? 'ready' : 'unavailable',
      afterEntryId: verified && count > 0 ? String(turns[count - 1].id || '') : '',
    };
  }

  private forkOriginSnapshot() {
    return this.forkOrigin && this.forkOriginAnchor
      ? { sourceSessionId: this.forkOrigin.sourceSessionId, ...this.forkOriginAnchor }
      : null;
  }

  nextEntryId(prefix: string): string {
    let id: string;
    do { id = `${prefix}-${++this.sequence}`; } while (this.entryIds.has(id));
    return id;
  }

  private uniqueMessageEntryId(messageId: string, type: string): string {
    if (messageId && !this.entryIds.has(messageId)) return messageId;
    let id: string;
    do { id = this.nextEntryId(type); } while (this.entryIds.has(id));
    return id;
  }

  pushEntry(entry: AcpEntry): AcpEntry {
    this.entryIds.add(String(entry.id));
    this.touchEntry(entry);
    this.entries.push(entry);
    return entry;
  }

  touchEntry(entry: AcpEntry | null | undefined): number {
    if (!entry) return this.revision;
    entry._revision = ++this.revision;
    return this.revision;
  }

  touchCurrentTurn(): number {
    const entry = this.entries[this.entries.length - 1];
    if (entry) this.touchEntry(entry);
    else this.revision += 1;
    return this.revision;
  }

  setPromptSuggestion(suggestion: AcpPromptSuggestion): boolean {
    if (
      this.promptSuggestion?.promptId === suggestion.promptId
      && this.promptSuggestion.text === suggestion.text
    ) {
      return false;
    }
    this.promptSuggestion = clone(suggestion);
    this.revision += 1;
    return true;
  }

  beginPrompt(prompt: unknown): AcpEntry {
    const content = Array.isArray(prompt)
      ? clone(prompt)
      : [{ type: 'text', text: String(prompt || '') }];
    this.promptSuggestion = null;
    this.activePlanEntry = null;
    this.plan = null;
    const startedAt = Date.now();
    return this.pushEntry({
      id: this.nextEntryId('user'),
      type: 'message',
      role: 'user',
      messageId: '',
      optimistic: true,
      content,
      turnStartedAt: startedAt,
      turnCompletedAt: null,
      turnDurationMs: null,
    });
  }

  recordAcceptedSteer(prompt: unknown, options: AcceptedSteerOptions = {}): boolean {
    const messageId = String(options.messageId || '');
    if (!messageId) return false;
    if (this.entries.some(entry => (
      entry?.type === 'message'
      && entry.role === 'user'
      && entry.messageId === messageId
    ))) return false;
    const content = Array.isArray(prompt)
      ? clone(prompt)
      : [{ type: 'text', text: String(prompt || '') }];
    const entry = {
      id: messageId,
      type: 'message',
      role: 'user',
      messageId,
      optimistic: true,
      content,
      createdAt: Date.now(),
      _meta: {
        farming: {
          steer: true,
          turnId: String(options.turnId || ''),
        },
      },
    };
    this.touchEntry(entry);
    const insertionIndex = Number.isFinite(Number(options.insertionIndex))
      ? Math.max(0, Math.min(this.entries.length, Math.floor(Number(options.insertionIndex))))
      : this.entries.length;
    this.entryIds.add(entry.id);
    this.entries.splice(insertionIndex, 0, entry);
    return true;
  }

  completePrompt(): void {
    this.completeContextCompactionTool();
    this.activePlanEntry = null;
    this.plan = null;
    // Runtime completion changes the visible state of the last turn. Touch the
    // existing entry so delta readers can refresh that turn without inventing
    // a protocol entry boundary.
    const userEntry = this.entries.findLast(entry => entry?.type === 'message' && entry.role === 'user' && entry.turnStartedAt);
    if (userEntry && !userEntry.turnCompletedAt) {
      userEntry.turnCompletedAt = Date.now();
      const startedAt = Number(userEntry.turnStartedAt);
      const completedAt = Number(userEntry.turnCompletedAt);
      userEntry.turnDurationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
        ? Math.max(0, completedAt - startedAt)
        : null;
      this.touchEntry(userEntry);
    } else {
      this.touchCurrentTurn();
    }
  }

  recordError(message: unknown, kind: unknown = 'unknown'): AcpEntry | null {
    const text = String(message || '').trim();
    if (!text) return null;
    return this.pushEntry({
      id: this.nextEntryId('error'),
      type: 'error',
      message: text,
      kind: String(kind || 'unknown'),
      status: 'failed',
    });
  }

  finishHistoryReplay(): void {
    // History replay uses the same reducer as live updates; nothing to close.
  }

  apply(notification: AcpNotification | null | undefined, options: AcpApplyOptions = {}): boolean {
    if (!notification || notification.sessionId !== this.sessionId) return false;
    const update = notification.update as AcpUpdate;
    if (!update || typeof update !== 'object') return false;
    this.updates.push({
      sequence: this.updates.length + 1,
      at: new Date().toISOString(),
      update: compactUpdateForLog(update),
    });
    if (this.updates.length > this.maxUpdates) {
      this.updates.splice(0, this.updates.length - this.maxUpdates);
      this.truncated = true;
    }

    const kind = update.sessionUpdate;
    const receivedAt = options.receivedAt === null
      ? null
      : Number.isFinite(Number(options.receivedAt)) && Number(options.receivedAt) > 0
        ? Number(options.receivedAt)
        : Date.now();
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      this.applyMessageChunk(update, kind);
    } else if (kind === 'tool_call') {
      this.applyToolCall(update, false, receivedAt);
    } else if (kind === 'tool_call_update') {
      this.applyToolCall(update, true, receivedAt);
    } else if (kind === 'plan') {
      this.applyPlan({ type: 'items', entries: clone(update.entries || []) });
    } else if (kind === 'plan_update') {
      this.applyPlan(clone(update.plan));
    } else if (kind === 'plan_removed') {
      this.removePlan();
    } else if (kind === 'context_compaction' || kind === 'context_compaction_update') {
      this.applyCompaction(update);
    } else if (kind === 'usage_update') {
      this.usage = clone(update);
    } else if (kind === 'available_commands_update') {
      this.availableCommands = clone(update.availableCommands || []) as unknown[];
    } else if (kind === 'current_mode_update') {
      this.currentModeId = String(update.currentModeId || '');
    } else if (kind === 'config_option_update') {
      this.configOptions = clone(update.configOptions || []) as unknown[];
    } else if (kind === 'session_info_update') {
      let metadataChanged = false;
      if (Object.prototype.hasOwnProperty.call(update, 'title')) {
        const title = String(update.title || '');
        metadataChanged = metadataChanged || title !== this.title;
        this.title = title;
      }
      if (Object.prototype.hasOwnProperty.call(update, 'updatedAt')) {
        const updatedAt = String(update.updatedAt || '');
        metadataChanged = metadataChanged || updatedAt !== this.updatedAt;
        this.updatedAt = updatedAt;
      }
      const subagentsChanged = this.applyCodexSubagentUpdate(update?._meta?.codex?.subagents);
      if (metadataChanged && !subagentsChanged) this.revision += 1;
    }
    return true;
  }

  applyCodexSubagentUpdate(raw: unknown): boolean {
    const update = normalizeCodexSubagentUpdate(raw, this.sessionId);
    if (!update) return false;
    const agentsById = update.kind === 'delta' && this.codexSubagents?.rootThreadId === update.rootThreadId
      ? new Map(this.codexSubagents.agents.map(agent => [agent.threadId, agent]))
      : new Map();
    for (const agent of update.agents) agentsById.set(agent.threadId, agent);
    this.codexSubagents = {
      version: 1,
      rootThreadId: update.rootThreadId,
      revision: update.revision,
      agents: [...agentsById.values()].slice(0, MAX_CODEX_SUBAGENTS),
    };
    // Session metadata changes are visible transcript state even when no
    // message/tool entry changed. Advance the reducer revision so the existing
    // revision-driven transcript read reconciles this snapshot without polling.
    this.revision += 1;
    return true;
  }

  applyMessageChunk(update: AcpUpdate, kind: unknown): void {
    const providerPolicy = acpSessionProviderPolicy(this.provider);
    const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
    const type = kind === 'agent_thought_chunk' ? 'thought' : 'message';
    const messageId = String(update.messageId || '');
    const last = this.entries[this.entries.length - 1];

    const compactionMeta = update?._meta?.context_compaction;
    if (kind === 'agent_message_chunk' && (providerPolicy.contextCompactionText([update.content]) || compactionMeta)) {
      if (!this.completeContextCompactionTool(compactionMeta?.summary || '')) {
        this.applyCompaction({
          compactionId: compactionMeta?.id || messageId,
          status: compactionMeta?.status || 'completed',
          summary: compactionMeta?.summary || '',
        });
      }
      return;
    }

    if (providerPolicy.isMirroredUserMessage(last, update, role, type)) {
      this.touchEntry(last);
      return;
    }

    // Farming inserts the local prompt optimistically. ACP Agents may echo the
    // same prompt during live updates; attach its protocol id without rendering
    // the user message twice.
    const matchingOptimisticUser = role === 'user' && messageId
      ? this.entries.findLast(entry => (
          entry?.type === 'message'
          && entry.role === 'user'
          && entry.optimistic
          && entry.messageId === messageId
        ))
      : null;
    const optimisticUser = matchingOptimisticUser || (
      role === 'user'
      && last?.type === 'message'
      && last.role === 'user'
      && last.optimistic
      ? last
      : null
    );
    if (
      optimisticUser
      && (optimisticUser.content || []).some(content => JSON.stringify(content) === JSON.stringify(update.content))
    ) {
      if (!optimisticUser.messageId) optimisticUser.messageId = messageId;
      this.touchEntry(optimisticUser);
      return;
    }

    if (
      last?.type === type
      && last.role === role
      && canMergeMessageChunks(this.provider, last, update)
    ) {
      const mirroredAssistantMessage = providerPolicy.isMirroredAssistantMessage(last, update, role, type);
      if (!last.messageId) last.messageId = messageId;
      if (!last._meta && update._meta) last._meta = clone(update._meta);
      if (mirroredAssistantMessage) {
        this.touchEntry(last);
        return;
      }
      appendContent(last.content as AcpContent[], update.content);
      this.touchEntry(last);
      return;
    }

    if (role === 'user') this.activePlanEntry = null;
    this.pushEntry({
      id: this.uniqueMessageEntryId(messageId, type),
      type,
      role,
      messageId,
      content: [],
      ...(update._meta ? { _meta: clone(update._meta) } : {}),
    });
    appendContent(this.entries[this.entries.length - 1].content as AcpContent[], update.content);
  }

  applyToolCall(update: AcpUpdate, isPatch: boolean, receivedAt: number | null): void {
    const id = String(update.toolCallId || '');
    if (!id) return;
    let entry = this.toolEntries.get(id);
    if (!entry) {
      entry = this.pushEntry({
        id,
        type: 'tool',
        title: '',
        kind: 'other',
        status: 'pending',
        content: [],
      });
      this.toolEntries.set(id, entry);
    }
    for (const field of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput', '_meta']) {
      if (!isPatch || Object.prototype.hasOwnProperty.call(update, field)) {
        if (update[field] !== undefined) entry[field] = clone(update[field]);
      }
    }
    if (receivedAt !== null) entry.lastActivityAt = receivedAt;
    this.touchEntry(entry);
  }

  applyCompaction(update: AcpUpdate): void {
    const id = String(update.compactionId || update.id || this.nextEntryId('compaction'));
    let entry = this.compactionEntries.get(id);
    if (!entry) {
      entry = this.pushEntry({ id, type: 'compaction', status: 'in_progress', summary: '' });
      this.compactionEntries.set(id, entry);
    }
    if (Object.prototype.hasOwnProperty.call(update, 'status')) entry.status = String(update.status || 'completed');
    if (Object.prototype.hasOwnProperty.call(update, 'summary')) entry.summary = String(update.summary || '');
    this.touchEntry(entry);
  }

  completeContextCompactionTool(summary: unknown = ''): boolean {
    const entry = this.entries.findLast(candidate => (
      candidate?.type === 'tool'
      && candidate?._meta?.contextCompaction === true
    ));
    if (!entry) return false;
    if (entry.status !== 'completed' || entry.title !== 'Context compacted') {
      entry.status = 'completed';
      entry.title = 'Context compacted';
      if (summary && !entry.rawOutput) entry.rawOutput = { summary: String(summary) };
      this.touchEntry(entry);
    }
    return true;
  }

  applyPlan(plan: unknown): void {
    this.plan = clone(plan);
    if (!this.activePlanEntry) {
      this.activePlanEntry = this.pushEntry({
        id: this.nextEntryId('plan'),
        type: 'plan',
        plan: clone(plan),
      });
      return;
    }
    this.activePlanEntry.plan = clone(plan);
    this.touchEntry(this.activePlanEntry);
  }

  removePlan(): void {
    if (this.activePlanEntry) {
      const index = this.entries.indexOf(this.activePlanEntry);
      if (index >= 0) this.entries.splice(index, 1);
    }
    this.activePlanEntry = null;
    this.plan = null;
    this.touchCurrentTurn();
  }

  transcriptSlice(options: TranscriptSliceOptions = {}) {
    const providerPolicy = acpSessionProviderPolicy(this.provider);
    const maxTurns = Number.isFinite(Number(options.maxTurns))
      ? Math.max(1, Math.floor(Number(options.maxTurns)))
      : 80;
    const requestedRevision = Number(options.sinceRevision);
    const resetRequired = Number.isFinite(requestedRevision) && (
      requestedRevision > this.revision
      || (this.resetBeforeRevision > 0 && requestedRevision <= this.resetBeforeRevision)
    );
    const delta = !options.cursor && Number.isFinite(requestedRevision) && requestedRevision >= 0 && !resetRequired;
    const endIndex = options.cursor ? this.entries.findIndex(entry => entry.id === options.cursor) : this.entries.length;
    if (endIndex < 0) throw new Error('History cursor is no longer available. Return to the latest messages.');
    let startIndex = 0;

    if (options.entryPatches) {
      let remaining = maxTurns;
      startIndex = endIndex;
      while (startIndex > 0 && endIndex - startIndex < 256) {
        startIndex -= 1;
        if (providerPolicy.transcriptTurnStart(this.entries[startIndex]) && --remaining <= 0) break;
      }
      // Keep the owning user prompt as context when a very long turn spans pages.
      let anchor = startIndex;
      while (anchor > 0 && !providerPolicy.transcriptTurnStart(this.entries[anchor])) anchor -= 1;
      const page = this.sanitizedEntries(startIndex, { forTranscript: true, endIndex });
      if (anchor < startIndex && providerPolicy.transcriptTurnStart(this.entries[anchor])) {
        page.unshift(...this.sanitizedEntries(anchor, { forTranscript: true, endIndex: anchor + 1 }));
      }
      const changedIds = delta ? new Set(this.entries.filter(entry => Number(entry._revision || 0) > requestedRevision).map(entry => entry.id)) : null;
      return {
        entries: changedIds ? page.filter(entry => changedIds.has(entry.id)) : page,
        entryPatch: { version: 1, order: page.map(entry => String(entry.id)), pageCursor: options.cursor || null },
        nextCursor: startIndex > 0 ? String(this.entries[startIndex].id) : null,
        forkOrigin: this.forkOriginSnapshot(), revision: this.revision, delta,
        hasMoreBefore: startIndex > 0, codexSubagents: clone(this.codexSubagents),
      };
    }

    if (delta) {
      startIndex = this.entries.findIndex(entry => Number(entry?._revision || 0) > requestedRevision);
      if (startIndex < 0) startIndex = this.entries.length;
      if (startIndex < this.entries.length) {
        while (startIndex > 0) {
          const entry = this.entries[startIndex];
          if (providerPolicy.transcriptTurnStart(entry)) break;
          startIndex -= 1;
        }
      }
    } else {
      let remaining = maxTurns;
      startIndex = endIndex;
      while (startIndex > 0) {
        startIndex -= 1;
        const entry = this.entries[startIndex];
        if (providerPolicy.transcriptTurnStart(entry)) {
          remaining -= 1;
          if (remaining <= 0) break;
        }
      }
    }

    return {
      entries: this.sanitizedEntries(startIndex, { forTranscript: true, endIndex }),
      nextCursor: startIndex > 0 ? String(this.entries[startIndex]?.id || '') : null,
      forkOrigin: this.forkOriginSnapshot(),
      revision: this.revision,
      delta,
      hasMoreBefore: startIndex > 0,
      codexSubagents: clone(this.codexSubagents),
    };
  }

  sanitizedEntries(
    startIndex = 0,
    options: SanitizedEntriesOptions = {},
  ): AcpEntry[] {
    const safeStart = Math.min(this.entries.length, Math.max(0, Math.floor(startIndex)));
    const entries = options.forTranscript === true
      ? this.entries.slice(safeStart, options.endIndex).map(entry => {
        const visible = { ...entry };
        delete visible._revision;
        if (entry.type !== 'tool') return clone(visible);
        // Tool details are read synchronously by the transcript projector and
        // never mutated there. Keep their potentially large protocol payloads
        // by reference so an initial page does not deep-clone megabytes merely
        // to produce a compact summary.
        return visible;
      })
      : clone(this.entries.slice(safeStart, options.endIndex));
    if (options.forTranscript !== true) {
      for (const entry of entries) delete entry._revision;
    }
    return acpSessionProviderPolicy(this.provider).sanitizeEntries(entries, this.entries, safeStart);
  }

  isInternalEntry(targetEntry: AcpEntry | null | undefined): boolean {
    return acpSessionProviderPolicy(this.provider).isInternalEntry(this.entries, targetEntry);
  }

  snapshot(
    extra: DataRecord = {},
    options: SnapshotOptions = {},
  ): AcpSessionSnapshot {
    const entries = options.includeEntries === false ? [] : this.sanitizedEntries(0);
    const snapshot: AcpSessionSnapshot = {
      ...clone(extra),
      version: 2,
      protocol: 'acp',
      provider: this.provider,
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: this.title,
      updatedAt: this.updatedAt || extra.updatedAt || '',
      truncated: this.truncated,
      revision: this.revision,
      entries,
      forkOrigin: this.forkOriginSnapshot(),
      usage: clone(this.usage),
      availableCommands: clone(this.availableCommands),
      currentModeId: this.currentModeId,
      configOptions: clone(this.configOptions),
      promptSuggestion: clone(this.promptSuggestion),
      codexSubagents: clone(this.codexSubagents),
    };
    if (options.includeUpdates === true) snapshot.updates = clone(this.updates);
    return snapshot;
  }

  private readonly checkpointEntries = new WeakMap<AcpEntry, { revision: unknown; json: string }>();

  async exportCheckpointChunks(): Promise<string[]> {
    const revision = this.revision;
    const entries = this.entries.slice();
    const metadata = JSON.stringify(this.exportCheckpoint(false));
    const chunks = [metadata.slice(0, -1), ',"entries":['];
    let batchStarted = performance.now();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      let encoded = this.checkpointEntries.get(entry);
      if (!encoded || encoded.revision !== entry._revision) {
        encoded = { revision: entry._revision, json: JSON.stringify(entry) };
        this.checkpointEntries.set(entry, encoded);
      }
      chunks.push(index ? ',' : '', encoded.json);
      if (performance.now() - batchStarted >= 4) {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (this.revision !== revision) throw new Error('ACP checkpoint changed while encoding');
        batchStarted = performance.now();
      }
    }
    if (this.revision !== revision) throw new Error('ACP checkpoint changed while encoding');
    chunks.push(']}');
    return chunks;
  }

  exportCheckpoint(includeEntries = true) {
    return {
      version: 1,
      provider: this.provider,
      sessionId: this.sessionId,
      cwd: this.cwd,
      sequence: this.sequence,
      revision: this.revision,
      resetBeforeRevision: this.resetBeforeRevision,
      ...(includeEntries ? { entries: clone(this.entries) } : {}),
      forkOrigin: clone(this.forkOrigin),
      activePlanEntryId: this.activePlanEntry?.id || '',
      plan: clone(this.plan),
      usage: clone(this.usage),
      availableCommands: clone(this.availableCommands),
      currentModeId: this.currentModeId,
      configOptions: clone(this.configOptions),
      title: this.title,
      updatedAt: this.updatedAt,
      codexSubagents: clone(this.codexSubagents),
      truncated: this.truncated,
    };
  }
}

export {
  AcpSessionState,
  MAX_ACP_UPDATES,
  MAX_ACP_UPDATE_LOG_VALUE_CHARS,
};
