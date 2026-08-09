import type {
  BusinessHealthProbeMessage,
  ProtocolClientHelloMessage,
} from '../../shared/browser-protocol.js';
import type {
  WebSocketHandshakeHealthClient,
  WebSocketHandshakeHealthPorts,
} from '../websocket-handshake-health-handlers.cjs';

const assert = require('assert');
const {
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} = require('../../shared/browser-protocol.js') as typeof import('../../shared/browser-protocol.js');
const {
  createWebSocketHandshakeHealthHandlers,
} = require('../websocket-handshake-health-handlers.cjs') as typeof import('../websocket-handshake-health-handlers.cjs');

interface TestClient extends WebSocketHandshakeHealthClient {
  closes: Array<{ code?: number; reason?: string }>;
  events: string[];
  sent: string[];
}

interface TestHarness {
  healthCalls: Array<{ client: TestClient; requestId: string }>;
  handlers: ReturnType<typeof createWebSocketHandshakeHealthHandlers<TestClient>>;
  releaseHealth(): void;
}

function createClient(overrides: Partial<TestClient> = {}): TestClient {
  const client: TestClient = {
    closes: [],
    events: [],
    sent: [],
    close(code, reason) {
      client.events.push('close');
      client.closes.push({ code, reason });
    },
    send(data) {
      client.events.push('send');
      client.sent.push(data);
    },
    ...overrides,
  };
  return client;
}

function createHarness(
  portOverrides: Partial<WebSocketHandshakeHealthPorts<TestClient>> = {},
): TestHarness {
  let releaseHealth!: () => void;
  const pendingHealth = new Promise<void>(resolve => {
    releaseHealth = resolve;
  });
  const healthCalls: Array<{ client: TestClient; requestId: string }> = [];
  const ports: WebSocketHandshakeHealthPorts<TestClient> = {
    sendState(client) {
      client.events.push('state');
    },
    sendResourceSnapshots(client) {
      client.events.push('resources');
    },
    sendLanguageServerRefreshSnapshot(client) {
      client.events.push('language-server');
    },
    sendBusinessHealthResult(client, requestId) {
      client.events.push('health');
      healthCalls.push({ client, requestId });
      return pendingHealth;
    },
    ...portOverrides,
  };
  return {
    handlers: createWebSocketHandshakeHealthHandlers(ports),
    healthCalls,
    releaseHealth,
  };
}

function protocolHello(
  protocolVersion: number,
  fields: Partial<ProtocolClientHelloMessage> = {},
): ProtocolClientHelloMessage {
  return { type: 'protocol-hello', protocolVersion, ...fields };
}

function healthProbe(requestId: string): BusinessHealthProbeMessage {
  return { type: 'business-health-probe', requestId };
}

function sentMessage(client: TestClient, index = 0): Record<string, unknown> {
  return JSON.parse(client.sent[index]);
}

