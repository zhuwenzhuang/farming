import { useSyncExternalStore } from 'react'
import type { ComposerSubmissionStatus } from '@/../shared/composer-submission'

const states = new Map<string, ComposerSubmissionStatus & { requestId: string }>()
const listeners = new Set<() => void>()
let preparationSequence = 0
export function updateComposerSubmission(agentId: string, requestId: string, status: ComposerSubmissionStatus | null) {
  if (!status) {
    if (states.get(agentId)?.requestId !== requestId) return
    states.delete(agentId)
  } else {
    if (states.size >= 128 && !states.has(agentId)) states.delete(states.keys().next().value!)
    states.set(agentId, { ...status, requestId })
  }
  listeners.forEach(listener => listener())
}
export function useComposerSubmission(agentId: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => states.get(agentId), () => undefined)
}


/** Reserve the existing per-Agent submission owner while asynchronous context
 * checks run, so another Composer surface cannot submit the same draft. */
export async function prepareComposerSubmission(agentId: string, prepare: () => Promise<void>, dispatch: () => boolean | Promise<boolean>) {
  if (states.has(agentId)) return false
  const requestId = `context-${Date.now()}-${++preparationSequence}`
  updateComposerSubmission(agentId, requestId, { phase: 'preparing', updatedAt: Date.now() })
  try {
    await prepare()
    if (states.get(agentId)?.requestId !== requestId) return false
    updateComposerSubmission(agentId, requestId, null)
    return await dispatch()
  } finally {
    updateComposerSubmission(agentId, requestId, null)
  }
}
