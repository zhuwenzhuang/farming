import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { AcpSessionState } from '../acp-session-state.cts'
import { AcpRuntime } from '../acp-runtime.cts'

const update = { sessionUpdate: 'notice', severity: 'warning', title: 'Optional integration unavailable',
  description: '**Plain text**\n<em>Work continues.</em>', _meta: { source: { retained: true } } }

for (const provider of ['agy', 'codex', 'claude', 'qwen', 'qoder', 'pi', 'opencode']) {
  test(`${provider}: standard notices use the same session state`, () => {
    const state = new AcpSessionState({ provider, sessionId: 'session' })
    assert.equal(state.apply({ sessionId: 'session', update }), true)
    assert.equal(state.notices[0].title, update.title)
    assert.deepEqual(state.entries, [])
    assert.equal(state.dismissNotice(state.notices[0].id), true)
    assert.deepEqual(state.notices, [])
  })
}

test('notices are independent live feedback, isolated by session and absent from history/checkpoints', () => {
  const state = new AcpSessionState({ sessionId: 'one' })
  state.beginPrompt([{ type: 'text', text: 'Continue working' }])
  const before = state.exportCheckpoint()
  assert.equal(state.apply({ sessionId: 'other', update }), false)
  for (const severity of ['info', 'warning', 'error', '_custom']) {
    assert.equal(state.apply({ sessionId: 'one', update: { ...update, severity } }), true)
  }
  assert.equal(state.notices.length, 4)
  assert.equal(new Set(state.notices.map(notice => notice.id)).size, 4)
  assert.deepEqual(state.notices.map(({ id: _id, ...notice }) => notice),
    ['info', 'warning', 'error', '_custom'].map(severity => ({ severity, title: update.title, description: update.description, _meta: update._meta })))
  assert.deepEqual(state.entries, before.entries)
  assert.equal(state.updates.length, 0)
  assert.equal('notices' in state.exportCheckpoint(), false)
  assert.equal('notices' in state.transcriptSlice(), false)
  const restored = AcpSessionState.fromCheckpoint(state.exportCheckpoint())!
  assert.deepEqual(restored.notices, [])
  // Live diagnostics emitted during session/load remain visible.
  restored.apply({ sessionId: 'one', update }, { receivedAt: null })
  assert.equal(restored.notices.length, 1)
  const first = state.notices[0].id
  const revision = state.revision
  assert.equal(state.dismissNotice(first), true)
  assert.equal(state.revision, revision + 1)
  assert.equal(state.dismissNotice(first), false)
  assert.equal(state.notices.length, 3)
  assert.equal(state.snapshot({}, { includeEntries: false }).notices instanceof Array, true)
  assert.equal(restored.dismissNotice(first), false, 'stale runtime IDs cannot dismiss new feedback')
})

test('invalid notices cannot erase feedback and notice floods remain bounded without truncating history', () => {
  const state = new AcpSessionState({ sessionId: 'one' })
  for (const invalid of [{ ...update, title: '' }, { ...update, title: null }, { ...update, severity: 42 }]) {
    assert.equal(state.apply({ sessionId: 'one', update: invalid }), false)
  }
  for (let i = 0; i < 80; i++) state.apply({ sessionId: 'one', update: { ...update, title: String(i) } })
  assert.equal(state.notices.length, 64)
  assert.equal(state.notices[0].title, '16')
  assert.equal(state.notices.at(-1)?.title, '79')
  assert.equal(state.truncated, false)
  assert.equal(state.updates.length, 0)
  const snapshot = state.snapshot()
  ;(snapshot.notices as Array<{ title: string }>)[0].title = 'mutated'
  assert.equal(state.notices[0].title, '16')
})

