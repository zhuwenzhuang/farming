import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const liveReaders = new WeakMap();

// thread/resume has no raw-event opt-in. Drain the receiver's own append-only
// rollout at native item/turn boundaries, including after resume. The same native
// IDs upsert with raw notifications and replay; sender-side guesses never qualify.
export async function farmingSyncCodexPeerReceipts(session, event, client, publish) {
  if (!['item/started', 'item/completed', 'turn/completed'].includes(event.method)) return;
  const id = event.params?.threadId;
  if (!bounded(id) || (id !== session.sessionId && !session.subagents.isKnownChild(id))) return;
  let readers = liveReaders.get(session);
  if (!readers) { readers = new Map(); liveReaders.set(session, readers); }
  let reader = readers.get(id);
  if (!reader) {
    if (readers.size >= 128) throw new Error('Codex peer receipt session limit exceeded');
    const { thread } = await client.threadRead({ threadId: id });
    if (thread.id !== id) throw new Error('Codex peer receipt session identity changed');
    if (!thread.path) return; // A newly created thread may not have materialized yet.
    const home = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
    const file = await fs.realpath(thread.path);
    const relative = path.relative(home, file);
    if (!['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0]) || !file.endsWith('.jsonl')) {
      throw new Error('Codex incoming message history is outside its provider home');
    }
    reader = { file, offset: 0, tail: Buffer.alloc(0), address: null, identity: null };
    readers.set(id, reader);
  }
  const handle = await fs.open(reader.file, 'r');
  try {
    const stat = await handle.stat();
    const identity = `${stat.dev}:${stat.ino}`;
    if ((reader.identity && reader.identity !== identity) || stat.size < reader.offset) {
      throw new Error('Codex incoming message history changed during live reading');
    }
    if (stat.size > 256 * 1024 * 1024) throw new Error('Codex incoming message history exceeds 256 MiB');
    let offset = reader.offset, tail = reader.tail, address = reader.address, count = 0, bytes = 0;
    const deadline = Date.now() + 10_000;
    const buffer = Buffer.alloc(64 * 1024);
    while (offset < stat.size) {
      if (Date.now() >= deadline) throw new Error('Codex live incoming message read timed out');
      const read = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!read.bytesRead) throw new Error('Codex incoming message history changed during live reading');
      offset += read.bytesRead;
      // Keep bytes until a complete line exists so split UTF-8 cannot corrupt text.
      let pending = Buffer.concat([tail, buffer.subarray(0, read.bytesRead)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline > 16 * 1024 * 1024) throw new Error('Codex incoming message history record is too large');
        const line = pending.subarray(0, newline).toString('utf8');
        pending = pending.subarray(newline + 1);
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (address === null) {
          if (row.type !== 'session_meta' || row.payload?.id !== id) throw new Error('Codex incoming message history identity mismatch');
          address = row.payload.agent_path || '/root';
        }
        if (row.type !== 'response_item' || row.payload?.type !== 'agent_message' || row.payload.recipient !== address) continue;
        const update = farmingCodexPeerUpdate(row.payload, row.timestamp);
        if (!update) continue;
        if (++count > 10000 || (bytes += Buffer.byteLength(JSON.stringify(update))) > 8 * 1024 * 1024) {
          throw new Error('Codex live incoming message batch exceeds the supported limit');
        }
        await publish({ method: 'rawResponseItem/completed', params: {
          threadId: id, turnId: event.params.turnId || event.params.turn?.id,
          item: row.payload, farmingReceiptTimestamp: row.timestamp,
        } });
      }
      if (pending.length > 16 * 1024 * 1024) throw new Error('Codex incoming message history record is too large');
      tail = pending;
    }
    Object.assign(reader, { offset, tail, address, identity });
  } finally { await handle.close(); }
}

// Only native receive-side response items qualify. Never parse human/tool text as provenance.
export function farmingCodexPeerUpdate(item, timestamp) {
  if (item?.type !== 'agent_message' || !bounded(item.id) || !bounded(item.author)
      || !bounded(item.recipient) || !Array.isArray(item.content)) return null;
  const encrypted = item.content.some(block => block?.type === 'encrypted_content');
  let text = item.content.filter(block => block?.type === 'input_text' && typeof block.text === 'string')
    .map(block => block.text).join('');
  const envelope = `Task name: ${item.recipient}\nSender: ${item.author}\nPayload:\n`;
  if (/^Message Type: (?:MESSAGE|FINAL_ANSWER|NEW_TASK)\n/.test(text)) {
    const offset = text.indexOf(envelope);
    if (offset === text.indexOf('\n') + 1) text = text.slice(offset + envelope.length);
  }
  // The raw API sometimes exposes only an envelope and ciphertext. Do not leak either.
  if (encrypted) text = '';
  return {
    sessionUpdate: 'session_message', messageId: item.id,
    content: [{ type: 'text', text }],
    _meta: { peerMessage: {
      version: 1, direction: 'incoming', senderAddress: item.author,
      ...(typeof timestamp === 'string' && timestamp.length > 0 && timestamp.length <= 80
        && Number.isFinite(Date.parse(timestamp)) ? { timestamp } : {}),
      ...(encrypted ? { bodyUnavailable: 'encrypted' } : {}),
    } },
  };
}

