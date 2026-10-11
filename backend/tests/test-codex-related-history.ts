import assert from 'node:assert/strict';
import { farmingReadRelatedHistory } from '../../scripts/vendor/codex-related-history.mjs';

async function run() {
  const all = Array.from({ length: 180 }, (_, i) => ({
    turnId: 'long-turn',
    item: { id: `item-${i}`, text: `entry-${i}:` + '中文🌱'.repeat(4000) },
  }));
  const calls: string[] = [];
  let badCursor = false;
  const client = {
    async sendRequest({ method, params }) {
      calls.push(method);
      if (method === 'thread/turns/list') return { data: [{ id: 'long-turn', status: 'completed' }] };
      assert.equal(method, 'thread/items/list');
      const ordered = all.toReversed();
      const start = params.cursor ? ordered.findIndex(entry => entry.item.id === params.cursor) + 1 : 0;
      assert(start >= 0);
      const data = ordered.slice(start, start + params.limit);
      return {
        data,
        nextCursor: badCursor ? params.cursor : start + data.length < ordered.length ? data.at(-1)?.item.id : null,
      };
    },
  };
  const options = {
    client, thread: { id: 'child', status: { type: 'notLoaded' } }, generation: 1,
    capabilities: {}, valid() {},
    project(item) {
      return [{ sessionUpdate: 'agent_message_chunk', messageId: item.id, content: { type: 'text', text: item.text } }];
    },
  };
  const read = (cursor = '', extra = {}) => farmingReadRelatedHistory({
    ...options, ...extra, params: { parentSessionId: 'parent', sessionId: 'child', maxTurns: 24, cursor },
  });
  const first = await read();
  assert.equal(first.status, 'idle', 'unloaded completed history must not be shown as running/unknown');
  assert(first.nextCursor, 'a long single turn must page by items');
  assert(first.updates.some(update => update.messageId === 'item-179'), 'show newest output first');
  const seen = new Set<string>();
  let page = first;
  let count = 0;
  do {
    assert(Buffer.byteLength(JSON.stringify(page)) < 2 * 1024 * 1024);
    for (const update of page.updates) {
      assert(!seen.has(update.messageId), 'no duplicated items');
      seen.add(update.messageId);
    }
    if (++count === 1) all.push({ turnId: 'long-turn', item: { id: 'live-new', text: 'new output' } });
    if (!page.nextCursor) break;
    page = await read(page.nextCursor);
    assert(count < 20, 'pagination must terminate');
  } while (count < 20);
  assert.equal(seen.size, 180);
  assert(!seen.has('live-new'), 'live appends cannot shift older-page boundaries');
  assert((await read()).updates.some(update => update.messageId === 'live-new'));
  await assert.rejects(read('invalid'), /Invalid or stale/);
  await assert.rejects(read(first.nextCursor, { generation: 2 }), /Invalid or stale/);
  await assert.rejects(read('', { valid() { throw new Error('parent replaced'); } }), /parent replaced/);
  badCursor = true;
  await assert.rejects(read(first.nextCursor), /invalid subagent history page/);
  badCursor = false;
  all.splice(0, all.length, { turnId: 'long-turn', item: { id: 'huge', text: '中'.repeat(600_000) } });
  await assert.rejects(read(), /single subagent history item.*1.5 MiB/);
  assert(calls.every(method => ['thread/turns/list', 'thread/items/list'].includes(method)));
  for (const scenario of [
    { items: 600, perTurn: 600, maxTurns: 24, providerLimit: 32, mixedBytes: false },
    { items: 330, perTurn: 11, maxTurns: 1, providerLimit: 32, mixedBytes: true },
    { items: 330, perTurn: 11, maxTurns: 2, providerLimit: 32, mixedBytes: true },
    { items: 330, perTurn: 11, maxTurns: 24, providerLimit: 32, mixedBytes: true },
    { items: 270, perTurn: 1, maxTurns: 200, providerLimit: 32, mixedBytes: false },
    { items: 200, perTurn: 200, maxTurns: 24, providerLimit: 1, mixedBytes: false },
  ]) {
    const entries = Array.from({ length: scenario.items }, (_, index) => ({
      turnId: `turn-${Math.floor(index / scenario.perTurn)}`,
      item: { id: `mixed-${index}`, text: '中文🌱'.repeat(scenario.mixedBytes && index % 17 === 0 ? 60_000 : 3) },
    }));
    let requests = 0;
    const mixedClient = {
      async sendRequest({ method, params }) {
        requests++;
        if (method === 'thread/turns/list') return { data: [{ status: 'completed' }] };
        const ordered = entries.toReversed();
        const boundary = params.cursor ? ordered.findIndex(entry => entry.item.id === params.cursor) : -1;
        if (params.cursor) assert(boundary >= 0, 'provider cursors must reference an accepted item');
        const data = ordered.slice(boundary + 1, boundary + 1 + Math.min(params.limit, scenario.providerLimit));
        return { data, nextCursor: boundary + 1 + data.length < ordered.length ? data.at(-1)!.item.id : null };
      },
    };
    let cursor: string | null = null;
    let visited: string[] = [];
    let pageCount = 0;
    do {
      requests = 0;
      const result = await farmingReadRelatedHistory({
        ...options, client: mixedClient,
        params: { parentSessionId: 'parent', sessionId: 'child', cursor, maxTurns: scenario.maxTurns },
      });
      assert(requests <= 64, 'each page respects the provider request budget');
      assert(result.updates.length <= 256, 'each page respects the item budget');
      assert(Buffer.byteLength(JSON.stringify(result.updates)) <= 1536 * 1024, 'each page respects the UTF-8 budget');
      visited = [...result.updates.map(update => update.messageId), ...visited];
      cursor = result.nextCursor;
      assert(++pageCount <= scenario.items, 'every page makes bounded forward progress');
    } while (cursor);
    assert.deepEqual(visited, entries.map(entry => entry.item.id), 'mixed windows preserve chronological order without gaps or duplicates');
  }
  for (const [turnStatus, expectedStatus] of [
    ['completed', 'idle'], ['failed', 'failed'], ['interrupted', 'interrupted'], ['inProgress', 'unknown'],
  ]) {
    const result = await read('', { client: { async sendRequest({ method }) {
      return method === 'thread/turns/list' ? { data: [{ status: turnStatus }] } : { data: [], nextCursor: null };
    } } });
    assert.equal(result.status, expectedStatus, 'unloaded historical state must not claim live execution');
  }
  console.log('test-codex-related-history passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
