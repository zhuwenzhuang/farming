import {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  type BusinessHealthProbeMessage,
  type ProtocolClientHelloMessage,
} from '../shared/browser-protocol.js';

interface WebSocketHandshakeHealthClient {
  focusedAgentId?: string | null;
  initialStateSnapshotSent?: boolean;
  protocolVersion?: number;
  stateScope?: 'all' | 'focused';
  close(code?: number, reason?: string): void;
  send(data: string): void;
}

interface WebSocketHandshakeHealthPorts<Client extends WebSocketHandshakeHealthClient> {
  sendState(client: Client): void;
  sendResourceSnapshots(client: Client): void;
  sendLanguageServerRefreshSnapshot(client: Client): void;
  sendBusinessHealthResult(client: Client, requestId: string): Promise<void>;
}

function createWebSocketHandshakeHealthHandlers<Client extends WebSocketHandshakeHealthClient>(
  ports: WebSocketHandshakeHealthPorts<Client>,
) {
  const protocolHello = (client: Client, message: ProtocolClientHelloMessage): void => {
    if (!protocolCompatible(message.protocolVersion)) {
      // Released clients render protocol-error messages, so deliver the
      // upgrade guidance before the terminal 4002 close reaches them.
      client.send(JSON.stringify({
        type: 'protocol-error',
        protocolVersion: PROTOCOL_VERSION,
        requestId: '',
        message: Number(message.protocolVersion) < MIN_PROTOCOL_VERSION
          ? `This Farming page uses protocol ${message.protocolVersion}, but the backend requires ${MIN_PROTOCOL_VERSION}. Refresh this page or update the Farming client.`
          : `This Farming page uses protocol ${message.protocolVersion}, but the backend only supports ${PROTOCOL_VERSION}. Update and restart the Farming backend.`,
      }));
      client.close(4002, `Unsupported Farming protocol version ${message.protocolVersion}`);
      return;
    }

    client.protocolVersion = message.protocolVersion;
    if (
      client.initialStateSnapshotSent !== true
      && message.initialStateScope === 'focused'
      && message.initialFocusedAgentId
    ) {
      client.focusedAgentId = message.initialFocusedAgentId;
      client.stateScope = 'focused';
    }
    if (client.initialStateSnapshotSent !== true) ports.sendState(client);
    ports.sendResourceSnapshots(client);
    ports.sendLanguageServerRefreshSnapshot(client);
  };

  const businessHealthProbe = (client: Client, message: BusinessHealthProbeMessage): void => {
    if (!client.protocolVersion) {
      client.send(JSON.stringify({
        type: 'protocol-error',
        protocolVersion: PROTOCOL_VERSION,
        requestId: message.requestId,
        message: 'Business health requires a negotiated Farming protocol',
      }));
      return;
    }
    void ports.sendBusinessHealthResult(client, message.requestId);
  };

  return { businessHealthProbe, protocolHello };
}

export {
  createWebSocketHandshakeHealthHandlers,
  type WebSocketHandshakeHealthClient,
  type WebSocketHandshakeHealthPorts,
};
