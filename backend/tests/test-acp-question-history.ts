import assert from 'node:assert/strict'
import { AcpSessionState } from '../acp-session-state.cjs'
import { projectAcpTranscript } from '../../src/components/code/acp/acp-entry-projection'
import { acpProgressFlowEntries } from '../../src/components/code/acp/acp-progress-timeline'

const state = new AcpSessionState({ sessionId: 'question-session' })
state.beginPrompt('Check the tests')
const say = (text: string) => state.apply({ sessionId: 'question-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } })
say('Before asking')
const question = state.pushEntry({ id: 'question-one', type: 'question', message: 'Which scope?', status: 'pending' })
say('Continued without an answer')
state.completePrompt('end_turn')
const transcript = projectAcpTranscript(state.snapshot({ state: 'idle' }))
assert.deepEqual(transcript.turns[0]?.processItems.map(item => item.type), ['progress', 'question'])
assert.equal(transcript.turns[0]?.finalMessage, 'Continued without an answer')
assert.deepEqual(acpProgressFlowEntries(transcript.turns[0]!.processItems).map(entry => entry.kind), ['item', 'item'])
const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!
assert.equal(restored.pendingQuestionEntries.get('question-one')?.message, 'Which scope?')
state.beginPrompt('A later turn')
say('Later answer')
state.completePrompt('end_turn')
question.status = 'answered'
question.answer = 'Core tests'
state.touchEntry(question)
const settled = projectAcpTranscript(state.snapshot({ state: 'idle' }))
assert.equal(settled.turns.length, 2)
assert.equal(settled.turns[0]?.processItems[1]?.question?.answer, 'Core tests')
assert.equal(settled.turns[1]?.processItems.some(item => item.question), false)
const settledRestore = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!
assert.equal(settledRestore.pendingQuestionEntries.size, 0, 'settled history must not create a live pending request')
assert.equal(projectAcpTranscript(settledRestore.snapshot()).turns[0]?.processItems[1]?.question?.status, 'answered')
console.log('ACP question chronology and checkpoint tests passed')
