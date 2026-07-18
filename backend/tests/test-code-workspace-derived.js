const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  displayedProjectsForSearch,
  editorFileStateByAgentForFiles,
  projectListProjectsForAgents,
  projectWorkspaceForHistoryRun,
  stableProjectSourceAgentId,
  visibleSearchTargetsForProjects,
} = importTsModule('src/components/code/workspace-derived.ts');
const {
  isProjectFilesWorkspaceId,
  projectFilesWorkspaceId,
  projectWorkspaceFromFilesId,
} = importTsModule('src/lib/project-workspaces.ts');

function agent(overrides = {}) {
  return {
    id: 'agent-1',
    command: 'codex',
    cwd: '/repo',
    projectWorkspace: '/repo',
    status: 'running',
    isMain: false,
    archived: false,
    source: '',
    startedAt: 100,
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    provider: 'codex',
    id: 's1',
    title: 'Session 1',
    cwd: '/repo',
    workspace: '/repo',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function openFile(agentId, path, overrides = {}) {
  return {
    agentId,
    file: {
      path,
      name: path.split('/').pop() || path,
      content: '',
      size: 0,
      mtimeMs: 0,
      sha1: 'sha',
      binary: false,
    },
    draft: '',
    dirty: false,
    externalChanged: false,
    saving: false,
    error: null,
    ...overrides,
  };
}

function run() {
  assert.strictEqual(projectWorkspaceForHistoryRun(null), '');
  assert.strictEqual(projectWorkspaceForHistoryRun({ cwd: '/cwd', projectWorkspace: '' }), '/cwd');
  assert.strictEqual(projectWorkspaceForHistoryRun({ cwd: '/cwd', projectWorkspace: '/project' }), '/project');

  const sourceAgents = [
    agent({ id: 'main', isMain: true }),
    agent({ id: 'older' }),
    agent({ id: 'newer' }),
  ];
  assert.strictEqual(stableProjectSourceAgentId(null, sourceAgents), 'older');
  assert.strictEqual(stableProjectSourceAgentId('older', [...sourceAgents].reverse()), 'older');
  assert.strictEqual(stableProjectSourceAgentId('missing', sourceAgents), 'older');
  assert.strictEqual(stableProjectSourceAgentId('main', sourceAgents), 'older');
  assert.strictEqual(stableProjectSourceAgentId(null, [agent({ id: 'main', isMain: true })]), null);
  const filesId = projectFilesWorkspaceId('/repo with spaces');
  assert.match(filesId, /^wroot_[0-9a-f]{16}$/);
  assert.strictEqual(projectWorkspaceFromFilesId(filesId), '/repo with spaces');
  assert.strictEqual(isProjectFilesWorkspaceId(filesId), true);

  const projectList = projectListProjectsForAgents(
    [agent({ id: 'main', isMain: true, projectWorkspace: '/main', cwd: '/main' }), agent({ id: 'sub', projectWorkspace: '/repo' })],
    [session({ id: 'session', workspace: '/repo' })],
    new Set(['/repo/hidden'])
  );
  assert.strictEqual(projectList[0].id, '__farming_main_agent__');
  assert(projectList.some(project => project.workspace === '/repo' && project.agentSessions.length === 1));
  const orderedProject = projectListProjectsForAgents([
    agent({ id: 'older', projectOrder: 1024 }),
    agent({ id: 'newer', projectOrder: 2048 }),
  ], [], new Set()).find(project => project.workspace === '/repo');
  assert.deepStrictEqual(orderedProject.agents.map(item => item.id), ['newer', 'older']);

  const stoppedWorktreeAgent = agent({
    id: 'worktree-agent',
    status: 'stopped',
    archived: true,
    gitWorktree: {
      workspace: '/repo-topic',
      commonDir: '/repo/.git',
      mainWorkspace: '/repo',
      linked: true,
      branch: 'topic',
      head: 'abcdef0123456789',
      detached: false,
      locked: false,
      prunable: false,
    },
  });
  const openOnlyProjects = projectListProjectsForAgents(
    [],
    [],
    {},
    [openFile('worktree-agent', 'src/topic.ts', { workspaceRoot: '/repo-topic' })],
    [stoppedWorktreeAgent],
  );
  assert.strictEqual(openOnlyProjects.length, 1);
  assert.strictEqual(openOnlyProjects[0].workspace, '/repo-topic');
  assert.strictEqual(openOnlyProjects[0].agents.length, 0);
  assert.strictEqual(openOnlyProjects[0].hasOpenFile, true);
  assert.strictEqual(openOnlyProjects[0].gitWorktree.branch, 'topic');
  const persistedEmptyProjects = projectListProjectsForAgents(
    [],
    [],
    {},
    [],
    [stoppedWorktreeAgent],
    ['/repo-topic'],
  );
  assert.strictEqual(persistedEmptyProjects.length, 1);
  assert.strictEqual(persistedEmptyProjects[0].workspace, '/repo-topic');
  assert.strictEqual(persistedEmptyProjects[0].agents.length, 0);
  assert.strictEqual(persistedEmptyProjects[0].hasOpenFile, undefined);
  assert.strictEqual(Object.hasOwn(persistedEmptyProjects[0], 'fileAgentId'), false);
  assert.deepStrictEqual(
    displayedProjectsForSearch(openOnlyProjects, 'repo-topic', new Set()).map(project => project.workspace),
    ['/repo-topic'],
  );
  assert.deepStrictEqual(displayedProjectsForSearch(openOnlyProjects, 'missing', new Set()), []);

  const searchSourceProjects = projectListProjectsForAgents(
    [
      agent({
        id: 'alpha',
        customTitle: 'Build Search with an adaptive title suffix',
        command: 'hidden-alpha-command',
        task: 'hidden alpha task',
        projectWorkspace: '/repo-alpha',
        cwd: '/repo-alpha',
      }),
      agent({ id: 'beta', customTitle: 'Deploy', projectWorkspace: '/repo-beta', cwd: '/repo-beta' }),
    ],
    [
      session({
        id: 'session-alpha',
        title: 'Investigate model picker',
        workspace: '/repo-alpha',
        cwd: '/repo-alpha',
        providerName: 'Hidden Provider',
        model: 'hidden-session-model',
      }),
      session({ id: 'session-beta', title: 'Archive path', workspace: '/repo-beta', cwd: '/repo-beta' }),
    ],
    { '/repo-alpha': 'Compiler Core' }
  );
  const filteredByProject = displayedProjectsForSearch(searchSourceProjects, 'repo-alpha', new Set(), new Set());
  assert.deepStrictEqual(filteredByProject.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredByProject[0].agents.map(item => item.id), ['alpha']);
  assert.deepStrictEqual(filteredByProject[0].agentSessions.map(item => item.id), ['session-alpha']);

  const filteredByProjectName = displayedProjectsForSearch(searchSourceProjects, 'compiler core', new Set(), new Set());
  assert.deepStrictEqual(filteredByProjectName.map(project => project.workspace), ['/repo-alpha']);

  const filteredByAgentTitle = displayedProjectsForSearch(searchSourceProjects, 'build search', new Set(), new Set());
  assert.deepStrictEqual(filteredByAgentTitle.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredByAgentTitle[0].agents.map(item => item.id), ['alpha']);
  assert.deepStrictEqual(filteredByAgentTitle[0].agentSessions.map(item => item.id), []);

  const filteredByAdaptiveTitleSuffix = displayedProjectsForSearch(searchSourceProjects, 'title suffix', new Set(), new Set());
  assert.deepStrictEqual(filteredByAdaptiveTitleSuffix.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredByAdaptiveTitleSuffix[0].agents.map(item => item.id), ['alpha']);

  const filteredBySession = displayedProjectsForSearch(searchSourceProjects, 'model picker', new Set(), new Set());
  assert.deepStrictEqual(filteredBySession.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredBySession[0].agents.map(item => item.id), []);
  assert.deepStrictEqual(filteredBySession[0].agentSessions.map(item => item.id), ['session-alpha']);

  assert.deepStrictEqual(displayedProjectsForSearch(searchSourceProjects, 'hidden-alpha-command', new Set(), new Set()), []);
  assert.deepStrictEqual(displayedProjectsForSearch(searchSourceProjects, 'hidden alpha task', new Set(), new Set()), []);
  assert.deepStrictEqual(displayedProjectsForSearch(searchSourceProjects, 'hidden provider', new Set(), new Set()), []);
  assert.deepStrictEqual(displayedProjectsForSearch(searchSourceProjects, 'hidden-session-model', new Set(), new Set()), []);

  const filteredByBackendMatch = displayedProjectsForSearch(
    searchSourceProjects,
    'backend-only-match',
    new Set(),
    new Set(['agent-session:codex:session-beta'])
  );
  assert.deepStrictEqual(filteredByBackendMatch.map(project => project.workspace), ['/repo-beta']);
  assert.deepStrictEqual(filteredByBackendMatch[0].agentSessions.map(item => item.id), ['session-beta']);

  const filteredClaimedAgentByBackendMatch = displayedProjectsForSearch(
    searchSourceProjects,
    'backend-only-match',
    new Set(),
    new Set(),
    new Set(['beta'])
  );
  assert.deepStrictEqual(filteredClaimedAgentByBackendMatch.map(project => project.workspace), ['/repo-beta']);
  assert.deepStrictEqual(filteredClaimedAgentByBackendMatch[0].agents.map(item => item.id), ['beta']);

  assert.deepStrictEqual(
    visibleSearchTargetsForProjects(searchSourceProjects, new Set([searchSourceProjects[0].id]), ''),
    [
      { kind: 'agent', id: 'beta' },
      { kind: 'agent-session', provider: 'codex', id: 'session-beta' },
    ]
  );
  assert.deepStrictEqual(
    visibleSearchTargetsForProjects(searchSourceProjects, new Set([searchSourceProjects[0].id]), 'alpha'),
    [
      { kind: 'agent', id: 'alpha' },
      { kind: 'agent-session', provider: 'codex', id: 'session-alpha' },
      { kind: 'agent', id: 'beta' },
      { kind: 'agent-session', provider: 'codex', id: 'session-beta' },
    ]
  );
  const homeSearchProjects = projectListProjectsForAgents(
    [],
    [session({ id: 'shared-id', providerHomeId: 'work' })],
    new Set()
  );
  assert.deepStrictEqual(
    visibleSearchTargetsForProjects(homeSearchProjects, new Set(), ''),
    [{ kind: 'agent-session', provider: 'codex', id: 'shared-id', providerHomeId: 'work' }]
  );

  const editorState = editorFileStateByAgentForFiles(
    [
      openFile('agent-1', 'src/a.ts', { dirty: true }),
      openFile('agent-1', 'src/b.ts', { externalChanged: true }),
    ],
    [
      openFile('agent-2', 'src/c.ts', { dirty: true, externalChanged: true }),
    ]
  );
  assert.deepStrictEqual(Array.from(editorState.dirty.get('agent-1') || []), ['src/a.ts']);
  assert.deepStrictEqual(Array.from(editorState.externalChanged.get('agent-1') || []), ['src/b.ts']);
  assert.deepStrictEqual(Array.from(editorState.dirty.get('agent-2') || []), ['src/c.ts']);
  assert.deepStrictEqual(Array.from(editorState.externalChanged.get('agent-2') || []), ['src/c.ts']);

  console.log('test-code-workspace-derived passed');
}

run();
