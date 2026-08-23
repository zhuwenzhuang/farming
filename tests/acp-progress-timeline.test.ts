import assert from 'node:assert/strict'
import test from 'node:test'
import { projectAcpTranscript } from '../src/components/code/acp/acp-entry-projection'
import { acpProgressFlowEntries } from '../src/components/code/acp/acp-progress-timeline'

test('flattens reasoning-only ACP evidence instead of nesting Reasoning under Reasoning', () => {
  const entries = acpProgressFlowEntries([
    { id: 'thought-1', type: 'thought' },
    { id: 'thought-2', type: 'thought' },
  ])

  assert.deepEqual(entries.map(entry => entry.kind), ['item', 'item'])
  assert.deepEqual(entries.map(entry => entry.kind === 'item' ? entry.item.id : ''), [
    'thought-1',
    'thought-2',
  ])
})

test('keeps mixed reasoning and tool evidence in original ACP order with useful thought labels', () => {
  const transcript = projectAcpTranscript({
    sessionId: 'reasoning-label-session',
    state: 'idle',
    revision: 1,
    entries: [
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Inspect the sequence' }],
      },
      {
        id: 'thought-1',
        type: 'thought',
        content: [{ type: 'text', text: '**Preparing the verification boundary**' }],
      },
      {
        id: 'tool-1',
        type: 'tool',
        title: 'Run verification',
        kind: 'execute',
        status: 'completed',
      },
      {
        id: 'thought-2',
        type: 'thought',
        content: [{ type: 'text', text: 'Checking the restored viewport.' }],
      },
      {
        id: 'answer-1',
        type: 'message',
        role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } },
        content: [{ type: 'text', text: 'Done.' }],
      },
    ],
  })
  const items = transcript.turns[0]?.processItems || []

  assert.deepEqual(items.map(item => item.id), ['thought-1', 'tool-1', 'thought-2'])
  assert.deepEqual(items.map(item => item.title), [
    'Preparing the verification boundary',
    'Run verification',
    'Checking the restored viewport.',
  ])
  const flow = acpProgressFlowEntries(items)
  assert.equal(flow.length, 1)
  assert.equal(flow[0]?.kind, 'group')
  assert.deepEqual(flow[0]?.kind === 'group' ? flow[0].items.map(item => item.id) : [], [
    'thought-1',
    'tool-1',
    'thought-2',
  ])
})

test('projects a settled ACP turn with process evidence and no final reply as missing its final reply', () => {
  const transcript = projectAcpTranscript({
    sessionId: 'missing-final-reply-session',
    state: 'idle',
    stopReason: 'end_turn',
    entries: [
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Run the checks' }],
      },
      {
        id: 'thought-1',
        type: 'thought',
        content: [{ type: 'text', text: 'Inspecting the failure boundary.' }],
      },
      {
        id: 'tool-1',
        type: 'tool',
        title: 'Run checks',
        kind: 'execute',
        status: 'completed',
      },
    ],
  })

  assert.equal(transcript.turns[0]?.status, 'missingFinalReply')
  assert.equal(transcript.turns[0]?.finalMessage, '')
})

test('keeps an ACP turn completed when process evidence has a final assistant result', () => {
  const transcript = projectAcpTranscript({
    sessionId: 'completed-final-reply-session',
    state: 'idle',
    stopReason: 'error',
    entries: [
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Run the checks' }],
      },
      {
        id: 'tool-1',
        type: 'tool',
        title: 'Run checks',
        kind: 'execute',
        status: 'completed',
      },
      {
        id: 'answer-1',
        type: 'message',
        role: 'assistant',
        _meta: { codex: { phase: 'final_answer' } },
        content: [{ type: 'text', text: 'Checks completed.' }],
      },
    ],
  })

  assert.equal(transcript.turns[0]?.status, 'completed')
  assert.equal(transcript.turns[0]?.finalMessage, 'Checks completed.')
})

test('keeps an active ACP turn with process evidence in progress', () => {
  const transcript = projectAcpTranscript({
    sessionId: 'active-process-session',
    state: 'working',
    entries: [
      {
        id: 'user-1',
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'Run the checks' }],
      },
      {
        id: 'thought-1',
        type: 'thought',
        content: [{ type: 'text', text: 'Still checking.' }],
      },
      {
        id: 'tool-1',
        type: 'tool',
        title: 'Run checks',
        kind: 'execute',
        status: 'in_progress',
        lastActivityAt: 1_725_000_000_000,
      },
    ],
  })

  assert.equal(transcript.turns[0]?.status, 'inProgress')
  assert.equal(transcript.turns[0]?.processItems.at(-1)?.lastActivityAt, 1_725_000_000_000)
})