test('confirmed input clears only pre-submission notices; rejection and uncertain delivery retain them', () => {
  const coalesced = new AcpSessionState({ sessionId: 'one' })
  assert.equal(coalesced.apply({ sessionId: 'one', update }), true)
  const initialId = coalesced.notices[0].id
  assert.equal(coalesced.apply({ sessionId: 'one', update }), true)
  assert.equal(coalesced.notices.length, 1, 'identical active notices must not stack duplicate banners')
  assert.notEqual(coalesced.notices[0].id, initialId)
  const inFlight = coalesced.beginPrompt([{ type: 'text', text: 'Next question' }])
  assert.equal(coalesced.apply({ sessionId: 'one', update }), true)
  assert.equal(coalesced.notices.length, 1)
  coalesced.confirmPromptInput(inFlight)
  assert.equal(coalesced.notices.length, 1, 'an identical notice re-emitted after submission must survive confirmation')

  for (const stopReason of ['error', 'cancelled']) {
    const state = new AcpSessionState({ sessionId: 'one' })
    state.apply({ sessionId: 'one', update })
    state.beginPrompt([{ type: 'text', text: 'Next question' }])
    assert.equal(state.notices.length, 1, 'admission alone is not acceptance')
    state.completePrompt(stopReason)
    assert.equal(state.notices.length, 1)
  }
  for (const confirmation of ['echo', 'response']) {
    const state = new AcpSessionState({ sessionId: 'one' })
    state.apply({ sessionId: 'one', update })
    const input = state.beginPrompt([{ type: 'text', text: 'Next question' }])
    state.apply({ sessionId: 'one', update: { ...update, title: 'New advisory' } })
    state.apply({ sessionId: 'wrong', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Next question' } } })
    assert.equal(state.notices.length, 2)
    if (confirmation === 'echo') {
      state.apply({ sessionId: 'one', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Next question' } } })
    } else state.confirmPromptInput(input)
    assert.deepEqual(state.notices.map(notice => notice.title), ['New advisory'])
    state.completePrompt('end_turn')
    assert.deepEqual(state.notices.map(notice => notice.title), ['New advisory'])
    assert.equal(state.confirmPromptInput(input), false, 'a duplicate acknowledgement cannot clear newer feedback')
  }
})

test('Steer acknowledgement clears its captured notices and preserves notices emitted while waiting', () => {
  const state = new AcpSessionState({ sessionId: 'one' })
  state.beginPrompt([{ type: 'text', text: 'Initial question' }])
  state.apply({ sessionId: 'one', update })
  const noticeIds = state.notices.map(notice => notice.id)
  state.apply({ sessionId: 'one', update: { ...update, title: 'Arrived while waiting' } })
  state.recordAcceptedSteer([{ type: 'text', text: 'Change direction' }], { messageId: 'steer-1', noticeIds })
  assert.deepEqual(state.notices.map(notice => notice.title), ['Arrived while waiting'])
})

test('real ACP transport negotiates notices, preserves successful turns, and retains only fresh load notices', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-notices-'))
  const runtime = new AcpRuntime({
    resolveLaunch: () => ({ command: process.execPath,
      args: ['--import', createRequire(path.resolve('package.json')).resolve('tsx'), path.resolve('backend/tests/fixtures/fake-acp-agent.mts')], version: 'test' }),
  })
  try {
    await runtime.prepareAgent({ agentId: 'one', provider: 'claude', cwd: root, providerHomePath: path.join(root, 'home'),
      env: { ...process.env }, approvalMode: 'full' })
    await runtime.prompt('one', [{ type: 'text', text: 'Inspect session notices' }])
    const binding = runtime.bindings.get('one')!
    assert.equal(binding.sessionState.notices.length, 4)
    assert.equal(runtime.getSession('one').state, 'idle')
    assert.equal(runtime.getSession('one').stopReason, 'end_turn')
    assert.equal(runtime.getSession('one').error, '')
    assert.equal(binding.sessionState.entries.filter(entry => entry.type === 'message' && entry.role === 'assistant').length, 1)
    const firstNoticeIds = binding.sessionState.notices.map(notice => notice.id)
    const originalPrompt = binding.connection.prompt
    try {
      binding.connection.prompt = async () => { throw new Error('Input rejected before acceptance') }
      await assert.rejects(runtime.prompt('one', [{ type: 'text', text: 'Rejected input' }]), /Input rejected/)
      assert.deepEqual(binding.sessionState.notices.map(notice => notice.id), firstNoticeIds)
      binding.connection.prompt = async () => ({ stopReason: 'cancelled' })
      await runtime.prompt('one', [{ type: 'text', text: 'Cancelled input' }])
      assert.deepEqual(binding.sessionState.notices.map(notice => notice.id), firstNoticeIds)
    } finally {
      binding.connection.prompt = originalPrompt
    }
    await runtime.prompt('one', [{ type: 'text', text: 'Inspect session notices' }])
    assert.equal(binding.sessionState.notices.length, 4, 'new notices survive successful prompt completion')
    assert.equal(binding.sessionState.notices.some(notice => firstNoticeIds.includes(notice.id)), false)
    const id = binding.sessionState.notices[0].id
    assert.throws(() => runtime.dismissNotice('one', 'wrong-session', id), /does not match/)
    runtime.dismissNotice('one', binding.sessionId, id)
    runtime.dismissNotice('one', binding.sessionId, id)
    assert.equal(binding.sessionState.notices.length, 3)
    const child = new AcpSessionState({ provider: 'claude', sessionId: 'child' })
    binding.subagentStates.set('child', child)
    runtime.clientHandlers(binding).sessionUpdate({ sessionId: 'child', update })
    assert.equal(child.notices.length, 1)
    assert.equal(binding.sessionState.notices.length, 3)
    runtime.dismissNotice('one', 'child', child.notices[0].id)
    assert.equal(child.notices.length, 0)
    runtime.clientHandlers(binding).sessionUpdate({ sessionId: 'unknown', update })
    assert.equal(binding.subagentStates.has('unknown'), false)
    await runtime.prepareAgent({ agentId: 'loaded', provider: 'claude', cwd: root,
      providerHomePath: path.join(root, 'loaded-home'), sessionId: 'loaded-session',
      env: { ...process.env, FARMING_TEST_ACP_LOAD_NOTICE: '1' }, approvalMode: 'full' })
    assert.deepEqual(runtime.bindings.get('loaded')!.sessionState.notices.map(notice => notice.title), ['Current advisory after load'])
  } finally {
    await runtime.dispose()
    await fs.rm(root, { recursive: true, force: true })
  }
})
