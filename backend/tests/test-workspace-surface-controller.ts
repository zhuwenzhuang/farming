const assert = require('assert');
const {
  currentWorkspaceSurface,
  planWorkspaceSurfaceRestore,
  resolveWorkspaceFileIdentityForAgents,
  WorkspaceSurfaceRestoreAdmission,
} = require('../../src/components/code/useWorkspaceSurfaceController.ts');
const {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
} = require('../../src/lib/global-workspace-files.ts');
const { projectFilesWorkspaceId } = require('../../src/lib/project-workspaces.ts');

function agent(id, workspace, extra = {}) {
  return {
    id,
    cwd: workspace,
    projectWorkspace: workspace,
    status: 'running',
    ...extra,
  };
}

function run() {
  const sourceProviderSessionKey = 'agent-session:codex:source';
  const sourceAgent = agent('agent-source', '/repo/one', {
    providerSessionKey: sourceProviderSessionKey,
  });
  const siblingAgent = agent('agent-sibling', '/repo/one', {
    providerSessionKey: 'agent-session:codex:sibling',
  });
  const otherAgent = agent('agent-other', '/repo/two');
  const mainAgent = agent('agent-main', '/farming', { isMain: true });
  const activeAgents = [sourceAgent, siblingAgent, otherAgent];

  const projectIdentity = resolveWorkspaceFileIdentityForAgents(
    projectFilesWorkspaceId('/repo/one'),
    siblingAgent.id,
    activeAgents,
    mainAgent,
  );
  assert.strictEqual(projectIdentity.filesId, projectFilesWorkspaceId('/repo/one'));
  assert.strictEqual(projectIdentity.workspaceRoot, '/repo/one');
  assert.strictEqual(projectIdentity.sourceAgentId, siblingAgent.id);
  assert.strictEqual(
    resolveWorkspaceFileIdentityForAgents(
      projectFilesWorkspaceId('/repo/one'),
      otherAgent.id,
      activeAgents,
      mainAgent,
    ).sourceAgentId,
    undefined,
    'a requested source Agent from another workspace must not own the file surface',
  );
  assert.strictEqual(
    resolveWorkspaceFileIdentityForAgents(
      sourceAgent.id,
      siblingAgent.id,
      activeAgents,
      mainAgent,
    ).sourceAgentId,
    siblingAgent.id,
    'an Agent-keyed legacy surface should canonicalize onto its Project while preserving an exact sibling owner',
  );
  const globalIdentity = resolveWorkspaceFileIdentityForAgents(
    GLOBAL_WORKSPACE_FILES_AGENT_ID,
    mainAgent.id,
    activeAgents,
    mainAgent,
  );
  assert.strictEqual(globalIdentity.workspaceRoot, GLOBAL_WORKSPACE_FILES_ROOT);
  assert.strictEqual(globalIdentity.sourceAgentId, mainAgent.id);

  const resolveIdentity = (filesId, sourceAgentId) => resolveWorkspaceFileIdentityForAgents(
    filesId,
    sourceAgentId,
    activeAgents,
    mainAgent,
  );
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: { kind: 'agent', agentId: sourceAgent.id },
      activeAgents,
      agentInventoryComplete: false,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: true,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    { kind: 'wait' },
    'Agent restore must wait for the authoritative inventory boundary',
  );
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: {
        kind: 'agent',
        agentId: 'stale-id',
        providerSessionKey: sourceProviderSessionKey,
        workspace: '/repo/two',
      },
      activeAgents,
      agentInventoryComplete: true,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: true,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    { kind: 'agent', agentId: sourceAgent.id },
    'stable provider identity must win before the weaker workspace fallback',
  );
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: { kind: 'agent', agentId: 'missing', workspace: '/repo/missing' },
      activeAgents,
      agentInventoryComplete: true,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: true,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    { kind: 'clear' },
  );

  const fileSurface = {
    kind: 'file',
    workspace: '/repo/one',
    filePath: 'src/index.ts',
    view: 'diff',
    lineNumber: 17,
    column: 3,
    endColumn: 9,
    sourceAgentId: siblingAgent.id,
  };
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: fileSurface,
      activeAgents,
      agentInventoryComplete: true,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: false,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    { kind: 'wait' },
  );
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: fileSurface,
      activeAgents,
      agentInventoryComplete: true,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: true,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    {
      kind: 'file',
      filesId: projectFilesWorkspaceId('/repo/one'),
      filePath: 'src/index.ts',
      target: {
        view: 'diff',
        lineNumber: 17,
        column: 3,
        endColumn: 9,
        revealInTree: true,
        sourceAgentId: siblingAgent.id,
      },
    },
  );
  assert.deepStrictEqual(
    planWorkspaceSurfaceRestore({
      surface: { ...fileSurface, workspace: '/repo/missing', sourceAgentId: undefined },
      activeAgents,
      agentInventoryComplete: true,
      projectWorkspaces: ['/repo/one'],
      projectWorkspacesLoaded: true,
      resolveWorkspaceFileIdentity: resolveIdentity,
    }),
    { kind: 'clear' },
  );

  const admission = new WorkspaceSurfaceRestoreAdmission(true);
  const firstGeneration = admission.begin();
  assert.strictEqual(typeof firstGeneration, 'number');
  assert.strictEqual(admission.begin(), null, 'one mount must never admit two concurrent restore effects');
  assert.strictEqual(admission.settle(firstGeneration + 1), false, 'a stale completion must not settle the owner');
  assert.strictEqual(admission.cancelFetch(firstGeneration), true);
  const secondGeneration = admission.begin();
  assert.notStrictEqual(secondGeneration, firstGeneration);
  assert.strictEqual(admission.beginOpening(secondGeneration), true);
  let openFileEffects = 1;
  assert.strictEqual(
    admission.cancelFetch(secondGeneration),
    false,
    'cleanup must not make an already-started host open/mount effect replayable',
  );
  if (admission.begin() !== null) openFileEffects += 1;
  assert.strictEqual(
    openFileEffects,
    1,
    'dependency restart while openFile is pending must not start a second effect',
  );
  assert.strictEqual(admission.settle(firstGeneration), false);
  assert.strictEqual(admission.settle(secondGeneration), true);
  assert.strictEqual(admission.settle(secondGeneration), false, 'a late completion must settle only once');
  assert.strictEqual(admission.begin(), null, 'a settled restore intent must not replay');
  assert.strictEqual(new WorkspaceSurfaceRestoreAdmission(false).begin(), null);

  assert.deepStrictEqual(currentWorkspaceSurface({
    activeView: 'projects',
    mainPaneMode: 'terminal',
    activeTerminalId: sourceAgent.id,
    activeAgents,
    openWorkspaceFile: null,
  }), {
    kind: 'agent',
    agentId: sourceAgent.id,
    providerSessionKey: sourceProviderSessionKey,
    workspace: '/repo/one',
  });
  const openFile = {
    agentId: projectFilesWorkspaceId('/repo/one'),
    workspaceRoot: '/repo/one',
    sourceAgentId: sourceAgent.id,
    file: { path: 'README.md' },
    diffRequestId: 2,
    cursor: { lineNumber: 4, column: 2, endColumn: 5 },
  };
  assert.deepStrictEqual(currentWorkspaceSurface({
    activeView: 'projects',
    mainPaneMode: 'browser',
    activeTerminalId: sourceAgent.id,
    activeAgents,
    openWorkspaceFile: openFile,
  }), {
    kind: 'file',
    workspace: '/repo/one',
    filePath: 'README.md',
    view: 'diff',
    lineNumber: 4,
    column: 2,
    endColumn: 5,
    sourceAgentId: sourceAgent.id,
  }, 'resource panes must preserve the last file surface exactly as the existing product does');
  assert.strictEqual(currentWorkspaceSurface({
    activeView: 'history',
    mainPaneMode: 'editor',
    activeTerminalId: sourceAgent.id,
    activeAgents,
    openWorkspaceFile: openFile,
  }), undefined);

  console.log('test-workspace-surface-controller passed');
}

run();
