const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const sessionBridgePath = path.join(__dirname, '../../frontend/session-bridge.js');
  const serverPath = path.join(__dirname, '../server.js');
  const sessionStreamProtocolPath = path.join(__dirname, '../session-stream-protocol.js');
  const appPath = path.join(__dirname, '../../src/App.tsx');
  const useWebSocketPath = path.join(__dirname, '../../src/hooks/useWebSocket.ts');
  const workspacePath = path.join(__dirname, '../../src/components/CodeWorkspace.tsx');
  const terminalPanePath = path.join(__dirname, '../../src/components/AgentTerminalPane.tsx');
  const sessionBridge = fs.readFileSync(sessionBridgePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const sessionStreamProtocol = fs.readFileSync(sessionStreamProtocolPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const useWebSocket = fs.readFileSync(useWebSocketPath, 'utf8');
  const workspace = fs.readFileSync(workspacePath, 'utf8');
  const terminalPane = fs.readFileSync(terminalPanePath, 'utf8');

  assert(
    sessionBridge.includes('FarmingSessionBridge'),
    'session bridge should attach a global bridge object'
  );
  assert(sessionBridge.includes('createClient'), 'session bridge should expose client creation');
  assert(sessionBridge.includes('focus-agent'), 'session bridge should handle focus requests');
  assert(sessionBridge.includes('streamScope') && sessionBridge.includes('previewScope'), 'session bridge should support scoped CRT terminal subscriptions');
  const codeFocusAgent = useWebSocket.slice(
    useWebSocket.indexOf('const focusAgent = useCallback'),
    useWebSocket.indexOf('const killAgent = useCallback')
  );
  assert(
    codeFocusAgent.includes("sendMessage({ type: 'focus-agent', agentId") &&
      !codeFocusAgent.includes('streamScope') &&
      !codeFocusAgent.includes('previewScope'),
    'Farming Code should retain the default all-stream subscription behavior'
  );
  assert(
    !useWebSocket.includes('const resizeAgent = useCallback') &&
      !app.includes('resizeAgent={ws.resizeAgent}') &&
      !workspace.includes('resizeAgent: (agentId: string, cols: number, rows: number)'),
    'Farming Code should not expose the legacy unfenced resize callback'
  );
  assert(sessionBridge.includes('resize-agent'), 'session bridge should handle resize requests');
  assert(
    sessionBridge.includes('sendTerminalInput(agentId, input, terminalControl)') &&
      sessionBridge.includes("type: 'input'") &&
      sessionBridge.includes('...terminalControl') &&
      !sessionBridge.includes('sendInput(agentId, input)'),
    'CRT should send terminal input only with the active fencing proof'
  );
  assert(
    sessionBridge.includes('acknowledgeTerminalOutput(agentId, charCount, controller)') &&
      sessionBridge.includes("type: 'terminal-output-ack'") &&
      server.includes("case 'terminal-output-ack':") &&
      server.includes('terminalControllerCoordinator.acknowledgeOutput(ws, data)'),
    'terminal renderer acknowledgements should use the fenced owner path'
  );
  assert(sessionBridge.includes('sendComposerMessage') && sessionBridge.includes("type: 'composer-input'"), 'CRT should route structured Agent messages through the Composer API');
  assert(
    sessionBridge.includes('interruptAgent(agentId, controller)')
      && sessionBridge.includes("type: 'interrupt-agent'")
      && sessionBridge.includes('...(controller || {})'),
    'CRT structured Composer should expose the shared Agent interrupt path without bypassing a live terminal controller',
  );
  assert(
    app.includes('if (activeTerminalId !== agentId)') &&
      app.includes('ws.focusAgent(agentId)') &&
      workspace.includes('markAgentReadIfNeeded(agentId, true, readCut)') &&
      workspace.includes('readOutputEpoch: readCut.runtimeEpoch') &&
      workspace.includes('readOutputSeq: readCut.outputSeq') &&
      terminalPane.includes('const readCut = getReadCutNow()') &&
      terminalPane.includes('onReadLatest?.(agent.id, readCut)'),
    'Code should advance the read cursor only after the renderer exposes the latest authoritative output cut'
  );
  assert(
    !terminalPane.includes('sessionBootstrapStateFromPayload') &&
      !terminalPane.includes('bootstrapState,'),
    'Code must fetch the authoritative /session-view checkpoint instead of treating truncated Agent list output as serialized terminal state',
  );
  assert(
    !server.includes('markUnreadForBackgroundOutput(stream.agentId)'),
    'server should not mark plain background output as unread'
  );
  assert(
    server.includes('deliverSessionStreamToClients(wss.clients, stream') &&
      sessionStreamProtocol.includes("client.streamScope === 'focused'") &&
      server.includes("client.previewScope !== 'none'"),
    'server should suppress background streams and previews for a focused CRT terminal'
  );
  const agentPatchRoute = server.slice(
    server.indexOf("app.patch(routePath(BASE_PATH, '/api/agents/:agentId')"),
    server.indexOf("app.post(routePath(BASE_PATH, '/api/agents/:agentId/fork')")
  );
  assert(
    agentPatchRoute.includes('scheduleBroadcastState();') &&
      !agentPatchRoute.includes('broadcastState();'),
    'agent flag PATCH responses should coalesce state broadcasts through the normal manager update path'
  );

  console.log('✓ Session bridge file is present');
}

run();
