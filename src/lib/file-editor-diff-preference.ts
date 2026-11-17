import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'farming.code.fileEditor.diff'
export type FileEditorDiffLayout = 'inline' | 'split'
let preference: { enabled: boolean; layout: FileEditorDiffLayout } = { enabled: false, layout: 'inline' }
try {
  const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
  if (stored && typeof stored.enabled === 'boolean' && (stored.layout === 'inline' || stored.layout === 'split')) preference = stored
} catch { /* Storage may be unavailable. */ }
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const snapshot = () => preference

export function setFileEditorDiffEnabled(value: boolean) {
  setFileEditorDiffMode(value ? preference.layout : 'off')
}

export function setFileEditorDiffMode(mode: FileEditorDiffLayout | 'off') {
  const next = { enabled: mode !== 'off', layout: mode === 'off' ? preference.layout : mode }
  if (next.enabled === preference.enabled && next.layout === preference.layout) return
  preference = next
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preference)) } catch { /* Retain the in-memory preference. */ }
  listeners.forEach(listener => listener())
}

export function useFileEditorDiffEnabled() {
  return useFileEditorDiffPreference().enabled
}

export function useFileEditorDiffPreference() {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
