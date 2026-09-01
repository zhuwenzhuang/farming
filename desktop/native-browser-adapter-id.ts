import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ADAPTER_ID_FILE = 'native-browser-adapter-id'
const ADAPTER_ID_PREFIX = 'desktop-browser-'
const ADAPTER_ID_RE = /^desktop-browser-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function desktopNativeBrowserAdapterIdFile(userDataDir: string) {
  return path.join(path.resolve(userDataDir), ADAPTER_ID_FILE)
}

function persistedAdapterId(file: string): string {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return ADAPTER_ID_RE.test(value) ? value : ''
  } catch {
    return ''
  }
}

/**
 * The adapter id is Desktop-profile identity, not renderer-document state.
 * Persisting it lets a relaunch select the same Desktop target while the
 * backend still treats all pre-relaunch native tabs as lost leases.
 */
export function resolveDesktopNativeBrowserAdapterId(userDataDir: string): string {
  const file = desktopNativeBrowserAdapterIdFile(userDataDir)
  const existing = persistedAdapterId(file)
  if (existing) return existing

  const adapterId = `${ADAPTER_ID_PREFIX}${crypto.randomUUID()}`
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  let descriptor: number | null = null
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, `${adapterId}\n`, 'utf8')
    fs.fdatasyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporary, file)
    fs.chmodSync(file, 0o600)
    return adapterId
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Preserve the original identity persistence failure.
      }
    }
    try {
      fs.unlinkSync(temporary)
    } catch {
      // A successful rename consumes the exact temporary path.
    }
  }
}
