const { buildTranscriptFromEvents } = require('./codex-transcript.cjs') as {
  buildTranscriptFromEvents(events: JsonEvent[], options: unknown): unknown;
};

const DEFAULT_MAX_EVENTS = 12_000;

type JsonEvent = Record<string, unknown>;

interface JsonAdapter {
  readonly sessionId: string;
  adapt(raw: unknown): JsonEvent[];
  flush(): JsonEvent[];
}

interface JsonAdapterOptions {
  operationId: string;
  prompt: string;
}

interface AgentJsonStreamParserOptions {
  maxEvents?: number;
  operationId?: unknown;
  prompt?: string;
  provider?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class JsonlStreamDecoder {
  buffer: string;

  constructor() {
    this.buffer = '';
  }

  push(chunk: unknown): unknown[] {
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    return lines.flatMap(parseJsonLine);
  }

  flush(): unknown[] {
    const trailing = this.buffer;
    this.buffer = '';
    return parseJsonLine(trailing);
  }
}

function parseJsonLine(line: unknown): unknown[] {
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

function itemEvent(type: string, turnId: string, item: unknown): JsonEvent {
  return { type, turn_id: turnId, item };
}

class CodexJsonAdapter {
  prompt: string;
  operationId: string;
  turnId: string;
  sessionId: string;
  started: boolean;

  constructor(options: JsonAdapterOptions) {
    this.prompt = options.prompt;
    this.operationId = options.operationId;
    this.turnId = `codex-${this.operationId}`;
    this.sessionId = '';
    this.started = false;
  }

  adapt(raw: unknown): JsonEvent[] {
    if (!isObject(raw)) return [];
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
      const rawError = isObject(raw.error) ? raw.error : {};
      const message = raw.message || rawError.message || raw.error || 'Codex execution failed';
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

  flush(): JsonEvent[] {
    return [];
  }

  ensureStarted(): void {
    this.started = true;
  }

  userMessageEvents(): JsonEvent[] {
    if (!this.prompt) return [];
    return [itemEvent('item.completed', this.turnId, {
      id: `${this.turnId}-user`,
      type: 'user_message',
      content: [{ type: 'text', text: this.prompt }],
    })];
  }
}

function openCodeToolItem(part: Record<string, unknown>): JsonEvent {
  const state = isObject(part.state) ? part.state : {};
  const input = isObject(state.input) ? state.input : {};
  const metadata = isObject(state.metadata) ? state.metadata : {};
  const id = part.callID || part.id;
  if (part.tool === 'bash') {
    return {
      id,
      type: 'command_execution',
      command: input.command || state.title || '',
      aggregated_output: state.output || metadata.output || '',
      exit_code: typeof metadata.exit === 'number' && Number.isFinite(metadata.exit)
        ? metadata.exit
        : null,
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
  prompt: string;
  operationId: string;
  turnId: string;
  sessionId: string;
  started: boolean;
  completed: boolean;
  text: string;

  constructor(options: JsonAdapterOptions) {
    this.prompt = options.prompt;
    this.operationId = options.operationId;
    this.turnId = `opencode-${this.operationId}`;
    this.sessionId = '';
    this.started = false;
    this.completed = false;
    this.text = '';
  }

  adapt(raw: unknown): JsonEvent[] {
    if (!isObject(raw)) return [];
    if (typeof raw.sessionID === 'string') this.sessionId = raw.sessionID;
    const events = this.startEvents(raw.timestamp);
    const part = isObject(raw.part) ? raw.part : {};

    if (raw.type === 'text' && typeof part.text === 'string') {
      this.text += part.text;
      events.push(itemEvent('item.completed', this.turnId, {
        id: `${this.turnId}-assistant`,
        type: 'agent_message',
        text: this.text,
      }));
    } else if (raw.type === 'tool_use' && (part.callID || part.id)) {
      const state = isObject(part.state) ? part.state : {};
      const eventType = state.status === 'completed' || state.status === 'error'
        ? 'item.completed'
        : 'item.started';
      events.push(itemEvent(eventType, this.turnId, openCodeToolItem(part)));
    } else if (raw.type === 'error') {
      const rawError = isObject(raw.error) ? raw.error : {};
      const message = rawError.message || raw.message || raw.error || 'OpenCode execution failed';
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

  flush(): JsonEvent[] {
    return this.completeEvents();
  }

  startEvents(timestamp: unknown): JsonEvent[] {
    if (this.started) return [];
    this.started = true;
    const events: JsonEvent[] = [{
      type: 'turn.started',
      turn_id: this.turnId,
      ...(typeof timestamp === 'number' && Number.isFinite(timestamp) ? { startedAtMs: timestamp } : {}),
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

  completeEvents(timestamp?: unknown): JsonEvent[] {
    if (!this.started || this.completed) return [];
    this.completed = true;
    return [{
      type: 'turn.completed',
      turn_id: this.turnId,
      ...(typeof timestamp === 'number' && Number.isFinite(timestamp) ? { completedAt: timestamp } : {}),
    }];
  }
}

function createAdapter(provider: string, options: JsonAdapterOptions): JsonAdapter {
  if (provider === 'codex') return new CodexJsonAdapter(options);
  if (provider === 'opencode') return new OpenCodeJsonAdapter(options);
  throw new Error(`Unsupported agent JSON provider: ${provider}`);
}

class AgentJsonStreamParser {
  provider: string;
  decoder: JsonlStreamDecoder;
  adapter: JsonAdapter;
  events: JsonEvent[];
  maxEvents: number;

  constructor(options: AgentJsonStreamParserOptions = {}) {
    const provider = String(options.provider || '').trim().toLowerCase();
    const operationId = String(options.operationId || Date.now());
    this.provider = provider;
    this.decoder = new JsonlStreamDecoder();
    this.adapter = createAdapter(provider, {
      operationId,
      prompt: typeof options.prompt === 'string' ? options.prompt.trim() : '',
    });
    this.events = [];
    this.maxEvents = typeof options.maxEvents === 'number' && Number.isFinite(options.maxEvents)
      ? Math.max(1, Math.floor(options.maxEvents))
      : DEFAULT_MAX_EVENTS;
  }

  get sessionId(): string {
    return this.adapter.sessionId;
  }

  push(chunk: unknown): JsonEvent[] {
    return this.appendRaw(this.decoder.push(chunk));
  }

  flush(): JsonEvent[] {
    const events = this.appendRaw(this.decoder.flush());
    return [...events, ...this.appendEvents(this.adapter.flush())];
  }

  transcript(options: unknown = {}): unknown {
    return buildTranscriptFromEvents(this.events, options);
  }

  appendRaw(rawEvents: unknown[]): JsonEvent[] {
    const normalized = rawEvents.flatMap(event => this.adapter.adapt(event));
    return this.appendEvents(normalized);
  }

  appendEvents(events: JsonEvent[]): JsonEvent[] {
    if (!events.length) return [];
    this.events.push(...events);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return events;
  }
}

export {
  AgentJsonStreamParser,
  JsonlStreamDecoder,
};
