import type {
  TerminalControllerClientMessage,
  TerminalControllerMessage,
} from '@/types/messages'

type ControllerListener = (message: TerminalControllerMessage) => void
type ControllerTransport = (message: TerminalControllerClientMessage) => boolean

let transport: ControllerTransport | null = null
const listeners = new Map<string, Set<ControllerListener>>()

export function setTerminalControllerTransport(next: ControllerTransport | null) {
  transport = next
}

export function sendTerminalControllerMessage(message: TerminalControllerClientMessage) {
  return transport?.(message) === true
}

export function subscribeTerminalController(attachmentId: string, listener: ControllerListener) {
  let current = listeners.get(attachmentId)
  if (!current) {
    current = new Set()
    listeners.set(attachmentId, current)
  }
  current.add(listener)
  return () => {
    const latest = listeners.get(attachmentId)
    if (!latest) return
    latest.delete(listener)
    if (latest.size === 0) listeners.delete(attachmentId)
  }
}

export function publishTerminalController(message: TerminalControllerMessage) {
  listeners.get(message.attachmentId)?.forEach(listener => listener(message))
}
