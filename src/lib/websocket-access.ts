import type { ClientMessage } from '@/types/messages'

export type WebSocketAccessMode = 'unknown' | 'owner' | 'read-only'

const READ_ONLY_CLIENT_MESSAGE_TYPES = new Set<ClientMessage['type']>([
  'business-health-probe',
  'focus-agent',
  'protocol-hello',
  'state-resync',
  'terminal-checkpoint-request',
  'watch-acp-transcripts',
  'unwatch-workspace-files',
  'watch-workspace-files',
  'workspace-request',
  'workspace-cancel',
])

const READ_ONLY_SILENT_MESSAGE_TYPES = new Set<ClientMessage['type']>(['resize-agent'])

export function outgoingWebSocketMessageDisposition(
  accessMode: WebSocketAccessMode,
  message: ClientMessage,
): 'queue' | 'send' | 'silent' {
  if (accessMode === 'unknown') return 'queue'
  if (accessMode === 'read-only' && READ_ONLY_SILENT_MESSAGE_TYPES.has(message.type)) {
    return 'silent'
  }
  return 'send'
}

export function replayableWebSocketMessage(
  accessMode: Exclude<WebSocketAccessMode, 'unknown'>,
  message: ClientMessage,
) {
  return accessMode === 'owner' || READ_ONLY_CLIENT_MESSAGE_TYPES.has(message.type)
}
