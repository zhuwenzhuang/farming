const MAX_ACP_UPDATES = 12_000;
const {
  isCodexInjectedContextMessage,
  stripCodexInternalContextBlocks,
} = require('./codex-transcript-sanitizer');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
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
  }

  setSessionId(sessionId) {
    this.sessionId = String(sessionId || this.sessionId);
  }

  nextEntryId(prefix) {
    return `${prefix}-${++this.sequence}`;
  }

  pushEntry(entry) {
    this.entries.push(entry);
    return entry;
  }

  beginPrompt(prompt) {
    const content = Array.isArray(prompt)
      ? clone(prompt)
      : [{ type: 'text', text: String(prompt || '') }];
    this.activePlanEntry = null;
    return this.pushEntry({
      id: this.nextEntryId('user'),
      type: 'message',
      role: 'user',
      messageId: '',
      optimistic: true,
      content,
    });
  }

  completePrompt() {
    // Prompt lifecycle is runtime state, not a transcript entry boundary.
  }

  finishHistoryReplay() {
    // History replay uses the same reducer as live updates; nothing to close.
  }

  apply(notification) {
    if (!notification || notification.sessionId !== this.sessionId) return false;
    const update = notification.update;
    if (!update || typeof update !== 'object') return false;
    this.updates.push({ sequence: this.updates.length + 1, at: new Date().toISOString(), update: clone(update) });
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
      return;
    }

    if (
      last?.type === type
      && last.role === role
      && canMergeMessageIds(last.messageId, messageId)
    ) {
      if (!last.messageId) last.messageId = messageId;
      appendContent(last.content, update.content);
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
    for (const field of ['title', 'kind', 'status', 'content', 'locations', 'rawInput', 'rawOutput']) {
      if (!isPatch || Object.prototype.hasOwnProperty.call(update, field)) {
        if (update[field] !== undefined) entry[field] = clone(update[field]);
      }
    }
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
  }

  removePlan() {
    if (this.activePlanEntry) {
      const index = this.entries.indexOf(this.activePlanEntry);
      if (index >= 0) this.entries.splice(index, 1);
    }
    this.activePlanEntry = null;
    this.plan = null;
  }

  snapshot(extra = {}, options = {}) {
    const entries = clone(this.entries);
    if (this.provider === 'codex') {
      let internalSegment = false;
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
    }
    const snapshot = {
      version: 2,
      protocol: 'acp',
      provider: this.provider,
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: this.title,
      updatedAt: this.updatedAt || extra.updatedAt || '',
      truncated: this.truncated,
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

module.exports = { AcpSessionState, MAX_ACP_UPDATES };
