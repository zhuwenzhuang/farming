const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const appSource = read('src/App.tsx');
  const codeWorkspaceSource = read('src/components/CodeWorkspace.tsx');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const pageVisibilitySource = read('src/hooks/usePageVisibility.ts');
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
    pageVisibilitySource.includes("document.addEventListener('visibilitychange', updateVisibility)") &&
      pageVisibilitySource.includes("window.addEventListener('pagehide', updateVisibility)") &&
      pageVisibilitySource.includes("window.addEventListener('pageshow', updateVisibility)") &&
      !webSocketSource.includes('usePageVisibility') &&
      !webSocketSource.includes('isPageVisible') &&
      !webSocketSource.includes('if (!pageVisible)') &&
      webSocketSource.includes('Keep it alive in hidden tabs') &&
      webSocketSource.includes('let disposed = false') &&
      webSocketSource.includes('if (disposed) return') &&
      webSocketSource.includes('if (disposed || wsRef.current !== ws) return'),
    'WebSocket hook should keep Chat live in hidden pages and guard cleanup-triggered reconnects'
  );

  assert(
    appSource.includes('const pageVisible = usePageVisibility()') &&
      appSource.includes('if (!pageVisible) return undefined') &&
      appSource.includes('CONTEXT_WINDOW_REFRESH_MS') &&
      appSource.includes("fetch(appPath('/api/usage'))"),
    'App should pause visible-only polling such as heartbeat display, context windows, and usage while the page is hidden'
  );

  assert(
    codeWorkspaceSource.includes('const pageVisible = usePageVisibility()') &&
      codeWorkspaceSource.includes('if (!pageVisible) return undefined') &&
      codeWorkspaceSource.includes('window.setInterval(refreshAgentSessions, 5_000)') &&
      codeWorkspaceSource.includes('window.setInterval(() => setNow(Date.now()), 60_000)'),
    'Code workspace should pause session-id polling and relative-time ticks while the page is hidden'
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
