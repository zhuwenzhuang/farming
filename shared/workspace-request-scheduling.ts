import type { LanguageServerRequestPayload, WorkspaceRequest } from './browser-protocol.js'

export type WorkspaceRequestLane = 'metadata' | 'interactive' | 'background' | 'languageServer' | 'languageServerBackground'

export const WORKSPACE_REQUEST_CONCURRENCY = { metadata: 2, interactive: 4, background: 2, languageServer: 1, languageServerBackground: 1 } as const

export function workspaceRequestLane(request: WorkspaceRequest): WorkspaceRequestLane {
  switch (request.operation) {
    case 'resolve-path':
    case 'file-link-access':
      return 'metadata'
    case 'search':
      return request.scope === 'entries' ? 'interactive' : 'background'
    case 'tree':
    case 'read-file':
    case 'save-file':
    case 'move-entry':
    case 'create-entry':
    case 'rename-entry':
    case 'delete-entry':
    case 'switch-branch':
      return 'interactive'
    default:
      return 'background'
  }
}

export function languageServerRequestLane(request: LanguageServerRequestPayload): WorkspaceRequestLane {
  // Optional semantic work must never hold a Files execution slot, even when
  // the server ignores cancellation during initialization.
  return request.operation === 'capability' || request.priority === 'background'
    ? 'languageServerBackground' : 'languageServer'
}

// One wall-clock budget covers browser admission, server admission, execution,
// and reconnect. Execution-specific subprocess caps may be shorter, never longer.
export function workspaceRequestBudget(request: WorkspaceRequest): number {
  switch (request.operation) {
    case 'resolve-path': return 5_000
    case 'file-link-access': return 5_000
    case 'tree':
    case 'read-file': return 30_000
    // Explicit content search permits the configured maximum execution time.
    case 'search': return request.scope === 'entries' ? 30_000 : 185_000
    default: return 60_000
  }
}
export type WorkspaceRequestPriority = 'interactive' | 'background'
