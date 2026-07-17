import type {
  TerminalControllerClientMessage,
  TerminalControllerMessage,
} from '@/types/messages'

type GeometryListener = (message: TerminalControllerMessage) => void
type GeometryTransport = (message: TerminalControllerClientMessage) => boolean

let transport: GeometryTransport | null = null
const listeners = new Map<string, Set<GeometryListener>>()

export function setTerminalGeometryTransport(next: GeometryTransport | null) {
  transport = next
}

export function sendTerminalGeometryMessage(message: TerminalControllerClientMessage) {
  return transport?.(message) === true
}

export function subscribeTerminalGeometry(attachmentId: string, listener: GeometryListener) {
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

export function publishTerminalGeometry(message: TerminalControllerMessage) {
  listeners.get(message.attachmentId)?.forEach(listener => listener(message))
}
