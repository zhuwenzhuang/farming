import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  validateServerMessage,
} from '../shared/browser-protocol.js'
import {
  advanceAgentStateSnapshot,
  agentStateDeltaDisposition,
  applyAgentStateDelta,
} from '../shared/agent-state-reducer.js'

export interface FarmingAgentStateBridge {
  MIN_PROTOCOL_VERSION: number
  PROTOCOL_VERSION: number
  advanceAgentStateSnapshot: typeof advanceAgentStateSnapshot
  agentStateDeltaDisposition: typeof agentStateDeltaDisposition
  applyAgentStateDelta: typeof applyAgentStateDelta
  protocolCompatible: typeof protocolCompatible
  validateServerMessage: typeof validateServerMessage
}

type AgentStateBridgeGlobal = typeof globalThis & {
  FarmingAgentState?: FarmingAgentStateBridge
}

(function attachAgentStateBridge(global: AgentStateBridgeGlobal) {
  global.FarmingAgentState = Object.freeze({
    MIN_PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    advanceAgentStateSnapshot,
    agentStateDeltaDisposition,
    applyAgentStateDelta,
    protocolCompatible,
    validateServerMessage,
  })
})(globalThis)
