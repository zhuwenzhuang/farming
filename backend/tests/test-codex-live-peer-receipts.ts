import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { farmingCodexPeerUpdate, farmingSyncCodexPeerReceipts } from '../../scripts/vendor/codex-peer-messages.mjs';

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-peer-live-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = root;
  try {
    const directory = path.join(root, 'sessions');
    await fs.mkdir(directory);
    const file = path.join(directory, 'receiver.jsonl');
    const header = JSON.stringify({ type: 'session_meta', payload: { id: 'receiver', agent_path: '/root' } }) + '\n';
    const receipt = (id: string, recipient = '/root') => JSON.stringify({
      timestamp: '2026-01-01T00:00:00Z', type: 'response_item', payload: {
        id, type: 'agent_message', author: '/root/child', recipient,
        content: [{ type: 'input_text', text: `Message Type: MESSAGE\nTask name: ${recipient}\nSender: /root/child\nPayload:\n子会话进展：${id}` }],
      },
    }) + '\n';
    await fs.writeFile(file, header + receipt('first') + receipt('inherited', '/root/other'));
    let reads = 0;
    const client = { async threadRead() { reads++; return { thread: { id: 'receiver', path: file } }; } };
    const session = { sessionId: 'receiver', subagents: { isKnownChild: () => false } };
    const event = { method: 'item/completed', params: { threadId: 'receiver', turnId: 'turn' } };
    const received: ReturnType<typeof farmingCodexPeerUpdate>[] = [];
    const publish = async (notification: { params: { item: unknown; farmingReceiptTimestamp: string } }) => {
      received.push(farmingCodexPeerUpdate(notification.params.item, notification.params.farmingReceiptTimestamp));
    };
    await farmingSyncCodexPeerReceipts(session, event, client, publish);
    assert.equal(received.length, 1);
    assert.equal(received[0].messageId, 'first');
    await farmingSyncCodexPeerReceipts(session, event, client, publish);
    assert.equal(received.length, 1, 'unchanged files never replay the same batch');
    const second = Buffer.from(receipt('second'));
    const split = second.indexOf(Buffer.from('子')) + 1;
    await fs.appendFile(file, second.subarray(0, split));
    await farmingSyncCodexPeerReceipts(session, event, client, publish);
    assert.equal(received.length, 1, 'incomplete rows are retained until their newline');
    await fs.appendFile(file, second.subarray(split));
    await farmingSyncCodexPeerReceipts(session, { ...event, method: 'turn/completed' }, client, publish);
    assert.equal(received[1].content[0].text, '子会话进展：second');
    assert.equal(received[1]._meta.peerMessage.timestamp, '2026-01-01T00:00:00Z');
    assert.equal(reads, 1, 'metadata is resolved once per exact live session');
    await farmingSyncCodexPeerReceipts(session, { ...event, params: { ...event.params, threadId: 'unknown' } }, client, publish);
    assert.equal(reads, 1, 'unannounced sessions cannot open arbitrary provider history');
    await fs.writeFile(file, header);
    await assert.rejects(farmingSyncCodexPeerReceipts(session, event, client, publish), /changed during live reading/);
    console.log('Codex live peer receipt tests passed');
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
