const { buildTranscriptFromEvents } = require('./codex-transcript');

const DEFAULT_MAX_EVENTS = 12_000;

class JsonlStreamDecoder {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    return lines.flatMap(parseJsonLine);
  }

  flush() {
    const trailing = this.buffer;
    this.buffer = '';
    return parseJsonLine(trailing);
  }
}

function parseJsonLine(line) {
  const text = String(line || '').trim();
  if (!text) return [];
  try {
    return [JSON.parse(text)];
  } catch {
    // Coding-agent CLIs occasionally print update notices or diagnostics to
    // stdout. They should remain visible in the terminal, but must not poison
    // the structured chat stream.
    return [];
  }
}

function itemEvent(type, turnId, item) {
  return { type, turn_id: turnId, item };
}

class CodexJsonAdapter {
  constructor(options) {
    this.prompt = options.prompt;
    this.operationId = options.operationId;
    this.turnId = `codex-${this.operationId}`;
    this.sessionId = '';
    this.started = false;
  }

  adapt(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (raw.type === 'thread.started') {
      this.sessionId = typeof raw.thread_id === 'string' ? raw.thread_id : this.sessionId;
      return [];
    }
    if (raw.type === 'turn.started') {
      if (this.started) return [];
      this.started = true;
      return [
        { type: 'turn.started', turn_id: this.turnId },
        ...this.userMessageEvents(),
      ];
    }
    if (raw.type === 'item.started' || raw.type === 'item.completed') {
      this.ensureStarted();
      return [itemEvent(raw.type, this.turnId, raw.item)];
    }
    if (raw.type === 'turn.completed') {
      this.ensureStarted();
      return [{ ...raw, turn_id: this.turnId }];
    }
    if (raw.type === 'turn.failed' || raw.type === 'error') {
      this.ensureStarted();
      const message = raw.message || raw.error?.message || raw.error || 'Codex execution failed';
      return [
        itemEvent('item.completed', this.turnId, {
          id: `${this.turnId}-error`,
          type: 'error',
          message: typeof message === 'string' ? message : JSON.stringify(message),
          status: 'failed',
        }),
        { type: 'turn.completed', turn_id: this.turnId },
      ];
    }
    return [];
  }

  flush() {
    return [];
  }

  ensureStarted() {
    this.started = true;
  }

  userMessageEvents() {
    if (!this.prompt) return [];
    return [itemEvent('item.completed', this.turnId, {
      id: `${this.turnId}-user`,
      type: 'user_message',
      content: [{ type: 'text', text: this.prompt }],
    })];
  }
}

function openCodeToolItem(part) {
  const state = part.state && typeof part.state === 'object' ? part.state : {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const id = part.callID || part.id;
  if (part.tool === 'bash') {
    return {
      id,
      type: 'command_execution',
      command: input.command || state.title || '',
      aggregated_output: state.output || state.metadata?.output || '',
      exit_code: Number.isFinite(state.metadata?.exit) ? state.metadata.exit : null,
      status: state.status,
    };
  }
  return {
    id,
    type: 'mcp_tool_call',
    server: 'opencode',
    tool: part.tool || 'tool',
    arguments: input,
    result: state.output,
    error: state.error,
    status: state.status,
  };
}

class OpenCodeJsonAdapter {
  constructor(options) {
    this.prompt = options.prompt;
    this.operationId = options.operationId;
    this.turnId = `opencode-${this.operationId}`;
    this.sessionId = '';
    this.started = false;
    this.completed = false;
    this.text = '';
  }

  adapt(raw) {
    if (!raw || typeof raw !== 'object') return [];
    if (typeof raw.sessionID === 'string') this.sessionId = raw.sessionID;
    const events = this.startEvents(raw.timestamp);
    const part = raw.part && typeof raw.part === 'object' ? raw.part : {};

    if (raw.type === 'text' && typeof part.text === 'string') {
      this.text += part.text;
      events.push(itemEvent('item.completed', this.turnId, {
        id: `${this.turnId}-assistant`,
        type: 'agent_message',
        text: this.text,
      }));
    } else if (raw.type === 'tool_use' && (part.callID || part.id)) {
      const state = part.state && typeof part.state === 'object' ? part.state : {};
      const eventType = state.status === 'completed' || state.status === 'error'
        ? 'item.completed'
        : 'item.started';
      events.push(itemEvent(eventType, this.turnId, openCodeToolItem(part)));
    } else if (raw.type === 'error') {
      const message = raw.error?.message || raw.message || raw.error || 'OpenCode execution failed';
      events.push(itemEvent('item.completed', this.turnId, {
        id: `${this.turnId}-error`,
        type: 'error',
        message: typeof message === 'string' ? message : JSON.stringify(message),
        status: 'failed',
      }));
    }

    if (raw.type === 'step_finish' && part.reason !== 'tool-calls') {
      events.push(...this.completeEvents(raw.timestamp));
    }
    return events;
  }

  flush() {
    return this.completeEvents();
  }

  startEvents(timestamp) {
    if (this.started) return [];
    this.started = true;
    const events = [{
      type: 'turn.started',
      turn_id: this.turnId,
      ...(Number.isFinite(timestamp) ? { startedAtMs: timestamp } : {}),
    }];
    if (this.prompt) {
      events.push(itemEvent('item.completed', this.turnId, {
        id: `${this.turnId}-user`,
        type: 'user_message',
        content: [{ type: 'text', text: this.prompt }],
      }));
    }
    return events;
  }

  completeEvents(timestamp) {
    if (!this.started || this.completed) return [];
    this.completed = true;
    return [{
      type: 'turn.completed',
      turn_id: this.turnId,
      ...(Number.isFinite(timestamp) ? { completedAt: timestamp } : {}),
    }];
  }
}

function createAdapter(provider, options) {
  if (provider === 'codex') return new CodexJsonAdapter(options);
  if (provider === 'opencode') return new OpenCodeJsonAdapter(options);
  throw new Error(`Unsupported agent JSON provider: ${provider}`);
}

class AgentJsonStreamParser {
  constructor(options = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const operationId = String(options.operationId || Date.now());
    this.provider = provider;
    this.decoder = new JsonlStreamDecoder();
    this.adapter = createAdapter(provider, {
      operationId,
      prompt: typeof options.prompt === 'string' ? options.prompt.trim() : '',
    });
    this.events = [];
    this.maxEvents = Number.isFinite(options.maxEvents)
      ? Math.max(1, Math.floor(options.maxEvents))
      : DEFAULT_MAX_EVENTS;
  }

  get sessionId() {
    return this.adapter.sessionId;
  }

  push(chunk) {
    return this.appendRaw(this.decoder.push(chunk));
  }

  flush() {
    const events = this.appendRaw(this.decoder.flush());
    return [...events, ...this.appendEvents(this.adapter.flush())];
  }

  transcript(options = {}) {
    return buildTranscriptFromEvents(this.events, options);
  }

  appendRaw(rawEvents) {
    const normalized = rawEvents.flatMap(event => this.adapter.adapt(event));
    return this.appendEvents(normalized);
  }

  appendEvents(events) {
    if (!events.length) return [];
    this.events.push(...events);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return events;
  }
}

module.exports = {
  AgentJsonStreamParser,
  JsonlStreamDecoder,
};
