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
  console.log('test-codex-related-history passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
