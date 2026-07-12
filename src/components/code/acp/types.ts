export interface AcpAvailableCommand {
  name: string
  description: string
  input?: { hint?: string } | null
}

export interface AcpSessionMode {
  id: string
  name: string
  description?: string | null
}

export interface AcpSessionConfigSelectOption {
  value: string
  name: string
  description?: string | null
}

export interface AcpSessionConfigSelectGroup {
  group: string
  name: string
  options: AcpSessionConfigSelectOption[]
}

interface AcpSessionConfigBase {
  id: string
  name: string
  description?: string | null
  category?: string | null
}

export interface AcpSessionConfigSelect extends AcpSessionConfigBase {
  type: 'select'
  currentValue: string
  options: Array<AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup>
}

export interface AcpSessionConfigBoolean extends AcpSessionConfigBase {
  type: 'boolean'
  currentValue: boolean
}

export type AcpSessionConfigOption = AcpSessionConfigSelect | AcpSessionConfigBoolean

export interface AcpSessionSnapshot {
  sessionId: string
  state: string
  error: string
  stopReason: string
  availableCommands: AcpAvailableCommand[]
  currentModeId: string
  modes?: {
    currentModeId: string
    availableModes: AcpSessionMode[]
  } | null
  configOptions: AcpSessionConfigOption[]
  usage?: {
    totalTokens?: number
    inputTokens?: number
    outputTokens?: number
    thoughtTokens?: number | null
  } | null
}
