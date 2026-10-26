import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'farming.code.chatWideLayout.v1'
function readPreference() {
  try { return window.localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
}
let wide = readPreference()
const subscribers = new Set<{ beforeChange?: () => void; notify: () => void }>()

function applyPreference(next: boolean) {
  if (next === wide) return
  // Capture every pane before any subscriber can commit the new geometry.
  for (const subscriber of subscribers) subscriber.beforeChange?.()
  wide = next
  for (const subscriber of subscribers) subscriber.notify()
}
function onStorage(event: StorageEvent) {
  if (event.key === STORAGE_KEY || event.key === null) applyPreference(readPreference())
}
export function toggleChatWideLayout() {
  const next = !wide
  applyPreference(next)
  try { window.localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* Keep the browser's in-memory preference. */ }
}
const getSnapshot = () => wide

export function useChatWideLayout(beforeChange?: () => void) {
  const subscribe = useCallback((notify: () => void) => {
    const subscriber = { beforeChange, notify }
    if (subscribers.size === 0) window.addEventListener('storage', onStorage)
    subscribers.add(subscriber)
    return () => {
      subscribers.delete(subscriber)
      if (subscribers.size === 0) window.removeEventListener('storage', onStorage)
    }
  }, [beforeChange])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
