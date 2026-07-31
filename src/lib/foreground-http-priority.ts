type ForegroundHttpListener = () => void

const listeners = new Set<ForegroundHttpListener>()
const FOREGROUND_HTTP_HOLD_MS = 5_000
let foregroundUntil = 0

export function requestForegroundHttpPriority() {
  foregroundUntil = Math.max(foregroundUntil, Date.now() + FOREGROUND_HTTP_HOLD_MS)
  listeners.forEach(listener => listener())
}

export function foregroundHttpPriorityActive() {
  return Date.now() < foregroundUntil
}

export function subscribeForegroundHttpPriority(listener: ForegroundHttpListener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
