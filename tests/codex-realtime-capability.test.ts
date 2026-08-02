import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACP_REALTIME_PROTOCOL_EXTENSION,
  REQUESTED_PROTOCOL_EXTENSIONS,
} from '../shared/browser-protocol'
import { codexRealtimeVoiceAvailable } from '../src/components/code/codex-realtime-capability'
import { createProtocolExtensionNegotiation } from '../src/lib/browser-protocol-extension-negotiation'

test('Codex Realtime negotiation fences events until ACK and resets for reconnect', () => {
  const firstSocket = createProtocolExtensionNegotiation(
    REQUESTED_PROTOCOL_EXTENSIONS,
  )
  firstSocket.observeServerHello({
    availableExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
  })
  assert.equal(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), false)
  assert.equal(codexRealtimeVoiceAvailable(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), true), false)

  firstSocket.observeServerHello({
    negotiatedExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
  })
  assert.equal(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), false)

  firstSocket.observeServerHello({
    availableExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
    negotiatedExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
  })
  assert.equal(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), true)
  assert.equal(codexRealtimeVoiceAvailable(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), true), true)
  assert.equal(codexRealtimeVoiceAvailable(true, false), false)

  firstSocket.reset()
  assert.equal(firstSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), false)

  const reconnectedSocket = createProtocolExtensionNegotiation(
    REQUESTED_PROTOCOL_EXTENSIONS,
  )
  reconnectedSocket.observeServerHello({
    availableExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
  })
  assert.equal(reconnectedSocket.accepts(ACP_REALTIME_PROTOCOL_EXTENSION), false)
})
