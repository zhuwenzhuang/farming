type SessionTransitionKind = 'output' | 'resize' | 'clear';

interface SessionTransitionChunk {
  kind: SessionTransitionKind;
  data: string;
  runtimeEpoch: string | undefined;
  outputSeq: number | undefined;
  stateRevision: number | undefined;
  cols: number | undefined;
  rows: number | undefined;
}

interface SessionStreamInput extends Record<string, unknown> {
  agentId?: unknown;
  chunks?: unknown;
  cols?: unknown;
  data?: unknown;
  kind?: unknown;
  outputSeq?: unknown;
  replace?: unknown;
  rows?: unknown;
  runtimeEpoch?: unknown;
  stateRevision?: unknown;
}

interface NormalizedSessionStream extends SessionStreamInput {
  chunks: SessionTransitionChunk[] | undefined;
  cols: number | undefined;
  data: string;
  kind: SessionTransitionKind;
  outputSeq: number | undefined;
  replace: boolean;
  rows: number | undefined;
  runtimeEpoch: string | undefined;
  stateRevision: number | undefined;
}

interface SessionStreamBatchOptions {
  intervalMs?: number;
  lastBroadcastAt?: number;
  now?: number;
  pendingCount?: number;
}

interface SessionStreamClient {
  bufferedAmount: number;
  close(code: number, reason: string): void;
  focusedAgentId?: unknown;
  readyState: number;
  send(message: string): void;
  streamScope?: unknown;
}

interface SessionStreamDeliveryOptions {
  maxBufferedAmount?: number;
  message?: string;
  openState?: number;
}

