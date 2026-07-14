const MAX_ACP_UPDATES = 2_000;
const MAX_ACP_UPDATE_LOG_VALUE_CHARS = 32 * 1024;
const {
  isCodexInjectedContextMessage,
  stripCodexInternalContextBlocks,
} = require('./codex-transcript-sanitizer');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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

function isContextCompactionText(content) {
  return /^\*?Context compacted(?: to fit the model's context window)?\.?\*?$/i.test(contentText(content).trim());
}

function canMergeMessageIds(existing, incoming) {
  return !existing || !incoming || existing === incoming;
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

  completePrompt() {
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
    }
    return true;
  }

  applyMessageChunk(update, kind) {
    const role = kind === 'user_message_chunk' ? 'user' : 'assistant';
    const type = kind === 'agent_thought_chunk' ? 'thought' : 'message';
    const messageId = String(update.messageId || '');
    const last = this.entries[this.entries.length - 1];

    const compactionMeta = update?._meta?.context_compaction;
    if (kind === 'agent_message_chunk' && (isContextCompactionText([update.content]) || compactionMeta)) {
      this.applyCompaction({
        compactionId: compactionMeta?.id || messageId,
        status: compactionMeta?.status || 'completed',
        summary: compactionMeta?.summary || '',
      });
      return;
    }

    // Farming inserts the local prompt optimistically. ACP Agents may echo the
    // same prompt during live updates; attach its protocol id without rendering
    // the user message twice.
    if (
      role === 'user'
      && last?.type === 'message'
      && last.role === 'user'
      && last.optimistic
      && (last.content || []).some(content => JSON.stringify(content) === JSON.stringify(update.content))
    ) {
      if (!last.messageId) last.messageId = messageId;
      this.touchEntry(last);
      return;
    }

    if (
      last?.type === type
      && last.role === role
      && canMergeMessageIds(last.messageId, messageId)
    ) {
      if (!last.messageId) last.messageId = messageId;
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
    const resetRequired = this.resetBeforeRevision > 0
      && Number.isFinite(requestedRevision)
      && requestedRevision <= this.resetBeforeRevision;
    const delta = Number.isFinite(requestedRevision) && requestedRevision >= 0 && !resetRequired;
    let startIndex = 0;

    if (delta) {
      startIndex = this.entries.findIndex(entry => Number(entry?._revision || 0) > requestedRevision);
      if (startIndex < 0) startIndex = this.entries.length;
      if (startIndex < this.entries.length) {
        while (startIndex > 0) {
          const entry = this.entries[startIndex];
          if (entry?.type === 'message' && entry.role === 'user') break;
          startIndex -= 1;
        }
      }
    } else {
      let remaining = maxTurns;
      startIndex = this.entries.length;
      while (startIndex > 0) {
        startIndex -= 1;
        const entry = this.entries[startIndex];
        if (entry?.type === 'message' && entry.role === 'user') {
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
      for (const content of entry.content || []) {
        if (content.type === 'text') content.text = stripCodexInternalContextBlocks(content.text);
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
      ...clone(extra),
    };
    if (options.includeUpdates === true) snapshot.updates = clone(this.updates);
    return snapshot;
  }
}

module.exports = {
  AcpSessionState,
  MAX_ACP_UPDATES,
  MAX_ACP_UPDATE_LOG_VALUE_CHARS,
};
