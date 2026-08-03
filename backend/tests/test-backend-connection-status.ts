const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  BACKEND_INITIAL_CONNECT_GRACE_MS,
  classifyBackendConnection,
  reducePageVisibilitySnapshot,
} = importTsModule('shared/backend-connection-status.ts');

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
  const connectionClassifierSource = read('shared/backend-connection-status.ts');
  const copySource = read('src/components/code/copy.ts');
  const stylesSource = read('src/styles/main.css');
  const workspaceFilesSource = read('src/hooks/useWorkspaceFiles.ts');
  const workspaceChangesSource = read('src/components/files/useWorkspaceFileChanges.ts');
  const pluginsPanelSource = read('src/components/code/PluginsPanel.tsx');
  const serverSource = read('backend/server.cts');
  const livenessSource = read('shared/websocket-liveness.ts');
  const liveStatusModule = importTsModule('src/lib/backend-live-status.ts');

  assert(
      liveStatusSource.includes('everConnected: boolean') &&
      liveStatusSource.includes('lastMessageAt: number') &&
      liveStatusSource.includes('disconnectedAt: number | null') &&
      liveStatusSource.includes("'checking' | 'ready' | 'recovering' | 'failed' | 'stopping' | 'unresponsive'") &&
      webSocketSource.includes('LAST_MESSAGE_STATE_THROTTLE_MS') &&
      webSocketSource.includes('everConnected: true') &&
      webSocketSource.includes('function markBackendMessage') &&
      webSocketSource.includes('markBackendMessage()') &&
      webSocketSource.includes('updateBackendConnectionStatus') &&
      webSocketSource.includes('markBackendDisconnected()') &&
      webSocketSource.includes('event.code === 4001') &&
      webSocketSource.includes('Farming token expired or is invalid') &&
      webSocketSource.includes('event.code === 4002') &&
      webSocketSource.includes('Farming frontend and backend versions differ. Refresh this page.') &&
      webSocketSource.includes('if (!terminalError)') &&
      webSocketSource.includes('reconnectTimer = setTimeout(connect, 1000)'),
    'The isolated backend status store should track transport and business-protocol health independently'
  );

  assert(
    webSocketSource.includes("errorKind: 'recoverable'") &&
      appSource.includes("ws.errorKind === 'recoverable'") &&
      copySource.includes('backendActionPending') &&
      stylesSource.includes('.app-toast.recovering'),
    'Writes attempted during a recoverable disconnect should use a neutral notice instead of a red global toast'
  );

  assert(
    workspaceFilesSource.includes("'farming:backend-connected'") &&
      workspaceFilesSource.includes('reconnectDirectoryLoadsRef') &&
      workspaceChangesSource.includes("'farming:backend-connected'") &&
      workspaceChangesSource.includes('retryAfterReconnectRef') &&
      codeWorkspaceSource.includes('codexModelsRetryOnReconnectRef') &&
      pluginsPanelSource.includes('retryOnReconnect'),
    'Automatic backend reads should retain their loading state and retry after a recoverable reconnect'
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
    connectionStatusSource.includes('if (!pageVisibility.visible || connection.connected) return undefined') &&
      connectionStatusSource.includes('if (!pageVisibility.visible || !isPageVisible()) return null') &&
      pageVisibilitySource.includes('reducePageVisibilitySnapshot(current') &&
      appSource.includes('const pageVisible = usePageVisibility()') &&
      appSource.includes('CONTEXT_WINDOW_REFRESH_MS') &&
      appSource.includes("fetch(appPath('/api/usage'), { signal: controller.signal })"),
    'App should pause visible-only polling and restart heartbeat observation after the page becomes visible'
  );

  assert(
    codeWorkspaceSource.includes('const pageVisible = usePageVisibility()') &&
      !codeWorkspaceSource.includes('window.setInterval(refreshAgentSessions, 5_000)') &&
      codeWorkspaceSource.includes('window.setInterval(() => setNow(Date.now()), 60_000)'),
    'Code workspace should use event-driven session-id refresh and pause relative-time ticks while the page is hidden'
  );

  assert(
      connectionClassifierSource.includes('BACKEND_INITIAL_CONNECT_GRACE_MS') &&
      connectionClassifierSource.includes("'lost'") &&
      connectionClassifierSource.includes("businessStatus === 'recovering'") &&
      connectionClassifierSource.includes("'unresponsive'") &&
      connectionStatusSource.includes('data-testid="connection-status"') &&
      appSource.includes('<BackendConnectionStatus copy={copy} />'),
    'The isolated connection component should report actual disconnects and failed business probes separately'
  );

  assert(
    serverSource.includes('startWebSocketLivenessMonitor(wss') &&
      serverSource.includes("server.on('close', () => clearInterval(websocketLivenessTimer))") &&
    serverSource.includes('initializeWebSocketLiveness(ws)') &&
      serverSource.includes("case 'business-health-probe':") &&
      serverSource.includes('probeAgentManagerBusinessHealth(agentManager)') &&
      livenessSource.includes("socket.on('pong'") &&
      livenessSource.includes('socket.ping()') &&
      livenessSource.includes('socket.terminate()'),
    'The server should use ping/pong only for transport cleanup and route visible health through the business protocol'
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
      copySource.includes('backendBusinessRecovering') &&
      copySource.includes('backendBusinessUnavailable') &&
      !copySource.includes('backendHeartbeatLost') &&
      !copySource.includes('没有收到 Farming 后端心跳'),
    'Connection status copy should distinguish transport recovery from business-state failure'
  );

  assert(
    stylesSource.includes('.connection-status.business-unavailable') &&
      stylesSource.includes('.connection-status-dot') &&
      stylesSource.includes('bottom: calc(env(safe-area-inset-bottom, 0px) + 86px)'),
    'Connection status should have a visible Code-style banner and a mobile-safe position'
  );

  const backgroundMessageAt = 1_000;
  const foregroundAt = backgroundMessageAt + 30_000;
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    lastMessageAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'ready',
  }), null, 'A connected but quiet WebSocket must never be mistaken for a lost heartbeat');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    lastMessageAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'unresponsive',
  }), 'business-unavailable', 'A failed business probe should be visible even while the transport remains connected');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    lastMessageAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
    businessStatus: 'recovering',
  }), 'business-recovering', 'A responsive backend still restoring authoritative state should remain distinct from probe failure');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'connecting', 'A real WebSocket close should start with a lightweight reconnecting state');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS - 1,
  }), 'connecting', 'A brief outage should not escalate into a red failure');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS,
  }), 'lost', 'An uninterrupted outage should escalate after the full grace window');

  liveStatusModule.resetBackendConnectionStatus();
  liveStatusModule.updateBackendConnectionStatus({ connected: true, disconnectedAt: null });
  liveStatusModule.markBackendDisconnected(foregroundAt);
  assert.strictEqual(
    liveStatusModule.getBackendConnectionSnapshot().disconnectedAt,
    foregroundAt,
    'The first close should record when the outage began',
  );
  liveStatusModule.markBackendDisconnected(foregroundAt + 1_000);
  assert.strictEqual(
    liveStatusModule.getBackendConnectionSnapshot().disconnectedAt,
    foregroundAt,
    'A failed reconnect must not restart the outage grace period',
  );
  liveStatusModule.updateBackendConnectionStatus({ connected: true, disconnectedAt: null });
  liveStatusModule.markBackendDisconnected(foregroundAt + 2_000);
  assert.strictEqual(
    liveStatusModule.getBackendConnectionSnapshot().disconnectedAt,
    foregroundAt + 2_000,
    'A later outage after a successful reconnect should get a fresh timestamp',
  );
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    lastMessageAt: backgroundMessageAt,
    disconnectedAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'connecting', 'Returning from a long-suspended page should restart the lightweight reconnect window');

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
