import type { WorkspaceFileEntry } from './workspace-files'

export type WorkspaceFileDecoration = Pick<
  WorkspaceFileEntry,
  'ignored' | 'gitStatus' | 'gitStatusLabel' | 'descendantGitStatus'
>

export interface WorkspaceFileDecorationEntry extends WorkspaceFileDecoration {
  path: string
}

const EMPTY_WORKSPACE_FILE_DECORATION: WorkspaceFileDecoration = Object.freeze({})

function sameDecoration(left: WorkspaceFileDecoration, right: WorkspaceFileDecoration) {
  return left.ignored === right.ignored
    && left.gitStatus === right.gitStatus
    && left.gitStatusLabel === right.gitStatusLabel
    && left.descendantGitStatus === right.descendantGitStatus
}

export class WorkspaceFileDecorationStore {
  private readonly decorations = new Map<string, WorkspaceFileDecoration>()
  private readonly listeners = new Map<string, Set<() => void>>()

  get(filePath: string) {
    return this.decorations.get(filePath) ?? EMPTY_WORKSPACE_FILE_DECORATION
  }

  replace(entryPaths: readonly string[], entries: readonly WorkspaceFileDecorationEntry[]) {
    const nextByPath = new Map(entries.map(entry => [entry.path, entry]))
    entryPaths.forEach(filePath => {
      const entry = nextByPath.get(filePath)
      const next: WorkspaceFileDecoration = entry
        ? {
            ...(entry.ignored ? { ignored: true } : {}),
            ...(entry.gitStatus ? { gitStatus: entry.gitStatus } : {}),
            ...(entry.gitStatusLabel ? { gitStatusLabel: entry.gitStatusLabel } : {}),
            ...(entry.descendantGitStatus ? { descendantGitStatus: entry.descendantGitStatus } : {}),
          }
        : EMPTY_WORKSPACE_FILE_DECORATION
      const previous = this.get(filePath)
      if (sameDecoration(previous, next)) return
      if (next === EMPTY_WORKSPACE_FILE_DECORATION) {
        this.decorations.delete(filePath)
      } else {
        this.decorations.set(filePath, next)
      }
      this.listeners.get(filePath)?.forEach(listener => listener())
    })
  }

  clear() {
    if (this.decorations.size === 0) return
    const changedPaths = Array.from(this.decorations.keys())
    this.decorations.clear()
    changedPaths.forEach(filePath => this.listeners.get(filePath)?.forEach(listener => listener()))
  }

  subscribe(filePath: string, listener: () => void) {
    const listeners = this.listeners.get(filePath) ?? new Set()
    listeners.add(listener)
    this.listeners.set(filePath, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(filePath)
    }
  }
}
