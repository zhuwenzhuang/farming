const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const sessionBridgePath = path.join(__dirname, '../../frontend/session-bridge.js');
  const serverPath = path.join(__dirname, '../server.cts');
  const sessionStreamProtocolPath = path.join(__dirname, '../session-stream-protocol.cts');
  const sessionPreviewDeliveryPath = path.join(__dirname, '../session-preview-delivery.cts');
  const focusScopeHandlersPath = path.join(__dirname, '../websocket-focus-scope-handlers.cts');
  const agentChangeBroadcastsPath = path.join(__dirname, '../websocket-agent-change-broadcasts.cts');
  const appPath = path.join(__dirname, '../../src/App.tsx');
  const useWebSocketPath = path.join(__dirname, '../../src/hooks/useWebSocket.ts');
  const workspacePath = path.join(__dirname, '../../src/components/CodeWorkspace.tsx');
  const codeSidebarPath = path.join(__dirname, '../../src/components/code/CodeSidebar.tsx');
  const agentRowStatePath = path.join(__dirname, '../../src/components/code/agent-row-state.ts');
  const terminalPanePath = path.join(__dirname, '../../src/components/AgentTerminalPane.tsx');
  const sessionBridge = fs.readFileSync(sessionBridgePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const sessionStreamProtocol = fs.readFileSync(sessionStreamProtocolPath, 'utf8');
  const sessionPreviewDelivery = fs.readFileSync(sessionPreviewDeliveryPath, 'utf8');
  const focusScopeHandlers = fs.readFileSync(focusScopeHandlersPath, 'utf8');
  const agentChangeBroadcasts = fs.readFileSync(agentChangeBroadcastsPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const useWebSocket = fs.readFileSync(useWebSocketPath, 'utf8');
  const workspace = fs.readFileSync(workspacePath, 'utf8');
  const codeSidebar = fs.readFileSync(codeSidebarPath, 'utf8');
  const agentRowState = fs.readFileSync(agentRowStatePath, 'utf8');
  const terminalPane = fs.readFileSync(terminalPanePath, 'utf8');

  assert(
    sessionBridge.includes('FarmingSessionBridge'),
    'session bridge should attach a global bridge object'
  );
  assert(sessionBridge.includes('createClient'), 'session bridge should expose client creation');
  assert(sessionBridge.includes('focus-agent'), 'session bridge should handle focus requests');
  assert(
    sessionBridge.includes('streamScope')
      && sessionBridge.includes('previewScope')
      && sessionBridge.includes('activityScope'),
    'session bridge should support scoped CRT terminal and activity subscriptions',
  );
  const codeFocusAgent = useWebSocket.slice(
    useWebSocket.indexOf('const focusAgent = useCallback'),
    useWebSocket.indexOf('const interruptAgent = useCallback')
  );
  assert(
    codeFocusAgent.includes('focusedAgentIdRef.current = agentId') &&
      codeFocusAgent.includes('agentActivityScopeRef.current = activityScope') &&
      codeFocusAgent.includes('agentPreviewScopeRef.current = previewScope') &&
      codeFocusAgent.includes("type: 'focus-agent',\n      agentId,\n      activityScope,") &&
      codeFocusAgent.includes('previewScope,') &&
      !codeFocusAgent.includes('streamScope') &&
      useWebSocket.includes('previewScope: agentPreviewScopeRef.current,'),
    'Farming Code should retain all terminal streams while restoring its activity and Preview view scopes',
  );
  assert(
    !useWebSocket.includes('const resizeAgent = useCallback') &&
      !app.includes('resizeAgent={ws.resizeAgent}') &&
      !workspace.includes('resizeAgent: (agentId: string, cols: number, rows: number)'),
    'Farming Code should not expose the legacy unfenced resize callback'
  );
  assert(sessionBridge.includes('resize-agent'), 'session bridge should handle resize requests');
  assert(
    sessionBridge.includes('archiveAgent(agentId)') &&
      sessionBridge.includes("type: 'archive-agent'") &&
      !sessionBridge.includes("type: 'kill-agent'"),
    'CRT KILL should use the shared Archive lifecycle transport',
  );
  assert(
    server.includes('function previewForClient(') &&
      server.includes('client.focusedAgentId !== preview.agentId') &&
      server.includes('previewSnapshot: null'),
    'the focused terminal must not receive a redundant full preview snapshot alongside its live output stream',
  );
  assert(
    server.includes("agentManager.on('agent-read', websocketAgentChangeBroadcasts.broadcastAgentRead);") &&
      agentChangeBroadcasts.includes("type: 'agent-read'") &&
      useWebSocket.includes("case 'agent-read':"),
    'read-cursor changes should travel as a small Agent delta instead of replacing the full Agent list',
  );
  assert(
    sessionBridge.includes('sendTerminalInput(agentId, input)') &&
      sessionBridge.includes("type: 'input'") &&
      !sessionBridge.includes('terminalControl') &&
      !sessionBridge.includes('leaseId') &&
      !sessionBridge.includes('fence'),
    'CRT should send direct shared terminal input without browser ownership metadata'
  );
  assert(
    !sessionBridge.includes('acknowledgeTerminalOutput') &&
      !sessionBridge.includes("type: 'terminal-output-ack'") &&
      !server.includes("case 'terminal-output-ack':"),
    'a slow browser renderer must not control shared PTY output flow'
  );
  assert(sessionBridge.includes('sendComposerMessage') && sessionBridge.includes("type: 'composer-input'"), 'CRT should route structured Agent messages through the Composer API');
  assert(
    sessionBridge.includes('interruptAgent(agentId)')
      && sessionBridge.includes("type: 'interrupt-agent'")
      && !sessionBridge.includes('...(controller || {})'),
    'CRT structured Composer should use the shared direct Agent interrupt path',
  );
  assert(
    app.includes("const projectsVisible = activeWorkspaceView === 'projects'") &&
      app.includes("activityScope: projectsVisible ? 'all' : 'none'") &&
      app.includes("previewScope: projectsVisible && activeTerminalAgent?.runtimeBinding.kind === 'terminal'\n        ? 'focused'\n        : 'none',") &&
      workspace.includes('markAgentReadIfNeeded(agent.id, true)') &&
      workspace.includes('readOutputEpoch: readCut.runtimeEpoch') &&
      workspace.includes('readOutputSeq: readCut.outputSeq') &&
      terminalPane.includes('const readCut = getReadCutNow()') &&
      terminalPane.includes('onReadLatest?.(agent.id, readCut)'),
    'Code should advance the read cursor only after the renderer exposes the latest authoritative output cut'
  );
  assert(
    server.includes('client.focusedAgentId') &&
      server.includes('deliverAcpSessionRevision(client, entry.session);') &&
      server.includes('client.acpRevisionCheckpointPending = true;') &&
      server.includes('recoverAcpSessionRevisionIfReady(ws);') &&
      useWebSocket.includes('agentId: focusedAgentIdRef.current,') &&
      useWebSocket.includes('activityScope: agentActivityScopeRef.current,'),
    'ACP revisions should follow focused browser interest, recover slow clients with one checkpoint marker, and restore focus after reconnect',
  );
  assert(
    server.includes('deliverAgentActivity(client, activity, message);') &&
      server.includes('client.activityScopeDeclared !== true') &&
      server.includes("if (scope === 'all') client.agentActivityAllCheckpointPending = true;") &&
      server.includes('client.agentActivityCheckpointPending = true;') &&
      server.includes('recoverAgentActivityIfReady(ws);') &&
      server.includes('queueAgentActivityRecovery(client);') &&
      server.includes('agentManager.getAgentActivityPayloads(Date.now())') &&
      server.includes("type: 'agent-activity-snapshot'") &&
      useWebSocket.includes("case 'agent-activity-snapshot':"),
    'Agent activity should follow browser view scope and recover with bounded focused or compact all-scope checkpoints',
  );
  assert(
    !terminalPane.includes('sessionBootstrapStateFromPayload') &&
      !terminalPane.includes('prefetchedTerminalSessionCheckpoint'),
    'Code must request the authoritative terminal checkpoint instead of treating truncated Agent list output as serialized terminal state',
  );
  assert(
    !server.includes('markUnreadForBackgroundOutput(stream.agentId)'),
    'server should not mark plain background output as unread'
  );
  assert(
    server.includes('deliverSessionStreamToClients(Array.from(wss.clients), stream') &&
      sessionStreamProtocol.includes("client.streamScope === 'focused'") &&
      server.includes('sessionPreviewScopeIncludesAgent(ws.previewScope, ws.focusedAgentId, previewAgentId)') &&
      focusScopeHandlers.includes('sessionPreviewScopeCheckpointRequired(') &&
      focusScopeHandlers.includes('ports.sendPreviewHydration(client)') &&
      focusScopeHandlers.includes('ports.declarePreviewScope(client)') &&
      server.includes('declarePreviewScope: client => declareSessionPreviewScope(client)') &&
      server.includes('sendPreviewHydration,') &&
      server.includes('PREVIEW_SCOPE_DECLARATION_WINDOW_MS') &&
      server.includes('ws.previewScopeDeclared !== true') &&
      server.includes('queueSessionPreviewHydration(') &&
      server.includes('cancelSessionPreviewHydration(ws)') &&
      server.includes("if (scope === 'none') return;") &&
      server.includes('agentManager.getPreviewPayload(ws.focusedAgentId)') &&
      server.includes('Ignoring Session preview without an exact Agent identity') &&
      sessionPreviewDelivery.includes("normalizedScope === 'none'") &&
      sessionPreviewDelivery.includes("normalizedScope !== 'focused'") &&
      sessionPreviewDelivery.includes('state.previewHydrationPending = true') &&
      sessionPreviewDelivery.includes('if (state.previewHydrationTimer) clearTimeout(state.previewHydrationTimer)'),
    'server should suppress background streams and previews for a focused CRT terminal'
  );
  assert(
    [workspace, codeSidebar, agentRowState].every(source => (
      !source.includes('previewText') && !source.includes('previewSnapshot')
    )) &&
      agentRowState.includes('agent.codexTerminalProfile?.model') &&
      agentRowState.includes('agent.terminalStatus?.runningCommand'),
    'Code Project, History, mobile, and Agent-row presentation must use lightweight Agent state rather than background Preview payloads',
  );
  const agentPatchRoute = server.slice(
    server.indexOf("app.patch(routePath(BASE_PATH, '/api/agents/:agentId')"),
    server.indexOf("app.post(routePath(BASE_PATH, '/api/agents/:agentId/fork')")
  );
  assert(
    agentPatchRoute.includes('queueAgentStateChange({ agentIds: [req.params.agentId] });') &&
      !agentPatchRoute.includes('broadcastState();'),
    'agent flag PATCH responses should coalesce one exact Agent mutation through the shared scheduler'
  );

  console.log('✓ Session bridge file is present');
}

run();
