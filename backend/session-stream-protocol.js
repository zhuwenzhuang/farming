function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function transitionKind(value) {
  return value === 'resize' || value === 'clear' ? value : 'output';
}

function transitionChunks(stream, data, runtimeEpoch, outputSeq, stateRevision) {
  if (Array.isArray(stream.chunks)) {
    return stream.chunks.map(chunk => ({
      kind: transitionKind(chunk.kind),
      data: typeof chunk.data === 'string' ? chunk.data : String(chunk.data || ''),
      runtimeEpoch: nonEmptyString(chunk.runtimeEpoch),
      outputSeq: finiteNumber(chunk.outputSeq),
      stateRevision: finiteNumber(chunk.stateRevision),
      cols: finiteNumber(chunk.cols),
      rows: finiteNumber(chunk.rows),
    }));
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

function normalizeSessionStream(stream) {
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

function coalesceSessionStream(existingStream, incomingStream) {
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
      Number.isFinite(chunk.stateRevision) &&
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

function deliverSessionStreamToClients(clients, stream, options = {}) {
  const openState = options.openState ?? 1;
  const maxBufferedAmount = Number.isFinite(options.maxBufferedAmount)
    ? options.maxBufferedAmount
    : 4 * 1024 * 1024;
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

module.exports = {
  coalesceSessionStream,
  deliverSessionStreamToClients,
  normalizeSessionStream,
};
