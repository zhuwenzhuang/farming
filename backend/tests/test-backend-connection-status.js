const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  BACKEND_HEARTBEAT_STALE_MS,
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
} = require('../../shared/backend-connection-status');

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
  const connectionClassifierSource = read('shared/backend-connection-status.js');
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
    connectionStatusSource.includes('const pageVisibility = usePageVisibilitySnapshot()') &&
      connectionStatusSource.includes('if (!pageVisibility.visible) return undefined') &&
      connectionStatusSource.includes('if (!pageVisibility.visible || !isPageVisible()) return null') &&
      connectionStatusSource.includes('visibleSince: pageVisibility.visibleSince') &&
      pageVisibilitySource.includes('reducePageVisibilitySnapshot(current') &&
      appSource.includes('const pageVisible = usePageVisibility()') &&
      appSource.includes('CONTEXT_WINDOW_REFRESH_MS') &&
      appSource.includes("fetch(appPath('/api/usage'))"),
    'App should pause visible-only polling and restart heartbeat observation after the page becomes visible'
  );

  assert(
    codeWorkspaceSource.includes('const pageVisible = usePageVisibility()') &&
      codeWorkspaceSource.includes('if (!pageVisible) return undefined') &&
      codeWorkspaceSource.includes('window.setInterval(refreshAgentSessions, 5_000)') &&
      codeWorkspaceSource.includes('window.setInterval(() => setNow(Date.now()), 60_000)'),
    'Code workspace should pause session-id polling and relative-time ticks while the page is hidden'
  );

  assert(
    connectionClassifierSource.includes('BACKEND_INITIAL_CONNECT_GRACE_MS') &&
      connectionClassifierSource.includes('BACKEND_HEARTBEAT_STALE_MS') &&
      connectionClassifierSource.includes("return 'lost'") &&
      connectionClassifierSource.includes("return 'stale'") &&
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

  const backgroundMessageAt = 1_000;
  const foregroundAt = backgroundMessageAt + BACKEND_HEARTBEAT_STALE_MS + 10_000;
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), null, 'Returning from a suspended background page should restart heartbeat observation');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_HEARTBEAT_STALE_MS,
  }), 'stale', 'A visible connected page should report stale after the full observation window');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    everConnected: true,
    lastMessageAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'lost', 'A real WebSocket close should remain immediately visible');

  const hiddenSnapshot = { visible: false, visibleSince: backgroundMessageAt };
  const hiddenPageShow = reducePageVisibilitySnapshot(hiddenSnapshot, {
    eventType: 'pageshow',
    documentVisible: false,
    changedAt: foregroundAt - 1_000,
  });
  assert.strictEqual(hiddenPageShow, hiddenSnapshot, 'A background pageshow must not start visible heartbeat observation');
  const foregroundSnapshot = reducePageVisibilitySnapshot(hiddenPageShow, {
    eventType: 'visibilitychange',
    documentVisible: true,
    changedAt: foregroundAt,
  });
  assert.deepStrictEqual(foregroundSnapshot, {
    visible: true,
    visibleSince: foregroundAt,
  }, 'The actual foreground transition should atomically start a fresh observation window');
  const hiddenAgain = reducePageVisibilitySnapshot(foregroundSnapshot, {
    eventType: 'pagehide',
    documentVisible: true,
    changedAt: foregroundAt + 1_000,
  });
  assert.deepStrictEqual(hiddenAgain, {
    visible: false,
    visibleSince: foregroundAt,
  }, 'Pagehide should suppress visible-only heartbeat observation');

  console.log('test-backend-connection-status passed');
}

run();
