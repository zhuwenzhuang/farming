/** Presentation provenance, never a permission grant or a session ownership claim. */
export interface AcpPeerMessage {
  version: 1
  direction: 'incoming'
  initiatedBy?: 'user'
  senderAddress: string
  senderAgentId?: string
  senderSessionKey?: string
  senderSessionId?: string
  senderTaskId?: string
  inReplyToTaskId?: string
  senderName?: string
  timestamp?: string
  bodyUnavailable?: 'encrypted'
}

export function normalizeAcpPeerMessage(value: unknown): AcpPeerMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const bounded = (key: string, limit = 512) => typeof source[key] === 'string'
    && source[key].length > 0 && source[key].length <= limit ? source[key] as string : undefined
  const senderAddress = bounded('senderAddress')
  if (source.version !== 1 || source.direction !== 'incoming' || !senderAddress) return null
  return {
    version: 1, direction: 'incoming', senderAddress,
    ...(source.initiatedBy === 'user' ? { initiatedBy: 'user' as const } : {}),
    ...(bounded('senderAgentId', 160) && bounded('senderSessionKey', 2048) ? { senderAgentId: bounded('senderAgentId', 160), senderSessionKey: bounded('senderSessionKey', 2048) } : {}),
    ...(bounded('senderSessionId') ? { senderSessionId: bounded('senderSessionId') } : {}),
    ...(bounded('inReplyToTaskId', 160) ? { inReplyToTaskId: bounded('inReplyToTaskId', 160) } : {}),
    ...(bounded('senderTaskId') ? { senderTaskId: bounded('senderTaskId') } : {}),
    ...(bounded('senderName', 240) ? { senderName: bounded('senderName', 240) } : {}),
    ...(bounded('timestamp', 80) ? { timestamp: bounded('timestamp', 80) } : {}),
    ...(source.bodyUnavailable === 'encrypted' ? { bodyUnavailable: 'encrypted' } : {}),
  }
}

/** An unavailable receipt carries no displayable body or attachments. */
export function isUnavailableAcpPeerReceipt(entry: { type?: unknown; role?: unknown; content?: unknown; _meta?: unknown }): boolean {
  if (entry.type !== 'message' || entry.role !== 'user') return false
  const meta = entry._meta && typeof entry._meta === 'object' ? entry._meta as Record<string, unknown> : {}
  if (!normalizeAcpPeerMessage(meta.peerMessage)?.bodyUnavailable) return false
  return entry.content == null || (Array.isArray(entry.content) && entry.content.every(block => (
    block?.type === 'text' && typeof block.text === 'string' && !block.text.trim()
  )))
}
