import { useSyncExternalStore } from 'react'
import type { ComposerSubmissionStatus } from '@/../shared/composer-submission'

const states = new Map<string, ComposerSubmissionStatus & { requestId: string }>()
const listeners = new Set<() => void>()
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
