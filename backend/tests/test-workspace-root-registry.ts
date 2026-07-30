const assert = require('assert');
const os = require('os');
const path = require('path');
const {
  GLOBAL_WORKSPACE_ROOT_ID,
  WorkspaceRootRegistry,
  rootIdForPath,
} = require('../workspace-root-registry.cjs');

const project = path.join(os.tmpdir(), 'farming-workspace-root-project');
const agentHome = path.join(os.tmpdir(), 'farming-workspace-root-agent-home');
let projectWorkspaces = [project];
let agentHomes: Record<string, Array<{ id: string; path: string }>> = {
  codex: [{ id: 'work', path: agentHome }],
};
let agents = [{ id: 'agent-1', cwd: project, projectWorkspace: project, isMain: false }];
const manager = {
  configManager: { getSettings: () => ({ projectWorkspaces, agentHomes }) },
  getState: () => ({ agents }),
  getAgentWorkspaceRoot: agentId => agents.some(agent => agent.id === agentId) ? project : null,
};
const registry = new WorkspaceRootRegistry(manager);
const rootId = rootIdForPath(project);
assert.strictEqual(registry.resolve(rootId).canonicalPath, project);
assert.strictEqual(registry.resolve('agent-1').rootId, rootId);
assert.strictEqual(registry.resolve(`__farming_project__:${encodeURIComponent(project)}`).rootId, rootId);
assert.strictEqual(registry.resolve(GLOBAL_WORKSPACE_ROOT_ID).accessPolicy.readOnly, true);
assert.strictEqual(rootIdForPath('/'), GLOBAL_WORKSPACE_ROOT_ID);
assert.strictEqual(registry.resolve(rootIdForPath(agentHome)).kind, 'agent-home');
assert.throws(() => registry.resolve('wroot_missing'), /workspace root not found/);

projectWorkspaces = [];
agents = [];
assert.throws(() => registry.resolve(rootId), /workspace root not found/);
assert(!registry.list().some(root => root.rootId === rootId));
assert.strictEqual(registry.resolve(rootIdForPath(agentHome)).canonicalPath, agentHome);
agentHomes = {};
assert.throws(() => registry.resolve(rootIdForPath(agentHome)), /workspace root not found/);
console.log('workspace root registry tests passed');
