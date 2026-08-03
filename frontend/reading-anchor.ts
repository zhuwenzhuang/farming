// A skin-neutral reading-location protocol. Renderers own how they resolve an
// anchor; this module owns only its stable shape and transport-safe storage.
// Chat anchors survive a browser/server restart, while terminal and file
// anchors remain tab-local. Never put terminal text in an anchor: terminal
// locations use a short fingerprint of adjacent logical lines instead.
(function installFarmingReadingAnchors(global: Window) {
  'use strict'

  type Surface = 'chat' | 'terminal' | 'file'
  type ReadingAnchor =
    | {
      version: 1
      surface: 'chat'
      resource: { kind: 'agent'; id: string }
      locator: { kind: 'message'; id: string; childId?: string }
      position: { unit: 'fraction'; value: number }
    }
    | {
      version: 1
      surface: 'terminal'
      resource: { kind: 'agent'; id: string }
      locator: { kind: 'terminal-lines'; id: string; lineCount?: number }
      position: { unit: 'row'; value: number }
    }
    | {
      version: 1
      surface: 'file'
      resource: { kind: 'file'; workspace: string; path: string }
      locator: { kind: 'file-line'; id: string }
      position: { unit: 'line-column'; value: number; column?: number }
    }

  interface ReadingAnchorRuntime {
    VERSION: 1
    agentKey(agentId: unknown, surface: unknown): string
    decode(encoded: unknown): ReadingAnchor | null
    encode(anchor: unknown): string
    fileKey(workspace: unknown, path: unknown): string
    fingerprint(parts: unknown[] | unknown): string
    importEncoded(encoded: unknown): ReadingAnchor | null
    importFromSearch(search?: string): ReadingAnchor | null
    read(key: string): ReadingAnchor | null
    remove(key: string): void
    save(anchor: unknown): ReadingAnchor | null
  }

  type AnchorRecord = Record<string, unknown>
  type AnchorWindow = Window & { FarmingReadingAnchors?: ReadingAnchorRuntime }

  const VERSION = 1 as const
  const STORAGE_PREFIX = 'farming.reading-anchor.v1:'
  const SURFACES = new Set<Surface>(['chat', 'terminal', 'file'])
  const LIMITS = { id: 512, path: 2048, workspace: 2048, encoded: 1800 }

  function isRecord(value: unknown): value is AnchorRecord {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  function boundedString(value: unknown, limit: number) {
    const text = typeof value === 'string' ? value.trim() : ''
    return text && text.length <= limit && !text.includes('\0') ? text : ''
  }

  function finiteNumber(value: unknown) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function normalizeAnchor(value: unknown): ReadingAnchor | null {
    if (!isRecord(value) || Number(value.version) !== VERSION) return null
    const surface = boundedString(value.surface, 16)
    const resource = isRecord(value.resource) ? value.resource : null
    const locator = isRecord(value.locator) ? value.locator : null
    const position = isRecord(value.position) ? value.position : null
    if (!SURFACES.has(surface as Surface) || !resource || !locator || !position) return null

    if (surface === 'file') {
      const workspace = boundedString(resource.workspace, LIMITS.workspace)
      const path = boundedString(resource.path, LIMITS.path)
      const line = finiteNumber(position.value)
      const column = finiteNumber(position.column)
      if (resource.kind !== 'file'
        || locator.kind !== 'file-line'
        || !workspace
        || !path
        || !Number.isInteger(line)
        || (line ?? 0) < 1) return null
      return {
        version: VERSION,
        surface,
        resource: { kind: 'file', workspace, path },
        locator: { kind: 'file-line', id: path },
        position: {
          unit: 'line-column',
          value: line as number,
          ...(Number.isInteger(column) && (column ?? 0) >= 1 ? { column: column as number } : {}),
        },
      }
    }

    const agentId = boundedString(resource.id, LIMITS.id)
    const locatorId = boundedString(locator.id, LIMITS.id)
    if (resource.kind !== 'agent' || !agentId || !locatorId) return null
    if (surface === 'chat') {
      const fraction = finiteNumber(position.value)
      const childId = boundedString(locator.childId, LIMITS.id)
      if (locator.kind !== 'message'
        || position.unit !== 'fraction'
        || fraction === null
        || fraction < 0
        || fraction > 1) return null
      return {
        version: VERSION,
        surface,
        resource: { kind: 'agent', id: agentId },
        locator: { kind: 'message', id: locatorId, ...(childId ? { childId } : {}) },
        position: { unit: 'fraction', value: fraction },
      }
    }

    const rowOffset = finiteNumber(position.value)
    const lineCount = finiteNumber(locator.lineCount)
    if (surface !== 'terminal'
      || locator.kind !== 'terminal-lines'
      || position.unit !== 'row'
      || !Number.isInteger(rowOffset)
      || (rowOffset ?? -1) < 0) return null
    return {
      version: VERSION,
      surface,
      resource: { kind: 'agent', id: agentId },
      locator: {
        kind: 'terminal-lines',
        id: locatorId,
        ...(Number.isInteger(lineCount) && (lineCount ?? 0) > 0 ? { lineCount: lineCount as number } : {}),
      },
      position: { unit: 'row', value: rowOffset as number },
    }
  }

  function keyFor(anchor: unknown) {
    const normalized = normalizeAnchor(anchor)
    if (!normalized) return ''
    if (normalized.resource.kind === 'file') {
      return `file:${normalized.resource.workspace}:${normalized.resource.path}`
    }
    return `agent:${normalized.resource.id}:${normalized.surface}`
  }

  function storageKey(key: string) {
    return `${STORAGE_PREFIX}${key}`
  }

  function persistentKey(key: string) {
    return key.endsWith(':chat')
  }

  function storedValue(key: string) {
    const name = storageKey(key)
    if (!persistentKey(key)) return global.sessionStorage.getItem(name)
    return global.localStorage.getItem(name) || global.sessionStorage.getItem(name)
  }

  function save(anchor: unknown) {
    const normalized = normalizeAnchor(anchor)
    const key = normalized && keyFor(normalized)
    if (!normalized || !key) return null
    try {
      const storage = persistentKey(key) ? global.localStorage : global.sessionStorage
      storage.setItem(storageKey(key), JSON.stringify(normalized))
      if (storage === global.localStorage) global.sessionStorage.removeItem(storageKey(key))
    } catch {
      // Private browsing or an exhausted browser store must not break viewing.
    }
    return normalized
  }

  function read(key: string) {
    if (!key) return null
    try {
      const parsed: unknown = JSON.parse(storedValue(key) || 'null')
      const normalized = normalizeAnchor(parsed)
      if (!normalized || keyFor(normalized) !== key) {
        if (parsed) {
          global.sessionStorage.removeItem(storageKey(key))
          if (persistentKey(key)) global.localStorage.removeItem(storageKey(key))
        }
        return null
      }
      if (persistentKey(key)) {
        global.localStorage.setItem(storageKey(key), JSON.stringify(normalized))
        global.sessionStorage.removeItem(storageKey(key))
      }
      return normalized
    } catch {
      return null
    }
  }

  function remove(key: string) {
    if (!key) return
    try {
      global.sessionStorage.removeItem(storageKey(key))
      if (persistentKey(key)) global.localStorage.removeItem(storageKey(key))
    } catch {
      // Best-effort only.
    }
  }

  function agentKey(agentId: unknown, surface: unknown) {
    return `agent:${String(agentId || '').trim()}:${String(surface)}`
  }

  function fileKey(workspace: unknown, path: unknown) {
    return `file:${String(workspace || '').trim()}:${String(path || '').trim()}`
  }

  function fingerprint(parts: unknown[] | unknown) {
    const value = (Array.isArray(parts) ? parts : [parts])
      .map(part => String(part || '').slice(0, 2048))
      .join('\u001f')
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    return `fnv1a-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`
  }

  function encode(anchor: unknown) {
    const normalized = normalizeAnchor(anchor)
    if (!normalized) return ''
    try {
      const text = JSON.stringify(normalized)
      const encoded = global.btoa(unescape(encodeURIComponent(text)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      return encoded.length <= LIMITS.encoded ? encoded : ''
    } catch {
      return ''
    }
  }

  function decode(encoded: unknown) {
    const compact = boundedString(encoded, LIMITS.encoded)
    if (!compact || !/^[A-Za-z0-9_-]+$/.test(compact)) return null
    try {
      const padded = compact.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((compact.length + 3) % 4)
      return normalizeAnchor(JSON.parse(decodeURIComponent(escape(global.atob(padded)))))
    } catch {
      return null
    }
  }

  function importEncoded(encoded: unknown) {
    const anchor = decode(encoded)
    return anchor ? save(anchor) : null
  }

  function importFromSearch(search?: string) {
    const params = new URLSearchParams(search || global.location.search || '')
    return importEncoded(params.get('fra') || '')
  }

  const anchorWindow = global as AnchorWindow
  anchorWindow.FarmingReadingAnchors = {
    VERSION,
    agentKey,
    fileKey,
    save,
    read,
    remove,
    fingerprint,
    encode,
    decode,
    importEncoded,
    importFromSearch,
  }
}(window))
