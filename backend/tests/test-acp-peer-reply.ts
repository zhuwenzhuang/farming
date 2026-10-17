import assert from 'node:assert/strict';
import test from 'node:test';
import { acpPeerReplyText } from '../acp-peer-reply.cts';

test('peer results retain complete Markdown and never read an older turn or internal reasoning', () => {
  const answer = '**Verified**\n\n' + 'Details. '.repeat(100);
  const entries = [
    { id: 'old', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    { id: 'input', type: 'message', role: 'user', content: [{ type: 'text', text: 'verify' }] },
    { id: 'reason', type: 'reasoning', role: 'assistant', content: [{ type: 'text', text: 'private' }] },
    { id: 'answer', type: 'message', role: 'assistant', content: [{ type: 'text', text: answer }] },
    { id: 'peer', type: 'message', role: 'assistant', sessionMessage: true, content: [{ type: 'text', text: 'peer message, not the answer' }] },
    { id: 'internal', type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'internal' }] },
  ];
  assert.equal(acpPeerReplyText(entries, 'input'), answer);
  assert.equal(acpPeerReplyText(entries.slice(0, 3), 'input'), '');
  assert.throws(() => acpPeerReplyText(entries, 'missing'), /anchor/);
});
