import { useEffect, useSyncExternalStore } from 'react'
import { MAX_ACP_TRANSCRIPT_INTEREST } from '../../shared/browser-protocol.js'

/** Visible transcript and control surfaces share one reference-counted interest. */
export class AcpRevisionInterestStore {
  private readonly references = new Map<string, number>()
  private readonly listeners = new Set<() => void>()
  private agentIds: readonly string[] = []

  getSnapshot = () => this.agentIds
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  acquire(agentId: string) {
    if (!agentId) return () => {}
    const count = this.references.get(agentId) || 0
    this.references.set(agentId, count + 1)
    if (count === 0) this.publish()
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.references.get(agentId) || 1) - 1
      if (remaining > 0) this.references.set(agentId, remaining)
      else {
        this.references.delete(agentId)
        this.publish()
      }
    }
  }

  private publish() {
    this.agentIds = [...this.references.keys()].sort()
    this.listeners.forEach(listener => listener())
  }
}

const visibleInterests = new AcpRevisionInterestStore()

export function useAcpRevisionInterest(agentId: string, active: boolean) {
  useEffect(() => active ? visibleInterests.acquire(agentId) : undefined, [agentId, active])
}

export function useVisibleAcpRevisionAgentIds() {
  return useSyncExternalStore(visibleInterests.subscribe, visibleInterests.getSnapshot, visibleInterests.getSnapshot)
}

export function acpRevisionWatchAgentIds(visible: readonly string[], retained: readonly string[]) {
  // Visible surfaces cannot lose their stream when the background cache is full.
  return [...new Set([...visible, ...retained])].slice(0, MAX_ACP_TRANSCRIPT_INTEREST)
}
