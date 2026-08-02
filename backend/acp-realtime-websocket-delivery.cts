interface RealtimeWebSocketClient {
  negotiatedProtocolExtensions?: Set<string>;
  protocolVersion?: number;
  readyState: number;
  send(data: string): void;
}

interface RealtimeWebSocketDeliveryOptions {
  extensionId: string;
  openState: number;
  protocolVersion: number;
}

export function broadcastAcpRealtimeToNegotiatedClients(
  clients: Iterable<RealtimeWebSocketClient>,
  event: unknown,
  options: RealtimeWebSocketDeliveryOptions,
): number {
  const message = JSON.stringify({ type: 'acp-realtime', event });
  let delivered = 0;
  for (const client of clients) {
    if (
      client.readyState !== options.openState
      || client.protocolVersion !== options.protocolVersion
      || client.negotiatedProtocolExtensions?.has(options.extensionId) !== true
    ) continue;
    client.send(message);
    delivered += 1;
  }
  return delivered;
}