interface SessionStreamDeliveryResult {
  sent: number;
  closed: number;
  skipped: number;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function transitionKind(value: unknown): SessionTransitionKind {
  return value === 'resize' || value === 'clear' ? value : 'output';
}

function transitionChunks(
  stream: SessionStreamInput,
  data: string,
  runtimeEpoch: string | undefined,
  outputSeq: number | undefined,
  stateRevision: number | undefined,
): SessionTransitionChunk[] | undefined {
  if (Array.isArray(stream.chunks)) {
    return stream.chunks.map((value) => {
      const chunk = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {};
      return {
        kind: transitionKind(chunk.kind),
        data: typeof chunk.data === 'string' ? chunk.data : String(chunk.data || ''),
        runtimeEpoch: nonEmptyString(chunk.runtimeEpoch),
        outputSeq: finiteNumber(chunk.outputSeq),
        stateRevision: finiteNumber(chunk.stateRevision),
        cols: finiteNumber(chunk.cols),
        rows: finiteNumber(chunk.rows),
      };
    });
  }
  if (stream.replace === true || !runtimeEpoch || outputSeq === undefined || stateRevision === undefined) {
    return undefined;
  }
  return [{
    kind: transitionKind(stream.kind),
    data,
    runtimeEpoch,
    outputSeq,
    stateRevision,
    cols: finiteNumber(stream.cols),
    rows: finiteNumber(stream.rows),
  }];
}

function normalizeSessionStream(stream: SessionStreamInput): NormalizedSessionStream {
  const data = typeof stream.data === 'string' ? stream.data : String(stream.data || '');
  const runtimeEpoch = nonEmptyString(stream.runtimeEpoch);
  const outputSeq = finiteNumber(stream.outputSeq);
  const stateRevision = finiteNumber(stream.stateRevision);
  return {
    ...stream,
    kind: transitionKind(stream.kind),
    data,
    replace: stream.replace === true,
    runtimeEpoch,
    outputSeq,
    stateRevision,
    cols: finiteNumber(stream.cols),
    rows: finiteNumber(stream.rows),
    chunks: transitionChunks(stream, data, runtimeEpoch, outputSeq, stateRevision),
  };
}

function coalesceSessionStream(
  existingStream: SessionStreamInput | null | undefined,
  incomingStream: SessionStreamInput,
): NormalizedSessionStream {
  const incoming = normalizeSessionStream(incomingStream);
  if (!existingStream) {
    return incoming;
  }

  const existing = normalizeSessionStream(existingStream);
  if (incoming.replace) {
    if (
      !existing.runtimeEpoch ||
      !incoming.runtimeEpoch ||
      existing.runtimeEpoch !== incoming.runtimeEpoch
    ) {
      return incoming;
    }
    const existingRevision = finiteNumber(existing.stateRevision);
    const incomingRevision = finiteNumber(incoming.stateRevision);
    if (
      existing.replace &&
      existingRevision !== undefined &&
      incomingRevision !== undefined &&
      existingRevision > incomingRevision
    ) {
      return existing;
    }
    if (incomingRevision === undefined) return incoming;
    const uncoveredChunks = (existing.chunks || []).filter(chunk => (
      chunk.runtimeEpoch === incoming.runtimeEpoch &&
      chunk.stateRevision !== undefined &&
      chunk.stateRevision > incomingRevision
    ));
    return {
      ...incoming,
      chunks: uncoveredChunks.length > 0 ? uncoveredChunks : undefined,
    };
  }

  if (
    !existing.runtimeEpoch ||
    !incoming.runtimeEpoch ||
    existing.runtimeEpoch !== incoming.runtimeEpoch
  ) {
    return incoming;
  }

  const incomingHasProof = incoming.outputSeq !== undefined && incoming.stateRevision !== undefined;
  if (!incomingHasProof) {
    // Do not let unproved bytes inherit a previous checkpoint's proof. The
    // browser will enter its checkpoint barrier when it receives this stream.
    return incoming;
  }

  if (existing.replace) {
    return {
      ...existing,
      data: existing.data,
      replace: true,
      cols: existing.cols,
      rows: existing.rows,
      chunks: [
        ...(existing.chunks || []),
        ...(incoming.chunks || []),
      ],
    };
  }

  return {
    ...existing,
    ...incoming,
    data: `${existing.data}${incoming.data}`,
    replace: false,
    runtimeEpoch: incoming.runtimeEpoch,
    outputSeq: incoming.outputSeq,
    stateRevision: incoming.stateRevision,
    cols: incoming.cols ?? existing.cols,
    rows: incoming.rows ?? existing.rows,
    chunks: [
      ...(existing.chunks || []),
      ...(incoming.chunks || []),
    ],
  };
}

function shouldBroadcastSessionStreamImmediately(
  options: SessionStreamBatchOptions = {},
): boolean {
  const pendingCount = finiteNumber(options.pendingCount) ?? 0;
  const lastBroadcastAt = finiteNumber(options.lastBroadcastAt) ?? 0;
  const now = finiteNumber(options.now) ?? Date.now();
  const intervalMs = Math.max(0, finiteNumber(options.intervalMs) ?? 0);
  return pendingCount === 0 && (lastBroadcastAt === 0 || now - lastBroadcastAt >= intervalMs);
}

function deliverSessionStreamToClients(
  clients: ReadonlyArray<SessionStreamClient | null | undefined> | null | undefined,
  stream: SessionStreamInput,
  options: SessionStreamDeliveryOptions = {},
): SessionStreamDeliveryResult {
  const openState = options.openState ?? 1;
  const maxBufferedAmount = finiteNumber(options.maxBufferedAmount) ?? 4 * 1024 * 1024;
  const message = options.message || JSON.stringify({
    type: 'session-output',
    stream,
  });
  const result = { sent: 0, closed: 0, skipped: 0 };

  for (const client of clients || []) {
    if (!client || client.readyState !== openState) {
      result.skipped += 1;
      continue;
    }
    if (client.streamScope === 'focused' && client.focusedAgentId !== stream.agentId) {
      result.skipped += 1;
      continue;
    }
    if (client.bufferedAmount > maxBufferedAmount) {
      client.close(1013, 'terminal stream backpressure');
      result.closed += 1;
      continue;
    }
    client.send(message);
    result.sent += 1;
  }
  return result;
}

export {
  coalesceSessionStream,
  deliverSessionStreamToClients,
  normalizeSessionStream,
  shouldBroadcastSessionStreamImmediately,
};
