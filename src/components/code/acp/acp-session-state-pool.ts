import type { AcpSessionSnapshot } from './types'

export interface AcpSessionStateSnapshot {
  session: AcpSessionSnapshot | null
  error: string
}

interface AcpSessionStateRecord {
  agentId: string
  snapshot: AcpSessionStateSnapshot
  subscribers: Set<() => void>
  retained: boolean
}

const records = new Map<string, AcpSessionStateRecord>()

function createRecord(agentId: string): AcpSessionStateRecord {
  return {
    agentId,
    snapshot: { session: null, error: '' },
    subscribers: new Set(),
    retained: false,
  }
}

function recordFor(agentId: string) {
  let record = records.get(agentId)
  if (!record) {
    record = createRecord(agentId)
    records.set(agentId, record)
  }
  return record
}

function updateRecord(
  agentId: string,
  update: (current: AcpSessionStateSnapshot) => AcpSessionStateSnapshot,
) {
  const record = recordFor(agentId)
  const next = update(record.snapshot)
  if (next === record.snapshot) return
  record.snapshot = next
  record.subscribers.forEach(listener => listener())
}

export function retainAcpSessionStates(agentIds: readonly string[]) {
  const retained = new Set(agentIds)
  for (const agentId of retained) recordFor(agentId).retained = true
  for (const record of [...records.values()]) {
    record.retained = retained.has(record.agentId)
    if (!record.retained && record.subscribers.size === 0) records.delete(record.agentId)
  }
}

export function subscribeAcpSessionState(agentId: string, listener: () => void) {
  const record = recordFor(agentId)
  record.subscribers.add(listener)
  return () => {
    record.subscribers.delete(listener)
    if (!record.retained && record.subscribers.size === 0) records.delete(agentId)
  }
}

export function getAcpSessionStateSnapshot(agentId: string) {
  return recordFor(agentId).snapshot
}

export function updateAcpSessionState(
  agentId: string,
  update: (current: AcpSessionStateSnapshot) => AcpSessionStateSnapshot,
) {
  updateRecord(agentId, update)
}

export function discardAcpSessionState(agentId: string) {
  const record = records.get(agentId)
  if (!record) return
  record.retained = false
  record.snapshot = { session: null, error: '' }
  record.subscribers.forEach(listener => listener())
  if (record.subscribers.size === 0) records.delete(agentId)
}

export function resetAcpSessionStatePoolForTests() {
  records.clear()
}
