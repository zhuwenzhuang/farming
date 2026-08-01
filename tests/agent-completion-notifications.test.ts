import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY,
  agentCompletionNotificationContent,
  agentCompletionNotificationOwner,
  agentCompletionNotificationStillEligible,
  observeAgentCompletionNotificationEvents,
  readAgentCompletionNotificationsEnabled,
  saveAgentCompletionNotificationsEnabled,
} from '../src/lib/agent-completion-notifications'
import type { Agent } from '../src/types/agent'

class MemoryStorage {
  values = new Map<string, string>()

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

function agent(overrides: Partial<Agent> = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/workspace',
    status: 'running',
    runtimeBinding: {
      kind: 'acp',
      provider: 'codex',
      state: 'idle',
    },
    attentionSeq: 0,
    attentionReason: '',
    runtimeObservation: {
      kind: 'codex',
      phase: 'idle',
      confidence: 'authoritative',
      source: 'structured-runtime',
      observerVersion: 'structured-v1',
      observedAt: 0,
    },
    ...overrides,
  } as Agent
}

test('stores the browser-local completion notification preference', () => {
  const storage = new MemoryStorage()
  assert.equal(readAgentCompletionNotificationsEnabled(storage), false)
  assert.equal(saveAgentCompletionNotificationsEnabled(true, storage), true)
  assert.equal(storage.getItem(AGENT_COMPLETION_NOTIFICATIONS_STORAGE_KEY), 'true')
  assert.equal(readAgentCompletionNotificationsEnabled(storage), true)
  assert.equal(saveAgentCompletionNotificationsEnabled(false, storage), true)
  assert.equal(readAgentCompletionNotificationsEnabled(storage), false)
})

test('uses the first observed Agent state only as a notification baseline', () => {
  const cursor = new Map<string, number>()
  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [agent({ attentionSeq: 4 })]), [])

  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [agent({
    attentionSeq: 5,
    attentionReason: 'turn-complete',
    attentionSummary: 'The migration is ready to review.',
    unread: false,
  })]), [{
    agentId: 'agent-1',
    attentionSeq: 5,
    kind: 'acp-completion',
    summary: 'The migration is ready to review.',
  }])

  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [agent({
    attentionSeq: 6,
    attentionReason: 'manual-unread',
  })]), [])
  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [agent({
    attentionSeq: 6,
    attentionReason: 'turn-complete',
  })]), [])
})

test('does not notify for a new historical Agent or a turn that immediately continues', () => {
  const cursor = new Map<string, number>([['agent-1', 1]])
  const newHistoricalAgent = agent({ id: 'agent-2', attentionSeq: 9, attentionReason: 'turn-complete' })
  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [newHistoricalAgent]), [])
  assert.equal(cursor.has('agent-1'), false)

  const event = {
    agentId: 'agent-2',
    attentionSeq: 9,
    kind: 'acp-completion' as const,
    summary: '',
  }
  assert.equal(agentCompletionNotificationStillEligible(newHistoricalAgent, event), true)
  assert.equal(agentCompletionNotificationStillEligible(agent({
    id: 'agent-2',
    attentionSeq: 9,
    attentionReason: 'turn-complete',
    runtimeObservation: {
      ...newHistoricalAgent.runtimeObservation,
      phase: 'working',
    },
  }), event), false)
})

test('uses the Terminal Agent notification request instead of inferred turn completion', () => {
  const cursor = new Map<string, number>([['agent-1', 3]])
  const terminal = agent({
    attentionSeq: 4,
    attentionReason: 'turn-complete',
    runtimeBinding: { kind: 'terminal' },
  })
  assert.deepEqual(observeAgentCompletionNotificationEvents(cursor, [terminal]), [])

  const nativeNotification = agent({
    attentionSeq: 5,
    attentionReason: 'terminal-notification',
    attentionSummary: 'Codex finished item 2.',
    runtimeBinding: { kind: 'terminal' },
  })
  const [event] = observeAgentCompletionNotificationEvents(cursor, [nativeNotification])
  assert.deepEqual(event, {
    agentId: 'agent-1',
    attentionSeq: 5,
    kind: 'terminal-notification',
    summary: 'Codex finished item 2.',
  })
  assert.equal(agentCompletionNotificationStillEligible(agent({
    ...nativeNotification,
    attentionSeq: 6,
    attentionReason: 'turn-complete',
  }), event), true)
})

test('elects one hidden tab and suppresses notification when any candidate is active', () => {
  assert.equal(agentCompletionNotificationOwner([
    { tabId: 'tab-b', pageActive: false },
    { tabId: 'tab-a', pageActive: false },
  ]), 'tab-a')
  assert.equal(agentCompletionNotificationOwner([
    { tabId: 'tab-a', pageActive: false },
    { tabId: 'tab-b', pageActive: true },
  ]), null)
})

test('builds localized notification copy from the bounded Agent summary', () => {
  const target = agent({ customTitle: 'Fix login' })
  assert.deepEqual(agentCompletionNotificationContent(target, 'en', 'acp-completion', 'The login fix is ready to review.'), {
    title: 'Fix login',
    body: 'The login fix is ready to review.',
  })
  assert.deepEqual(agentCompletionNotificationContent(target, 'zh'), {
    title: 'Fix login',
    body: 'Agent 有新消息，点击返回 Farming 查看。',
  })
  assert.deepEqual(agentCompletionNotificationContent(target, 'en', 'terminal-notification', 'Tests are passing.'), {
    title: 'Fix login',
    body: 'Tests are passing.',
  })
})
