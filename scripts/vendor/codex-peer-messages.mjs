import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 512;

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
