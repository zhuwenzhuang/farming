const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  buildCrtHistoryItems,
  calculateCrtAgentPageLayout,
  calculateCrtHistoryPageSize,
  crtHistoryAgentName,
  crtAgentSessionKey,
  crtResumedSessionFromSource,
  crtDashboardStateSignature,
  findDefaultNewAgentIndex,
  findDirectionalNavigationIndex,
  getCrtAgentTitle,
  getCrtProjectName,
  getCrtPreviewCellStyle,
  calculateTerminalInputBridgePosition,
  getCrtTerminalFontSize,
  normalizeCrtTerminalFontSize,
  isCrtAgentWorking,
  getCrtAgentReadPatch,
  getCrtBrandPaneKey,
  formatSystemClock,
  formatCrtTokenRate,
  formatCrtHistoryAge,
  getCrtHistoryPage,
  getCrtAgentPage,
  getCrtAgentVerticalPageTarget,
  requestedCrtAgentId,
  createSessionModalState,
} = require('../../frontend/skins/crt/app.js');

function run() {
  const crtSource = fs.readFileSync(path.resolve(__dirname, '../../frontend/skins/crt/app.js'), 'utf8');
  assert(
    crtSource.includes("data.type === 'agent-started'")
      && crtSource.includes('selectCrtStartedAgent(data.agentId)'),
    'CRT should select the Agent confirmed by the agent-started message',
  );
  const newAgentDialogSource = crtSource.slice(
    crtSource.indexOf('function showInputDialog'),
    crtSource.indexOf('function hideInputDialog'),
  );
  assert(
    newAgentDialogSource.includes('void loadAgents();')
      && crtSource.includes("fetch(farmingApiPath('/executables'), { cache: 'no-store' })"),
    'Opening the CRT New Agent dialog should rediscover executable agents without an HTTP cache',
  );
  assert(
    crtSource.includes("fetch(farmingApiPath('/agent-sessions?limit=60&fresh=1'), { cache: 'no-store' })"),
    'Opening CRT History should request a bounded current backend session scan',
  );
  assert.strictEqual(normalizeCrtTerminalFontSize(10), 10);
  assert.strictEqual(normalizeCrtTerminalFontSize(15.6), 16);
  assert.strictEqual(normalizeCrtTerminalFontSize(100), 20);
  assert.strictEqual(normalizeCrtTerminalFontSize('invalid'), 15);
  assert.strictEqual(formatCrtTokenRate(undefined), '--');
  assert.strictEqual(formatCrtTokenRate(0), '~0');
  assert.strictEqual(formatCrtTokenRate(9.94), '~9.9');
  assert.strictEqual(formatCrtTokenRate(1250), '~1.3K');
  assert.strictEqual(formatCrtTokenRate(1200000), '~1.2M');
  assert.strictEqual(requestedCrtAgentId('?agent=agent-123'), 'agent-123');
  assert.strictEqual(requestedCrtAgentId('?view=agents'), '');
  assert.strictEqual(crtHistoryAgentName('codex resume session-1'), 'Codex');
  assert.strictEqual(crtHistoryAgentName('qodercli'), 'Qoder');
  assert.strictEqual(crtHistoryAgentName('env QODER_HOME=/tmp/qoder /usr/local/bin/qodercli'), 'Qoder');
  assert.strictEqual(calculateCrtHistoryPageSize(680), 10);
  assert.strictEqual(calculateCrtHistoryPageSize(135), 1);
  assert.deepStrictEqual(
    getCrtHistoryPage(['a', 'b', 'c', 'd', 'e'], 1, 2),
    { items: ['c', 'd'], page: 1, pageSize: 2, totalItems: 5, totalPages: 3, start: 2 },
  );
  assert.deepStrictEqual(
    getCrtHistoryPage(['a', 'b', 'c'], 99, 2),
    { items: ['c'], page: 1, pageSize: 2, totalItems: 3, totalPages: 2, start: 2 },
  );
  assert.deepStrictEqual(
    calculateCrtAgentPageLayout(680, 400, 1),
    { columns: 2, rows: 2, pageSize: 4 },
    'a single Agent should occupy one stable bay instead of stretching across the dashboard',
  );
  assert.deepStrictEqual(
    calculateCrtAgentPageLayout(680, 400, 4),
    { columns: 2, rows: 2, pageSize: 4 },
  );
  assert.deepStrictEqual(
    calculateCrtAgentPageLayout(680, 400, 6),
    { columns: 3, rows: 2, pageSize: 6 },
  );
  assert.deepStrictEqual(
    calculateCrtAgentPageLayout(680, 560, 9),
    { columns: 3, rows: 3, pageSize: 9 },
  );
  assert.deepStrictEqual(
    calculateCrtAgentPageLayout(240, 560, 4),
    { columns: 1, rows: 2, pageSize: 2 },
    'small screens should preserve the minimum card width instead of squeezing two columns',
  );
  assert.deepStrictEqual(
    getCrtAgentPage(['a', 'b', 'c', 'd', 'e', 'f', 'g'], 1, 6),
    { items: ['g'], page: 1, pageSize: 6, totalItems: 7, totalPages: 2, start: 6 },
  );
  assert.strictEqual(getCrtAgentVerticalPageTarget({
    itemIndex: 4,
    totalItems: 12,
    pageSize: 6,
    columns: 3,
    key: 'ArrowDown',
  }), 7, 'ArrowDown should keep the selected column on the next Agent page');
  assert.strictEqual(getCrtAgentVerticalPageTarget({
    itemIndex: 7,
    totalItems: 12,
    pageSize: 6,
    columns: 3,
    key: 'ArrowUp',
  }), 4, 'ArrowUp should keep the selected column on the previous Agent page');
  assert.strictEqual(getCrtAgentVerticalPageTarget({
    itemIndex: 1,
    totalItems: 12,
    pageSize: 6,
    columns: 3,
    key: 'ArrowDown',
  }), -1, 'Agent page navigation should not intercept arrows within a visible page');

  assert.strictEqual(
    crtAgentSessionKey({ provider: 'codex', id: 'session-1', providerHomeId: 'work' }),
    'agent-session:codex:home:work:session-1',
  );
  assert.deepStrictEqual(
    crtResumedSessionFromSource('qoder-history:home:team:qoder-1'),
    { provider: 'qoder', providerHomeId: 'team', sessionId: 'qoder-1' },
  );
  assert.strictEqual(formatCrtHistoryAge(1_000, 1_000), 'now');
  assert.strictEqual(formatCrtHistoryAge(1_000, 61_000), '1m');

  const historyItems = buildCrtHistoryItems({
    taskHistory: [
      {
        id: 'run-1',
        agentId: 'old-agent',
        source: 'codex-history:session-1',
        archivedAt: 1_000,
      },
      {
        id: 'run-2',
        agentId: 'shell-agent',
        source: 'ui',
        archivedAt: 3_000,
      },
    ],
    agents: [
      {
        id: 'archived-agent',
        archived: true,
        archivedAt: 2_000,
      },
      {
        id: 'live-agent',
        status: 'running',
        providerSessionKey: 'agent-session:codex:live-session',
      },
    ],
    sessions: [
      {
        provider: 'codex',
        id: 'session-1',
        title: 'Recovered session',
        cwd: '/repo/farming',
        updatedAt: new Date(4_000).toISOString(),
      },
      {
        provider: 'codex',
        id: 'live-session',
        title: 'Already live',
        cwd: '/repo/farming',
        updatedAt: new Date(5_000).toISOString(),
      },
      {
        provider: 'qoder',
        id: 'main-page-session',
        title: 'On projects page',
        cwd: '/repo/farming',
        updatedAt: new Date(6_000).toISOString(),
      },
    ],
    mainPageSessionKeys: ['agent-session:qoder:main-page-session'],
  });
  assert.deepStrictEqual(
    historyItems.map((item) => `${item.kind}:${item.kind === 'session' ? item.session.id : item.kind === 'agent' ? item.agent.id : item.entry.id}`),
    ['session:session-1', 'run:run-2', 'agent:archived-agent'],
  );

  const agentOptions = [
    { name: 'claude' },
    { name: 'codex' },
    { name: 'bash' },
  ];
  assert.strictEqual(findDefaultNewAgentIndex(agentOptions, 'codex'), 1);
  assert.strictEqual(findDefaultNewAgentIndex(agentOptions, 'CODEX'), 1);
  assert.strictEqual(findDefaultNewAgentIndex(agentOptions, 'missing'), 0);
  assert.strictEqual(findDefaultNewAgentIndex([], 'codex'), -1);

  const navigationRects = [
    { left: 0, right: 100, top: 0, bottom: 100 },
    { left: 120, right: 220, top: 0, bottom: 100 },
    { left: 0, right: 100, top: 120, bottom: 220 },
    { left: 120, right: 220, top: 120, bottom: 220 },
  ];
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, -1, 'ArrowRight'), 0);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 0, 'ArrowRight'), 1);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 0, 'ArrowDown'), 2);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 3, 'ArrowLeft'), 2);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 3, 'ArrowUp'), 1);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 0, 'ArrowUp'), -1);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 0, 'ArrowUp', true), 2);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 1, 'ArrowRight', true), 0);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 2, 'ArrowDown', true), 0);
  assert.strictEqual(findDirectionalNavigationIndex(navigationRects, 0, 'ArrowLeft', true), 1);

  const verticalNavigationRects = [
    { left: 0, right: 100, top: 0, bottom: 40 },
    { left: 0, right: 100, top: 60, bottom: 100 },
  ];
  assert.strictEqual(findDirectionalNavigationIndex(verticalNavigationRects, 1, 'ArrowDown', true), 0);
  assert.strictEqual(findDirectionalNavigationIndex(verticalNavigationRects, 0, 'ArrowUp', true), 1);
  assert.strictEqual(findDirectionalNavigationIndex(verticalNavigationRects, 0, 'ArrowRight', true), -1);

  const titledAgent = {
    id: 'agent-1',
    command: 'codex resume --last',
    cwd: '/repo/farming',
    projectWorkspace: '/repo/farming',
    providerSessionTitle: '修复终端缩略图展示',
    sessionTitle: 'farming',
    status: 'running',
  };

  assert.strictEqual(getCrtAgentTitle(titledAgent), '修复终端缩略图展示');
  assert.strictEqual(getCrtProjectName(titledAgent), 'farming');
  assert.strictEqual(
    getCrtProjectName(titledAgent, { '/repo/farming/': 'Farming Core' }),
    'Farming Core',
  );
  assert.strictEqual(
    getCrtAgentTitle({ ...titledAgent, customTitle: '用户命名的 Agent' }),
    '用户命名的 Agent',
  );
  assert.strictEqual(
    getCrtAgentTitle({ command: 'qodercli', sessionTitle: '✦ Working… (farming)' }),
    'Qoder',
  );

  assert.deepStrictEqual(
    getCrtPreviewCellStyle({ fg: 1, bg: 4, attributes: 0x05 }),
    {
      color: '#cd3131',
      backgroundColor: '#2472c8',
      fontWeight: 'bold',
      fontStyle: '',
      textDecoration: 'underline',
      opacity: '',
    },
  );
  assert.deepStrictEqual(
    calculateTerminalInputBridgePosition(
      { x: 10, y: 5 },
      { cols: 80, rows: 20 },
      { left: 100, top: 200, width: 800, height: 400 },
      { left: 10, top: 20 },
    ),
    { left: 190, top: 280, height: 20 },
  );
  assert.strictEqual(getCrtTerminalFontSize(), 15);
  assert.deepStrictEqual(
    getCrtAgentReadPatch({ unread: true, attentionSeq: 4, readAttentionSeq: 2 }),
    { readAttentionSeq: 4 },
  );
  assert.deepStrictEqual(
    getCrtAgentReadPatch({ unread: true, attentionSeq: 0, readAttentionSeq: 0 }),
    { unread: false },
  );
  assert.strictEqual(getCrtAgentReadPatch({ unread: false, attentionSeq: 4, readAttentionSeq: 2 }), null);

  const dashboardState = {
    mainAgentId: 'agent-main',
    agents: [{
      id: 'agent-main',
      status: 'running',
      activityLevel: 'warm',
      command: 'bash',
      output: 'old output',
      previewText: 'old preview',
      terminalStatus: { activity: 'idle' },
    }],
  };
  assert.strictEqual(
    crtDashboardStateSignature(dashboardState),
    crtDashboardStateSignature({
      ...dashboardState,
      agents: [{ ...dashboardState.agents[0], output: 'new output', previewText: 'new preview' }],
    }),
    'stream text should use the targeted preview path instead of invalidating the whole dashboard',
  );
  assert.notStrictEqual(
    crtDashboardStateSignature(dashboardState),
    crtDashboardStateSignature({
      ...dashboardState,
      agents: [{ ...dashboardState.agents[0], status: 'stopped' }],
    }),
    'visible status changes should invalidate the dashboard structure',
  );

  const brandState = {
    mainAgentId: 'agent-main',
    agents: [
      { id: 'agent-main', isMain: true },
      { id: 'agent-worker-1' },
      { id: 'agent-worker-2' },
      { id: 'agent-worker-3' },
    ],
  };
  assert.strictEqual(getCrtBrandPaneKey('agent-main', brandState), 'main');
  assert.strictEqual(getCrtBrandPaneKey('agent-worker-1', brandState), 'worker-a');
  assert.strictEqual(getCrtBrandPaneKey('agent-worker-2', brandState), 'worker-b');
  assert.strictEqual(getCrtBrandPaneKey('agent-worker-3', brandState), 'worker-a');
  assert.strictEqual(getCrtBrandPaneKey('missing', brandState), null);

  assert.strictEqual(
    isCrtAgentWorking({ status: 'running', terminalStatus: { activity: 'busy' } }),
    true,
  );
  assert.strictEqual(
    isCrtAgentWorking({ status: 'running', activityLevel: 'hot', terminalStatus: { activity: 'idle' } }),
    false,
    'recent activity alone must not make a CRT card blink',
  );
  assert.match(formatSystemClock(Date.UTC(2026, 6, 12, 2, 3, 4), 'UTC'), /^2026-07-12 02:03:04$/);

  const modalState = createSessionModalState(titledAgent, 'terminal', { crtEffects: true });
  assert.strictEqual(modalState.title, '修复终端缩略图展示');

  console.log('✓ CRT cards use meaningful titles and working-state blink');
}

run();
