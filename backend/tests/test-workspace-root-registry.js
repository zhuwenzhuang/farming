const assert = require('assert');
const os = require('os');
const path = require('path');
const {
  GLOBAL_WORKSPACE_ROOT_ID,
  WorkspaceRootRegistry,
  rootIdForPath,
} = require('../workspace-root-registry');

const project = path.join(os.tmpdir(), 'farming-workspace-root-project');
let projectWorkspaces = [project];
let agents = [{ id: 'agent-1', cwd: project, projectWorkspace: project, isMain: false }];
const manager = {
  configManager: { getSettings: () => ({ projectWorkspaces }) },
  getState: () => ({ agents }),
  getAgentWorkspaceRoot: agentId => agents.some(agent => agent.id === agentId) ? project : null,
};
const registry = new WorkspaceRootRegistry(manager);
const rootId = rootIdForPath(project);
assert.strictEqual(registry.resolve(rootId).canonicalPath, project);
assert.strictEqual(registry.resolve('agent-1').rootId, rootId);
assert.strictEqual(registry.resolve(`__farming_project__:${encodeURIComponent(project)}`).rootId, rootId);
assert.strictEqual(registry.resolve(GLOBAL_WORKSPACE_ROOT_ID).accessPolicy.readOnly, true);
assert.throws(() => registry.resolve('wroot_missing'), /workspace root not found/);

projectWorkspaces = [];
agents = [];
assert.throws(() => registry.resolve(rootId), /workspace root not found/);
assert(!registry.list().some(root => root.rootId === rootId));
console.log('workspace root registry tests passed');
