import { useSyncExternalStore } from 'react'

export const SHARED_NOW_TICK_MS = 1_000

type SharedNowListener = () => void

type SharedNowLease = { readonly listener: SharedNowListener }

const leases = new Set<SharedNowLease>()
let timer: ReturnType<typeof setInterval> | null = null
let now = Date.now()

function tick() {
  now = Date.now()
  for (const lease of leases) lease.listener()
}

export function subscribeSharedNow(listener: SharedNowListener): () => void {
  now = Date.now()
  if (leases.size === 0 && timer === null) {
    timer = setInterval(tick, SHARED_NOW_TICK_MS)
  }
  const lease: SharedNowLease = { listener }
  leases.add(lease)
  return () => {
    if (!leases.delete(lease)) return
    if (leases.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function getSharedNowSnapshot(): number {
  return now
}

const subscribeNothing = () => () => {}

export function useSharedNow(enabled: boolean): number {
  return useSyncExternalStore(
    enabled ? subscribeSharedNow : subscribeNothing,
    getSharedNowSnapshot,
    getSharedNowSnapshot,
  )
}
