import type { AcpPeerMessage } from './acp-peer-message'

export interface CommunicationExchange {
  taskId: string
  messageId: string
  contextId: string
  state: string
  source: AcpPeerMessage
  target: { agentId: string; sessionKey: string; name: string }
  text: string
  result: string
  detail: string
  updatedAt: string
  replyToTaskId?: string
}
