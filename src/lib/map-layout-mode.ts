const STORAGE_KEY = 'farming-map-layout-mode'

export type MapLayoutMode = 'session' | 'task'

export function readMapLayoutMode(): MapLayoutMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'task' || v === 'session') return v
  } catch {
    /* ignore */
  }
  return 'session'
}

export function writeMapLayoutMode(mode: MapLayoutMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

export function toggleMapLayoutMode(current: MapLayoutMode): MapLayoutMode {
  const next = current === 'session' ? 'task' : 'session'
  writeMapLayoutMode(next)
  return next
}
