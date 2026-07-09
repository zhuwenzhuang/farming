const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const manager = read('backend/agent-manager.js');
  const server = read('backend/server.js');
  const sessionStore = read('backend/farming-session-store.js');
  const workspace = read('src/components/CodeWorkspace.tsx');
  const sidebar = read('src/components/code/CodeSidebar.tsx');
  const model = read('src/components/code/model.ts');
  const styles = read('src/styles/main.css');

  assert(manager.includes('ensureAgentOrders(agentRecord, Array.from(this.agents.values()))'));
  assert(manager.includes('agent.pinnedOrder = nextPinnedOrder(Array.from(this.agents.values()))'));
  assert(manager.includes('reorderProjectAgent(agentId'));
  assert(manager.includes('reorderPinnedAgent(agentId'));
  assert(manager.includes('reorderAgent(agentId'));
  assert(manager.includes('projectOrder: finiteOrder(agent.projectOrder)'));
  assert(manager.includes('pinnedOrder: finiteOrder(agent.pinnedOrder)'));
  assert(server.includes("app.post(routePath(BASE_PATH, '/api/agents/:agentId/reorder')"));
  assert(server.includes("app.patch(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId')"));
  assert(server.includes('displayPinned'));
  assert(sessionStore.includes('projectOrder: typeof agent.projectOrder'));
  assert(sessionStore.includes('pinnedOrder: typeof agent.pinnedOrder'));

  assert(!workspace.includes('agentListOrderRef'));
  assert(workspace.includes('const reorderSidebarAgent = useCallback'));
  assert(workspace.includes("appPath(`/api/agent-sessions/${encodeURIComponent(contextMenuAgentSession.provider)}"));
  assert(sidebar.includes('draggable={reorderable || undefined}'));
  assert(sidebar.includes('if (draggedRef.current)'));
  assert(!sidebar.includes('code-agent-drag-handle'));
  assert(sidebar.includes('onReorderAgent('));
  assert(sidebar.includes('const sortedAgents = project.agents.filter(agent => !agent.pinned)'));
  assert(sidebar.includes('(a.agent.pinnedOrder ?? 0) - (b.agent.pinnedOrder ?? 0)'));
  assert(model.includes('(b.projectOrder ?? 0) - (a.projectOrder ?? 0)'));
  assert(styles.includes('.code-agent-row.drop-before::before'));
  assert(styles.includes('.code-agent-row.drop-after::after'));

  console.log('agent order wiring assertions passed');
}

run();