async function run(): Promise<void> {
  {
    const client = createClient();
    const { handlers } = createHarness();
    const version = MIN_PROTOCOL_VERSION - 1;

    handlers.protocolHello(client, protocolHello(version));

    assert.deepStrictEqual(client.events, ['send', 'close']);
    assert.deepStrictEqual(sentMessage(client), {
      type: 'protocol-error',
      protocolVersion: PROTOCOL_VERSION,
      requestId: '',
      message: `This Farming page uses protocol ${version}, but the backend requires ${MIN_PROTOCOL_VERSION}. Refresh this page or update the Farming client.`,
    });
    assert.deepStrictEqual(client.closes, [{
      code: 4002,
      reason: `Unsupported Farming protocol version ${version}`,
    }]);
    assert.strictEqual(client.protocolVersion, undefined);
  }

  {
    const client = createClient();
    const { handlers } = createHarness();
    const version = PROTOCOL_VERSION + 1;

    handlers.protocolHello(client, protocolHello(version));

    assert.deepStrictEqual(client.events, ['send', 'close']);
    assert.deepStrictEqual(sentMessage(client), {
      type: 'protocol-error',
      protocolVersion: PROTOCOL_VERSION,
      requestId: '',
      message: `This Farming page uses protocol ${version}, but the backend only supports ${PROTOCOL_VERSION}. Update and restart the Farming backend.`,
    });
    assert.deepStrictEqual(client.closes, [{
      code: 4002,
      reason: `Unsupported Farming protocol version ${version}`,
    }]);
    assert.strictEqual(client.protocolVersion, undefined);
  }

  {
    const client = createClient({
      focusedAgentId: null,
      initialStateSnapshotSent: false,
      stateScope: 'all',
    });
    const { handlers } = createHarness({
      sendState(current) {
        assert.strictEqual(current.protocolVersion, PROTOCOL_VERSION);
        assert.strictEqual(current.focusedAgentId, 'agent-focused');
        assert.strictEqual(current.stateScope, 'focused');
        current.events.push('state');
      },
    });

    handlers.protocolHello(client, protocolHello(PROTOCOL_VERSION, {
      initialFocusedAgentId: 'agent-focused',
      initialStateScope: 'focused',
    }));

    assert.strictEqual(client.protocolVersion, PROTOCOL_VERSION);
    assert.strictEqual(client.focusedAgentId, 'agent-focused');
    assert.strictEqual(client.stateScope, 'focused');
    assert.deepStrictEqual(client.events, ['state', 'resources', 'language-server']);
  }

  {
    const client = createClient({
      focusedAgentId: 'existing-agent',
      initialStateSnapshotSent: false,
      stateScope: 'focused',
    });
    const { handlers } = createHarness();

    handlers.protocolHello(client, protocolHello(PROTOCOL_VERSION, {
      initialStateScope: 'all',
    }));

    assert.strictEqual(client.focusedAgentId, 'existing-agent');
    assert.strictEqual(client.stateScope, 'focused');
    assert.deepStrictEqual(client.events, ['state', 'resources', 'language-server']);
  }

  {
    const client = createClient({
      focusedAgentId: 'existing-agent',
      initialStateSnapshotSent: true,
      stateScope: 'all',
    });
    const { handlers } = createHarness();

    handlers.protocolHello(client, protocolHello(PROTOCOL_VERSION, {
      initialFocusedAgentId: 'ignored-agent',
      initialStateScope: 'focused',
    }));

    assert.strictEqual(client.protocolVersion, PROTOCOL_VERSION);
    assert.strictEqual(client.focusedAgentId, 'existing-agent');
    assert.strictEqual(client.stateScope, 'all');
    assert.deepStrictEqual(client.events, ['resources', 'language-server']);
  }

  {
    const client = createClient({ initialStateSnapshotSent: false });
    const expected = new Error('state snapshot failed');
    const { handlers } = createHarness({
      sendState(current) {
        current.events.push('state');
        throw expected;
      },
    });

    assert.throws(
      () => handlers.protocolHello(client, protocolHello(PROTOCOL_VERSION)),
      error => error === expected,
    );
    assert.strictEqual(client.protocolVersion, PROTOCOL_VERSION);
    assert.deepStrictEqual(client.events, ['state']);
  }

  {
    const client = createClient();
    const { handlers, healthCalls } = createHarness();

    handlers.businessHealthProbe(client, healthProbe('health-before-hello'));

    assert.deepStrictEqual(client.events, ['send']);
    assert.deepStrictEqual(sentMessage(client), {
      type: 'protocol-error',
      protocolVersion: PROTOCOL_VERSION,
      requestId: 'health-before-hello',
      message: 'Business health requires a negotiated Farming protocol',
    });
    assert.deepStrictEqual(healthCalls, []);
  }

  {
    const client = createClient({ protocolVersion: PROTOCOL_VERSION });
    const { handlers, healthCalls, releaseHealth } = createHarness();

    const result = handlers.businessHealthProbe(client, healthProbe('health-after-hello'));

    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(client.events, ['health']);
    assert.strictEqual(healthCalls.length, 1);
    assert.strictEqual(healthCalls[0].client, client);
    assert.strictEqual(healthCalls[0].requestId, 'health-after-hello');
    releaseHealth();
    await Promise.resolve();
  }

  console.log('WebSocket handshake and health handlers passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
