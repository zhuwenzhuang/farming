import { useSyncExternalStore } from 'react'

// Explicit attachment survives pane collapse, but ends with this browser
// connection. History reads and sidebar inventory do not acquire supervision.
let parents: readonly string[] = []
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => parents
export function attachSubagent(parentSessionKey: string) {
  if (!parentSessionKey || parents.includes(parentSessionKey)) return
  parents = [...parents, parentSessionKey].slice(-20)
  listeners.forEach(listener => listener())
}
export function useSubagentSupervision() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
