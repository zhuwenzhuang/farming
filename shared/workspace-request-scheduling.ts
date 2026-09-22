import type { LanguageServerRequestPayload, WorkspaceRequest } from './browser-protocol.js'

export type WorkspaceRequestLane = 'interactive' | 'background'

export const WORKSPACE_REQUEST_CONCURRENCY = { interactive: 4, background: 2 } as const

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
  return request.operation === 'capability' || request.priority === 'background' ? 'background' : 'interactive'
}
