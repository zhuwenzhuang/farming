import { useSyncExternalStore } from 'react'
import type { CodeCopy } from './copy'
const key = 'farming.composer-input-preferences'
const defaults = { foldLongPaste: true, optimizeImages: false }
let cached = defaults
let loaded = false
const listeners = new Set<() => void>()
export function readComposerInputPreferences() {
  if (!loaded && typeof localStorage !== 'undefined') {
    loaded = true
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || '{}')
      cached = { foldLongPaste: parsed.foldLongPaste !== false, optimizeImages: parsed.optimizeImages === true }
    } catch { /* Storage is optional; the in-memory preference still works. */ }
  }
  return cached
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function ComposerInputPreferences({ copy }: { copy: CodeCopy }) {
  const preferences = useSyncExternalStore(subscribe, readComposerInputPreferences, () => defaults)
  return <>{(['foldLongPaste', 'optimizeImages'] as const).map(option => <button key={option} type="button" role="menuitemcheckbox" aria-checked={preferences[option]}
    data-testid={`composer-${option}`} onClick={() => {
      cached = { ...preferences, [option]: !preferences[option] }
      try { localStorage.setItem(key, JSON.stringify(cached)) } catch { /* Keep session preference. */ }
      listeners.forEach(listener => listener())
    }}><span>{copy[option]}</span><small>{preferences[option] ? '✓' : '—'}</small></button>)}</>
}