// Codex's typed history omits agent_message. Read only the recipient's authoritative
// rollout, at a fixed byte boundary; retain compact peer records, never the full history.
export async function farmingCodexPeerHistory(thread, turnIds) {
  if (!thread.path) return [];
  const home = await fs.realpath(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const file = await fs.realpath(thread.path);
  const relative = path.relative(home, file);
  if (!['sessions', 'archived_sessions'].includes(relative.split(path.sep)[0]) || !file.endsWith('.jsonl')) {
    throw new Error('Codex incoming message history is outside its provider home');
  }
  const handle = await fs.open(file, 'r');
  const deadline = Date.now() + 10_000;
  const peers = [];
  let pending = [], bytes = 0, first = true, tail = '', ownAddress = null;
  try {
    const { size } = await handle.stat();
    if (size > 256 * 1024 * 1024) throw new Error('Codex incoming message history exceeds 256 MiB');
    const consume = line => {
      if (line.length > 16 * 1024 * 1024) throw new Error('Codex incoming message history record is too large');
      if (!line.trim()) return;
      const row = JSON.parse(line);
      if (first) {
        first = false;
        if (row.type !== 'session_meta' || row.payload?.id !== thread.id) throw new Error('Codex incoming message history identity mismatch');
        ownAddress = row.payload.agent_path || '/root';
      }
      if (row.type === 'response_item' && row.payload?.type === 'agent_message') {
        const item = row.payload;
        // A fork can contain inherited parent records. Only its own inbound messages belong here.
        if (item.recipient !== ownAddress) return;
        const turnId = item.internal_chat_message_metadata_passthrough?.turn_id;
        if (turnIds && !turnIds.has(turnId)) return;
        const update = farmingCodexPeerUpdate(item, row.timestamp);
        if (!update) return;
        bytes += Buffer.byteLength(JSON.stringify(update));
        if (peers.length >= 10_000 || bytes > 8 * 1024 * 1024) throw new Error('Codex incoming message history exceeds its message limit');
        const peer = { type: 'farmingPeerMessage', id: item.id, update, turnId, beforeId: null };
        peers.push(peer);
        pending.push(peer);
      }
      if (row.type === 'event_msg' && row.payload?.type === 'item_completed') {
        for (const peer of pending) peer.beforeId = row.payload.item?.id || null;
        pending = [];
      }
    };
    const buffer = Buffer.alloc(64 * 1024);
    // StringDecoder preserves UTF-8 boundaries between read chunks.
    const { StringDecoder } = await import('node:string_decoder');
    const decoder = new StringDecoder('utf8');
    for (let offset = 0; offset < size;) {
      if (Date.now() > deadline) throw new Error('Codex incoming message history timed out');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead;
      tail += decoder.write(buffer.subarray(0, bytesRead));
      let end;
      while ((end = tail.indexOf('\n')) >= 0) {
        consume(tail.slice(0, end));
        tail = tail.slice(end + 1);
      }
      if (tail.length > 16 * 1024 * 1024) throw new Error('Codex incoming message history record is too large');
    }
    // A partial final record may be an in-flight append; replay only committed lines.
    if (first) throw new Error('Codex incoming message history has no session identity');
    return peers;
  } finally { await handle.close(); }
}

export async function* farmingMergePeerHistory(pages, peers) {
  const byAnchor = new Map();
  for (const peer of peers) {
    const group = byAnchor.get(peer.beforeId) || [];
    group.push(peer);
    byAnchor.set(peer.beforeId, group);
  }
  for await (const page of pages) {
    const result = [];
    for (const item of page) {
      const incoming = byAnchor.get(item.id);
      if (incoming) { result.push(...incoming); byAnchor.delete(item.id); }
      result.push(item);
    }
    yield result;
  }
  // Only unanchored tail messages may follow the typed snapshot. Anchors absent from
  // a bounded history page belong outside that page, never to its end.
  if (byAnchor.has(null)) yield byAnchor.get(null);
}
