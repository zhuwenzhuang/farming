const MAX_ACP_UPDATES = 2_000;
const MAX_ACP_UPDATE_LOG_VALUE_CHARS = 32 * 1024;
const MAX_CODEX_SUBAGENTS = 128;
const MAX_CODEX_SUBAGENT_ID_CHARS = 160;
const MAX_CODEX_SUBAGENT_NAME_CHARS = 120;
const {
  visibleUserMessageText,
} = require('./codex-transcript');
const {
  isCodexContextCompactionMessage,
  isCodexInjectedContextMessage,
  stripCodexInternalContextBlocks,
} = require('./codex-transcript-sanitizer');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function boundedSubagentId(value) {
  return String(value || '').trim().slice(0, MAX_CODEX_SUBAGENT_ID_CHARS);
}

function normalizeCodexSubagentStatus(value) {
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

function normalizeCodexSubagentUpdate(raw, sessionId) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.agents)) return null;
  const rootThreadId = boundedSubagentId(raw.rootThreadId);
  if (!rootThreadId || rootThreadId !== sessionId) return null;
  const agents = [];
  const seen = new Set();
  for (const candidate of raw.agents.slice(0, MAX_CODEX_SUBAGENTS)) {
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
    revision: Number.isFinite(Number(raw.revision))
      ? Math.max(0, Math.floor(Number(raw.revision)))
      : 0,
    kind: raw.kind === 'delta' ? 'delta' : 'snapshot',
    agents,
  };
}

function compactUpdateForLog(update) {
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

function appendContent(blocks, content) {
  if (!content || typeof content !== 'object') return;
  const next = clone(content);
  const previous = blocks[blocks.length - 1];
  if (previous?.type === 'text' && next.type === 'text') {
    previous.text = `${previous.text || ''}${next.text || ''}`;
    return;
  }
  blocks.push(next);
}

function contentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text')
    .map(block => String(block.text || ''))
    .join('');
}

function isCodexSteerMessage(entry) {
  return entry?.type === 'message'
    && entry.role === 'user'
    && entry?._meta?.codex?.steer === true;
}

function isContextCompactionText(content) {
  return isCodexContextCompactionMessage(contentText(content));
}

function canMergeMessageIds(existing, incoming) {
  return !existing || !incoming || existing === incoming;
}

function codexMessagePhase(meta) {
  return String(meta?.codex?.phase || '');
}

function canMergeMessageChunks(existing, update) {
  if (!canMergeMessageIds(existing?.messageId, String(update?.messageId || ''))) return false;
  // Codex ACP history can omit message ids while still preserving the original
  // commentary/final-answer boundary in metadata. Never merge across that
  // boundary or the frontend loses the only authoritative answer signal.
  return codexMessagePhase(existing?._meta) === codexMessagePhase(update?._meta);
}

function isCodexMirroredAssistantMessage(provider, existing, update, role, type) {
  if (provider !== 'codex' || role !== 'assistant' || type !== 'message') return false;
  if (!existing || existing.type !== type || existing.role !== role) return false;
  if (codexMessagePhase(existing._meta) !== codexMessagePhase(update?._meta)) return false;
  const existingId = String(existing.messageId || '');
  const incomingId = String(update?.messageId || '');
  // The App Server thread item has an id while the JSONL response-item
  // fallback does not. If both have ids, keep them as distinct protocol
  // messages even when their visible text happens to match.
  if (existingId && incomingId) return false;
  const existingText = stripCodexInternalContextBlocks(contentText(existing.content));
  const incomingText = stripCodexInternalContextBlocks(contentText([update?.content]));
  return Boolean(existingText) && existingText === incomingText;
}

