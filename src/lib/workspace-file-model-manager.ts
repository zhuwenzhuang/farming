import type { OpenWorkspaceFile } from './workspace-open-files'
import { fetchWorkspaceFile, type WorkspaceFile } from './workspace-files'
import { normalizeWorkspaceResourcePath, workspaceFileResourceKey } from './workspace-working-copy'

const DEFAULT_MODEL_LIMIT = 32
const DEFAULT_MODEL_BYTES_LIMIT = 16 * 1024 * 1024
const DEFAULT_RESOLVE_TIMEOUT_MS = 15_000

export type WorkspaceFileReader = (
  rootId: string,
  filePath: string,
  options: { signal: AbortSignal; exactExternal?: boolean },
) => Promise<WorkspaceFile>

interface WorkspaceFileModelEntry {
  exactExternal: boolean
  file: WorkspaceFile
  openFile?: OpenWorkspaceFile
  rootId: string
  workspaceRoot?: string
}

interface PendingWorkspaceFileResolve {
  controller: AbortController
  filePath: string
  promise: Promise<WorkspaceFile>
  rootId: string
  timeout: ReturnType<typeof setTimeout>
}

export interface WorkspaceFileResolveOptions {
  exactExternal?: boolean
  reload?: boolean
  signal?: AbortSignal
  workspaceRoot?: string
}

export interface WorkspaceFileModelManagerOptions {
  maxBytes?: number
  maxModels?: number
  readFile?: WorkspaceFileReader
  resolveTimeoutMs?: number
}

export function workspaceFileModelKey(
  rootId: string,
  filePath: string,
  workspaceRoot?: string,
  exactExternal = false,
) {
  const resource = workspaceFileResourceKey(filePath, workspaceRoot)
  const accessOwner = workspaceRoot
    ? normalizeWorkspaceResourcePath(workspaceRoot)
    : rootId
  return JSON.stringify([
    accessOwner,
    resource,
    exactExternal,
  ])
}

function workspaceFileModelBytes(entry: WorkspaceFileModelEntry) {
  const contentBytes = entry.file.content.length * 2
  const draftBytes = entry.openFile && entry.openFile.draft !== entry.file.content
    ? entry.openFile.draft.length * 2
    : 0
  return contentBytes + draftBytes
}

function canResolveFromRetainedEntry(entry: WorkspaceFileModelEntry) {
  return !entry.exactExternal
    && entry.file.external !== true
    && entry.file.symbolicLink !== true
}

