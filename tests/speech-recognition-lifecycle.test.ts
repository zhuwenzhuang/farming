import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isCurrentSpeechRecognition,
  ownSpeechRecognition,
  releaseSpeechRecognition,
  stopSpeechRecognition,
  type SpeechRecognitionOwner,
} from '../src/components/code/speech-recognition-lifecycle'
import type { SpeechRecognitionLike } from '../src/components/code/types'

function recognition(): SpeechRecognitionLike & { stopCalls: number } {
  return {
    continuous: false,
    interimResults: false,
    lang: 'en-US',
    onresult: null,
    onerror: null,
    onend: null,
    start() {},
    stopCalls: 0,
    stop() { this.stopCalls += 1 },
  } as SpeechRecognitionLike & { stopCalls: number }
}

test('manual stop keeps the exact recognition alive for its late final result', () => {
  const current = recognition()
  const owner: SpeechRecognitionOwner = { current, stopping: null }
  let draft = ''

  assert.equal(stopSpeechRecognition(owner, false), 'stopped')
  assert.equal(owner.current, current)
  if (isCurrentSpeechRecognition(owner, current)) draft += 'late final result'
  assert.equal(draft, 'late final result')
  assert.equal(releaseSpeechRecognition(owner, current), true)
  assert.equal(owner.current, null)
})

test('Agent switch rejects a late result from the released recognition', () => {
  const agentA = recognition()
  const owner: SpeechRecognitionOwner = { current: agentA, stopping: null }
  let agentBDraft = ''

  assert.equal(stopSpeechRecognition(owner, true), 'stopped')
  assert.equal(owner.current, null)
  if (isCurrentSpeechRecognition(owner, agentA)) agentBDraft += 'stale A result'
  assert.equal(agentBDraft, '')
})

test('old end or error callbacks cannot release a replacement recognition', () => {
  const oldRecognition = recognition()
  const replacement = recognition()
  const owner: SpeechRecognitionOwner = { current: replacement, stopping: null }

  assert.equal(releaseSpeechRecognition(owner, oldRecognition), false)
  assert.equal(owner.current, replacement)
  assert.equal(releaseSpeechRecognition(owner, replacement), true)
  assert.equal(owner.current, null)
})

test('speech end and audio end share one stop before the late final result', () => {
  const current = recognition()
  const owner: SpeechRecognitionOwner = { current: null, stopping: null }
  ownSpeechRecognition(owner, current)
  const acceptedResults: string[] = []

  assert.equal(stopSpeechRecognition(owner, false), 'stopped')
  assert.equal(stopSpeechRecognition(owner, false), 'stopping')
  assert.equal(current.stopCalls, 1)
  if (isCurrentSpeechRecognition(owner, current)) acceptedResults.push('late final result')
  assert.deepEqual(acceptedResults, ['late final result'])
  assert.equal(releaseSpeechRecognition(owner, current), true)
  assert.equal(owner.current, null)
  assert.equal(owner.stopping, null)
})
