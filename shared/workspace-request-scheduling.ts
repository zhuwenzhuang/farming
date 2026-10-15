import type { LanguageServerRequestPayload, WorkspaceRequest } from './browser-protocol.js'

export type WorkspaceRequestLane = 'interactive' | 'background' | 'languageServer' | 'languageServerBackground'

export const WORKSPACE_REQUEST_CONCURRENCY = { interactive: 4, background: 2, languageServer: 1, languageServerBackground: 1 } as const

export function workspaceRequestLane(request: WorkspaceRequest): WorkspaceRequestLane {
  switch (request.operation) {
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
