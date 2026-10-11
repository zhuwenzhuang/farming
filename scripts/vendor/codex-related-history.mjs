import { farmingCodexPeerHistory, farmingMergePeerHistory } from './codex-peer-messages.mjs';

const MAX_BYTES = 1536 * 1024;
const MAX_ITEMS = 256;
const MAX_REQUESTS = 64;

function decodeCursor(value, identity) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (decoded.version !== 1 || decoded.identity !== identity
      || typeof decoded.before !== 'string' || !decoded.before) throw new Error();
    return decoded.before;
  } catch {
    throw new Error('Invalid or stale subagent history cursor. Return to latest messages.');
  }
}

function encodeCursor(before, identity) {
  if (!before) return null;
  const value = Buffer.from(JSON.stringify({ version: 1, identity, before })).toString('base64url');
  if (value.length > 4096) throw new Error('Provider subagent history cursor exceeds the supported size.');
  return value;
}

// A page is a newest-first provider item window, projected in chronological order.
// Native cursors fix the older boundary even while the child continues producing output.
export async function farmingReadRelatedHistory({ client, thread, params, generation, capabilities, project, valid }) {
  const identity = JSON.stringify([params.parentSessionId, params.sessionId, generation]);
  let before = decodeCursor(params.cursor, identity);
  const deadline = Date.now() + 10_000;
  let requests = 0;
  const read = async (method, request) => {
    if (++requests > MAX_REQUESTS || Date.now() >= deadline) {
      throw new Error('Subagent history read timed out. Retry this page.');
    }
    let timer;
    try {
      const result = await Promise.race([
        client.sendRequest({ method, params: request }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Subagent history read timed out. Retry this page.')), deadline - Date.now());
        }),
      ]);
      valid();
      return result;
    } finally { clearTimeout(timer); }
  };
  const latest = await read('thread/turns/list', {
    threadId: thread.id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded',
  });
  const latestTurn = latest.data[0];
  const status = thread.status?.type === 'notLoaded'
    ? ({ completed: 'idle', failed: 'failed', interrupted: 'interrupted' }[latestTurn?.status] || 'unknown')
    : thread.status?.type || 'unknown';
  const peers = await farmingCodexPeerHistory(thread);
  valid();
  let entries = [];
  let updates = [];
  let limit = 32;
  const seen = new Set(before ? [before] : []);
  do {
    if (entries.length && requests >= MAX_REQUESTS - 1) break;
    const page = await read('thread/items/list', {
      threadId: thread.id, cursor: before, limit, sortDirection: 'desc',
    });
    if (!Array.isArray(page.data) || page.data.length > limit
      || (page.nextCursor != null && (typeof page.nextCursor !== 'string' || !page.nextCursor))
      || (page.nextCursor && seen.has(page.nextCursor))
      || (!page.data.length && page.nextCursor)) {
      throw new Error('Provider returned an invalid subagent history page.');
    }
    const candidate = [...entries, ...page.data];
    const turns = new Set(candidate.map(entry => entry.turnId));
    const projection = { clientCapabilities: capabilities, farmingHistoryUserTurns: new Set() };
    const next = [];
    const items = candidate.toReversed().map(entry => ({ ...entry.item, farmingHistoryTurnId: entry.turnId }));
    // Anchored peer messages belong only to their item window. Unanchored tail
    // messages belong only to the latest page, not every historical page.
    const windowPeers = peers.filter(peer => peer.beforeId !== null || !params.cursor);
    for await (const merged of farmingMergePeerHistory([items], windowPeers)) {
      for (const item of merged) next.push(...(await project(item, projection) || []));
    }
    const bytes = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (bytes > MAX_BYTES || turns.size > params.maxTurns || candidate.length > MAX_ITEMS) {
      if (limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      if (!entries.length) {
        throw new Error('A single subagent history item exceeds the 1.5 MiB page limit. Its output must be inspected in provider history.');
      }
      break;
    }
    entries = candidate;
    updates = next;
    before = page.nextCursor || null;
    if (before) seen.add(before);
    if (!before || entries.length >= MAX_ITEMS || turns.size >= params.maxTurns || requests >= MAX_REQUESTS - 1) break;
    limit = Math.min(32, MAX_ITEMS - entries.length);
  } while (true);
  valid();
  const nextCursor = encodeCursor(before, identity);
  return {
    sessionId: thread.id, title: thread.agentNickname || thread.name || 'Subagent',
    updates, status, stopReason: status === 'interrupted' ? 'cancelled' : status === 'failed' ? 'error' : '',
    nextCursor, truncated: Boolean(nextCursor),
  };
}
