export type LanguageServerStatus = 'connected' | 'ready' | 'unavailable' | 'error'

export interface LanguageServerConnection {
  id: string
  root: string
  workspace: string
}

export interface LanguageServerCapability {
  status: LanguageServerStatus
  source: 'managed' | 'vscode'
  detail: string
  vscodeVersion: string
  features: string[]
  workspaces: string[]
  connections: LanguageServerConnection[]
}

export interface LanguageServerPosition {
  line: number
  character: number
}

export interface LanguageServerRange {
  start: LanguageServerPosition
  end: LanguageServerPosition
}

export interface LanguageServerLocation {
  path: string
  range: LanguageServerRange | null
  selectionRange?: LanguageServerRange | null
  originSelectionRange?: LanguageServerRange | null
}

export interface LanguageServerSymbol extends Partial<LanguageServerLocation> {
  name: string
  detail: string
  kind: number
  children?: LanguageServerSymbol[]
}

export interface LanguageServerHierarchyItem extends LanguageServerLocation {
  id: string
  name: string
  detail: string
  kind: number
}

export interface LanguageServerDiagnostic {
  message: string
  severity: number
  range: LanguageServerRange
  source?: string
  code?: string | number
}

export type LanguageServerMethod =
  | 'hover'
  | 'definition'
  | 'references'
  | 'implementation'
  | 'documentSymbols'
  | 'workspaceSymbols'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls'
  | 'prepareTypeHierarchy'
  | 'supertypes'
  | 'subtypes'
  | 'diagnostics'

export interface LanguageServerRequest {
  rootId: string
  method: LanguageServerMethod
  filePath?: string
  position?: LanguageServerPosition
  query?: string
  itemId?: string
}