function waitForWorkspaceFileResolve(
  promise: Promise<WorkspaceFile>,
  signal?: AbortSignal,
) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('File open was aborted', 'AbortError'))
  return new Promise<WorkspaceFile>((resolve, reject) => {
    const abort = () => reject(new DOMException('File open was aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      file => {
        signal.removeEventListener('abort', abort)
        resolve(file)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/**
 * Owns one bounded resolved snapshot and one transport resolve per canonical
 * workspace resource. UI intent cancellation only cancels that waiter; a
 * shared resolve remains available to other waiters and the retained model.
 */
export class WorkspaceFileModelManager {
  private readonly entries = new Map<string, WorkspaceFileModelEntry>()
  private readonly pendingResolves = new Map<string, PendingWorkspaceFileResolve>()
  private readonly protectedKeys = new Set<string>()
  private readonly watchReadyRevalidationKeys = new Set<string>()
  private readonly maxBytes: number
  private readonly maxModels: number
  private readonly readFile: WorkspaceFileReader
  private readonly resolveTimeoutMs: number

  constructor(options: WorkspaceFileModelManagerOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MODEL_BYTES_LIMIT
    this.maxModels = options.maxModels ?? DEFAULT_MODEL_LIMIT
    this.readFile = options.readFile ?? fetchWorkspaceFile
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS
  }

  resolve(rootId: string, filePath: string, options: WorkspaceFileResolveOptions = {}) {
    const key = workspaceFileModelKey(
      rootId,
      filePath,
      options.workspaceRoot,
      options.exactExternal === true,
    )
    const retained = this.entries.get(key)
    if (retained && !options.reload && canResolveFromRetainedEntry(retained)) {
      this.touch(key, retained)
      this.watchReadyRevalidationKeys.add(key)
      return waitForWorkspaceFileResolve(Promise.resolve(retained.file), options.signal)
    }

    let pending = this.pendingResolves.get(key)
    if (!pending) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.resolveTimeoutMs)
      const promise = this.readFile(rootId, filePath, {
        signal: controller.signal,
        exactExternal: options.exactExternal,
      }).then(file => {
        this.acceptFile(rootId, file, options)
        return file
      }).finally(() => {
        clearTimeout(timeout)
        if (this.pendingResolves.get(key)?.promise === promise) {
          this.pendingResolves.delete(key)
        }
      })
      pending = { controller, filePath, promise, rootId, timeout }
      this.pendingResolves.set(key, pending)
    }

    return waitForWorkspaceFileResolve(pending.promise, options.signal)
  }

  acceptOpenFiles(
    retainedFiles: readonly OpenWorkspaceFile[],
    protectedFiles: readonly OpenWorkspaceFile[],
  ) {
    this.protectedKeys.clear()
    protectedFiles.forEach(file => this.protectedKeys.add(workspaceFileModelKey(
      file.agentId,
      file.file.path,
      file.workspaceRoot,
      file.exactExternal === true,
    )))
    retainedFiles.forEach(file => this.acceptOpenFile(file))
    this.prune()
  }

  retainedOpenFiles() {
    return Array.from(this.entries.values()).flatMap(entry => (
      entry.openFile ? [entry.openFile] : []
    ))
  }

  consumeWatchReadyRevalidation(
    rootId: string,
    filePath: string,
    options: Pick<WorkspaceFileResolveOptions, 'exactExternal' | 'workspaceRoot'> = {},
  ) {
    const key = workspaceFileModelKey(
      rootId,
      filePath,
      options.workspaceRoot,
      options.exactExternal === true,
    )
    return this.watchReadyRevalidationKeys.delete(key)
  }

  invalidateRoot(rootId: string) {
    for (const [key, entry] of this.entries) {
      if (entry.rootId !== rootId) continue
      this.entries.delete(key)
      this.watchReadyRevalidationKeys.delete(key)
    }
    for (const [key, pending] of this.pendingResolves) {
      if (pending.rootId !== rootId) continue
      pending.controller.abort()
      clearTimeout(pending.timeout)
      this.pendingResolves.delete(key)
    }
  }

  invalidateFile(rootId: string, filePath: string) {
    for (const [key, entry] of this.entries) {
      if (entry.rootId !== rootId || entry.file.path !== filePath) continue
      this.entries.delete(key)
      this.watchReadyRevalidationKeys.delete(key)
    }
    for (const [key, pending] of this.pendingResolves) {
      if (pending.rootId !== rootId || pending.filePath !== filePath) continue
      pending.controller.abort()
      clearTimeout(pending.timeout)
      this.pendingResolves.delete(key)
    }
  }

  dispose() {
    this.pendingResolves.forEach(pending => {
      pending.controller.abort()
      clearTimeout(pending.timeout)
    })
    this.pendingResolves.clear()
    this.entries.clear()
    this.protectedKeys.clear()
    this.watchReadyRevalidationKeys.clear()
  }

  private acceptFile(
    rootId: string,
    file: WorkspaceFile,
    options: Pick<WorkspaceFileResolveOptions, 'exactExternal' | 'workspaceRoot'>,
  ) {
    const key = workspaceFileModelKey(
      rootId,
      file.path,
      options.workspaceRoot,
      options.exactExternal === true,
    )
    const previous = this.entries.get(key)
    this.watchReadyRevalidationKeys.delete(key)
    this.touch(key, {
      exactExternal: options.exactExternal === true,
      file,
      openFile: previous?.openFile,
      rootId,
      workspaceRoot: options.workspaceRoot,
    })
    this.prune()
  }

  private acceptOpenFile(openFile: OpenWorkspaceFile) {
    const key = workspaceFileModelKey(
      openFile.agentId,
      openFile.file.path,
      openFile.workspaceRoot,
      openFile.exactExternal === true,
    )
    this.touch(key, {
      exactExternal: openFile.exactExternal === true,
      file: openFile.file,
      openFile,
      rootId: openFile.agentId,
      workspaceRoot: openFile.workspaceRoot,
    })
  }

  private touch(key: string, entry: WorkspaceFileModelEntry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private prune() {
    let bytes = Array.from(this.entries.values())
      .reduce((total, entry) => total + workspaceFileModelBytes(entry), 0)
    while (this.entries.size > this.maxModels || bytes > this.maxBytes) {
      const removable = Array.from(this.entries.entries())
        .find(([key]) => !this.protectedKeys.has(key))
      if (!removable) break
      const [key, entry] = removable
      this.entries.delete(key)
      bytes -= workspaceFileModelBytes(entry)
    }
  }
}
