import { acknowledgedProtocolExtensions } from '../../shared/browser-protocol.js'

export interface ProtocolExtensionServerHello {
  availableExtensions?: readonly string[]
  negotiatedExtensions?: readonly string[]
}

export interface ProtocolExtensionNegotiation {
  observeServerHello(hello: ProtocolExtensionServerHello): void
  accepts(extension: string): boolean
  reset(): void
}

export function createProtocolExtensionNegotiation(
  requestedExtensions: readonly string[],
): ProtocolExtensionNegotiation {
  let acknowledged = new Set<string>()

  return {
    observeServerHello(hello) {
      acknowledged = new Set(acknowledgedProtocolExtensions(
        requestedExtensions,
        hello.availableExtensions,
        hello.negotiatedExtensions,
      ))
    },
    accepts(extension) {
      return acknowledged.has(extension)
    },
    reset() {
      acknowledged = new Set()
    },
  }
}
