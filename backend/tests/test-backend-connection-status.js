const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const appSource = read('src/App.tsx');
  const connectionStatusSource = read('src/components/BackendConnectionStatus.tsx');
  const codeWorkspaceSource = read('src/components/CodeWorkspace.tsx');
  const webSocketSource = read('src/hooks/useWebSocket.ts');
  const liveStatusSource = read('src/lib/backend-live-status.ts');
  const pageVisibilitySource = read('src/hooks/usePageVisibility.ts');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');

  assert(
    liveStatusSource.includes('everConnected: boolean') &&
      liveStatusSource.includes('lastMessageAt: number') &&
      webSocketSource.includes('LAST_MESSAGE_STATE_THROTTLE_MS') &&
      webSocketSource.includes('everConnected: true') &&
      webSocketSource.includes('function markBackendMessage') &&
      webSocketSource.includes('markBackendMessage()') &&
      webSocketSource.includes('updateBackendConnectionStatus') &&
      webSocketSource.includes('event.code === 4001') &&
      webSocketSource.includes('Farming token expired or is invalid'),
    'The isolated backend status store should track whether the backend was ever connected and when the last message arrived'
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
    connectionStatusSource.includes('const pageVisible = usePageVisibility()') &&
      connectionStatusSource.includes('if (!pageVisible) return undefined') &&
      appSource.includes('const pageVisible = usePageVisibility()') &&
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
    connectionStatusSource.includes('BACKEND_INITIAL_CONNECT_GRACE_MS') &&
      connectionStatusSource.includes('BACKEND_HEARTBEAT_STALE_MS') &&
      connectionStatusSource.includes("return 'lost'") &&
      connectionStatusSource.includes("return 'stale'") &&
      connectionStatusSource.includes('data-testid="connection-status"') &&
      appSource.includes('<BackendConnectionStatus copy={copy} />'),
    'The isolated connection component should classify initial connecting, disconnected, and stale states'
  );

  assert(
    !webSocketSource.includes('systemStats: SystemStats | null') &&
      webSocketSource.includes('updateBackendSystemStats') &&
      liveStatusSource.includes('useBackendSystemStats') &&
      !codeWorkspaceSource.includes('systemStats: SystemStats | null'),
    'System stats should update narrow subscribers instead of the App and CodeWorkspace state tree'
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
