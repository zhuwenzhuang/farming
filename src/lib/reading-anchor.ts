export type ReadingAnchor =
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
  agentKey(agentId: string, surface: 'chat' | 'terminal'): string
  fileKey(workspace: string, path: string): string
  save(anchor: ReadingAnchor): ReadingAnchor | null
  read(key: string): ReadingAnchor | null
  remove(key: string): void
  fingerprint(parts: string[]): string
  encode(anchor: ReadingAnchor): string
  importEncoded(encoded: string): ReadingAnchor | null
}

declare global {
  interface Window {
    FarmingReadingAnchors?: ReadingAnchorRuntime
  }
}

const fallbackAnchors = new Map<string, ReadingAnchor>()

function runtime() {
  return typeof window === 'undefined' ? null : window.FarmingReadingAnchors || null
}

function fallbackFingerprint(parts: string[]) {
  const value = parts.map(part => String(part || '').slice(0, 2048)).join('\u001f')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`
}

export function readingAnchorAgentKey(agentId: string, surface: 'chat' | 'terminal') {
  return runtime()?.agentKey(agentId, surface) || `agent:${agentId}:${surface}`
}

export function readingAnchorFileKey(workspace: string, path: string) {
  return runtime()?.fileKey(workspace, path) || `file:${workspace}:${path}`
}

export function saveReadingAnchor(anchor: ReadingAnchor) {
  const key = anchor.resource.kind === 'agent'
    ? readingAnchorAgentKey(anchor.resource.id, anchor.surface as 'chat' | 'terminal')
    : readingAnchorFileKey(anchor.resource.workspace, anchor.resource.path)
  const saved = runtime()?.save(anchor) || anchor
  fallbackAnchors.set(key, saved)
  return saved
}

export function readReadingAnchor(key: string) {
  return runtime()?.read(key) || fallbackAnchors.get(key) || null
}

export function clearReadingAnchor(key: string) {
  runtime()?.remove(key)
  fallbackAnchors.delete(key)
}

export function terminalReadingAnchorFingerprint(lines: string[]) {
  return runtime()?.fingerprint(lines) || fallbackFingerprint(lines)
}

export function encodeReadingAnchorForKey(key: string) {
  const anchor = readReadingAnchor(key)
  return anchor ? runtime()?.encode(anchor) || '' : ''
}

export function importSharedReadingAnchor(encoded: string | undefined) {
  if (!encoded) return null
  return runtime()?.importEncoded(encoded) || null
}
