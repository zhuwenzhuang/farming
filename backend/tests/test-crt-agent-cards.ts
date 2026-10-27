const assert = require('assert');
const { encodeProviderSessionKey } = require('../../shared/provider-session-identity.js');

const {
  buildCrtHistoryItems,
  buildCrtSearchResults,
  buildCrtStructuredPreview,
  calculateCrtAgentPageLayout,
  calculateCrtHistoryPageSize,
  crtHistoryAgentName,
  crtAgentSessionKey,
  crtClaimedSessionFromSource,
  crtResumedSessionFromSource,
  crtDashboardStateSignature,
  findDefaultNewAgentIndex,
  findDirectionalNavigationIndex,
  getCrtAgentTitle,
  getCrtProjectName,
  getCrtPreviewCellStyle,
  getCrtTerminalSnapshotRows,
  crtStructuredPreviewMessageLines,
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
  crtAgentInventoryCounts,
  getCrtAgentVerticalPageTarget,
  getCrtLiveAgents,
  getCrtRegularAgents,
  getCrtMainAgentDialogAction,
  isCrtLiveAgent,
  isCrtViewableAgent,
  hasRetainedCrtTerminalCheckpoint,
  classifyCrtTerminalCheckpointResponse,
  crtTerminalFailureDetail,
  requestedCrtAgentId,
  createSessionModalState,
} = require('../../frontend/skins/crt/app.js');