class AcpSessionState {
  constructor(options = {}) {
    this.provider = String(options.provider || '');
    this.sessionId = String(options.sessionId || '');
    this.cwd = String(options.cwd || '');
    this.maxUpdates = Number.isFinite(options.maxUpdates)
      ? Math.max(1, Math.floor(options.maxUpdates))
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

  setSessionId(sessionId) {
    this.sessionId = String(sessionId || this.sessionId);
  }

  static fromCheckpoint(checkpoint, options = {}) {
    if (!checkpoint || checkpoint.version !== 1 || !Array.isArray(checkpoint.entries)) return null;
    const state = new AcpSessionState({
      provider: options.provider || checkpoint.provider,
      sessionId: options.sessionId || checkpoint.sessionId,
      cwd: options.cwd || checkpoint.cwd,
      maxUpdates: options.maxUpdates,
      revisionBase: checkpoint.revision,
      resetBeforeRevision: checkpoint.resetBeforeRevision,
    });
    state.entries = clone(checkpoint.entries);
    state.toolEntries.clear();
    state.compactionEntries.clear();
    let maximumRevision = 0;
    for (const entry of state.entries) {
      maximumRevision = Math.max(maximumRevision, Number(entry?._revision || 0));
      if (entry?.type === 'tool' && entry.id) state.toolEntries.set(String(entry.id), entry);
      if (entry?.type === 'compaction' && entry.id) state.compactionEntries.set(String(entry.id), entry);
    }
    state.revision = Math.max(state.revision, maximumRevision);
    state.sequence = Math.max(0, Math.floor(Number(checkpoint.sequence || 0)));
    state.activePlanEntry = checkpoint.activePlanEntryId
      ? state.entries.find(entry => entry?.id === checkpoint.activePlanEntryId) || null
      : null;
    state.plan = clone(checkpoint.plan ?? state.activePlanEntry?.plan ?? null);
    state.usage = clone(checkpoint.usage ?? null);
    state.availableCommands = clone(checkpoint.availableCommands || []);
    state.currentModeId = String(checkpoint.currentModeId || '');
    state.configOptions = clone(checkpoint.configOptions || []);
    state.title = String(checkpoint.title || '');
    state.updatedAt = String(checkpoint.updatedAt || '');
    state.codexSubagents = clone(checkpoint.codexSubagents ?? null);
    state.truncated = checkpoint.truncated === true;
    return state;
  }

  nextEntryId(prefix) {
    return `${prefix}-${++this.sequence}`;
  }

  pushEntry(entry) {
    this.touchEntry(entry);
    this.entries.push(entry);
    return entry;
  }

  touchEntry(entry) {
    if (!entry) return this.revision;
    entry._revision = ++this.revision;
    return this.revision;
  }

  touchCurrentTurn() {
    const entry = this.entries[this.entries.length - 1];
    if (entry) this.touchEntry(entry);
    else this.revision += 1;
    return this.revision;
  }

  beginPrompt(prompt) {
    const content = Array.isArray(prompt)
      ? clone(prompt)
      : [{ type: 'text', text: String(prompt || '') }];
    this.activePlanEntry = null;
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

  recordAcceptedSteer(prompt, options = {}) {
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
        codex: {
          steer: true,
          turnId: String(options.turnId || ''),
        },
      },
    };
    this.touchEntry(entry);
    const insertionIndex = Number.isFinite(Number(options.insertionIndex))
      ? Math.max(0, Math.min(this.entries.length, Math.floor(Number(options.insertionIndex))))
      : this.entries.length;
    this.entries.splice(insertionIndex, 0, entry);
    return true;
  }

