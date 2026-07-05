const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const sessionBridgePath = path.join(__dirname, '../../frontend/session-bridge.js');
  const serverPath = path.join(__dirname, '../server.js');
  const appPath = path.join(__dirname, '../../src/App.tsx');
  const workspacePath = path.join(__dirname, '../../src/components/CodeWorkspace.tsx');
  const sessionBridge = fs.readFileSync(sessionBridgePath, 'utf8');
  const server = fs.readFileSync(serverPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const workspace = fs.readFileSync(workspacePath, 'utf8');

  assert(
    sessionBridge.includes('FarmingSessionBridge'),
    'session bridge should attach a global bridge object'
  );
  assert(sessionBridge.includes('createClient'), 'session bridge should expose client creation');
  assert(sessionBridge.includes('focus-agent'), 'session bridge should handle focus requests');
  assert(sessionBridge.includes('resize-agent'), 'session bridge should handle resize requests');
  assert(
    server.includes('agentManager.setAgentUnread(data.agentId, false)'),
    'server should clear unread state when a client focuses an agent'
  );
  assert(
    app.includes('if (activeTerminalId !== agentId)') &&
      app.includes('ws.focusAgent(agentId)') &&
      workspace.includes('if (agent?.unread) onUpdateAgentFlags(agentId, { unread: false })'),
    'App should clear unread state over HTTP when opening an agent so refresh/reconnect windows do not keep stale unread dots'
  );
  assert(
    !server.includes('markUnreadForBackgroundOutput(stream.agentId)'),
    'server should not mark plain background output as unread'
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
