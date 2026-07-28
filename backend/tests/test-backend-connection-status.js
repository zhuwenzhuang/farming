const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  BACKEND_INITIAL_CONNECT_GRACE_MS,
  BACKEND_HEARTBEAT_FAILURE_MS,
  BACKEND_HEARTBEAT_STALE_MS,
  BACKEND_OBSERVER_LAG_RESET_MS,
  advanceBackendObservation,
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
  const workspaceFilesSource = read('src/hooks/useWorkspaceFiles.ts');
  const workspaceChangesSource = read('src/components/files/useWorkspaceFileChanges.ts');
  const pluginsPanelSource = read('src/components/code/PluginsPanel.tsx');

  assert(
      liveStatusSource.includes('everConnected: boolean') &&
      liveStatusSource.includes('lastMessageAt: number') &&
      liveStatusSource.includes('disconnectedAt: number | null') &&
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
      connectionStatusSource.includes('if (!pageVisibility.visible) return undefined') &&
      connectionStatusSource.includes('if (!pageVisibility.visible || !isPageVisible()) return null') &&
      connectionStatusSource.includes('Math.max(pageVisibility.visibleSince, observation.continuousSince)') &&
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
      connectionClassifierSource.includes('BACKEND_HEARTBEAT_FAILURE_MS') &&
      connectionClassifierSource.includes('BACKEND_HEARTBEAT_STALE_MS') &&
      connectionClassifierSource.includes("'lost'") &&
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
  }), 'connecting', 'A missing heartbeat should start with the lightweight recovery state');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_HEARTBEAT_FAILURE_MS,
  }), 'stale', 'A missing heartbeat should escalate only after the full failure window');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    everConnected: true,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'connecting', 'A real WebSocket close should start with a lightweight reconnecting state');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    everConnected: true,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS - 1,
  }), 'connecting', 'A brief outage should not escalate into a red failure');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    everConnected: true,
    lastMessageAt: foregroundAt,
    disconnectedAt: foregroundAt,
    visibleSince: foregroundAt,
    now: foregroundAt + BACKEND_INITIAL_CONNECT_GRACE_MS,
  }), 'lost', 'An uninterrupted outage should escalate after the full grace window');
  assert.strictEqual(classifyBackendConnection({
    connected: false,
    everConnected: true,
    lastMessageAt: backgroundMessageAt,
    disconnectedAt: backgroundMessageAt,
    visibleSince: foregroundAt,
    now: foregroundAt,
  }), 'connecting', 'Returning from a long-suspended page should restart the lightweight reconnect window');

  const continuousObservation = advanceBackendObservation({
    now: foregroundAt,
    continuousSince: foregroundAt,
  }, foregroundAt + 1_000);
  assert.deepStrictEqual(continuousObservation, {
    now: foregroundAt + 1_000,
    continuousSince: foregroundAt,
  }, 'A normal observer tick should preserve the continuous foreground window');
  const resumedObservation = advanceBackendObservation(
    continuousObservation,
    continuousObservation.now + BACKEND_OBSERVER_LAG_RESET_MS + 1
  );
  assert.deepStrictEqual(resumedObservation, {
    now: continuousObservation.now + BACKEND_OBSERVER_LAG_RESET_MS + 1,
    continuousSince: continuousObservation.now + BACKEND_OBSERVER_LAG_RESET_MS + 1,
  }, 'A delayed observer tick should start a fresh window instead of blaming backend heartbeat');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: foregroundAt,
    visibleSince: resumedObservation.continuousSince,
    now: resumedObservation.now,
  }), null, 'Main-thread suspension should not immediately report a false backend heartbeat failure');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: foregroundAt,
    visibleSince: resumedObservation.continuousSince,
    now: resumedObservation.now + BACKEND_HEARTBEAT_STALE_MS,
  }), 'connecting', 'A full uninterrupted observation window should first report lightweight recovery');
  assert.strictEqual(classifyBackendConnection({
    connected: true,
    everConnected: true,
    lastMessageAt: foregroundAt,
    visibleSince: resumedObservation.continuousSince,
    now: resumedObservation.now + BACKEND_HEARTBEAT_FAILURE_MS,
  }), 'stale', 'A continued heartbeat failure should eventually escalate');

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
