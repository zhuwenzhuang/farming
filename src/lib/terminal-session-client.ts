import type { TerminalSessionClientMessage } from '@/types/messages'

type TerminalSessionTransport = (message: TerminalSessionClientMessage) => boolean

let transport: TerminalSessionTransport | null = null

export function setTerminalSessionTransport(next: TerminalSessionTransport | null) {
  transport = next
}

export function sendTerminalSessionMessage(message: TerminalSessionClientMessage) {
  return transport?.(message) === true
}
