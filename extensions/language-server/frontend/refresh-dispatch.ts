import type { LanguageServerRefreshMessage } from '@/types/messages'

type RefreshConsumer = (message: LanguageServerRefreshMessage) => void

const pending = new Map<string, LanguageServerRefreshMessage>()
let consumer: RefreshConsumer | null = null
let serverEpoch = ''

export function dispatchLanguageServerRefresh(message: LanguageServerRefreshMessage) {
  if (consumer) {
    consumer(message)
    return
  }
  if (message.serverEpoch !== serverEpoch) {
    serverEpoch = message.serverEpoch
    pending.clear()
  }
  const key = `${message.rootId}\0${message.workspace}\0${message.kind}`
  const previous = pending.get(key)
  if (!previous || previous.revision < message.revision) pending.set(key, message)
}

export function registerLanguageServerRefreshConsumer(next: RefreshConsumer) {
  consumer = next
  for (const message of pending.values()) next(message)
  pending.clear()
}
