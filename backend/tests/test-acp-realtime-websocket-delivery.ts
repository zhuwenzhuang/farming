const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const {
  broadcastAcpRealtimeToNegotiatedClients,
} = require('../acp-realtime-websocket-delivery.cjs');
const {
  acknowledgeBrowserProtocolExtensions,
  offerBrowserProtocolExtensions,
} = require('../browser-protocol-websocket-handshake.cjs');
const {
  ACP_REALTIME_PROTOCOL_EXTENSION,
  AVAILABLE_PROTOCOL_EXTENSIONS,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  protocolCompatible,
  validateClientMessage,
} = require('../../shared/browser-protocol.js');

type ObservedClient = {
  messages: Array<Record<string, unknown>>;
  socket: typeof WebSocket;
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
};

function serverPort(server: typeof http.Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  return address.port;
}

async function observeClient(url: string): Promise<ObservedClient> {
  const socket = new WebSocket(url);
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: Record<string, unknown>) => void;
  }> = [];
  socket.on('message', payload => {
    const message = JSON.parse(payload.toString());
    messages.push(message);
    const matching = waiters.filter(waiter => waiter.predicate(message));
    matching.forEach(waiter => waiter.resolve(message));
    matching.forEach(waiter => waiters.splice(waiters.indexOf(waiter), 1));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    messages,
    socket,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise(resolve => waiters.push({ predicate, resolve }));
    },
  };
}

async function closeClient(client: ObservedClient): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>(resolve => client.socket.once('close', resolve));
  client.socket.close();
  await closed;
}

async function run() {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  const handshakeOptions = {
    availableExtensions: AVAILABLE_PROTOCOL_EXTENSIONS,
    minProtocolVersion: MIN_PROTOCOL_VERSION,
    protocolVersion: PROTOCOL_VERSION,
  };
  wss.on('connection', socket => {
    offerBrowserProtocolExtensions(socket, handshakeOptions);
    socket.on('message', payload => {
      const validation = validateClientMessage(JSON.parse(payload.toString()));
      if (!validation.ok || validation.value.type !== 'protocol-hello') return;
      if (!protocolCompatible(validation.value.protocolVersion)) return;
      acknowledgeBrowserProtocolExtensions(socket, validation.value, handshakeOptions);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${serverPort(server)}`;
  const clients: ObservedClient[] = [];
  const event = {
    agentId: 'agent-1',
    sessionId: 'session-1',
    operationId: 'operation-1',
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0' },
  };

  try {
    const oldClient = await observeClient(url);
    clients.push(oldClient);
    const oldOffer = await oldClient.waitFor(message => (
      message.type === 'protocol-hello' && !Object.hasOwn(message, 'negotiatedExtensions')
    ));
    assert.deepStrictEqual(oldOffer.availableExtensions, [ACP_REALTIME_PROTOCOL_EXTENSION]);
    oldClient.socket.send(JSON.stringify({
      type: 'protocol-hello',
      protocolVersion: PROTOCOL_VERSION,
    }));
    const oldAck = await oldClient.waitFor(message => Object.hasOwn(message, 'negotiatedExtensions'));
    assert.deepStrictEqual(oldAck.negotiatedExtensions, []);

    const newClient = await observeClient(url);
    clients.push(newClient);
    const offer = await newClient.waitFor(message => (
      message.type === 'protocol-hello' && !Object.hasOwn(message, 'negotiatedExtensions')
    ));
    assert.deepStrictEqual(offer.availableExtensions, [ACP_REALTIME_PROTOCOL_EXTENSION]);
    assert.strictEqual(
      broadcastAcpRealtimeToNegotiatedClients(wss.clients, event, {
        extensionId: ACP_REALTIME_PROTOCOL_EXTENSION,
        openState: WebSocket.OPEN,
        protocolVersion: PROTOCOL_VERSION,
      }),
      0,
      'an event emitted after the offer but before client hello acknowledgement must be dropped',
    );
    assert.strictEqual(newClient.messages.some(message => message.type === 'acp-realtime'), false);

    newClient.socket.send(JSON.stringify({
      type: 'protocol-hello',
      protocolVersion: PROTOCOL_VERSION,
      requestedExtensions: [ACP_REALTIME_PROTOCOL_EXTENSION],
    }));
    const ack = await newClient.waitFor(message => Object.hasOwn(message, 'negotiatedExtensions'));
    assert.deepStrictEqual(ack.negotiatedExtensions, [ACP_REALTIME_PROTOCOL_EXTENSION]);
    assert.strictEqual(
      broadcastAcpRealtimeToNegotiatedClients(wss.clients, event, {
        extensionId: ACP_REALTIME_PROTOCOL_EXTENSION,
        openState: WebSocket.OPEN,
        protocolVersion: PROTOCOL_VERSION,
      }),
      1,
    );
    assert.deepStrictEqual(
      await newClient.waitFor(message => message.type === 'acp-realtime'),
      { type: 'acp-realtime', event },
    );
    assert.strictEqual(
      oldClient.messages.some(message => message.type === 'acp-realtime'),
      false,
      'an old v4 client must not receive Realtime events after another socket negotiates them',
    );

    await closeClient(newClient);
    const reconnectedClient = await observeClient(url);
    clients.push(reconnectedClient);
    await reconnectedClient.waitFor(message => (
      message.type === 'protocol-hello' && !Object.hasOwn(message, 'negotiatedExtensions')
    ));
    assert.strictEqual(
      broadcastAcpRealtimeToNegotiatedClients(wss.clients, event, {
        extensionId: ACP_REALTIME_PROTOCOL_EXTENSION,
        openState: WebSocket.OPEN,
        protocolVersion: PROTOCOL_VERSION,
      }),
      0,
      'a replacement socket must negotiate again instead of inheriting the old acknowledgement',
    );
    assert.strictEqual(reconnectedClient.messages.some(message => message.type === 'acp-realtime'), false);

    console.log('ACP Realtime production WebSocket path requires a per-socket extension acknowledgement');
  } finally {
    try {
      await Promise.all(clients.map(closeClient));
    } finally {
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
