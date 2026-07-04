const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const appSource = read('src/App.tsx');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');

  assert(
    webSocketSource.includes('everConnected: boolean') &&
      webSocketSource.includes('lastMessageAt: number') &&
      webSocketSource.includes('LAST_MESSAGE_STATE_THROTTLE_MS') &&
      webSocketSource.includes('everConnected: true') &&
      webSocketSource.includes('function markBackendMessage') &&
      webSocketSource.includes('markBackendMessage()') &&
      webSocketSource.includes('event.code === 4001') &&
      webSocketSource.includes('Farming token expired or is invalid'),
    'WebSocket state should expose whether the backend was ever connected and when the last backend message arrived'
  );

  assert(
    appSource.includes('BACKEND_INITIAL_CONNECT_GRACE_MS') &&
      appSource.includes('BACKEND_HEARTBEAT_STALE_MS') &&
      appSource.includes("return 'lost'") &&
      appSource.includes("return 'stale'") &&
      appSource.includes('data-testid="connection-status"') &&
      appSource.includes('backendConnectionMessage'),
    'App should classify initial connecting, disconnected, and stale backend heartbeat states'
  );

  assert(
    copySource.includes('backendConnecting') &&
      copySource.includes('backendConnectionLost') &&
      copySource.includes('backendHeartbeatLost') &&
      copySource.includes('没有收到 Farming 后端心跳'),
    'Connection status copy should cover both English and Chinese backend heartbeat states'
  );

  assert(
    stylesSource.includes('.connection-status.stale') &&
      stylesSource.includes('.connection-status-dot') &&
      stylesSource.includes('bottom: calc(env(safe-area-inset-bottom, 0px) + 86px)'),
    'Connection status should have a visible Code-style banner and a mobile-safe position'
  );

  console.log('test-backend-connection-status passed');
}

run();
