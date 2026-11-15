import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAcpTranscript } from '../src/components/code/acp/acp-entry-projection'
import { AcpSessionState } from '../backend/acp-session-state.cts'
import { acpTranscriptEntries } from '../backend/acp-transcript.cts'

const text = (value: string) => [{ type: 'text', text: value }]
const input = { id: 'input', type: 'message', role: 'user', content: text('Verify the command') }
const reply = (id: string, value = 'Verification complete.') => ({ id, type: 'message', role: 'assistant', content: text(value) })
const thought = { id: 'thought', type: 'thought', role: 'assistant', content: text('The background command finished.') }
const entries = [input, reply('earlier'), thought, reply('final')]

for (const provider of ['agy', 'codex', 'claude', 'qwen', 'qoder', 'pi', 'opencode']) {
  test(`${provider}: repeated native replies retain identity, content and order in a disclosure`, () => {
    const turn = projectAcpTranscript({ provider, state: 'idle', entries }).turns[0]!
    assert.equal(turn.finalMessage, 'Verification complete.')
    assert.deepEqual(turn.processItems.map(item => item.id), ['acp-progress-earlier', 'thought'])
    assert.equal(turn.processItems[0]?.repeatsFinalResponse, true)
    assert.equal(turn.processItems[0]?.detail, turn.finalMessage)
    assert.equal(turn.processItems[1]?.repeatsFinalResponse, undefined)
    assert.deepEqual(projectAcpTranscript({ provider, state: 'idle', entries }).turns[0], turn)
  })
}

test('native agy background completion preserves both raw replies and folds only their presentation', () => {
  const state = new AcpSessionState({ provider: 'agy' })
  state.beginPrompt(text('Verify the command'))
  state.recordAcceptedSteer(text('Reply with the verification result'), { messageId: 'steer' })
  // Native agy emits two idless deltas separated by thought after a background
  // task completion wakes the model. These are separate replies, not snapshots.
  for (const [kind, value] of [
    ['agent_message_chunk', 'Verification complete.'],
    ['agent_thought_chunk', 'The background command finished.'],
    ['agent_message_chunk', 'Verification complete.'],
  ]) state.applyMessageChunk({ content: { type: 'text', text: value } }, kind)
  state.completePrompt()
  assert.equal(state.entries.filter(entry => entry.role === 'assistant' && entry.type === 'message').length, 2)
  const turn = projectAcpTranscript({ state: 'idle', entries: state.entries }).turns[0]!
  assert.equal(turn.processItems.filter(item => item.repeatsFinalResponse).length, 1)
  assert.equal(turn.finalMessage, 'Verification complete.')
})

test('matching thought remains a thought with its full original body', () => {
  const turn = projectAcpTranscript({ state: 'idle', entries: [input,
    { ...thought, content: text('Verification complete.') }, reply('final')] }).turns[0]!
  assert.equal(turn.processItems[0]?.type, 'thought')
  assert.equal(turn.processItems[0]?.repeatsFinalResponse, true)
  assert.equal(turn.processItems[0]?.detail, 'Verification complete.')
})

test('streaming, incomplete pages, different text, media and new inputs do not fold replies', () => {
  const steer = { ...input, id: 'steer', _meta: { farming: { steer: true } } }
  for (const session of [
    { state: 'working', entries },
    { state: 'idle', entries, includesLatest: false },
    { state: 'idle', entries, stopReason: 'cancelled' },
    { state: 'idle', entries, stopReason: 'max_tokens' },
    { state: 'idle', entries: [input, { ...reply('earlier'), transcriptContentTruncated: true }, thought, reply('final')] },
    { state: 'idle', entries: [input, reply('earlier'), thought, { ...reply('final'), transcriptContentTruncated: true }] },
    { state: 'idle', entries: [input, { id: 'retry', type: 'status', title: 'Verification complete.' }, reply('final')] },
    { state: 'idle', entries: [input, reply('earlier', 'Verification'), thought, reply('final')] },
    { state: 'idle', entries: [input, { ...reply('earlier'), content: [...text('Verification complete.'), { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }, thought, reply('final')] },
    { state: 'idle', entries: [input, reply('earlier'), thought, { ...reply('final'), content: [...text('Verification complete.'), { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }] }] },
    { state: 'idle', entries: [input, reply('earlier'), steer, thought, reply('final')] },
    { state: 'idle', entries: [input, reply('earlier'), { ...input, id: 'next' }, thought, reply('final')] },
  ]) {
    const turns = projectAcpTranscript(session).turns
    assert.equal(turns.flatMap(turn => turn.processItems).some(item => item.repeatsFinalResponse), false)
  }
})

test('bounded backend projections explicitly identify incomplete message bodies', () => {
  const projected = acpTranscriptEntries([reply('huge', 'x'.repeat(3 * 1024 * 1024))])
  assert.equal(projected[0].transcriptContentTruncated, true)
  const complete = acpTranscriptEntries([reply('short')])
  assert.equal(complete[0].transcriptContentTruncated, undefined)
})

test('explicit final-answer phases retain repeated earlier answers as disclosures', () => {
  const turn = projectAcpTranscript({ state: 'idle', entries: entries.map(entry => entry.role === 'assistant' && entry.type === 'message'
    ? { ...entry, _meta: { codex: { phase: 'final_answer' } } } : entry) }).turns[0]!
  assert.equal(turn.processItems[0]?.type, 'answer')
  assert.equal(turn.processItems[0]?.repeatsFinalResponse, true)
})
