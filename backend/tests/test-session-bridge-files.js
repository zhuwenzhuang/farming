const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const sessionBridgePath = path.join(__dirname, '../../frontend/session-bridge.js');
  const serverPath = path.join(__dirname, '../server.js');
  const appPath = path.join(__dirname, '../../src/App.tsx');
  const useWebSocketPath = path.join(__dirname, '../../src/hooks/useWebSocket.ts');
  const workspacePath = path.join(__dirname, '../../src/components/CodeWorkspace.tsx');
  const sessionBridge = fs.readFileSync(sessionBridgePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const useWebSocket = fs.readFileSync(useWebSocketPath, 'utf8');
  const workspace = fs.readFileSync(workspacePath, 'utf8');

  assert(
    sessionBridge.includes('FarmingSessionBridge'),
    'session bridge should attach a global bridge object'
  );
  assert(sessionBridge.includes('createClient'), 'session bridge should expose client creation');
  assert(sessionBridge.includes('focus-agent'), 'session bridge should handle focus requests');
  assert(sessionBridge.includes('streamScope') && sessionBridge.includes('previewScope'), 'session bridge should support scoped CRT terminal subscriptions');
  const codeFocusAgent = useWebSocket.slice(
    useWebSocket.indexOf('const focusAgent = useCallback'),
    useWebSocket.indexOf('const resizeAgent = useCallback')
  );
  assert(
    codeFocusAgent.includes("sendMessage({ type: 'focus-agent', agentId") &&
      !codeFocusAgent.includes('streamScope') &&
      !codeFocusAgent.includes('previewScope'),
    'Farming Code should retain the default all-stream subscription behavior'
  );
  assert(sessionBridge.includes('resize-agent'), 'session bridge should handle resize requests');
  assert(sessionBridge.includes('sendComposerMessage') && sessionBridge.includes("type: 'composer-input'"), 'CRT should route structured Agent messages through the Composer API');
  assert(sessionBridge.includes('interruptAgent') && sessionBridge.includes("type: 'interrupt-agent'"), 'CRT structured Composer should expose the shared Agent interrupt path');
  assert(
    app.includes('if (activeTerminalId !== agentId)') &&
      app.includes('ws.focusAgent(agentId)') &&
      workspace.includes('onUpdateAgentFlags(agentId, { readAttentionSeq: attentionSeq })'),
    'App should advance the read cursor over HTTP only after the latest agent output is actually viewed'
  );
  assert(
    !server.includes('markUnreadForBackgroundOutput(stream.agentId)'),
    'server should not mark plain background output as unread'
  );
  assert(
    server.includes("client.streamScope === 'focused'") &&
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