function run() {
  assert.strictEqual(normalizeCrtTerminalFontSize(10), 10);
  assert.strictEqual(normalizeCrtTerminalFontSize(15.6), 16);
  assert.strictEqual(normalizeCrtTerminalFontSize(100), 20);
  assert.strictEqual(normalizeCrtTerminalFontSize('invalid'), 15);
  assert.strictEqual(formatCrtTokenRate(null), '--');
  assert.strictEqual(formatCrtTokenRate(undefined), '--');
  assert.strictEqual(formatCrtTokenRate(''), '--');
  assert.strictEqual(formatCrtTokenRate(0), '0');
  assert.strictEqual(formatCrtTokenRate(9.94), '9.9');
  assert.strictEqual(formatCrtTokenRate(1250), '1.3K');
  assert.strictEqual(formatCrtTokenRate(1200000), '1.2M');
  assert.strictEqual(requestedCrtAgentId('?agent=agent-123'), 'agent-123');
  assert.strictEqual(requestedCrtAgentId('?view=agents'), '');
  const liveDashboardState = {
    mainAgentId: 'agent-main',
    agents: [
      { id: 'agent-main', status: 'running', isMain: true },
      { id: 'agent-live', status: 'running' },
      { id: 'agent-pending', status: 'pending' },
      { id: 'agent-stopped', status: 'stopped' },
      { id: 'agent-dead', status: 'dead' },
      { id: 'agent-archived', status: 'running', archived: true },
    ],
  };
  assert.strictEqual(isCrtLiveAgent(liveDashboardState.agents[1]), true);
  assert.strictEqual(isCrtLiveAgent(liveDashboardState.agents[3]), false);
  assert.deepStrictEqual(
    getCrtLiveAgents(liveDashboardState).map((agent) => agent.id),
    ['agent-main', 'agent-live', 'agent-pending'],
    'CRT dashboard counts and renders only live Agent records',
  );
  assert.deepStrictEqual(
    getCrtRegularAgents(liveDashboardState).map((agent) => agent.id),
    ['agent-live', 'agent-pending'],
    'stopped, dead, and archived Agent records should not occupy CRT dashboard bays',
  );
  for (const provider of ['codex', 'claude', 'qwen']) {
    for (const status of ['stopped', 'dead']) {
      const exited = {
        id: 'exited-launch', status,
        providerSessionProvider: provider, providerSessionTemporary: true,
      };
      const exitedState = { mainAgentId: null, agents: [exited] };
      assert.deepStrictEqual(getCrtRegularAgents(exitedState).map(agent => agent.id), [],
        'CRT dashboard hides stopped or dead temporary Provider launches');
      assert.strictEqual(isCrtLiveAgent(exited), false, 'viewable stopped records do not become live runtimes');
      assert.strictEqual(isCrtViewableAgent(exited), true, 'unarchived exited launches remain inspectable when already open or targeted via ?agent=');
      assert.strictEqual(isCrtViewableAgent({ ...exited, archived: true }), false);
      assert.strictEqual(getCrtMainAgentDialogAction({ currentState: exitedState }), 'show',
        'when only stopped or dead records exist and no session is open, CRT should still onboard the Main Agent');
      assert.strictEqual(getCrtMainAgentDialogAction({ currentState: exitedState, sessionOpen: true }), 'none',
        'an open session modal must not be covered by Main Agent onboarding');
      assert.deepStrictEqual(getCrtRegularAgents({ ...exitedState, agents: [{ ...exited, archived: true }] }), []);
      assert.deepStrictEqual(getCrtRegularAgents({ ...exitedState, agents: [{ ...exited, isMain: true }] }), []);
    }
  }
  assert.strictEqual(hasRetainedCrtTerminalCheckpoint({
    runtimeEpoch: 'epoch-1',
    outputSeq: 0,
    stateRevision: 1,
    cols: 80,
    rows: 24,
  }), true);
  assert.strictEqual(hasRetainedCrtTerminalCheckpoint({
    runtimeEpoch: 'epoch-1',
    outputSeq: null,
    stateRevision: null,
    cols: 80,
    rows: 24,
  }), false);
  assert.strictEqual(classifyCrtTerminalCheckpointResponse(
    { runtimeEpoch: 'epoch-1', outputSeq: 3, stateRevision: 2, cols: 80, rows: 24 },
    { status: 'running' },
    { runtimeEpoch: 'epoch-1', outputSeq: 3, stateRevision: 2, cols: 80, rows: 24 },
  ), 'live-checkpoint');
  assert.strictEqual(classifyCrtTerminalCheckpointResponse(
    { status: 'dead', runtimeEpoch: 'epoch-1', outputSeq: 3, stateRevision: 2, cols: 80, rows: 24 },
    { status: 'dead' },
    { runtimeEpoch: 'epoch-1', outputSeq: 3, stateRevision: 2, cols: 80, rows: 24 },
  ), 'stopped-checkpoint');
  assert.strictEqual(classifyCrtTerminalCheckpointResponse(
    { status: 'dead', runtimeEpoch: 'epoch-1', outputSeq: null, stateRevision: null, cols: 80, rows: 24 },
    { status: 'dead' },
    { runtimeEpoch: 'epoch-1', outputSeq: null, stateRevision: null, cols: 80, rows: 24 },
  ), 'stopped-without-checkpoint');
  assert.strictEqual(crtTerminalFailureDetail({ status: 'running' }, 'Press R to retry.'), 'The Agent is still running. Press R to retry.');
  assert.strictEqual(crtTerminalFailureDetail({ status: 'stopped' }, 'Press R to retry.'), 'The Agent has stopped. Press R to retry.');
  assert.strictEqual(crtTerminalFailureDetail({ status: 'dead' }, 'Press R to retry.'), 'The Agent has stopped. Press R to retry.');
  assert.strictEqual(crtTerminalFailureDetail('stopped', 'Press R to retry.'), 'The Agent has stopped. Press R to retry.');
  assert.deepStrictEqual(crtAgentInventoryCounts(liveDashboardState), {
    running: 2,
    total: 3,
  });
  assert.deepStrictEqual(crtAgentInventoryCounts({
    ...liveDashboardState,
    agentInventoryScope: 'focused',
    agentInventoryRunning: 71,
    agentInventoryTotal: 73,
    agents: liveDashboardState.agents.slice(0, 2),
  }), {
    running: 71,
    total: 73,
  }, 'A focused CRT Session should keep authoritative global Agent counts without the full inventory');
  assert.deepStrictEqual(crtAgentInventoryCounts({
    ...liveDashboardState,
    agentInventoryScope: 'all',
    agentInventoryRunning: 4,
    agentInventoryTotal: 6,
    agents: liveDashboardState.agents.slice(0, 2),
  }), {
    running: 4,
    total: 6,
  }, 'A progressive all-scope Snapshot should use authoritative totals before every row arrives');
  assert.deepStrictEqual(
    buildCrtStructuredPreview({
      state: 'working',
      entries: [
        { type: 'message', role: 'user', internal: true, content: [{ type: 'text', text: 'hidden injected context' }] },
        { type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'hidden heartbeat' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: '  Explain the dashboard preview\nclearly.  ' }] },
        { type: 'thought', content: [{ type: 'text', text: 'Comparing the live Agent cards' }] },
        { type: 'tool', title: 'Inspect CRT layout', status: 'in_progress' },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'The preview now follows the latest conversation.' }] },
      ],
    }, { runtimeBinding: { kind: 'acp', state: 'working' } }),
    {
      messageLines: [
        { role: 'user', label: 'YOU', text: 'Explain the dashboard preview clearly.' },
        { role: 'assistant', label: 'AGENT', text: 'The preview now follows the latest conversation.' },
      ],
      userText: 'Explain the dashboard preview clearly.',
      assistantText: 'The preview now follows the latest conversation.',
      activityText: 'Inspect CRT layout · in progress',
      state: 'working',
    },
    'CRT Chat previews should keep the latest visible turn and activity while excluding internal ACP entries',
  );
  assert.deepStrictEqual(
    crtStructuredPreviewMessageLines({
      entries: [
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'First question' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
        { type: 'message', role: 'assistant', internal: true, content: [{ type: 'text', text: 'hidden heartbeat' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Follow up' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Intermediate progress' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Second answer' }] },
        { type: 'message', role: 'user', content: [{ type: 'text', text: 'Latest question' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Latest answer' }] },
      ],
    }),
    [
      { role: 'user', label: 'YOU', text: 'First question' },
      { role: 'assistant', label: 'AGENT', text: 'First answer' },
      { role: 'user', label: 'YOU', text: 'Follow up' },
      { role: 'assistant', label: 'AGENT', text: 'Second answer' },
      { role: 'user', label: 'YOU', text: 'Latest question' },
      { role: 'assistant', label: 'AGENT', text: 'Latest answer' },
    ],
    'CRT Chat cards should preserve the bounded ordered recent visible conversation without internal entries',
  );
  const terminalSnapshot = {
    cells: [
      [{ char: 'A', width: 1, fg: 2, bg: -1, attributes: 0 }],
      [{ char: ' ', width: 1, fg: -1, bg: -1, attributes: 0 }],
      [{ char: ' ', width: 1, fg: -1, bg: -1, attributes: 0 }],
    ],
    cursorVisible: false,
    cursorY: 2,
  };
  assert.deepStrictEqual(
    getCrtTerminalSnapshotRows(terminalSnapshot),
    terminalSnapshot.cells.slice(0, 1),
    'CRT Terminal cards should remove unused trailing screen rows',
  );
  assert.deepStrictEqual(
    getCrtTerminalSnapshotRows({ ...terminalSnapshot, cursorVisible: true, cursorY: 1 }),
    terminalSnapshot.cells.slice(0, 2),
    'CRT Terminal cards should retain an otherwise blank visible cursor row',
  );
  assert.strictEqual(crtHistoryAgentName('codex resume session-1'), 'Codex');
  assert.strictEqual(crtHistoryAgentName('qodercli'), 'Qoder');
  assert.strictEqual(crtHistoryAgentName('env QODER_HOME=/tmp/qoder /usr/local/bin/qodercli'), 'Qoder');
  assert.deepStrictEqual(
    buildCrtSearchResults({
      query: 'green house',
      mainAgentId: 'agent-main',
      projectNames: { '/repo/farm': 'Green House' },
      agents: [
        { id: 'agent-main', isMain: true, command: 'codex', projectWorkspace: '/repo/farm' },
        {
          id: 'agent-live',
          command: 'codex',
          customTitle: 'Harvest Index',
          projectWorkspace: '/repo/farm',
          status: 'running',
          providerSessionKey: encodeProviderSessionKey('codex', 'session-live', 'default'),
        },
        { id: 'agent-archived', command: 'claude', projectWorkspace: '/repo/farm', archived: true },
      ],
      sessions: [
        { provider: 'codex', id: 'session-live', title: 'Claimed', workspace: '/repo/farm' },
        { provider: 'claude', id: 'session-archive', title: 'Seed catalog', workspace: '/repo/farm' },
        { provider: 'qoder', id: 'session-other', title: 'Unrelated', workspace: '/repo/other' },
      ],
    }).map((result) => `${result.kind}:${result.kind === 'agent' ? result.agent.id : result.session.id}`),
    ['agent:agent-live', 'session:session-archive'],
    'CRT Search should combine matching live Agents and unclaimed provider sessions while excluding Main and archived Agent records',
  );
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
    encodeProviderSessionKey('codex', 'session-1', 'work'),
  );
  assert.deepStrictEqual(
    crtResumedSessionFromSource('qoder-history:home:team:qoder-1'),
    { provider: 'qoder', providerHomeId: 'team', sessionId: 'qoder-1', forked: false },
  );
  assert.deepStrictEqual(
    crtResumedSessionFromSource('qoder-history-fork:home:team:qoder-1'),
    { provider: 'qoder', providerHomeId: 'team', sessionId: 'qoder-1', forked: true },
  );
  assert.strictEqual(
    crtClaimedSessionFromSource('qoder-history-fork:home:team:qoder-1'),
    null,
    'a forked resume owns a new provider session, so CRT must not claim the origin',
  );
  assert.strictEqual(formatCrtHistoryAge(1_000, 1_000), 'now');
  assert.strictEqual(formatCrtHistoryAge(1_000, 61_000), '1m');

  const liveMainAgentState = {
    mainAgentId: 'main-agent',
    agents: [{ id: 'main-agent', status: 'running' }],
  };
  const missingMainAgentState = { mainAgentId: '', agents: [] };
  const regularAgentOnlyState = {
    mainAgentId: '',
    agents: [{ id: 'regular-agent', status: 'running' }],
  };
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: missingMainAgentState,
    mainView: 'history',
  }), 'none', 'History should not be interrupted by Main Agent onboarding during recovery');
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: liveMainAgentState,
    mainView: 'history',
    dialogActive: true,
    pendingMainAgent: true,
  }), 'hide', 'a recovered Main Agent should dismiss stale onboarding');
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: missingMainAgentState,
    mainView: 'agents',
  }), 'show', 'the Agents view should still onboard a genuinely missing Main Agent');
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: regularAgentOnlyState,
    mainView: 'agents',
  }), 'none', 'Main Agent onboarding should not cover an existing regular Agent supervision surface');
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: regularAgentOnlyState,
    mainView: 'agents',
    dialogActive: true,
    pendingMainAgent: true,
  }), 'hide', 'a regular Agent should dismiss stale automatic Main Agent onboarding');
  assert.strictEqual(getCrtMainAgentDialogAction({
    currentState: missingMainAgentState,
    mainView: 'agents',
    dialogActive: true,
    pendingMainAgent: false,
  }), 'none', 'state refreshes should not reclassify an active regular-Agent dialog');

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
        providerSessionKey: encodeProviderSessionKey('codex', 'live-session', 'default'),
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
    mainPageSessionKeys: [encodeProviderSessionKey('qoder', 'main-page-session', 'default')],
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
    source: 'codex-history:019d0f72',
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
    getCrtAgentTitle({ ...titledAgent, source: 'ui', runtimeBinding: { kind: 'acp' }, providerSessionTitle: '第一条消息', sessionTitle: '第一条消息' }),
    'Codex',
    'CRT live Agents must not use first-message Provider titles',
  );
  assert.strictEqual(
    getCrtAgentTitle({ ...titledAgent, source: 'ui', adaptiveTitle: 'Agent-generated title' }),
    'Agent-generated title',
    'CRT should use the same explicit adaptive-title source as Farming Code',
  );
  assert.strictEqual(
    getCrtAgentTitle({ command: 'qodercli', sessionTitle: '✦ Working… (farming)' }),
    'Qoder',
  );

  const longTitle = '现在代码中有哪些是死功能，比如 json 的 chat 是否仍然存在';
  assert.strictEqual(
    getCrtAgentTitle({ ...titledAgent, customTitle: longTitle }),
    longTitle,
    'CRT title containers should receive the full title and apply responsive ellipsis themselves',
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
  assert.notStrictEqual(
    crtDashboardStateSignature(dashboardState),
    crtDashboardStateSignature({
      ...dashboardState,
      agents: [{ ...dashboardState.agents[0], adaptiveTitle: 'Updated Pi title' }],
    }),
    'adaptive title changes should invalidate the dashboard structure',
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
  assert.strictEqual(
    createSessionModalState({ ...titledAgent, customTitle: longTitle }, 'terminal', { crtEffects: true }).title,
    longTitle,
    'an open CRT session should let the responsive header display the full title',
  );

  // Regression: CRT & Code terminal stopped-without-checkpoint races and retained-checkpoint stopped notice
  const fs = require('node:fs');
  const path = require('node:path');
  const ts = require('typescript');
  const vm = require('node:vm');
  const root = path.resolve(__dirname, '../..');
  const Replay = require(path.join(root, 'frontend/terminal-replay.js'));
  const Coordinator = require(path.join(root, 'frontend/terminal-attachment-coordinator.js'));
  const extractFunctions = (file: string, names: string[]) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const nodes = ast.statements.filter((node: { kind: number; name?: { text?: string } }) => (
      ts.isFunctionDeclaration(node) && Boolean(node.name?.text && names.includes(node.name.text))
    ));
    assert.strictEqual(nodes.length, names.length, `Expected product functions in ${file}`);
    return ts.transpileModule(nodes.map((node: { getText: (sourceFile: unknown) => string }) => node.getText(ast)).join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
  };
  const makeCoordinator = () => {
    const attachment = new Coordinator(Replay);
    attachment.beginAttachment();
    return attachment;
  };
  const newEpoch = 'farming-runtime-v1:00000000000000000002:adversarial';
  const nextOutput = { kind: 'output', runtimeEpoch: newEpoch, outputSeq: 1, stateRevision: 1, data: 'new runtime output' };
  const attachment = makeCoordinator();
  const replication: Record<string, unknown> = { agentId: 'a', attachment, disposed: false, checkpointRetryTimer: null, installInProgress: false, queuedCheckpointInstall: null };
  let pendingWrite: (() => void) | null = null;
  let notices = 0;
  let checkpointRequests = 0;
  let drainedCheckpoint: unknown = null;
  const crtContext: Record<string, unknown> = {
    crtTerminalReplication: replication,
    terminal: { reset() {}, write(_text: string, callback: () => void) { pendingWrite = callback; } },
    state: { agents: [{ id: 'a', status: 'stopped' }] },
    document: { getElementById() { return { classList: { remove() {} } }; } },
    CRT_TERMINAL_CHECKPOINT_SCROLLBACK_STEPS: [200],
    clearPendingCrtTerminalFitResize() {},
    updateCrtTerminalInputState() {},
    clearCrtTerminalNotices() {},
    refreshSessionTerminalUi() {},
    showCrtTerminalStoppedNotice() { notices += 1; },
    requestCrtTerminalReplay() { checkpointRequests += 1; },
    performCrtTerminalCheckpointInstall(_rep: unknown, queued: unknown) { drainedCheckpoint = queued; return true; },
    getSessionRuntime() { return null; },
    clearTimeout,
  };
  vm.createContext(crtContext);
  vm.runInContext(extractFunctions('frontend/skins/crt/app.ts', [
    'drainCrtTerminalCheckpointInstall', 'settleStoppedCrtTerminalWithoutCheckpoint', 'isStoppedCrtSessionStatus',
  ]), crtContext);
  const oldOperation = attachment.beginCheckpointOperation();
  (crtContext.settleStoppedCrtTerminalWithoutCheckpoint as (...args: unknown[]) => void)(
    replication,
    { status: 'stopped', output: 'old stopped output' },
    oldOperation,
  );
  assert.strictEqual(replication.installInProgress, true, 'fallback write keeps installInProgress true until callback settles');
  assert.strictEqual(typeof pendingWrite, 'function');
  const newOperation = attachment.beginCheckpointOperation();
  assert(attachment.commitCheckpoint(newOperation, { runtimeEpoch: newEpoch, outputSeq: 1, stateRevision: 1, cols: 80, rows: 24 }));
  (crtContext.state as { agents: Array<{ status: string }> }).agents[0].status = 'running';
  replication.pendingCheckpoint = { checkpoint: 'queued-live', operation: newOperation };
  pendingWrite!();
  assert.strictEqual(notices, 0, 'superseded fallback write callback must not show stopped notice');
  assert.deepStrictEqual(drainedCheckpoint, { checkpoint: 'queued-live', operation: newOperation }, 'superseded fallback write drains pendingCheckpoint install');

  const second = makeCoordinator();
  const secondReplication: Record<string, unknown> = { agentId: 'a', attachment: second, disposed: false, checkpointRetryTimer: null };
  crtContext.crtTerminalReplication = secondReplication;
  crtContext.setTimeout = () => 99;
  (crtContext.state as { agents: Array<{ status: string }> }).agents[0].status = 'running';
  checkpointRequests = 0;
  const requestOperation = second.beginCheckpointOperation();
  second.beginRecovery(nextOutput);
  second.queueTransition(nextOutput);
  (crtContext.settleStoppedCrtTerminalWithoutCheckpoint as (...args: unknown[]) => void)(
    secondReplication,
    { status: 'stopped', output: '' },
    requestOperation,
  );
  assert.strictEqual(second.queuedTransitionCount, 1, 'stale stopped response must not clear queued transitions');
  assert.strictEqual(second.isReplayTargetPending(), true, 'stale stopped response must preserve replay target');
  assert.strictEqual((crtContext.state as { agents: Array<{ status: string }> }).agents[0].status, 'running', 'stale stopped response must not overwrite running status');
  assert.strictEqual(second.failureCount, 1, 'stale stopped response records an invariant failure with backoff');
  assert.strictEqual(secondReplication.checkpointRetryTimer, 99, 'stale stopped response schedules bounded retry instead of synchronous infinite loop');
  assert.strictEqual(checkpointRequests, 0, 'stale stopped response must not loop synchronously');

  // CRT fallback write callback when new output arrives mid-write must advance recovery instead of showing stopped notice
  const crtMidWrite = makeCoordinator();
  const crtMidWriteRep: Record<string, unknown> = { agentId: 'a', attachment: crtMidWrite, disposed: false, checkpointRetryTimer: null, installInProgress: false };
  crtContext.crtTerminalReplication = crtMidWriteRep;
  (crtContext.state as { agents: Array<{ status: string }> }).agents[0].status = 'stopped';
  notices = 0;
  checkpointRequests = 0;
  const crtMidWriteOp = crtMidWrite.beginCheckpointOperation();
  (crtContext.settleStoppedCrtTerminalWithoutCheckpoint as (...args: unknown[]) => void)(
    crtMidWriteRep,
    { status: 'stopped', output: 'old history' },
    crtMidWriteOp,
  );
  crtMidWrite.queueTransition(nextOutput);
  pendingWrite!();
  assert.strictEqual(notices, 0, 'CRT fallback callback must not show stopped notice when new output arrived mid-write');
  assert.strictEqual(checkpointRequests, 1, 'CRT fallback callback triggers replay recovery when new output arrived mid-write');

  const third = makeCoordinator();
  const thirdOperation = third.beginCheckpointOperation();
  third.beginRecovery(nextOutput);
  third.queueTransition(nextOutput);
  const phases: string[] = [];
  let codeCheckpointRequests = 0;
  const record = {
    attachment: third,
    disposed: false,
    replication: { needsReconnectOutputSync: true, bootstrappingSnapshot: true, stoppedWithoutCheckpoint: false, checkpointRetryTimer: null as number | null },
    hostEl: { classList: { add() {}, remove() {} } },
    replicationPorts: { isAttached: () => true, publishStatus: (phase: string) => phases.push(phase), notifyReady() {} },
  };
  let codeCompleteReplace: (() => void) | null = null;
  const codeContext: Record<string, unknown> = {
    window: { setTimeout: () => 77 },
    clearTerminalCheckpointRetry() {},
    requestTerminalReplay() { codeCheckpointRequests += 1; },
    replaceTerminalOutput(_rec: unknown, _out: string, done: () => void, options: { beforeReplace: () => boolean }) {
      assert(options.beforeReplace());
      codeCompleteReplace = done;
    },
  };
  vm.createContext(codeContext);
  vm.runInContext(extractFunctions('src/lib/terminal-session-replication.ts', [
    'settleStoppedTerminalWithoutCheckpoint', 'isCurrentReplicationAttachment',
  ]), codeContext);
  (codeContext.settleStoppedTerminalWithoutCheckpoint as (...args: unknown[]) => void)(
    record,
    { status: 'stopped', output: '' },
    third.generation,
    thirdOperation,
  );
  assert.strictEqual(third.queuedTransitionCount, 1, 'Code stale stopped response must not clear queued transitions');
  assert.strictEqual(third.isReplayTargetPending(), true, 'Code stale stopped response must preserve replay target');
  assert.strictEqual(record.replication.stoppedWithoutCheckpoint, false, 'Code stale stopped response must not set stoppedWithoutCheckpoint');
  assert.deepStrictEqual(phases, ['retrying'], 'Code stale stopped response publishes retrying instead of ready');
  assert.strictEqual(third.failureCount, 1, 'Code stale stopped response increments failureCount');
  assert.strictEqual(record.replication.checkpointRetryTimer, 77, 'Code stale stopped response schedules bounded retry timer');
  assert.strictEqual(codeCheckpointRequests, 0, 'Code stale stopped response must not recurse synchronously');

  // Code fallback write callback when new output arrives mid-write must advance recovery instead of publishing ready/stopped
  const fourth = makeCoordinator();
  const fourthPhases: string[] = [];
  const fourthRecord = {
    attachment: fourth,
    disposed: false,
    replication: { needsReconnectOutputSync: true, bootstrappingSnapshot: true, stoppedWithoutCheckpoint: false, replayInProgress: false, checkpointRetryTimer: null as number | null },
    hostEl: { classList: { add() {}, remove() {} } },
    replicationPorts: { isAttached: () => true, publishStatus: (phase: string) => fourthPhases.push(phase), notifyReady() {} },
  };
  codeCheckpointRequests = 0;
  (codeContext.settleStoppedTerminalWithoutCheckpoint as (...args: unknown[]) => void)(
    fourthRecord,
    { status: 'stopped', output: 'old history' },
    fourth.generation,
    fourth.beginCheckpointOperation(),
  );
  fourth.queueTransition(nextOutput);
  codeCompleteReplace!();
  assert.strictEqual(fourthRecord.replication.stoppedWithoutCheckpoint, false, 'Code fallback callback must not set stoppedWithoutCheckpoint when new output arrived mid-write');
  assert.deepStrictEqual(fourthPhases, [], 'Code fallback callback must not publish ready when new output arrived mid-write');
  assert.strictEqual(codeCheckpointRequests, 1, 'Code fallback callback triggers replay recovery when new output arrived mid-write');

  console.log('✓ CRT cards use meaningful titles and working-state blink');
}

run();