  completePrompt() {
    this.completeContextCompactionTool();
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

  recordError(message, kind = 'unknown') {
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

  finishHistoryReplay() {
    // History replay uses the same reducer as live updates; nothing to close.
  }

  apply(notification) {
    if (!notification || notification.sessionId !== this.sessionId) return false;
    const update = notification.update;
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
    if (kind === 'user_message_chunk' || kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      this.applyMessageChunk(update, kind);
    } else if (kind === 'tool_call') {
      this.applyToolCall(update, false);
    } else if (kind === 'tool_call_update') {
      this.applyToolCall(update, true);
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
      this.availableCommands = clone(update.availableCommands || []);
    } else if (kind === 'current_mode_update') {
      this.currentModeId = String(update.currentModeId || '');
    } else if (kind === 'config_option_update') {
      this.configOptions = clone(update.configOptions || []);
    } else if (kind === 'session_info_update') {
      if (Object.prototype.hasOwnProperty.call(update, 'title')) this.title = String(update.title || '');
      if (Object.prototype.hasOwnProperty.call(update, 'updatedAt')) this.updatedAt = String(update.updatedAt || '');
      this.applyCodexSubagentUpdate(update?._meta?.codex?.subagents);
    }
    return true;
  }

  applyCodexSubagentUpdate(raw) {
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

  applyMessageChunk(update, kind) {
    const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
    const type = kind === 'agent_thought_chunk' ? 'thought' : 'message';
    const messageId = String(update.messageId || '');
    const last = this.entries[this.entries.length - 1];

    const compactionMeta = update?._meta?.context_compaction;
    if (kind === 'agent_message_chunk' && (isContextCompactionText([update.content]) || compactionMeta)) {
      if (!this.completeContextCompactionTool(compactionMeta?.summary || '')) {
        this.applyCompaction({
          compactionId: compactionMeta?.id || messageId,
          status: compactionMeta?.status || 'completed',
          summary: compactionMeta?.summary || '',
        });
      }
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
      && canMergeMessageChunks(last, update)
    ) {
      const mirroredAssistantMessage = isCodexMirroredAssistantMessage(this.provider, last, update, role, type);
      if (!last.messageId) last.messageId = messageId;
      if (!last._meta && update._meta) last._meta = clone(update._meta);
      if (mirroredAssistantMessage) {
        this.touchEntry(last);
        return;
      }
      appendContent(last.content, update.content);
      this.touchEntry(last);
      return;
    }

    if (role === 'user') this.activePlanEntry = null;
    this.pushEntry({
      id: messageId || this.nextEntryId(type),
      type,
      role,
      messageId,
      content: [],
      ...(update._meta ? { _meta: clone(update._meta) } : {}),
    });
    appendContent(this.entries[this.entries.length - 1].content, update.content);
  }

  applyToolCall(update, isPatch) {
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
    this.touchEntry(entry);
  }

  applyCompaction(update) {
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

  completeContextCompactionTool(summary = '') {
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

  applyPlan(plan) {
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

  removePlan() {
    if (this.activePlanEntry) {
      const index = this.entries.indexOf(this.activePlanEntry);
      if (index >= 0) this.entries.splice(index, 1);
    }
    this.activePlanEntry = null;
    this.plan = null;
    this.touchCurrentTurn();
  }

  transcriptSlice(options = {}) {
    const maxTurns = Number.isFinite(Number(options.maxTurns))
      ? Math.max(1, Math.floor(Number(options.maxTurns)))
      : 80;
    const requestedRevision = Number(options.sinceRevision);
    const resetRequired = Number.isFinite(requestedRevision) && (
      requestedRevision > this.revision
      || (this.resetBeforeRevision > 0 && requestedRevision <= this.resetBeforeRevision)
    );
    const delta = Number.isFinite(requestedRevision) && requestedRevision >= 0 && !resetRequired;
    let startIndex = 0;

    if (delta) {
      startIndex = this.entries.findIndex(entry => Number(entry?._revision || 0) > requestedRevision);
      if (startIndex < 0) startIndex = this.entries.length;
      if (startIndex < this.entries.length) {
        while (startIndex > 0) {
          const entry = this.entries[startIndex];
          if (
            entry?.type === 'message'
            && entry.role === 'user'
            && !isCodexSteerMessage(entry)
          ) break;
          startIndex -= 1;
        }
      }
    } else {
      let remaining = maxTurns;
      startIndex = this.entries.length;
      while (startIndex > 0) {
        startIndex -= 1;
        const entry = this.entries[startIndex];
        if (
          entry?.type === 'message'
          && entry.role === 'user'
          && !isCodexSteerMessage(entry)
        ) {
          remaining -= 1;
          if (remaining <= 0) break;
        }
      }
    }

    return {
      entries: this.sanitizedEntries(startIndex, { forTranscript: true }),
      revision: this.revision,
      delta,
      hasMoreBefore: startIndex > 0,
      codexSubagents: clone(this.codexSubagents),
    };
  }

  sanitizedEntries(startIndex = 0, options = {}) {
    const safeStart = Math.min(this.entries.length, Math.max(0, Math.floor(startIndex)));
    const entries = options.forTranscript === true
      ? this.entries.slice(safeStart).map(entry => {
        const visible = { ...entry };
        delete visible._revision;
        if (entry.type !== 'tool') return clone(visible);
        // Tool details are read synchronously by the transcript projector and
        // never mutated there. Keep their potentially large protocol payloads
        // by reference so an initial page does not deep-clone megabytes merely
        // to produce a compact summary.
        return visible;
      })
      : clone(this.entries.slice(safeStart));
    if (options.forTranscript !== true) {
      for (const entry of entries) delete entry._revision;
    }
    if (this.provider !== 'codex') return entries;

    let internalSegment = false;
    for (let index = 0; index < safeStart; index += 1) {
      const entry = this.entries[index];
      if (entry?.type !== 'message' || entry.role !== 'user') continue;
      const hasAttachment = (entry.content || []).some(content => content.type !== 'text');
      internalSegment = !hasAttachment && isCodexInjectedContextMessage(contentText(entry.content));
    }
    for (const entry of entries) {
      if (entry.type === 'message' && entry.role === 'user') {
        const hasAttachment = (entry.content || []).some(content => content.type !== 'text');
        const rawText = contentText(entry.content);
        internalSegment = !hasAttachment && isCodexInjectedContextMessage(rawText);
      }
      entry.internal = internalSegment;
      if (!['message', 'thought'].includes(entry.type)) continue;
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

  isInternalEntry(targetEntry) {
    if (this.provider !== 'codex' || !targetEntry) return false;
    let internalSegment = false;
    for (const entry of this.entries) {
      if (entry.type === 'message' && entry.role === 'user') {
        const hasAttachment = (entry.content || []).some(content => content.type !== 'text');
        internalSegment = !hasAttachment && isCodexInjectedContextMessage(contentText(entry.content));
      }
      if (entry === targetEntry) return internalSegment;
    }
    return false;
  }

  snapshot(extra = {}, options = {}) {
    const entries = options.includeEntries === false ? [] : this.sanitizedEntries(0);
    const snapshot = {
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
      usage: clone(this.usage),
      availableCommands: clone(this.availableCommands),
      currentModeId: this.currentModeId,
      configOptions: clone(this.configOptions),
      codexSubagents: clone(this.codexSubagents),
      ...clone(extra),
    };
    if (options.includeUpdates === true) snapshot.updates = clone(this.updates);
    return snapshot;
  }

  exportCheckpoint() {
    return {
      version: 1,
      provider: this.provider,
      sessionId: this.sessionId,
      cwd: this.cwd,
      sequence: this.sequence,
      revision: this.revision,
      resetBeforeRevision: this.resetBeforeRevision,
      entries: clone(this.entries),
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

module.exports = {
  AcpSessionState,
  MAX_ACP_UPDATES,
  MAX_ACP_UPDATE_LOG_VALUE_CHARS,
};
