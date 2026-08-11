const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const manager = read('backend/agent-manager.cts');
  const server = read('backend/server.cts');
  const agentSessionRouter = read('backend/agent-session-router.cts');
  const projectMutationRouter = read('backend/project-mutation-router.cts');
  const sessionStore = read('backend/farming-session-store.cts');
  const workspace = read('src/components/CodeWorkspace.tsx');
  const sidebar = read('src/components/code/CodeSidebar.tsx');
  const reorderHook = read('src/components/code/useAgentReorder.ts');
  const model = read('src/components/code/model.ts');
  const styles = [
    read('src/styles/main.css'),
    read('src/styles/agent-list.css'),
    read('src/styles/sidebar.css'),
  ].join('\n');

  assert(manager.includes('this.registerAgentRecord('));
  assert.strictEqual((manager.match(/this\.agents\.set\(/g) || []).length, 1);
  assert.strictEqual((manager.match(/this\.agents\.delete\(/g) || []).length, 1);
  assert.strictEqual((manager.match(/this\.deleteAgentRecord\(/g) || []).length, 4);
  assert(manager.includes('this.agentOrderAllocator.observe(agent)'));
  assert(manager.includes('this.agentOrderAllocator.observe(this.agents.get(updatedAgentId))'));
  assert(manager.includes('staged.pinnedOrder = this.agentOrderAllocator.nextPinnedOrder()'));
  assert(!manager.includes('ensureAgentOrders(agentRecord, Array.from(this.agents.values()))'));
  assert(!manager.includes('nextPinnedOrder(Array.from(this.agents.values()))'));
  assert(manager.includes('reorderProjectAgent(agentId'));
  assert(manager.includes('reorderPinnedAgent(agentId'));
  assert(manager.includes('reorderAgent(agentId'));
  assert(manager.includes('projectOrder: finiteOrder(agent.projectOrder)'));
  assert(manager.includes('pinnedOrder: finiteOrder(agent.pinnedOrder)'));
  assert(server.includes("app.post(routePath(BASE_PATH, '/api/agents/:agentId/reorder')"));
  assert(server.includes("app.use(routePath(BASE_PATH, '/api/projects'), createProjectMutationRouter("));
  assert(projectMutationRouter.includes("router.post('/reorder'"));
  assert(agentSessionRouter.includes("router.patch('/agent-sessions/:provider/:sessionId'"));
  assert(agentSessionRouter.includes('displayPinned'));
  assert(sessionStore.includes('projectOrder: typeof agent.projectOrder'));
  assert(sessionStore.includes('pinnedOrder: typeof agent.pinnedOrder'));

  assert(!workspace.includes('agentListOrderRef'));
  assert(workspace.includes('const reorderSidebarAgent = useCallback'));
  assert(workspace.includes('const reorderSidebarProject = useCallback'));
  assert(workspace.includes("appPath(`/api/agent-sessions/${encodeURIComponent(contextMenuAgentSession.provider)}"));
  assert(sidebar.includes('isCompactViewport, isTouchInputViewport'));
  assert(sidebar.includes("from '@/lib/responsive-mode'"));
  assert(sidebar.includes('draggable={(reorderable && !isTouchInputViewport()) || undefined}'));
  assert(sidebar.includes('if (draggedRef.current)'));
  assert(!sidebar.includes('code-agent-drag-handle'));
  assert(sidebar.includes('useAgentReorder('));
  assert(sidebar.includes('onProjectDragStart'));
  assert(reorderHook.includes('onReorder('));
  assert(sidebar.includes('const sortedAgents = project.agents.filter(agent => !agent.pinned)'));
  assert(sidebar.includes('(a.agent.pinnedOrder ?? 0) - (b.agent.pinnedOrder ?? 0)'));
  assert(model.includes('(b.projectOrder ?? 0) - (a.projectOrder ?? 0)'));
  assert(styles.includes('.code-agent-row.drop-before::before'));
  assert(styles.includes('.code-agent-row.drop-after::after'));
  assert(styles.includes('.code-project-row.drop-before::before'));
  assert(styles.includes('background: var(--code-accent)'));
  assert(!styles.includes('background: #d97757'));

  console.log('agent order wiring assertions passed');
}

run();
