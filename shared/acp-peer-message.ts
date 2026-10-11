/** Presentation provenance, never a permission grant or a session ownership claim. */
export interface AcpPeerMessage {
  version: 1
  direction: 'incoming'
  senderAddress: string
  senderSessionId?: string
  senderTaskId?: string
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
    ...(bounded('senderSessionId') ? { senderSessionId: bounded('senderSessionId') } : {}),
    ...(bounded('senderTaskId') ? { senderTaskId: bounded('senderTaskId') } : {}),
    ...(bounded('senderName', 240) ? { senderName: bounded('senderName', 240) } : {}),
    ...(bounded('timestamp', 80) ? { timestamp: bounded('timestamp', 80) } : {}),
    ...(source.bodyUnavailable === 'encrypted' ? { bodyUnavailable: 'encrypted' } : {}),
  }
}
