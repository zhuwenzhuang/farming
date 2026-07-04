const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');
const {
  displayedProjectsForSearch,
  editorFileStateByAgentForFiles,
  projectListProjectsForAgents,
  projectWorkspaceForHistoryRun,
  shouldMarkAgentUnreadForTurnTransition,
  visibleSearchTargetsForProjects,
} = importTsModule('src/components/code/workspace-derived.ts');

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

  const projectList = projectListProjectsForAgents(
    [agent({ id: 'main', isMain: true, projectWorkspace: '/main', cwd: '/main' }), agent({ id: 'sub', projectWorkspace: '/repo' })],
    [session({ id: 'session', workspace: '/repo' })],
    new Set(['/repo/hidden'])
  );
  assert.strictEqual(projectList[0].id, '__farming_main_agent__');
  assert(projectList.some(project => project.workspace === '/repo' && project.agentSessions.length === 1));

  const searchSourceProjects = projectListProjectsForAgents(
    [
      agent({ id: 'alpha', title: 'Build Search', projectWorkspace: '/repo-alpha', cwd: '/repo-alpha' }),
      agent({ id: 'beta', title: 'Deploy', projectWorkspace: '/repo-beta', cwd: '/repo-beta' }),
    ],
    [
      session({ id: 'session-alpha', title: 'Investigate model picker', workspace: '/repo-alpha', cwd: '/repo-alpha' }),
      session({ id: 'session-beta', title: 'Archive path', workspace: '/repo-beta', cwd: '/repo-beta' }),
    ],
    new Set()
  );
  const filteredByProject = displayedProjectsForSearch(searchSourceProjects, 'repo-alpha', new Set(), new Set());
  assert.deepStrictEqual(filteredByProject.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredByProject[0].agents.map(item => item.id), ['alpha']);
  assert.deepStrictEqual(filteredByProject[0].agentSessions.map(item => item.id), ['session-alpha']);

  const filteredBySession = displayedProjectsForSearch(searchSourceProjects, 'model picker', new Set(), new Set());
  assert.deepStrictEqual(filteredBySession.map(project => project.workspace), ['/repo-alpha']);
  assert.deepStrictEqual(filteredBySession[0].agents.map(item => item.id), []);
  assert.deepStrictEqual(filteredBySession[0].agentSessions.map(item => item.id), ['session-alpha']);

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

  assert.strictEqual(
    shouldMarkAgentUnreadForTurnTransition({
      wasTurnActive: true,
      isTurnActive: false,
      isMain: false,
      alreadyUnread: false,
      terminalPaneViewed: false,
      terminalFollowingLatest: false,
    }),
    true,
    'a background agent should become unread when an active turn ends unseen'
  );
  assert.strictEqual(
    shouldMarkAgentUnreadForTurnTransition({
      wasTurnActive: true,
      isTurnActive: false,
      isMain: false,
      alreadyUnread: false,
      terminalPaneViewed: true,
      terminalFollowingLatest: true,
    }),
    false,
    'a viewed terminal at the latest output should not become unread when the turn ends'
  );
  assert.strictEqual(
    shouldMarkAgentUnreadForTurnTransition({
      wasTurnActive: false,
      isTurnActive: false,
      isMain: false,
      alreadyUnread: false,
      terminalPaneViewed: false,
      terminalFollowingLatest: false,
    }),
    false,
    'plain background output without an active-to-idle transition should not mark unread'
  );
  assert.strictEqual(
    shouldMarkAgentUnreadForTurnTransition({
      wasTurnActive: true,
      isTurnActive: false,
      isMain: true,
      alreadyUnread: false,
      terminalPaneViewed: false,
      terminalFollowingLatest: false,
    }),
    false,
    'main agent rows should not get unread dots from turn transitions'
  );
  assert.strictEqual(
    shouldMarkAgentUnreadForTurnTransition({
      wasTurnActive: true,
      isTurnActive: false,
      isMain: false,
      alreadyUnread: true,
      terminalPaneViewed: false,
      terminalFollowingLatest: false,
    }),
    false,
    'already unread rows should not emit duplicate unread updates'
  );

  console.log('test-code-workspace-derived passed');
}

run();
