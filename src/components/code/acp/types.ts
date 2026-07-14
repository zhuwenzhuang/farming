export interface AcpAvailableCommand {
  name: string
  description: string
  input?: { hint?: string } | null
}

export interface AcpAuthMethod {
  id: string
  name: string
  description?: string | null
  type?: 'agent' | 'terminal' | 'env_var'
  link?: string | null
  args?: string[]
  env?: Record<string, string>
  vars?: Array<{ name: string; label?: string | null; secret?: boolean; optional?: boolean }>
  _meta?: Record<string, unknown>
}

export interface AcpTerminalDisplay {
  command?: string
  args?: string[]
  cwd?: string
  output?: string
  truncated?: boolean
  exitStatus?: { exitCode?: number | null; signal?: string | null } | null
  released?: boolean
  startedAt?: number
  endedAt?: number | null
  durationMs?: number
  interactive?: boolean
}

export interface AcpAuthTerminal {
  terminalId: string
  methodId: string
  name: string
  state: 'running' | 'completed' | 'failed' | string
  error?: string
  terminal?: AcpTerminalDisplay | null
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
  provider?: string
  agentInfo?: {
    name?: string
    title?: string
    version?: string
  } | null
  sessionId: string
  state: string
  error: string
  stopReason: string
  errorKind?: string
  authMethods?: AcpAuthMethod[]
  authTerminal?: AcpAuthTerminal | null
  availableCommands: AcpAvailableCommand[]
  currentModeId: string
  modes?: {
    currentModeId: string
    availableModes: AcpSessionMode[]
  } | null
  configOptions: AcpSessionConfigOption[]
  usage?: {
    used: number
    size: number
    cost?: {
      amount: number
      currency: string
    } | null
  } | null
}
