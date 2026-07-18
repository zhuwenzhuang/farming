let ws = null;
let wsReconnectTimer = null;
let state = null;
let focusedAgentId = null;
let keyMap = {};
let agents = [];
let waitingForAgent = false;
let selectedAgentIndex = null;
let terminal = null;
let fitAddon = null;
let availableThemes = [];
let currentTheme = 'terminal';
let themeSettings = {};
let currentSessionSkin = null;
let currentSessionTitle = 'Agent Session';
let sessionClient = null;
let globalSettings = {
  workspace: '',
  workspaceHistory: [],
  defaultLaunchAgent: '',
  dangerouslySkipAgentPermissionsByDefault: false,
  crtSkinEffectsEnabled: true,
  crtDynamicHeatEnabled: false,
  crtTerminalFontSize: 15
};
let crtTerminalFontSizeSaveTimer = null;
let workspaceHistorySelection = -1;
let workspaceHistoryExpanded = false;
let pendingMainAgentLaunch = false;
let pendingAgentLaunchPrefill = null;
let crtNavigationKey = '';
let crtMainView = 'agents';
let didApplyAgentDeeplink = false;
let historyAgentSessions = [];
let historyLoading = false;
let historyError = '';
let historyActionPendingKey = '';
let pendingProviderSessionOpenAgentId = '';
let historyPage = 0;
let historyPageSize = 1;
let searchQuery = '';
let searchAgentSessions = [];
let searchLoading = false;
let searchError = '';
let searchSelectionIndex = 0;
let searchRequestSequence = 0;
let searchDebounceTimer = null;
let searchAbortController = null;
let searchActionPendingKey = '';
let billingSummary = null;
let billingLoading = false;
let billingError = '';
let billingRequestSequence = 0;
let billingAbortController = null;
let billingRefreshTimer = null;
let billingLiveDayRefreshTimer = null;
let billingCanvasFrame = null;
let billingMode = 'days';
let billingSelectedDate = '';
let billingSelectedHour = null;
let billingDailyRenderSignature = '';
let billingDayDetail = null;
let billingDayDetailLoading = false;
let billingDayDetailError = '';
let billingDayDetailRequestSequence = 0;
let billingDayDetailAbortController = null;
let billingDayDetailRetryTimer = null;
let billingDisplayedTotalDate = '';
let billingDisplayedTotalValue = null;
let billingTotalAnimationFrame = null;
let billingTotalAnimationTarget = null;
const billingAnimatedMetrics = new Map();
const billingDayDetailCache = new Map();
let crtAgentPage = 0;
let crtAgentPageSize = 1;
let crtAgentPageColumns = 1;
let crtAgentPageResizeFrame = null;
let dashboardRenderDeferred = false;
let lastCrtDashboardSignature = '';
let crtPreviewRenderTimer = null;
const pendingCrtPreviewRenders = new Map();
const crtStructuredPreviewCache = new Map();
const crtStructuredPreviewTimers = new Map();
let sessionRuntime = null;
let structuredSessionPoller = null;
let structuredSessionLoading = false;
let structuredSessionRenderedAt = '';
let structuredSessionSnapshot = null;
let structuredSessionControlsLoading = false;
let structuredSessionControlsRevision = '';
let structuredComposerMenu = '';
let structuredComposerMenuOpenerId = '';
let structuredComposerMenuFocusPending = false;
let structuredComposerConfigId = '';
let structuredComposerAttachments = [];
const structuredComposerHistory = new Map();
const structuredComposerPendingFollowUps = new Map();
let structuredComposerHistoryIndex = -1;
let structuredComposerCompositionEndAt = 0;
let structuredComposerRestoreFocusAfterInterrupt = false;
let runtimeSwitchPending = false;
let pendingRuntimeSwitchAgentId = '';
let runtimeSwitchRequestSequence = 0;
let crtTerminalReplication = null;
const terminalPreviewSnapshots = new Map();
const crtBrandPulseTimers = new Map();
const SESSION_LINK_LIMIT = 6;
const CRT_PROTOCOL_VERSION = 2;
const CRT_PREVIEW_RENDER_INTERVAL_MS = 1000;
const CRT_STRUCTURED_PREVIEW_REFRESH_MS = 240;
const CRT_AGENT_CARD_MIN_WIDTH = 200;
const CRT_AGENT_CARD_MIN_HEIGHT = 160;
const CRT_AGENT_GRID_GAP = 15;
const CRT_AGENT_GRID_PADDING = 20;
const CRT_SEARCH_DEBOUNCE_MS = 180;
const CRT_SEARCH_RESULT_LIMIT = 100;
const CRT_BILLING_REFRESH_MS = 30_000;
const CRT_BILLING_LIVE_DAY_REFRESH_MS = 5_000;
const CRT_BILLING_DAY_DETAIL_CACHE_MS = 30_000;
const CRT_BILLING_TOTAL_ANIMATION_MS = 900;
const CRT_BILLING_DAY_DETAIL_RETRY_MS = 750;
const CRT_BILLING_DAY_DETAIL_MAX_RETRIES = 4;
const CRT_TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS = 5_000;
const CRT_TERMINAL_RESIZE_SETTLE_MS = 250;
const CRT_TERMINAL_MIN_COLS = 40;
const CRT_TERMINAL_MIN_ROWS = 10;
const CRT_AGENT_DISPLAY_NAMES = {
  qwen: 'Qwen Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  qoder: 'Qoder',
  qodercli: 'Qoder',
  aider: 'Aider',
  'github-copilot-cli': 'GitHub Copilot CLI',
  claude: 'Claude Code',
  'amazon-q': 'Amazon Q',
  bash: 'bash',
  zsh: 'zsh'
};
const CRT_TITLE_STATUS_PREFIX_PATTERN = /^[\s*＊✳✱✲✶·•◇✋✦⏲\u2800-\u28FF]+/u;
const CRT_QODER_RUNTIME_TITLE_PATTERN = /^[◇✋✦⏲]/u;
const RUNTIME_PATHS = typeof window !== 'undefined' ? window.FarmingRuntimePaths : null;
const TERMINAL_REPLAY = typeof window !== 'undefined' ? window.FarmingTerminalReplay : null;

function farmingApiPath(path) {
  return RUNTIME_PATHS ? RUNTIME_PATHS.apiPath(path) : `/api${path.startsWith('/') ? path : `/${path}`}`;
}

function farmingWebSocketUrl() {
  if (RUNTIME_PATHS) return RUNTIME_PATHS.webSocketUrl();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}`;
}

function findDirectionalNavigationIndex(rects, currentIndex, key, wrap = false) {
  if (!Array.isArray(rects) || rects.length === 0) return -1;
  if (currentIndex < 0 || currentIndex >= rects.length) return 0;

  const current = rects[currentIndex];
  const currentX = (current.left + current.right) / 2;
  const currentY = (current.top + current.bottom) / 2;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;

  rects.forEach((rect, index) => {
    if (index === currentIndex) return;
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    const primaryDelta = horizontal ? x - currentX : y - currentY;
    if (primaryDelta * direction <= 1) return;
    const crossDelta = horizontal ? Math.abs(y - currentY) : Math.abs(x - currentX);
    const score = Math.abs(primaryDelta) + crossDelta * 2;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  if (bestIndex >= 0 || !wrap || rects.length < 2) return bestIndex;

  const centers = rects.map((rect) => ({
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  }));
  const primaryValues = centers.map((center) => horizontal ? center.x : center.y);
  if (Math.max(...primaryValues) - Math.min(...primaryValues) <= 1) return -1;
  const wrapEdge = direction > 0 ? Math.min(...primaryValues) : Math.max(...primaryValues);

  centers.forEach((center, index) => {
    if (index === currentIndex) return;
    const primary = horizontal ? center.x : center.y;
    const crossDelta = horizontal ? Math.abs(center.y - currentY) : Math.abs(center.x - currentX);
    const score = Math.abs(primary - wrapEdge) * 1000 + crossDelta;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function calculateCrtAgentPageLayout(availableWidth, availableHeight, itemCount) {
  const width = Math.max(0, Number(availableWidth) || 0);
  const height = Math.max(0, Number(availableHeight) || 0);
  const innerWidth = Math.max(0, width - CRT_AGENT_GRID_PADDING * 2);
  const innerHeight = Math.max(0, height - CRT_AGENT_GRID_PADDING * 2);
  const maxColumns = Math.max(1, Math.floor(
    (innerWidth + CRT_AGENT_GRID_GAP) / (CRT_AGENT_CARD_MIN_WIDTH + CRT_AGENT_GRID_GAP),
  ));
  const maxRows = Math.max(1, Math.floor(
    (innerHeight + CRT_AGENT_GRID_GAP) / (CRT_AGENT_CARD_MIN_HEIGHT + CRT_AGENT_GRID_GAP),
  ));
  const count = Math.max(0, Math.floor(Number(itemCount) || 0));
  const preferred = count <= 4
    ? { columns: 2, rows: 2 }
    : count <= 6
      ? { columns: 3, rows: 2 }
      : { columns: 3, rows: 3 };
  const columns = Math.min(preferred.columns, maxColumns);
  const rows = Math.min(preferred.rows, maxRows);
  return { columns, rows, pageSize: columns * rows };
}

function getCrtAgentPage(items, page, pageSize) {
  const source = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const totalPages = Math.max(1, Math.ceil(source.length / size));
  const currentPage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));
  const start = currentPage * size;
  return {
    items: source.slice(start, start + size),
    page: currentPage,
    pageSize: size,
    totalItems: source.length,
    totalPages,
    start,
  };
}

function getCrtAgentVerticalPageTarget({ itemIndex, totalItems, pageSize, columns, key }) {
  const rawIndex = Number(itemIndex);
  const total = Math.max(0, Math.floor(Number(totalItems) || 0));
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const columnCount = Math.max(1, Math.floor(Number(columns) || 1));
  if (!Number.isFinite(rawIndex)) return -1;
  const index = Math.floor(rawIndex);
  if (index < 0 || index >= total || (key !== 'ArrowUp' && key !== 'ArrowDown')) return -1;

  const page = Math.floor(index / size);
  const pageStart = page * size;
  const localIndex = index - pageStart;
  const pageItemCount = Math.min(size, total - pageStart);
  const row = Math.floor(localIndex / columnCount);
  const column = localIndex % columnCount;

  if (key === 'ArrowDown') {
    const lastRow = Math.ceil(pageItemCount / columnCount) - 1;
    const nextStart = pageStart + size;
    if (row !== lastRow || nextStart >= total) return -1;
    const nextCount = Math.min(size, total - nextStart);
    return nextStart + Math.min(column, nextCount - 1);
  }

  if (row !== 0 || page === 0) return -1;
  const previousStart = pageStart - size;
  const previousCount = Math.min(size, total - previousStart);
  const previousLastRowStart = Math.floor((previousCount - 1) / columnCount) * columnCount;
  const previousLastRowCount = previousCount - previousLastRowStart;
  return previousStart + previousLastRowStart + Math.min(column, previousLastRowCount - 1);
}

function findDefaultNewAgentIndex(agentOptions, preferredAgentName) {
  if (!Array.isArray(agentOptions) || agentOptions.length === 0) return -1;
  const preferredName = String(preferredAgentName || '').trim().toLowerCase();
  if (!preferredName) return 0;
  const preferredIndex = agentOptions.findIndex((agent) => (
    String(agent && agent.name || '').trim().toLowerCase() === preferredName
  ));
  return preferredIndex >= 0 ? preferredIndex : 0;
}

function crtAgentSessionKey(session) {
  const provider = String(session && session.provider || '').trim().toLowerCase();
  const sessionId = String(session && session.id || '').trim();
  const providerHomeId = String(session && session.providerHomeId || 'default').trim() || 'default';
  if (!provider || !sessionId) return '';
  const scopedSessionId = providerHomeId === 'default'
    ? sessionId
    : `home:${providerHomeId}:${sessionId}`;
  return `agent-session:${provider}:${scopedSessionId}`;
}

function crtResumedSessionFromSource(source) {
  const match = /^([a-z]+)-history(?:-fork)?:(?:(?:home:([A-Za-z0-9._-]+):)?(.+))$/.exec(source || '');
  if (!match) return null;
  return {
    provider: match[1],
    providerHomeId: match[2] || 'default',
    sessionId: match[3]
  };
}

function crtHistoryItemResumeSession(item) {
  if (!item) return null;
  if (item.kind === 'session') {
    const provider = String(item.session.provider || '').trim().toLowerCase();
    const sessionId = String(item.session.id || '').trim();
    if (!provider || !sessionId) return null;
    return {
      provider,
      sessionId,
      providerHomeId: item.session.providerHomeId || 'default'
    };
  }
  if (item.kind === 'agent') {
    const provider = String(item.agent.providerSessionProvider || '').trim().toLowerCase();
    const sessionId = String(item.agent.providerSessionId || '').trim();
    if (provider && sessionId && item.agent.providerSessionTemporary !== true) {
      return {
        provider,
        sessionId,
        providerHomeId: item.agent.providerHomeId || 'default'
      };
    }
    return crtResumedSessionFromSource(item.agent.source);
  }
  return crtResumedSessionFromSource(item.entry.source);
}

function crtHistoryTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function crtHistoryItemUpdatedAt(item) {
  if (item.kind === 'session') {
    return Math.max(crtHistoryTimestamp(item.session.updatedAt), crtHistoryTimestamp(item.session.createdAt));
  }
  const source = item.kind === 'agent' ? item.agent : item.entry;
  return Math.max(source.archivedAt || 0, source.lastActivity || 0, source.startedAt || 0);
}

function crtHistoryItemResumeKey(item) {
  const resumed = crtHistoryItemResumeSession(item);
  return resumed
    ? `resume:${resumed.provider}:${resumed.providerHomeId || 'default'}:${resumed.sessionId}`
    : '';
}

function crtHistoryItemPriority(item) {
  if (item.kind === 'session') return 30;
  if (item.kind === 'agent') return 20;
  return 10;
}

function shouldReplaceCrtHistoryItem(current, candidate) {
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt;
  return crtHistoryItemPriority(candidate) > crtHistoryItemPriority(current);
}

function crtHistorySessionDisplayKey(item) {
  if (item.kind !== 'session') return '';
  const title = String(item.session.title || '').trim().toLowerCase();
  const workspace = String(item.session.workspace || item.session.cwd || '').trim().toLowerCase();
  const provider = String(item.session.provider || '').trim().toLowerCase();
  const home = String(item.session.providerHomeId || 'default').trim().toLowerCase();
  return title.length > 4 && workspace ? `${provider}:${home}:${workspace}:${title}` : '';
}

function buildCrtHistoryItems({ taskHistory = [], agents: agentRecords = [], sessions = [], mainPageSessionKeys = [] } = {}) {
  const liveAgents = agentRecords.filter((agent) => (
    agent.isMain !== true
    && isCrtLiveAgent(agent)
  ));
  const claimedSessionKeys = new Set(liveAgents.map((agent) => (
    agent.providerSessionKey || (() => {
      const resumed = crtResumedSessionFromSource(agent.source);
      return resumed ? crtAgentSessionKey({
        provider: resumed.provider,
        id: resumed.sessionId,
        providerHomeId: resumed.providerHomeId
      }) : '';
    })()
  )).filter(Boolean));
  const mainPageKeys = new Set(Array.isArray(mainPageSessionKeys) ? mainPageSessionKeys : []);
  const historySessions = sessions.filter((session) => {
    const key = crtAgentSessionKey(session);
    if (!key || claimedSessionKeys.has(key)) return false;
    return session.archived === true || !mainPageKeys.has(key);
  });
  const candidates = [
    ...taskHistory.map((entry) => ({ kind: 'run', historyKey: `run:${entry.id}`, entry })),
    ...agentRecords
      .filter((agent) => agent.isMain !== true && agent.archived === true)
      .map((agent) => ({ kind: 'agent', historyKey: `agent:${agent.id}`, agent })),
    ...historySessions.map((session) => ({ kind: 'session', historyKey: crtAgentSessionKey(session), session }))
  ].map((item) => ({ ...item, updatedAt: crtHistoryItemUpdatedAt(item) }));

  const retained = [];
  const resumable = new Map();
  candidates.forEach((item) => {
    const resumeKey = crtHistoryItemResumeKey(item);
    if (!resumeKey) {
      retained.push(item);
      return;
    }
    const current = resumable.get(resumeKey);
    if (!current || shouldReplaceCrtHistoryItem(current, item)) resumable.set(resumeKey, item);
  });

  const exactDedupe = [...retained, ...resumable.values()];
  const visualSessions = new Map();
  exactDedupe.forEach((item) => {
    const displayKey = crtHistorySessionDisplayKey(item);
    if (!displayKey) return;
    const current = visualSessions.get(displayKey);
    if (!current || shouldReplaceCrtHistoryItem(current, item)) visualSessions.set(displayKey, item);
  });

  return exactDedupe
    .filter((item) => {
      const displayKey = crtHistorySessionDisplayKey(item);
      return !displayKey || visualSessions.get(displayKey) === item;
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function buildCrtSearchResults({ query = '', agents: agentRecords = [], sessions = [], mainAgentId = '', projectNames = {} } = {}) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return [];

  const liveAgents = agentRecords.filter((agent) => (
    agent
    && agent.id !== mainAgentId
    && agent.isMain !== true
    && isCrtLiveAgent(agent)
  ));
  const claimedSessionKeys = new Set(liveAgents.map((agent) => {
    if (agent.providerSessionKey) return agent.providerSessionKey;
    const resumed = crtResumedSessionFromSource(agent.source);
    return resumed ? crtAgentSessionKey({
      provider: resumed.provider,
      id: resumed.sessionId,
      providerHomeId: resumed.providerHomeId,
    }) : '';
  }).filter(Boolean));
  const includesQuery = (values) => values.some((value) => (
    String(value || '').toLowerCase().includes(normalizedQuery)
  ));
  const matchingAgents = liveAgents.filter((agent) => includesQuery([
    getCrtAgentTitle(agent),
    getCrtProjectName(agent, projectNames),
    agent.projectWorkspace,
    agent.cwd,
    agent.task,
    agent.command,
    agent.providerSessionTitle,
    agent.sessionTitle,
  ])).map((agent) => ({
    kind: 'agent',
    searchKey: `agent:${agent.id}`,
    agent,
  }));
  const matchingSessions = sessions.filter((session) => {
    const key = crtAgentSessionKey(session);
    if (!key || claimedSessionKeys.has(key)) return false;
    const workspace = session.workspace || session.cwd || '';
    return includesQuery([
      session.title,
      session.providerName,
      session.provider,
      workspace,
      getCrtProjectName({ projectWorkspace: workspace }, projectNames),
    ]);
  }).map((session) => ({
    kind: 'session',
    searchKey: crtAgentSessionKey(session),
    session,
  }));

  return [...matchingAgents, ...matchingSessions];
}

function getCrtNavigationScope() {
  const sessionModal = document.getElementById('session-modal');
  if (sessionModal && sessionModal.classList.contains('active')) return sessionModal;
  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal && settingsModal.classList.contains('active')) return settingsModal;
  const inputDialog = document.getElementById('input-dialog');
  if (inputDialog && inputDialog.classList.contains('active')) return inputDialog;
  const billingArea = document.getElementById('billing-area');
  if (billingArea && !billingArea.classList.contains('hidden')) return billingArea;
  const searchArea = document.getElementById('search-area');
  if (searchArea && !searchArea.classList.contains('hidden')) return searchArea;
  const historyArea = document.getElementById('history-area');
  if (historyArea && !historyArea.classList.contains('hidden')) return historyArea;
  return document.querySelector('.main-container');
}

function getCrtNavigationItems() {
  const scope = getCrtNavigationScope();
  if (!scope) return [];
  return Array.from(scope.querySelectorAll('[data-crt-nav-key]')).filter((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function clearCrtNavigationSelection({ forget = true } = {}) {
  document.querySelectorAll('.crt-nav-selected').forEach((element) => {
    element.classList.remove('crt-nav-selected');
  });
  if (forget) crtNavigationKey = '';
}

function setCrtNavigationSelection(element) {
  if (!element) return false;
  clearCrtNavigationSelection({ forget: false });
  crtNavigationKey = element.dataset.crtNavKey || '';
  element.classList.add('crt-nav-selected');
  if (typeof element.focus === 'function') element.focus({ preventScroll: true });
  const scrollTarget = element.closest && element.closest('#settings-modal .settings-panel')
    ? element.closest('#settings-modal .settings-panel')
    : element;
  if (typeof scrollTarget.scrollIntoView === 'function') {
    scrollTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  return true;
}

function restoreCrtNavigationSelection() {
  if (!crtNavigationKey) return false;
  const element = getCrtNavigationItems().find((candidate) => candidate.dataset.crtNavKey === crtNavigationKey);
  return element ? setCrtNavigationSelection(element) : false;
}

function moveCrtNavigationSelection(key) {
  const scope = getCrtNavigationScope();
  const items = getCrtNavigationItems();
  if (!items.length) return false;
  const currentIndex = items.findIndex((element) => (
    element.classList.contains('crt-nav-selected') || element.dataset.crtNavKey === crtNavigationKey
  ));
  if (currentIndex < 0) {
    const defaultItem = items.find((element) => element.dataset.crtNavDefault === 'true') || items[0];
    return setCrtNavigationSelection(defaultItem);
  }
  const rects = items.map((element) => element.getBoundingClientRect());
  const wrap = Boolean(scope && (
    scope.id === 'input-dialog'
    || scope.classList.contains('main-container')
  ));
  const nextIndex = findDirectionalNavigationIndex(rects, currentIndex, key, wrap);
  return nextIndex >= 0 ? setCrtNavigationSelection(items[nextIndex]) : false;
}

function activateCrtNavigationSelection() {
  const item = getCrtNavigationItems().find((element) => element.classList.contains('crt-nav-selected'));
  if (!item) return false;
  if (item.matches('input, textarea, select')) {
    item.focus();
    return true;
  }
  item.click();
  return true;
}

let sessionSearchMatches = [];
let sessionSearchIndex = -1;
const MAX_WORKSPACE_HISTORY = 5;
const TERMINAL_THEME = {
  background: '#000d06',
  foreground: '#0ccc68',
  cursor: '#55f59b',
  cursorAccent: '#001409',
  selectionBackground: 'rgba(12, 204, 104, 0.3)',
  black: '#000000',
  red: '#087a42',
  green: '#0ccc68',
  yellow: '#45dc8c',
  blue: '#09683a',
  magenta: '#16a95f',
  cyan: '#2bd47e',
  white: '#87eeb1',
  brightBlack: '#07532f',
  brightRed: '#12a95e',
  brightGreen: '#55f59b',
  brightYellow: '#79f5ad',
  brightBlue: '#18a763',
  brightMagenta: '#4bdd91',
  brightCyan: '#70efaa',
  brightWhite: '#c5f8d9'
};
const TERMINAL_FONT_FAMILY = typeof window !== 'undefined' && window.FarmingTerminalBridge
  ? window.FarmingTerminalBridge.DEFAULT_FONT_FAMILY
  : '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", "Sarasa Mono SC", "PingFang SC", "Hiragino Sans GB", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", monospace';
const DEFAULT_TERMINAL_FONT_SIZE = 15;
const MIN_TERMINAL_FONT_SIZE = 10;
const MAX_TERMINAL_FONT_SIZE = 20;
const TERMINAL_SCROLLBACK = 5000;
const FARMING_CODE_THEME = {
  id: 'farming-code',
  displayName: 'Farming Code',
  description: 'Modern workspace for coding, files, review, and agent supervision'
};
const SESSION_MODAL_BRIDGE = (() => {
  if (typeof window !== 'undefined' && window.FarmingSessionModalBridge) {
    return window.FarmingSessionModalBridge;
  }

  if (typeof require === 'function') {
    try {
      return require('./session-modal-bridge.js');
    } catch {
      return null;
    }
  }

  return null;
})();

function isBrowserShortcut(event) {
  const pressed = event.key.toLowerCase();
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const primary = isMac ? event.metaKey : event.ctrlKey;
  const wrongPrimary = isMac ? event.ctrlKey : event.metaKey;

  if (wrongPrimary || !primary) {
    if (!isMac && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && pressed === 'f4') {
      return true;
    }
    return false;
  }

  const noModifiers = !event.shiftKey && !event.altKey;
  const withShift = event.shiftKey && !event.altKey;
  const withAlt = event.altKey && !event.shiftKey;

  const baseKeys = isMac ? ['t', 'n', 'w', 'q', 'h', 'm', ','] : ['t', 'n', 'w', 'h'];
  const shiftKeys = isMac ? ['t', 'n', 'a', 'z', ']', '[', 'j', 'c'] : ['t', 'n', 'j', 'c'];
  const altKeys = isMac ? ['w'] : [];

  if (noModifiers && (baseKeys.includes(pressed) || /^[0-9]$/.test(event.key) || ['c', 'x', 'v'].includes(pressed))) {
    return true;
  }
  if (withShift && shiftKeys.includes(pressed)) {
    return true;
  }
  if (withAlt && altKeys.includes(pressed)) {
    return true;
  }

  return false;
}

function isPrimaryModifierPressed(event) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  return isMac ? event.metaKey : event.ctrlKey;
}

function isCopyShortcut(event) {
  return isPrimaryModifierPressed(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c';
}

function isPasteShortcut(event) {
  return isPrimaryModifierPressed(event) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v';
}

function disposeTerminal() {
  if (terminal) {
    terminal.dispose();
    terminal = null;
  }
  fitAddon = null;
}

function focusSessionTerminal() {
  if (terminal && typeof terminal.focus === 'function') {
    terminal.focus();
  }
}

function getDocumentSelectionText() {
  const selection = window.getSelection();
  return selection ? selection.toString() : '';
}

function getTerminalSelectionText() {
  if (!terminal || typeof terminal.getSelection !== 'function') {
    return '';
  }
  return normalizeTerminalSelectionText(terminal);
}

function normalizeTerminalSelectionText(terminalInstance) {
  const selection = terminalInstance && typeof terminalInstance.getSelection === 'function'
    ? terminalInstance.getSelection() || ''
    : '';

  const position = terminalInstance && typeof terminalInstance.getSelectionPosition === 'function'
    ? terminalInstance.getSelectionPosition()
    : null;
  const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
  if (!position || !buffer || typeof buffer.getLine !== 'function') {
    return selection;
  }

  const rebuiltSelection = rebuildTerminalSelectionFromBuffer(position, buffer);
  if (rebuiltSelection !== null) {
    return rebuiltSelection;
  }

  if (!selection.includes('\n')) {
    return selection;
  }

  const ordered = getOrderedSelectionPosition(position);
  const startRow = ordered.start.y;
  return selection.split('\n').reduce((text, part, index) => {
    if (index === 0) {
      return part;
    }

    const currentLine = buffer.getLine(startRow + index);
    const separator = currentLine && currentLine.isWrapped ? '' : '\n';
    return `${text}${separator}${part}`;
  }, '');
}

function getOrderedSelectionPosition(position) {
  const start = { ...position.start };
  const end = { ...position.end };
  if (start.y > end.y || (start.y === end.y && start.x > end.x)) {
    return { start: end, end: start };
  }
  return { start, end };
}

function readTerminalLineSelectionText(line, startCol, endCol) {
  if (!line || typeof line.getCell !== 'function') {
    return null;
  }

  let text = '';
  const maxCol = Math.max(startCol, endCol);
  for (let col = Math.max(0, startCol); col <= maxCol; col += 1) {
    const cell = line.getCell(col);
    if (!cell) continue;

    if (typeof cell.getChars === 'function') {
      text += cell.getChars();
      continue;
    }

    const code = typeof cell.getCode === 'function' ? cell.getCode() : 0;
    if (code > 0) {
      text += String.fromCodePoint(code);
    }
  }

  return text.trimEnd();
}

function rebuildTerminalSelectionFromBuffer(position, buffer) {
  const ordered = getOrderedSelectionPosition(position);
  const rows = [];

  for (let row = ordered.start.y; row <= ordered.end.y; row += 1) {
    const line = buffer.getLine(row);
    const startCol = row === ordered.start.y ? ordered.start.x : 0;
    const fallbackEndCol = typeof (line && line.length) === 'number' ? line.length - 1 : ordered.end.x;
    const endCol = row === ordered.end.y ? ordered.end.x : fallbackEndCol;
    const text = readTerminalLineSelectionText(line, startCol, endCol);
    if (text === null) {
      return null;
    }

    const separator = row === ordered.start.y ? '' : line && line.isWrapped ? '' : '\n';
    rows.push(`${separator}${text}`);
  }

  return rows.join('');
}

function hasAnySelection() {
  return Boolean(getTerminalSelectionText() || getDocumentSelectionText());
}

function setClipboardText(event, text) {
  if (!event || !event.clipboardData || !text) {
    return false;
  }

  event.clipboardData.setData('text/plain', text);
  return true;
}

async function copyTerminalSelection() {
  const text = getTerminalSelectionText() || getDocumentSelectionText();
  if (!text) {
    return false;
  }

  if (fallbackCopyText(text)) {
    focusSessionTerminal();
    return true;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.warn('Clipboard API copy failed, falling back:', error);
  }

  return false;
}

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function pasteTerminalText(text) {
  if (!text || !focusedAgentId) {
    return false;
  }

  const normalized = text.replace(/\r\n/g, '\n');
  if (terminal && typeof terminal.paste === 'function') {
    terminal.paste(normalized);
  } else {
    sendTerminalInput(normalized);
  }
  focusSessionTerminal();
  return true;
}

function isCrtNativeTerminalPasteTarget(target) {
  return Boolean(
    target &&
    typeof target.closest === 'function' &&
    target.closest('#terminal-output .xterm')
  );
}

async function pasteFromClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    return false;
  }

  try {
    const text = await navigator.clipboard.readText();
    return pasteTerminalText(text);
  } catch (error) {
    console.warn('Clipboard API paste failed:', error);
    return false;
  }
}

function getSessionClient() {
  if (!window.FarmingSessionBridge || !window.FarmingSessionBridge.createClient) {
    return null;
  }

  if (!sessionClient) {
    sessionClient = window.FarmingSessionBridge.createClient({
      getSocket: () => ws,
      fetchImpl: (...args) => fetch(...args)
    });
  }

  return sessionClient;
}

function normalizeCrtTerminalFontSize(value) {
  const fontSize = Number(value);
  if (!Number.isFinite(fontSize)) return DEFAULT_TERMINAL_FONT_SIZE;
  return Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(fontSize)));
}

function getCrtTerminalFontSize() {
  return normalizeCrtTerminalFontSize(globalSettings.crtTerminalFontSize);
}

async function createTerminalInstance(options = {}) {
  if (window.FarmingTerminalBridge && window.FarmingTerminalBridge.createInstance) {
    return window.FarmingTerminalBridge.createInstance({
      theme: {
        ...(currentSessionSkin && currentSessionSkin.terminalTheme
          ? currentSessionSkin.terminalTheme
          : TERMINAL_THEME),
        background: TERMINAL_THEME.background
      },
      fontSize: getCrtTerminalFontSize(),
      fontFamily: TERMINAL_FONT_FAMILY,
      cursorBlink: false,
      requireWebgl: true,
      onWebglContextLoss: () => {
        showCrtWebglFailure(new Error('The xterm WebGL context was lost. Close and reopen this terminal to restore it.'));
      },
      smoothScrollDuration: 120,
      disableStdin: options.disableStdin === true,
      scrollback: TERMINAL_SCROLLBACK
    });
  }

  return null;
}

function showCrtTerminalFailure(titleText, error, detailText) {
  const terminalContainer = document.getElementById('terminal-output');
  if (!terminalContainer) return;
  terminalContainer.querySelector('.crt-webgl-error')?.remove();
  const panel = document.createElement('div');
  panel.className = 'crt-webgl-error';
  const title = document.createElement('strong');
  title.textContent = titleText;
  const message = document.createElement('span');
  message.textContent = error && error.message
    ? error.message
    : String(error || 'Terminal unavailable');
  const detail = document.createElement('small');
  detail.textContent = detailText;
  panel.append(title, message, detail);
  terminalContainer.appendChild(panel);
}

function showCrtWebglFailure(error) {
  showCrtTerminalFailure(
    'CRT WEBGL ERROR',
    error,
    'The Agent is still running. Close and reopen this terminal after WebGL is available.'
  );
}

function shouldUseLiveSessionText(agent) {
  return Boolean(agent && agent.sessionSource === 'live-text');
}

function getAgentDisplayText(agent) {
  if (!agent) return '';
  const text = stripAnsi(agent.previewText || agent.output || '');
  const decorativeLine = /^[\s▀▄─━═░▒▓█│┃┄┅┈┉┌┐└┘├┤┬┴┼╭╮╰╯]+$/u;
  const terminalChrome = /(?:Type your message or @path\/to\/file|\? for shortcuts|YOLO Shift\+Tab|Auto Model · ctx|Enjoy Off-Peak Discount|Try \/(?:effort|context-window))/i;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !decorativeLine.test(line) && !terminalChrome.test(line))
    .join('\n');
}

function crtPreviewColor(index) {
  const ansi16 = [
    '#000000', '#cd3131', '#0dbc79', '#e5e510',
    '#2472c8', '#bc3fbc', '#11a8cd', '#c8c8c8',
    '#666666', '#f14c4c', '#23d18b', '#f5f543',
    '#3b8eea', '#d670d6', '#29b8db', '#ffffff'
  ];
  if (!Number.isFinite(index) || index < 0) return '';
  if (index < ansi16.length) return ansi16[index];
  if (index <= 231) {
    const offset = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[Math.floor(offset / 36)]}, ${levels[Math.floor((offset % 36) / 6)]}, ${levels[offset % 6]})`;
  }
  if (index <= 255) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return `rgb(${(index >> 16) & 0xff}, ${(index >> 8) & 0xff}, ${index & 0xff})`;
}

function getCrtPreviewCellStyle(cell) {
  const attrs = cell && cell.attributes || 0;
  let color = crtPreviewColor(cell && cell.fg);
  let backgroundColor = crtPreviewColor(cell && cell.bg);
  if (attrs & 0x10) {
    [color, backgroundColor] = [backgroundColor || '#000000', color || '#0ccc68'];
  }
  return {
    color,
    backgroundColor,
    fontWeight: attrs & 0x01 ? 'bold' : '',
    fontStyle: attrs & 0x02 ? 'italic' : '',
    textDecoration: [attrs & 0x04 ? 'underline' : '', attrs & 0x40 ? 'line-through' : ''].filter(Boolean).join(' '),
    opacity: attrs & 0x20 ? '0' : (attrs & 0x08 ? '0.65' : '')
  };
}

function getCrtTerminalSnapshotRows(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.cells)) return [];
  let lastMeaningfulRow = -1;
  snapshot.cells.forEach((cells, rowIndex) => {
    if (!Array.isArray(cells)) return;
    const meaningful = cells.some((cell) => {
      if (!cell || cell.width === 0) return false;
      const attributes = cell.attributes || 0;
      const hasBackground = Number.isFinite(cell.bg) && cell.bg >= 0;
      return String(cell.char || '').trim() !== '' || hasBackground || Boolean(attributes & 0x10);
    });
    if (meaningful) lastMeaningfulRow = rowIndex;
  });
  const cursorRow = snapshot.cursorVisible === true && Number.isInteger(snapshot.cursorY)
    ? Math.min(snapshot.cells.length - 1, Math.max(0, snapshot.cursorY))
    : -1;
  const lastVisibleRow = Math.max(lastMeaningfulRow, cursorRow);
  return lastVisibleRow >= 0 ? snapshot.cells.slice(0, lastVisibleRow + 1) : [];
}

function renderCrtTerminalSnapshot(container, snapshot) {
  if (!container) return false;
  const rows = getCrtTerminalSnapshotRows(snapshot);
  if (rows.length === 0) return false;
  container.classList.add('terminal-snapshot');
  rows.forEach((cells) => {
    const row = document.createElement('div');
    row.className = 'terminal-snapshot-row';
    let currentSpan = null;
    let currentStyleKey = '';
    cells.forEach((cell) => {
      if (!cell || cell.width === 0) return;
      const style = getCrtPreviewCellStyle(cell);
      const styleKey = JSON.stringify(style);
      if (!currentSpan || styleKey !== currentStyleKey) {
        currentSpan = document.createElement('span');
        Object.assign(currentSpan.style, style);
        row.appendChild(currentSpan);
        currentStyleKey = styleKey;
      }
      currentSpan.appendChild(document.createTextNode(cell.char || ' '));
    });
    container.appendChild(row);
  });
  return true;
}

function crtStructuredPreviewStatus(agent, cached) {
  if (cached && cached.error && !cached.preview) return 'PREVIEW OFFLINE';
  if ((!cached || !cached.preview) && (!cached || cached.loading)) return 'SYNCING';
  const status = String(structuredRuntimeStatus(agent) || 'idle').toUpperCase().replaceAll('-', ' ');
  if (status === 'WAITING FOR PERMISSION') return 'PERMISSION NEEDED';
  if (status === 'WAITING FOR INPUT') return 'INPUT NEEDED';
  return status;
}

function appendCrtStructuredPreviewLine(container, role, label, text) {
  if (!text) return;
  const line = document.createElement('div');
  line.className = `agent-chat-preview-line ${role}`;
  line.dataset.previewRole = role;
  const roleLabel = document.createElement('span');
  roleLabel.className = 'agent-chat-preview-role';
  roleLabel.textContent = label;
  const content = document.createElement('span');
  content.className = 'agent-chat-preview-text';
  content.textContent = text;
  line.append(roleLabel, content);
  container.appendChild(line);
}

function renderCrtStructuredPreview(output, agent) {
  output.classList.add('structured-preview');
  const cached = crtStructuredPreviewCache.get(agent.id) || null;
  const preview = cached && cached.preview;
  const runtimeStatus = String(structuredRuntimeStatus(agent) || '').toLowerCase();
  const active = ['connecting', 'working', 'waiting-for-permission', 'waiting-for-input', 'interrupting']
    .includes(runtimeStatus);
  const panel = document.createElement('div');
  panel.className = `agent-chat-preview${active ? ' active' : ''}`;
  panel.dataset.previewKind = 'chat';

  const meta = document.createElement('div');
  meta.className = 'agent-chat-preview-meta';
  const channel = document.createElement('span');
  channel.textContent = `CHAT / ${structuredRuntimeKind(agent)}`;
  const stateLabel = document.createElement('span');
  stateLabel.className = 'agent-chat-preview-state';
  const signal = document.createElement('i');
  signal.setAttribute('aria-hidden', 'true');
  const stateText = document.createElement('span');
  stateText.textContent = crtStructuredPreviewStatus(agent, cached);
  stateLabel.append(signal, stateText);
  meta.append(channel, stateLabel);
  panel.appendChild(meta);

  const trail = document.createElement('div');
  trail.className = 'agent-chat-preview-trail';
  panel.appendChild(trail);

  if (preview) {
    const messageLines = Array.isArray(preview.messageLines) && preview.messageLines.length > 0
      ? preview.messageLines
      : [
        { role: 'user', label: 'YOU', text: preview.userText },
        { role: 'assistant', label: 'AGENT', text: preview.assistantText },
      ];
    messageLines.forEach((line) => {
      appendCrtStructuredPreviewLine(trail, line.role, line.label, line.text);
    });
    if (active && preview.activityText && preview.activityText !== preview.assistantText) {
      appendCrtStructuredPreviewLine(trail, 'activity', 'NOW', preview.activityText);
    }
  }

  if (!trail.querySelector('.agent-chat-preview-line')) {
    const empty = document.createElement('div');
    empty.className = 'agent-chat-preview-empty';
    empty.textContent = cached && cached.error
      ? 'Conversation preview unavailable'
      : active ? 'Establishing conversation stream…' : 'Ready for the first message';
    trail.appendChild(empty);
  }

  output.replaceChildren(panel);
  scheduleCrtStructuredPreviewRefresh(agent);
}

function renderCrtAgentOutput(output, agent, { main = false } = {}) {
  output.classList.remove('structured-preview');
  if (isStructuredRuntimeAgent(agent)) {
    renderCrtStructuredPreview(output, agent);
    return;
  }
  const outputTail = document.createElement('div');
  outputTail.className = 'agent-output-tail';
  const cleanOutput = getAgentDisplayText(agent);
  if (!renderCrtTerminalSnapshot(outputTail, agent.previewSnapshot)) {
    outputTail.textContent = main
      ? cleanOutput.slice(-150) || 'No output yet...'
      : cleanOutput || 'No output yet...';
  }
  output.replaceChildren(outputTail);
}

function crtDashboardStateSignature(value) {
  if (!value || !Array.isArray(value.agents)) return '';
  return JSON.stringify([
    value.mainAgentId || '',
    value.agents.map((agent) => [
      agent.id,
      agent.status,
      agent.activityLevel,
      agent.command,
      agent.customTitle,
      agent.providerSessionTitle,
      agent.sessionTitle,
      agent.cwd,
      agent.projectWorkspace,
      agent.unread === true,
      agent.pinned === true,
      agent.projectOrder,
      agent.pinnedOrder,
    ]),
  ]);
}

function isCrtSessionOpen() {
  return typeof document !== 'undefined' && document.body.classList.contains('session-open');
}

function renderCrtDashboardIfNeeded(force = false) {
  if (!state) return false;
  if (!force && isCrtSessionOpen()) {
    dashboardRenderDeferred = true;
    return false;
  }
  const signature = crtDashboardStateSignature(state);
  if (!force && signature === lastCrtDashboardSignature) return false;
  dashboardRenderDeferred = false;
  renderState();
  return true;
}

function scheduleCrtRenderedStructuredPreviews() {
  if (typeof document === 'undefined' || !state) return;
  document.querySelectorAll('#map-area .agent-block[data-agent-id], #main-agent-block[data-agent-id]')
    .forEach((block) => {
      const agent = state.agents.find((candidate) => candidate.id === block.dataset.agentId);
      if (agent) scheduleCrtStructuredPreviewRefresh(agent);
    });
}

function updateCrtAgentPreviewCard(agent) {
  if (typeof document === 'undefined' || !isCrtLiveAgent(agent)) return false;
  const block = Array.from(document.querySelectorAll('[data-agent-id]'))
    .find((candidate) => candidate.dataset.agentId === agent.id);
  if (!block) return false;

  const isMain = block.id === 'main-agent-block';
  const header = block.querySelector('.agent-header');
  const status = block.querySelector('.agent-status');
  const output = block.querySelector('.agent-output');
  if (!header || !status || !output) return false;

  header.textContent = getCrtAgentTitle(agent);
  if (isMain) {
    status.textContent = `${agent.status} | ${agent.activityLevel}`;
  } else {
    const selected = block.classList.contains('crt-nav-selected');
    const activityClass = globalSettings.crtDynamicHeatEnabled === true ? agent.activityLevel : '';
    block.className = `agent-block ${activityClass} ${agent.status} ${isCrtAgentWorking(agent) ? 'working' : ''} ${agent.unread === true ? 'unread' : ''}`;
    if (selected) block.classList.add('crt-nav-selected');
    const projectName = getCrtProjectName(agent);
    status.textContent = [agent.status, agent.activityLevel, projectName].filter(Boolean).join(' | ');
  }

  renderCrtAgentOutput(output, agent, { main: isMain });
  lastCrtDashboardSignature = crtDashboardStateSignature(state);
  return true;
}

function flushCrtPreviewCardRenders() {
  crtPreviewRenderTimer = null;
  const pending = Array.from(pendingCrtPreviewRenders.values());
  pendingCrtPreviewRenders.clear();
  if (pending.length === 0) return;
  if (isCrtSessionOpen()) {
    dashboardRenderDeferred = true;
    return;
  }

  pending.forEach(({ agent, previousSnapshot, previousText, previewChanged }) => {
    const currentAgent = state && state.agents.find((candidate) => candidate.id === agent.id);
    if (!isCrtLiveAgent(currentAgent)) return;
    if (!updateCrtAgentPreviewCard(currentAgent)) {
      if (currentAgent.id !== state.mainAgentId && !isCrtAgentOnCurrentPage(currentAgent.id)) {
        if (previewChanged) pulseCrtBrandForAgent(agent.id);
        return;
      }
      renderCrtDashboardIfNeeded(true);
      return;
    }
    if (previewChanged) {
      appendCrtPreviewAfterimage(agent.id, previousSnapshot, previousText);
      pulseCrtBrandForAgent(agent.id);
    }
  });
}

function scheduleCrtPreviewCardRender(agent, previousSnapshot, previousText, previewChanged) {
  if (!isCrtLiveAgent(agent)) return;
  const existing = pendingCrtPreviewRenders.get(agent.id);
  pendingCrtPreviewRenders.set(agent.id, {
    agent,
    previousSnapshot: existing ? existing.previousSnapshot : previousSnapshot,
    previousText: existing ? existing.previousText : previousText,
    previewChanged: Boolean(previewChanged || (existing && existing.previewChanged)),
  });
  if (!crtPreviewRenderTimer) {
    crtPreviewRenderTimer = setTimeout(flushCrtPreviewCardRenders, CRT_PREVIEW_RENDER_INTERVAL_MS);
  }
}

function appendCrtPreviewAfterimage(agentId, snapshot, fallbackText) {
  if (typeof document === 'undefined') return;
  const block = Array.from(document.querySelectorAll('[data-agent-id]'))
    .find((candidate) => candidate.dataset.agentId === agentId);
  const output = block && block.querySelector('.agent-output');
  if (!output || (!snapshot && !fallbackText)) return;

  const afterimage = document.createElement('div');
  afterimage.className = 'agent-output-afterimage';
  const tail = document.createElement('div');
  tail.className = 'agent-output-tail';
  if (!renderCrtTerminalSnapshot(tail, snapshot)) tail.textContent = fallbackText;
  afterimage.appendChild(tail);
  afterimage.addEventListener('animationend', () => afterimage.remove(), { once: true });
  output.appendChild(afterimage);
}

function crtCommandProgram(command) {
  const tokens = String(command || '').trim().split(/\s+/).filter(Boolean);
  let index = tokens[0] === 'env' ? 1 : 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  const executable = tokens[index] || '';
  return executable.split('/').pop() || '';
}

function crtAgentDisplayName(command) {
  const program = crtCommandProgram(command);
  return CRT_AGENT_DISPLAY_NAMES[program] || program || 'Agent';
}

function crtWorkspaceBasenames(agent) {
  return [agent && agent.cwd, agent && agent.projectWorkspace]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).pop() || '')
    .filter(Boolean)
    .map((value) => value.toLowerCase());
}

function getCrtProjectName(agent, projectNames = globalSettings && globalSettings.projectNames) {
  const workspace = normalizeWorkspaceValue(agent && (agent.projectWorkspace || agent.cwd));
  if (!workspace) return '';
  const workspaceKey = workspace.replace(/[/\\]+$/, '') || workspace;

  if (projectNames && typeof projectNames === 'object') {
    const configuredEntry = Object.entries(projectNames).find(
      ([candidate]) => (normalizeWorkspaceValue(candidate).replace(/[/\\]+$/, '') || candidate) === workspaceKey,
    );
    const configuredName = configuredEntry && typeof configuredEntry[1] === 'string'
      ? configuredEntry[1].trim()
      : '';
    if (configuredName) return configuredName;
  }

  return workspaceKey.split(/[/\\]/).filter(Boolean).pop() || workspace;
}

function crtTitleComparisonKey(title) {
  return String(title || '')
    .trim()
    .replace(/^[\s*＊✳✱✲✶·•:.◇✋✦⏲\u2800-\u28FF]+/u, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function truncateCrtAgentTitle(title) {
  const text = String(title || '').trim();
  return text.length <= 28 ? text : `${text.slice(0, 27)}…`;
}

function meaningfulCrtSessionTitle(title, agent) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return '';

  const program = crtCommandProgram(agent && agent.command).toLowerCase();
  const displayName = crtAgentDisplayName(agent && agent.command).toLowerCase();
  if ((program === 'qoder' || program === 'qodercli') && CRT_QODER_RUNTIME_TITLE_PATTERN.test(text)) {
    return '';
  }

  const normalized = crtTitleComparisonKey(text);
  const genericTitles = new Set([
    program,
    displayName,
    `${program} session`,
    `${displayName} session`,
    'main agent',
    'farming'
  ].filter(Boolean));
  if (genericTitles.has(normalized) || crtWorkspaceBasenames(agent).includes(normalized)) {
    return '';
  }

  return truncateCrtAgentTitle(text.replace(CRT_TITLE_STATUS_PREFIX_PATTERN, '').trim() || text);
}

function getCrtAgentTitle(agent) {
  if (!agent) return 'Agent';
  const customTitle = typeof agent.customTitle === 'string' ? agent.customTitle.trim() : '';
  if (customTitle) return truncateCrtAgentTitle(customTitle);
  if (agent.isMain) return 'Main Agent';

  const providerTitle = meaningfulCrtSessionTitle(agent.providerSessionTitle, agent);
  if (providerTitle) return providerTitle;

  const sessionTitle = meaningfulCrtSessionTitle(agent.sessionTitle, agent);
  if (sessionTitle) return sessionTitle;

  if (/^[a-z]+-history(?:-fork)?:/.test(agent.source || '')) {
    const taskTitle = meaningfulCrtSessionTitle(agent.task, agent);
    if (taskTitle) return taskTitle;
  }

  return crtAgentDisplayName(agent.command);
}

function isCrtAgentWorking(agent) {
  if (!agent) return false;
  if (agent.status === 'pending') return true;
  if (agent.status !== 'running') return false;

  const activity = agent.terminalStatus && agent.terminalStatus.activity;
  if (activity === 'busy') return true;
  if (activity === 'idle' || activity === 'exited') return false;
  if (agent.terminalStatus && agent.terminalStatus.busy === true) return true;
  const runtime = agent.runtimeBinding || { kind: 'terminal' };
  if (
    runtime.kind === 'app-server' &&
    ['working', 'waiting-for-input', 'interrupting'].includes(runtime.state || '')
  ) {
    return true;
  }
  return agent.terminalBusy === true;
}

function getCrtAgentReadPatch(agent) {
  if (!agent || agent.unread !== true) return null;
  const attentionSeq = Number.isFinite(agent.attentionSeq) ? Math.max(0, Number(agent.attentionSeq)) : 0;
  const readAttentionSeq = Number.isFinite(agent.readAttentionSeq) ? Math.max(0, Number(agent.readAttentionSeq)) : 0;
  return attentionSeq > readAttentionSeq
    ? { readAttentionSeq: attentionSeq }
    : { unread: false };
}

async function markCrtAgentReadIfNeeded(agent) {
  const patch = getCrtAgentReadPatch(agent);
  if (!patch) return;

  try {
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agent.id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    agent.unread = false;
    if (typeof patch.readAttentionSeq === 'number') {
      agent.readAttentionSeq = patch.readAttentionSeq;
    }
    renderCrtDashboardIfNeeded();
  } catch (error) {
    console.warn('Failed to mark CRT agent as read:', error && (error.message || error));
  }
}

function getCrtBrandPaneKey(agentId, currentState) {
  if (!agentId || !currentState || !Array.isArray(currentState.agents)) return null;
  const agent = currentState.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return null;
  if (agent.id === currentState.mainAgentId || agent.isMain) return 'main';

  const workers = currentState.agents.filter(
    (candidate) => candidate.id !== currentState.mainAgentId && !candidate.isMain,
  );
  const workerIndex = workers.findIndex((candidate) => candidate.id === agentId);
  if (workerIndex < 0) return null;
  return workerIndex % 2 === 0 ? 'worker-a' : 'worker-b';
}

function isCrtBrandAgentLive(agent) {
  return Boolean(agent && (agent.status === 'running' || agent.status === 'pending'));
}

function updateCrtBrandState(currentState) {
  const brand = document.getElementById('crt-brand-lockup');
  if (!brand || !currentState || !Array.isArray(currentState.agents)) return;

  const paneLive = {
    main: false,
    'worker-a': false,
    'worker-b': false,
  };
  currentState.agents.forEach((agent) => {
    const paneKey = getCrtBrandPaneKey(agent.id, currentState);
    if (paneKey && isCrtBrandAgentLive(agent)) paneLive[paneKey] = true;
  });

  Object.entries(paneLive).forEach(([paneKey, live]) => {
    brand.dataset[`${paneKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())}Live`] = String(live);
    const pane = brand.querySelector(`[data-brand-pane="${paneKey}"]`);
    if (pane) pane.classList.toggle('is-live', live);
  });
}

function pulseCrtBrandForAgent(agentId) {
  const paneKey = getCrtBrandPaneKey(agentId, state);
  const brand = document.getElementById('crt-brand-lockup');
  const pane = paneKey && brand && brand.querySelector(`[data-brand-pane="${paneKey}"]`);
  if (!pane) return;

  const previousTimer = crtBrandPulseTimers.get(paneKey);
  if (previousTimer) clearTimeout(previousTimer);
  pane.classList.remove('is-signaling');
  void pane.getBoundingClientRect();
  pane.classList.add('is-signaling');
  crtBrandPulseTimers.set(paneKey, setTimeout(() => {
    pane.classList.remove('is-signaling');
    crtBrandPulseTimers.delete(paneKey);
  }, 600));
}

function normalizeSessionLink(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '';
  }

  let trimmed = rawUrl.trim();
  const trailingPunctuation = new Set(['.', ',', ';', '!', '?', '\u3002', '\uff0c', '\uff1b', '\uff01', '\uff1f']);

  while (trimmed.length > 0) {
    const lastChar = trimmed[trimmed.length - 1];
    if (trailingPunctuation.has(lastChar)) {
      trimmed = trimmed.slice(0, -1);
      continue;
    }

    if (lastChar === ')' || lastChar === ']') {
      const openChar = lastChar === ')' ? '(' : '[';
      const closeChar = lastChar;
      const openCount = (trimmed.match(new RegExp(`\\${openChar}`, 'g')) || []).length;
      const closeCount = (trimmed.match(new RegExp(`\\${closeChar}`, 'g')) || []).length;
      if (closeCount > openCount) {
        trimmed = trimmed.slice(0, -1);
        continue;
      }
    }

    break;
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    return '';
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return '';
  }
}

function extractSessionLinks(text, limit = SESSION_LINK_LIMIT) {
  if (typeof text !== 'string' || !text) {
    return [];
  }

  const matches = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const seen = new Set();
  const links = [];

  matches.forEach((match) => {
    const normalized = normalizeSessionLink(match);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    links.push(normalized);
  });

  return links.slice(-limit);
}

function formatSelectionStatus(selectionPosition, selectionText = '') {
  if (!selectionPosition || !selectionPosition.start || !selectionPosition.end) {
    return 'No selection';
  }

  const charCount = typeof selectionText === 'string' ? selectionText.length : 0;
  const start = `${selectionPosition.start.y + 1}:${selectionPosition.start.x + 1}`;
  const end = `${selectionPosition.end.y + 1}:${selectionPosition.end.x + 1}`;
  return `Sel ${start} -> ${end}${charCount ? ` • ${charCount} chars` : ''}`;
}

function deriveSessionSearchMatchesFromLines(lines, query) {
  const normalizedQuery = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!normalizedQuery) {
    return [];
  }

  const matches = [];
  lines.forEach((lineText, lineIndex) => {
    const normalizedLine = String(lineText || '').toLowerCase();
    let searchStart = 0;

    while (searchStart < normalizedLine.length) {
      const matchIndex = normalizedLine.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }

      matches.push({
        line: lineIndex,
        startColumn: matchIndex,
        length: normalizedQuery.length,
        preview: String(lineText || '').trim(),
      });
      searchStart = matchIndex + Math.max(1, normalizedQuery.length);
    }
  });

  return matches;
}

function buildTerminalLineProjection(line) {
  if (!line || typeof line.length !== 'number' || typeof line.getCell !== 'function') {
    return { text: '', offsetToCell: [0] };
  }

  let text = '';
  const offsetToCell = [0];

  for (let column = 0; column < line.length; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      continue;
    }

    const chars = typeof cell.getChars === 'function'
      ? cell.getChars()
      : (typeof cell.getCodepoint === 'function' && cell.getCodepoint() > 0
        ? String.fromCodePoint(cell.getCodepoint())
        : '');

    if (!chars) {
      continue;
    }

    const startOffset = text.length;
    text += chars;
    for (let offset = startOffset; offset < text.length; offset += 1) {
      offsetToCell[offset] = column;
    }
  }

  offsetToCell[text.length] = line.length;
  return { text, offsetToCell };
}

const CRT_READING_ANCHOR_LINE_COUNT = 3;

function crtReadingAnchorApi() {
  return window.FarmingReadingAnchors || null;
}

function crtTerminalVisibleBufferBase(currentTerminal) {
  if (!currentTerminal) return 0;
  if (typeof currentTerminal.getVisibleBufferBase === 'function') {
    return Math.max(0, Number(currentTerminal.getVisibleBufferBase()) || 0);
  }
  return Math.max(0, Number(currentTerminal.buffer && currentTerminal.buffer.active && currentTerminal.buffer.active.viewportY) || 0);
}

function crtLogicalTerminalLineAtRow(currentTerminal, row) {
  const buffer = currentTerminal && currentTerminal.buffer && currentTerminal.buffer.active;
  if (!buffer || typeof buffer.getLine !== 'function' || !Number.isFinite(row) || row < 0) return null;
  let startRow = row;
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow -= 1;
  let endRow = row;
  while (buffer.getLine(endRow + 1)?.isWrapped) endRow += 1;
  const lines = [];
  for (let index = startRow; index <= endRow; index += 1) {
    lines.push(buildTerminalLineProjection(buffer.getLine(index)).text.trimEnd());
  }
  return { startRow, endRow, text: lines.join('') };
}

function saveCrtTerminalReadingAnchor(agentId, currentTerminal = terminal) {
  const api = crtReadingAnchorApi();
  if (!api || !agentId || !currentTerminal) return;
  const key = api.agentKey(agentId, 'terminal');
  const buffer = currentTerminal.buffer && currentTerminal.buffer.active;
  const base = crtTerminalVisibleBufferBase(currentTerminal);
  const maxRow = Math.max(0, Number(buffer && buffer.length) || 0);
  if (!buffer || base >= maxRow - Math.max(1, Number(currentTerminal.rows) || 1)) {
    api.remove(key);
    return;
  }
  const firstLine = crtLogicalTerminalLineAtRow(currentTerminal, base);
  if (!firstLine) return;
  const lines = [];
  let row = firstLine.startRow;
  for (let index = 0; index < CRT_READING_ANCHOR_LINE_COUNT; index += 1) {
    const line = crtLogicalTerminalLineAtRow(currentTerminal, row);
    if (!line) break;
    lines.push(line.text);
    row = line.endRow + 1;
  }
  if (!lines.length) return;
  api.save({
    version: 1,
    surface: 'terminal',
    resource: { kind: 'agent', id: agentId },
    locator: { kind: 'terminal-lines', id: api.fingerprint(lines), lineCount: lines.length },
    position: { unit: 'row', value: Math.max(0, base - firstLine.startRow) },
  });
}

function restoreCrtTerminalReadingAnchor(agentId, currentTerminal = terminal) {
  const api = crtReadingAnchorApi();
  if (!api || !agentId || !currentTerminal) return false;
  const key = api.agentKey(agentId, 'terminal');
  const anchor = api.read(key);
  if (!anchor || anchor.surface !== 'terminal') return false;
  const buffer = currentTerminal.buffer && currentTerminal.buffer.active;
  const lineCount = Math.max(1, Number(anchor.locator && anchor.locator.lineCount) || 1);
  const lastRow = Math.max(0, Number(buffer && buffer.length) || 0);
  let closest = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let row = 0; row <= lastRow;) {
    const firstLine = crtLogicalTerminalLineAtRow(currentTerminal, row);
    if (!firstLine) {
      row += 1;
      continue;
    }
    const lines = [firstLine.text];
    let nextRow = firstLine.endRow + 1;
    for (let index = 1; index < lineCount; index += 1) {
      const line = crtLogicalTerminalLineAtRow(currentTerminal, nextRow);
      if (!line) break;
      lines.push(line.text);
      nextRow = line.endRow + 1;
    }
    if (lines.length === lineCount && api.fingerprint(lines) === anchor.locator.id) {
      const distance = Math.abs(firstLine.startRow - crtTerminalVisibleBufferBase(currentTerminal));
      if (distance < closestDistance) {
        closest = firstLine;
        closestDistance = distance;
      }
    }
    row = Math.max(row + 1, firstLine.endRow + 1);
  }
  if (!closest || typeof currentTerminal.scrollToLine !== 'function') {
    api.remove(key);
    currentTerminal.scrollToBottom?.();
    return false;
  }
  currentTerminal.scrollToLine(Math.min(closest.endRow, closest.startRow + Math.max(0, Number(anchor.position.value) || 0)));
  return true;
}

function saveCrtStructuredReadingAnchor(agentId) {
  const api = crtReadingAnchorApi();
  const container = document.getElementById('terminal-output');
  if (!api || !agentId || !container) return;
  const key = api.agentKey(agentId, 'chat');
  if (container.scrollHeight - container.scrollTop - container.clientHeight < 80) {
    api.remove(key);
    return;
  }
  const containerRect = container.getBoundingClientRect();
  const turn = Array.from(container.querySelectorAll('[data-reading-anchor-id]'))
    .find((candidate) => candidate.getBoundingClientRect().bottom > containerRect.top);
  if (!turn) return;
  const turnRect = turn.getBoundingClientRect();
  api.save({
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: { kind: 'message', id: turn.dataset.readingAnchorId },
    position: { unit: 'fraction', value: Math.max(0, Math.min(1, (containerRect.top - turnRect.top) / Math.max(1, turnRect.height))) },
  });
}

function restoreCrtStructuredReadingAnchor(agentId) {
  const api = crtReadingAnchorApi();
  const container = document.getElementById('terminal-output');
  if (!api || !agentId || !container) return false;
  const key = api.agentKey(agentId, 'chat');
  const anchor = api.read(key);
  if (!anchor || anchor.surface !== 'chat') return false;
  const target = container.querySelector(`[data-reading-anchor-id="${CSS.escape(anchor.locator.id)}"]`);
  if (!target) {
    api.remove(key);
    container.scrollTop = container.scrollHeight;
    return false;
  }
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  container.scrollTop += targetRect.top + targetRect.height * anchor.position.value - containerRect.top;
  return true;
}

function collectWrappedLinkContext(buffer, row) {
  if (!buffer || typeof buffer.getLine !== 'function') {
    return null;
  }

  let startRow = row;
  while (startRow > 0) {
    const previousLine = buffer.getLine(startRow - 1);
    if (!previousLine || !previousLine.isWrapped) {
      break;
    }
    startRow -= 1;
  }

  const segments = [];
  let currentRow = startRow;
  while (true) {
    const line = buffer.getLine(currentRow);
    if (!line) {
      break;
    }

    const projection = buildTerminalLineProjection(line);
    segments.push({
      row: currentRow,
      text: projection.text,
      offsetToCell: projection.offsetToCell,
    });

    if (!line.isWrapped) {
      break;
    }
    currentRow += 1;
  }

  if (!segments.length) {
    return null;
  }

  let mergedText = '';
  const segmentOffsets = [];
  segments.forEach((segment) => {
    segmentOffsets.push(mergedText.length);
    mergedText += segment.text;
  });

  return { mergedText, segments, segmentOffsets };
}

function mapMergedOffsetToTerminalPosition(context, offset) {
  const clampedOffset = Math.max(0, Math.min(offset, context.mergedText.length));

  for (let index = context.segments.length - 1; index >= 0; index -= 1) {
    const segment = context.segments[index];
    const segmentStart = context.segmentOffsets[index];
    if (clampedOffset >= segmentStart) {
      const localOffset = Math.min(clampedOffset - segmentStart, segment.text.length);
      const cell = segment.offsetToCell[localOffset] ?? segment.offsetToCell[segment.offsetToCell.length - 1] ?? 0;
      return { x: cell, y: segment.row };
    }
  }

  return { x: 0, y: context.segments[0].row };
}

function collectTerminalHyperlinkRange(buffer, row, column, hyperlinkId) {
  let startRow = row;
  let startColumn = column;

  while (true) {
    if (startColumn > 0) {
      const currentLine = buffer.getLine(startRow);
      const previousCell = currentLine && currentLine.getCell(startColumn - 1);
      if (previousCell && typeof previousCell.getHyperlinkId === 'function' && previousCell.getHyperlinkId() === hyperlinkId) {
        startColumn -= 1;
        continue;
      }
    }

    const previousRow = startRow - 1;
    const previousLine = previousRow >= 0 ? buffer.getLine(previousRow) : null;
    if (!previousLine || !previousLine.isWrapped || previousLine.length === 0) {
      break;
    }

    const previousTail = previousLine.getCell(previousLine.length - 1);
    if (!previousTail || typeof previousTail.getHyperlinkId !== 'function' || previousTail.getHyperlinkId() !== hyperlinkId) {
      break;
    }

    startRow = previousRow;
    startColumn = previousLine.length;
  }

  let endRow = row;
  let endColumn = column + 1;

  while (true) {
    const currentLine = buffer.getLine(endRow);
    const nextCell = currentLine && endColumn < currentLine.length ? currentLine.getCell(endColumn) : null;
    if (nextCell && typeof nextCell.getHyperlinkId === 'function' && nextCell.getHyperlinkId() === hyperlinkId) {
      endColumn += 1;
      continue;
    }

    const nextRow = endRow + 1;
    const nextLine = buffer.getLine(nextRow);
    const currentLineWraps = currentLine && currentLine.isWrapped;
    if (!currentLineWraps || !nextLine || nextLine.length === 0) {
      break;
    }

    const nextHead = nextLine.getCell(0);
    if (!nextHead || typeof nextHead.getHyperlinkId !== 'function' || nextHead.getHyperlinkId() !== hyperlinkId) {
      break;
    }

    endRow = nextRow;
    endColumn = 0;
  }

  return {
    start: { x: startColumn, y: startRow },
    end: { x: endColumn, y: endRow },
  };
}

function createTerminalOsc8LinkProvider(terminalInstance) {
  return {
    provideLinks(row, callback) {
      const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
      const line = buffer && typeof buffer.getLine === 'function' ? buffer.getLine(row) : null;
      const wasmTerm = terminalInstance ? terminalInstance.wasmTerm : null;
      if (!line || !wasmTerm || typeof wasmTerm.getHyperlinkUri !== 'function') {
        callback(undefined);
        return;
      }

      const links = [];
      const seen = new Set();

      for (let column = 0; column < line.length; column += 1) {
        const cell = line.getCell(column);
        const hyperlinkId = cell && typeof cell.getHyperlinkId === 'function' ? cell.getHyperlinkId() : 0;
        if (!hyperlinkId || seen.has(hyperlinkId)) {
          continue;
        }

        const uri = normalizeSessionLink(wasmTerm.getHyperlinkUri(hyperlinkId) || '');
        if (!uri) {
          continue;
        }

        seen.add(hyperlinkId);
        links.push({
          text: uri,
          range: collectTerminalHyperlinkRange(buffer, row, column, hyperlinkId),
          activate: () => {
            window.open(uri, '_blank', 'noopener,noreferrer');
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

function createTerminalUrlLinkProvider(terminalInstance) {
  return {
    provideLinks(row, callback) {
      const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
      const context = collectWrappedLinkContext(buffer, row);
      if (!context || !context.mergedText) {
        callback(undefined);
        return;
      }

      const links = [];
      const matches = context.mergedText.matchAll(/https?:\/\/[^\s<>"']+/gi);
      for (const match of matches) {
        const normalized = normalizeSessionLink(match[0]);
        if (!normalized) {
          continue;
        }

        const startOffset = match.index;
        const endOffset = startOffset + normalized.length;
        const start = mapMergedOffsetToTerminalPosition(context, startOffset);
        const end = mapMergedOffsetToTerminalPosition(context, endOffset);

        if (row < start.y || row > end.y) {
          continue;
        }

        links.push({
          text: normalized,
          range: { start, end },
          activate: () => {
            window.open(normalized, '_blank', 'noopener,noreferrer');
          },
        });
      }

      callback(links.length ? links : undefined);
    },
  };
}

function registerTerminalLinks(terminalInstance) {
  if (!terminalInstance || typeof terminalInstance.registerLinkProvider !== 'function') {
    return;
  }

  terminalInstance.registerLinkProvider(createTerminalOsc8LinkProvider(terminalInstance));
  terminalInstance.registerLinkProvider(createTerminalUrlLinkProvider(terminalInstance));
}

function getTerminalBufferLines(terminalInstance) {
  const buffer = terminalInstance && terminalInstance.buffer ? terminalInstance.buffer.active : null;
  if (!buffer || typeof buffer.length !== 'number' || typeof buffer.getLine !== 'function') {
    return [];
  }

  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    lines.push(line && typeof line.translateToString === 'function' ? line.translateToString(false) : '');
  }
  return lines;
}

function updateSessionTitleDisplay(title = currentSessionTitle) {
  currentSessionTitle = title || 'Agent Session';
  const titleNode = document.getElementById('session-title');
  if (titleNode) {
    titleNode.textContent = currentSessionTitle;
  }
}

function updateSessionSelectionStatus() {
  const statusNode = document.getElementById('session-selection-status');
  if (!statusNode) {
    return;
  }

  const selectionPosition = terminal && typeof terminal.getSelectionPosition === 'function'
    ? terminal.getSelectionPosition()
    : undefined;
  const selectionText = terminal && typeof terminal.getSelection === 'function'
    ? terminal.getSelection()
    : '';
  const statusText = formatSelectionStatus(selectionPosition, selectionText);
  statusNode.textContent = statusText;
  statusNode.classList.toggle('is-empty', statusText === 'No selection');
}

function updateSessionSearchStatus(text = 'No search') {
  const statusNode = document.getElementById('session-search-status');
  if (!statusNode) {
    return;
  }

  statusNode.textContent = text;
  statusNode.classList.toggle('is-empty', text === 'No search' || text === 'No matches');
}

function applyCurrentSearchMatch({ selectLine = false } = {}) {
  if (!terminal || sessionSearchIndex < 0 || sessionSearchIndex >= sessionSearchMatches.length) {
    updateSessionSearchStatus(sessionSearchMatches.length ? 'No active match' : 'No matches');
    return;
  }

  const match = sessionSearchMatches[sessionSearchIndex];
  terminal.scrollToLine(match.line);
  if (selectLine && typeof terminal.selectLines === 'function') {
    terminal.selectLines(match.line, match.line);
  } else if (typeof terminal.select === 'function') {
    terminal.select(match.startColumn, match.line, Math.max(1, match.length));
  }

  updateSessionSearchStatus(`Match ${sessionSearchIndex + 1}/${sessionSearchMatches.length} • L${match.line + 1}`);
  updateSessionSelectionStatus();
}

function refreshSessionSearchMatches({ preserveIndex = false } = {}) {
  const searchInput = document.getElementById('session-search-input');
  const query = searchInput ? searchInput.value : '';
  sessionSearchMatches = deriveSessionSearchMatchesFromLines(getTerminalBufferLines(terminal), query);
  if (!sessionSearchMatches.length) {
    sessionSearchIndex = -1;
    if (terminal && typeof terminal.clearSelection === 'function') {
      terminal.clearSelection();
    }
    updateSessionSearchStatus(query.trim() ? 'No matches' : 'No search');
    updateSessionSelectionStatus();
    return;
  }

  sessionSearchIndex = preserveIndex && sessionSearchIndex >= 0
    ? Math.min(sessionSearchIndex, sessionSearchMatches.length - 1)
    : 0;
  applyCurrentSearchMatch();
}

function navigateSessionSearchMatch(direction) {
  if (!sessionSearchMatches.length) {
    refreshSessionSearchMatches();
    return;
  }

  sessionSearchIndex = (sessionSearchIndex + direction + sessionSearchMatches.length) % sessionSearchMatches.length;
  applyCurrentSearchMatch();
}

function setupSessionSearchControls() {
  const searchInput = document.getElementById('session-search-input');
  const prevButton = document.getElementById('session-search-prev');
  const nextButton = document.getElementById('session-search-next');
  const lineButton = document.getElementById('session-search-line');
  if (!searchInput || searchInput.dataset.bound === 'true') {
    return;
  }

  searchInput.dataset.bound = 'true';

  searchInput.addEventListener('input', () => {
    refreshSessionSearchMatches();
  });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigateSessionSearchMatch(event.shiftKey ? -1 : 1);
    }
  });
  prevButton.addEventListener('click', () => navigateSessionSearchMatch(-1));
  nextButton.addEventListener('click', () => navigateSessionSearchMatch(1));
  lineButton.addEventListener('click', () => applyCurrentSearchMatch({ selectLine: true }));
}

function resetSessionUiState() {
  sessionSearchMatches = [];
  sessionSearchIndex = -1;
  const searchInput = document.getElementById('session-search-input');
  if (searchInput) {
    searchInput.value = '';
  }
  updateSessionSearchStatus('No search');
  updateSessionSelectionStatus();
}

function refreshSessionTerminalUi({ preserveSearchIndex = false } = {}) {
  const searchInput = document.getElementById('session-search-input');
  if (searchInput && searchInput.value.trim()) {
    refreshSessionSearchMatches({ preserveIndex: preserveSearchIndex });
    return;
  }

  updateSessionSearchStatus('No search');
  updateSessionSelectionStatus();
}

function deriveSessionTextPatch(fullText, previousLength, forceReplace = false) {
  if (typeof fullText !== 'string') {
    return {
      mode: 'noop',
      text: '',
      nextLength: previousLength
    };
  }

  if (forceReplace || fullText.length < previousLength) {
    return {
      mode: 'replace',
      text: fullText,
      nextLength: fullText.length
    };
  }

  if (fullText.length > previousLength) {
    return {
      mode: 'append',
      text: fullText.slice(previousLength),
      nextLength: fullText.length
    };
  }

  return {
    mode: 'noop',
    text: '',
    nextLength: previousLength
  };
}

function replaceTerminalOutput(terminalInstance, text) {
  if (!terminalInstance) return;
  if (typeof terminalInstance.reset === 'function') {
    terminalInstance.reset();
  } else if (typeof terminalInstance.clear === 'function') {
    terminalInstance.clear();
  }
  if (text && typeof terminalInstance.write === 'function') {
    terminalInstance.write(text);
  }
}

function normalizeSessionViewPayload(payload, fallbackAgent = null) {
  const session = payload && payload.session ? payload.session : {};

  return {
    agentId: session.agentId || (fallbackAgent && fallbackAgent.id) || null,
    command: session.command || (fallbackAgent && fallbackAgent.command) || '',
    cwd: session.cwd || (fallbackAgent && fallbackAgent.cwd) || '',
    status: session.status || (fallbackAgent && fallbackAgent.status) || 'running',
    sessionSource: session.sessionSource || (fallbackAgent && fallbackAgent.sessionSource) || 'buffer',
    output: typeof session.output === 'string' ? session.output : ((fallbackAgent && fallbackAgent.output) || ''),
    renderOutput: typeof session.renderOutput === 'string' ? session.renderOutput : '',
    runtimeEpoch: typeof session.runtimeEpoch === 'string' ? session.runtimeEpoch : '',
    outputSeq: Number.isFinite(session.outputSeq) ? session.outputSeq : null,
    stateRevision: Number.isFinite(session.stateRevision) ? session.stateRevision : null,
    previewCols: Number.isFinite(session.previewCols) ? session.previewCols : null,
    previewRows: Number.isFinite(session.previewRows) ? session.previewRows : null,
    previewText: typeof session.previewText === 'string' ? session.previewText : ((fallbackAgent && fallbackAgent.previewText) || ''),
    previewSnapshot: session.previewSnapshot && typeof session.previewSnapshot === 'object'
      ? session.previewSnapshot
      : ((fallbackAgent && fallbackAgent.previewSnapshot) || null),
    isMain: typeof session.isMain === 'boolean' ? session.isMain : Boolean(fallbackAgent && fallbackAgent.isMain),
    activityLevel: session.activityLevel || (fallbackAgent && fallbackAgent.activityLevel) || 'cold',
    lastActivity: session.lastActivity || (fallbackAgent && fallbackAgent.lastActivity) || null,
    startedAt: session.startedAt || null,
    exitedAt: session.exitedAt || null
  };
}

function createCrtTerminalReplication(agentId) {
  return {
    agentId,
    lastResizeCols: null,
    lastResizeRows: null,
    pendingFitResize: null,
    fitResizeTimer: null,
    applyingLocalResize: false,
    replayState: TERMINAL_REPLAY.createState(),
    checkpointInFlight: false,
    checkpointSeq: 0,
    checkpointAbortController: null,
    checkpointRetryTimer: null,
    installSeq: 0,
    installInProgress: false,
    pendingCheckpoint: null,
    writeInProgress: false,
    disposed: false
  };
}

function installCrtTerminalTestApi() {
  if (
    typeof window === 'undefined' ||
    !window.__FARMING_E2E__ ||
    window.__farmingCrtTerminalTest
  ) return;
  window.__farmingCrtTerminalTest = {
    getState() {
      const replication = crtTerminalReplication;
      if (!replication || replication.disposed) return null;
      return {
        runtimeEpoch: replication.replayState.runtimeEpoch,
        outputSeq: replication.replayState.outputSeq,
        stateRevision: replication.replayState.stateRevision,
        cols: terminal?.cols || 0,
        rows: terminal?.rows || 0,
        replaying: replication.replayState.recovering,
        checkpointHalted: replication.replayState.halted,
        writeInProgress: replication.writeInProgress,
        checkpointInFlight: replication.checkpointInFlight,
        checkpointInstallInProgress: replication.installInProgress,
        pendingFitResize: replication.pendingFitResize,
        fitResizeTimerPending: replication.fitResizeTimer !== null
      };
    },
    getRows() {
      const buffer = terminal && terminal.buffer && terminal.buffer.active;
      if (!buffer || typeof buffer.getLine !== 'function') return [];
      const rows = [];
      for (let index = 0; index < buffer.length; index += 1) {
        rows.push(buffer.getLine(index)?.translateToString(true) || '');
      }
      return rows;
    },
    notifyResizeForTest(cols, rows) {
      sendSessionResize(focusedAgentId, { cols, rows });
    },
    streamSequenced(data, outputSeq, runtimeEpoch, stateRevision) {
      const replication = crtTerminalReplication;
      if (!replication || replication.disposed) return false;
      handleCrtTerminalStream({
        agentId: replication.agentId,
        kind: 'output',
        data: String(data || ''),
        outputSeq,
        runtimeEpoch,
        stateRevision
      });
      return true;
    },
    replaceStream(stream) {
      const replication = crtTerminalReplication;
      if (!replication || replication.disposed || !stream) return false;
      handleCrtTerminalStream({
        ...stream,
        agentId: replication.agentId,
        replace: true
      });
      return true;
    }
  };
}

function disposeCrtTerminalReplication() {
  const replication = crtTerminalReplication;
  if (!replication) return;
  replication.disposed = true;
  if (replication.fitResizeTimer) clearTimeout(replication.fitResizeTimer);
  replication.fitResizeTimer = null;
  replication.pendingFitResize = null;
  if (replication.checkpointRetryTimer) clearTimeout(replication.checkpointRetryTimer);
  replication.checkpointRetryTimer = null;
  replication.checkpointAbortController?.abort();
  replication.checkpointAbortController = null;
  document.getElementById('terminal-output')?.classList.remove('crt-terminal-checkpoint-installing');
  crtTerminalReplication = null;
}

function queueCrtTerminalInput(input) {
  const replication = crtTerminalReplication;
  if (!replication || replication.disposed) return false;
  const text = String(input || '');
  if (!text) return false;
  return Boolean(getSessionClient()?.sendTerminalInput(replication.agentId, text));
}

function requestCrtTerminalReplay() {
  const replication = crtTerminalReplication;
  if (
    !replication ||
    replication.disposed ||
    replication.replayState.halted ||
    replication.checkpointRetryTimer ||
    replication.checkpointInFlight ||
    replication.installInProgress
  ) return;
  TERMINAL_REPLAY.beginRecovery(replication.replayState);
  void refreshSessionView(true, replication.agentId, getCurrentSessionToken());
}

function queueCrtTerminalTransition(event) {
  const replication = crtTerminalReplication;
  if (!replication || replication.disposed) return;
  const result = TERMINAL_REPLAY.queueTransition(replication.replayState, event);
  if (!result.queued) {
    requestCrtTerminalReplay();
  }
}

function scheduleCrtTerminalCheckpointRetry(replication, delay) {
  if (
    !replication ||
    replication.disposed ||
    replication.replayState.halted ||
    replication.checkpointRetryTimer
  ) return;
  replication.checkpointRetryTimer = setTimeout(() => {
    replication.checkpointRetryTimer = null;
    if (!crtTerminalReplication || crtTerminalReplication !== replication || replication.disposed) return;
    requestCrtTerminalReplay();
  }, delay);
}

function retryCrtTerminalReplayAfterFailure(replication, failure, error = null) {
  if (!replication || replication.disposed) return;
  replication.checkpointInFlight = false;
  if (failure.halted) {
    stopCrtTerminalReplay(replication, failure.message);
    return;
  }
  if (error) console.warn('Terminal replay request failed; retrying:', error);
  scheduleCrtTerminalCheckpointRetry(replication, failure.delay);
}

function finishCrtTerminalReplay(replication = crtTerminalReplication) {
  if (
    !replication ||
    replication.disposed ||
    replication.checkpointInFlight ||
    replication.installInProgress ||
    replication.pendingCheckpoint ||
    replication.writeInProgress
  ) return;
  if (replication.replayState.queuedTransitions.length > 0 && !replication.replayState.recovering) {
    flushCrtTerminalTransitions();
    if (
      replication.replayState.queuedTransitions.length > 0 ||
      replication.writeInProgress ||
      replication.checkpointInFlight ||
      replication.replayState.recovering
    ) return;
  }
  if (
    replication.replayState.recovering ||
    TERMINAL_REPLAY.isReplayTargetPending(replication.replayState)
  ) {
    requestCrtTerminalReplay();
    return;
  }
  requestAnimationFrame(() => {
    if (!crtTerminalReplication || crtTerminalReplication !== replication || replication.disposed) return;
    document.getElementById('terminal-output')?.classList.remove('crt-terminal-checkpoint-installing');
    sendSessionResize(replication.agentId);
  });
}

function stopCrtTerminalReplay(replication, error) {
  if (!replication || replication.disposed) return;
  replication.checkpointInFlight = false;
  replication.installInProgress = false;
  replication.pendingCheckpoint = null;
  TERMINAL_REPLAY.clearQueuedTransitions(replication.replayState);
  document.getElementById('terminal-output')?.classList.add('crt-terminal-checkpoint-installing');
  console.error('Terminal replay failed:', error);
  showCrtTerminalFailure(
    'CRT TERMINAL SYNC ERROR',
    error,
    'The Agent is still running. Close and reopen this terminal to retry recovery.'
  );
}

function applyCrtTerminalTransition(event) {
  const replication = crtTerminalReplication;
  if (!replication || !terminal || replication.disposed) return;
  const decision = TERMINAL_REPLAY.classifyTransition(replication.replayState, event);
  if (decision.action === 'drop') return;
  if (decision.action === 'recover') {
    queueCrtTerminalTransition(event);
    requestCrtTerminalReplay();
    return;
  }

  if (event.kind === 'resize') {
    replication.applyingLocalResize = true;
    try {
      terminal.resize(Math.floor(event.cols), Math.floor(event.rows));
    } finally {
      replication.applyingLocalResize = false;
    }
    TERMINAL_REPLAY.commitTransition(replication.replayState, event);
    refreshSessionTerminalUi({ preserveSearchIndex: true });
    flushCrtTerminalTransitions();
    return;
  }

  const transitionData = event.kind === 'clear' ? '\x1b[2J\x1b[3J\x1b[H' : event.data;
  if (!transitionData) {
    TERMINAL_REPLAY.commitTransition(replication.replayState, event);
    flushCrtTerminalTransitions();
    return;
  }

  replication.writeInProgress = true;
  terminal.write(transitionData, () => {
    if (!crtTerminalReplication || crtTerminalReplication !== replication || replication.disposed) return;
    TERMINAL_REPLAY.commitTransition(replication.replayState, event);
    if (event.kind === 'clear') terminal.clearSelection?.();
    replication.writeInProgress = false;
    refreshSessionTerminalUi({ preserveSearchIndex: true });
    if (drainCrtTerminalCheckpointInstall(replication)) return;
    flushCrtTerminalTransitions();
    finishCrtTerminalReplay(replication);
  });
}

function flushCrtTerminalTransitions() {
  const replication = crtTerminalReplication;
  if (
    !replication ||
    replication.disposed ||
    replication.replayState.recovering ||
    replication.checkpointInFlight ||
    replication.installInProgress ||
    replication.writeInProgress
  ) return;

  while (
    !replication.replayState.recovering &&
    !replication.checkpointInFlight &&
    !replication.installInProgress &&
    !replication.writeInProgress
  ) {
    const next = TERMINAL_REPLAY.takeQueuedTransition(replication.replayState);
    if (!next) break;
    applyCrtTerminalTransition(next);
  }
}

function performCrtTerminalCheckpointInstall(replication, sessionView) {
  if (
    !crtTerminalReplication ||
    crtTerminalReplication !== replication ||
    !terminal ||
    replication.disposed
  ) return false;

  const installSeq = replication.installSeq + 1;
  replication.installSeq = installSeq;
  replication.installInProgress = true;
  TERMINAL_REPLAY.beginRecovery(replication.replayState, sessionView);
  const container = document.getElementById('terminal-output');
  container?.classList.add('crt-terminal-checkpoint-installing');

  replication.applyingLocalResize = true;
  try {
    terminal.resize(sessionView.previewCols, sessionView.previewRows);
  } finally {
    replication.applyingLocalResize = false;
  }
  terminal.reset();

  const finishInstall = () => {
    if (
      !crtTerminalReplication ||
      crtTerminalReplication !== replication ||
      replication.disposed ||
      replication.installSeq !== installSeq
    ) return;

    TERMINAL_REPLAY.commitCheckpoint(replication.replayState, {
      runtimeEpoch: sessionView.runtimeEpoch,
      outputSeq: sessionView.outputSeq,
      stateRevision: sessionView.stateRevision,
      cols: sessionView.previewCols,
      rows: sessionView.previewRows
    });
    replication.installInProgress = false;
    refreshSessionTerminalUi({ preserveSearchIndex: true });
    const runtime = getSessionRuntime();
    if (runtime) {
      runtime.markHydrated(sessionView.renderOutput.length);
      syncSessionRuntimeState();
    }
    if (drainCrtTerminalCheckpointInstall(replication)) return;
    flushCrtTerminalTransitions();
    finishCrtTerminalReplay(replication);
  };

  if (sessionView.renderOutput) {
    terminal.write(sessionView.renderOutput, finishInstall);
  } else {
    finishInstall();
  }
  return true;
}

function drainCrtTerminalCheckpointInstall(replication = crtTerminalReplication) {
  if (
    !replication ||
    replication.disposed ||
    replication.installInProgress ||
    replication.writeInProgress ||
    !replication.pendingCheckpoint
  ) return false;
  const sessionView = replication.pendingCheckpoint;
  replication.pendingCheckpoint = null;
  return performCrtTerminalCheckpointInstall(replication, sessionView);
}

function installCrtTerminalCheckpoint(sessionView) {
  const replication = crtTerminalReplication;
  if (!replication || !terminal || replication.disposed) return false;
  const checkpoint = {
    runtimeEpoch: sessionView.runtimeEpoch,
    outputSeq: sessionView.outputSeq,
    stateRevision: sessionView.stateRevision,
    cols: sessionView.previewCols,
    rows: sessionView.previewRows
  };
  const decision = TERMINAL_REPLAY.evaluateCheckpoint(replication.replayState, checkpoint);
  if (decision.action === 'reject') {
    retryCrtTerminalReplayAfterFailure(
      replication,
      TERMINAL_REPLAY.recordInvariantFailure(
        replication.replayState,
        decision.signature || 'invalid-checkpoint',
        decision.message || 'Terminal replay returned an invalid screen state'
      )
    );
    return false;
  }
  if (
    decision.action === 'current' &&
    terminal.cols === sessionView.previewCols &&
    terminal.rows === sessionView.previewRows
  ) {
    TERMINAL_REPLAY.commitCheckpoint(replication.replayState, checkpoint);
    flushCrtTerminalTransitions();
    finishCrtTerminalReplay(replication);
    return true;
  }

  replication.pendingCheckpoint = sessionView;
  TERMINAL_REPLAY.beginRecovery(replication.replayState, sessionView);
  drainCrtTerminalCheckpointInstall(replication);
  return true;
}

function handleCrtTerminalStream(stream) {
  const replication = crtTerminalReplication;
  if (!replication || !stream || stream.agentId !== replication.agentId) return;
  if (stream.replace === true) {
    replication.checkpointSeq += 1;
    replication.checkpointAbortController?.abort();
    replication.checkpointAbortController = null;
    replication.checkpointInFlight = false;
    installCrtTerminalCheckpoint({
      runtimeEpoch: stream.runtimeEpoch,
      outputSeq: stream.outputSeq,
      stateRevision: stream.stateRevision,
      previewCols: stream.cols,
      previewRows: stream.rows,
      renderOutput: typeof stream.data === 'string' ? stream.data : ''
    });
    if (Array.isArray(stream.chunks)) {
      stream.chunks.forEach((chunk) => queueCrtTerminalTransition({
        kind: chunk.kind || 'output',
        data: typeof chunk.data === 'string' ? chunk.data : '',
        runtimeEpoch: chunk.runtimeEpoch || stream.runtimeEpoch,
        outputSeq: chunk.outputSeq,
        stateRevision: chunk.stateRevision,
        cols: chunk.cols,
        rows: chunk.rows
      }));
    }
    return;
  }

  const chunks = Array.isArray(stream.chunks) ? stream.chunks : [stream];
  chunks.forEach((chunk) => {
    const event = {
      kind: chunk.kind || 'output',
      data: typeof chunk.data === 'string' ? chunk.data : '',
      runtimeEpoch: chunk.runtimeEpoch || stream.runtimeEpoch,
      outputSeq: chunk.outputSeq,
      stateRevision: chunk.stateRevision,
      cols: chunk.cols,
      rows: chunk.rows
    };
    if (
      replication.replayState.recovering ||
      replication.checkpointInFlight ||
      replication.installInProgress ||
      replication.writeInProgress
    ) {
      queueCrtTerminalTransition(event);
    } else {
      applyCrtTerminalTransition(event);
    }
  });
}
function deriveSessionStreamPatch(stream, currentFocusedAgentId, currentSessionSource) {
  if (!stream) return null;
  if (stream.agentId !== currentFocusedAgentId) return null;
  if (!currentSessionSource) return null;
  if (typeof stream.data !== 'string' || stream.data.length === 0) return null;

  return {
    text: stream.data,
    nextLengthDelta: stream.data.length
  };
}

function createSessionModalState(agent, themeId, currentThemeSettings) {
  const title = agent ? getCrtAgentTitle(agent) : 'Agent Session';
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.createModalState) {
    return {
      ...SESSION_MODAL_BRIDGE.createModalState(agent, themeId, currentThemeSettings),
      title
    };
  }

  const sessionSource = agent && agent.sessionSource ? agent.sessionSource : 'buffer';
  return {
    agentId: agent ? agent.id : null,
    sessionSource,
    sessionSkin: null,
    title
  };
}

function shouldPollSessionView(sessionSource) {
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.shouldPollSessionView) {
    return SESSION_MODAL_BRIDGE.shouldPollSessionView(sessionSource);
  }
  return false;
}

function getSessionModalDomState(documentRef) {
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.getDomState) {
    return SESSION_MODAL_BRIDGE.getDomState(documentRef);
  }
  return {
    modal: documentRef.getElementById('session-modal'),
    terminalContainer: documentRef.getElementById('terminal-output'),
    title: documentRef.getElementById('session-title')
  };
}

function getSessionRuntime() {
  if (!sessionRuntime && SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.createRuntime) {
    sessionRuntime = SESSION_MODAL_BRIDGE.createRuntime({
      deriveSessionStreamPatch,
      refreshSessionView,
    });
  }

  return sessionRuntime;
}

function syncSessionRuntimeState() {
  const runtime = getSessionRuntime();
  if (!runtime) return;

  focusedAgentId = runtime.getFocusedAgentId();
}

function getActiveSessionSource() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getSessionSource() : null;
}

function getSessionOutputLength() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getLastOutputLength() : 0;
}

function getCurrentSessionToken() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.getSessionToken() : 0;
}

function setSessionOutputLength(length) {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.setLastOutputLength(length);
  }
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
            .replace(/\[\?[0-9;]*[a-zA-Z]/g, '')
            .replace(/\[>[0-9;]*[a-zA-Z]/g, '');
}

async function loadThemes() {
  try {
    const response = await fetch(farmingApiPath('/themes'));
    const data = await response.json();
    availableThemes = data.themes;
    currentTheme = data.current;

    const settingsResponse = await fetch(farmingApiPath(`/themes/${currentTheme}/settings`));
    const settingsData = await settingsResponse.json();
    themeSettings = settingsData.settings || {};

  } catch (error) {
    console.error('Failed to load themes:', error);
  }
}

async function loadGlobalSettings() {
  try {
    const response = await fetch(farmingApiPath('/settings'));
    const data = await response.json();
    globalSettings = {
      ...globalSettings,
      ...(data.settings || {})
    };
    applyCRTEffects(globalSettings.crtSkinEffectsEnabled !== false);
    if (state) renderCrtDashboardIfNeeded();
    if (agents.length > 0) renderAgentList();
    syncWorkspaceSettings();
    refreshWorkspaceMemoryUI();
  } catch (error) {
    console.error('Failed to load global settings:', error);
  }
}

async function saveGlobalSettings() {
  try {
    syncWorkspaceSettings();
    const response = await fetch(farmingApiPath('/settings'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(globalSettings)
    });

    const data = await response.json();
    if (data.success) {
      globalSettings = {
        ...globalSettings,
        ...(data.settings || {})
      };
      syncWorkspaceSettings();
    }
  } catch (error) {
    console.error('Failed to save global settings:', error);
  }
}

async function setTheme(themeId) {
  try {
    const response = await fetch(farmingApiPath(`/themes/${themeId}/set`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    if (data.success) {
      currentTheme = themeId;
      // 重新加载页面应用新主题
      location.reload();
    }
  } catch (error) {
    console.error('Failed to set theme:', error);
  }
}

function getUiThemeOptions() {
  return [...availableThemes, FARMING_CODE_THEME];
}

function activateUiTheme(themeId) {
  if (themeId === FARMING_CODE_THEME.id) {
    location.assign(RUNTIME_PATHS ? RUNTIME_PATHS.path('/code/') : '/code/');
    return;
  }
  setTheme(themeId);
}

function applyCRTEffects(enabled) {
  const body = document.body;

  if (enabled) {
    body.classList.remove('no-crt');
  } else {
    body.classList.add('no-crt');
  }
}

function renderThemeList() {
  const container = document.getElementById('theme-list');
  if (!container) return;

  container.innerHTML = '';
  const themeOptions = getUiThemeOptions();
  const hasCurrentTheme = themeOptions.some((option) => option.id === currentTheme);

  themeOptions.forEach((theme, index) => {
    const item = document.createElement('div');
    item.className = 'theme-item';
    item.tabIndex = -1;
    item.setAttribute('role', 'button');
    item.dataset.crtNavKey = `settings:theme:${theme.id}`;
    if (theme.id === currentTheme || (index === 0 && !hasCurrentTheme)) {
      item.dataset.crtNavDefault = 'true';
    }
    item.style.cssText = `
      border: 1px solid ${theme.id === currentTheme ? '#00ff00' : '#444'};
      padding: 10px;
      margin: 10px 0;
      cursor: pointer;
      background: ${theme.id === currentTheme ? '#1a2a1a' : '#1a1a1a'};
      position: relative;
    `;

    item.innerHTML = `
      <div style="font-weight: bold; color: #00ff00;">${theme.displayName}</div>
      <div style="font-size: 12px; color: #888; margin-top: 5px;">${theme.description}</div>
    `;

    item.onclick = () => activateUiTheme(theme.id);
    container.appendChild(item);
  });
  restoreCrtNavigationSelection();
}

function applyCrtTerminalFontSize(value) {
  const fontSize = normalizeCrtTerminalFontSize(value);
  globalSettings.crtTerminalFontSize = fontSize;
  const input = document.getElementById('crt-terminal-font-size');
  const output = document.getElementById('crt-terminal-font-size-value');
  if (input) input.value = String(fontSize);
  if (output) output.textContent = `${fontSize} px`;
  if (terminal && terminal.options) terminal.options.fontSize = fontSize;
  if (terminal && fitAddon && focusedAgentId && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (!terminal || !fitAddon || !focusedAgentId) return;
      sendSessionResize();
    });
  }
  return fontSize;
}

function scheduleCrtTerminalFontSizeSave() {
  if (crtTerminalFontSizeSaveTimer) clearTimeout(crtTerminalFontSizeSaveTimer);
  crtTerminalFontSizeSaveTimer = setTimeout(() => {
    crtTerminalFontSizeSaveTimer = null;
    void saveGlobalSettings();
  }, 150);
}

function initDisplaySettings() {
  const crtContainer = document.getElementById('crt-effects-container');
  const crtToggle = document.getElementById('crt-effects');
  const dynamicHeatToggle = document.getElementById('dynamic-heat');
  const terminalFontSizeInput = document.getElementById('crt-terminal-font-size');

  if (crtContainer) {
    if (currentTheme === 'terminal') {
      crtContainer.style.display = 'block';
      if (crtToggle) {
        crtToggle.checked = globalSettings.crtSkinEffectsEnabled !== false;
        crtToggle.onchange = async () => {
          globalSettings.crtSkinEffectsEnabled = crtToggle.checked;
          applyCRTEffects(crtToggle.checked);
          await saveGlobalSettings();
        };
      }
    } else {
      crtContainer.style.display = 'none';
    }
  }

  applyCRTEffects(globalSettings.crtSkinEffectsEnabled !== false);

  if (dynamicHeatToggle) {
    dynamicHeatToggle.checked = globalSettings.crtDynamicHeatEnabled === true;
    dynamicHeatToggle.onchange = async () => {
      globalSettings.crtDynamicHeatEnabled = dynamicHeatToggle.checked;
      renderState();
      await saveGlobalSettings();
    };
  }

  if (terminalFontSizeInput) {
    applyCrtTerminalFontSize(globalSettings.crtTerminalFontSize);
    terminalFontSizeInput.oninput = () => {
      applyCrtTerminalFontSize(terminalFontSizeInput.value);
      scheduleCrtTerminalFontSizeSave();
    };
  }
}

function initSessionEngineSettings() {
  const skipPermissionCheckToggle = document.getElementById('skip-permission-check-by-default');
  if (!skipPermissionCheckToggle) return;

  skipPermissionCheckToggle.checked = globalSettings.dangerouslySkipAgentPermissionsByDefault === true;
  skipPermissionCheckToggle.onchange = async () => {
    globalSettings.dangerouslySkipAgentPermissionsByDefault = skipPermissionCheckToggle.checked;
    await saveGlobalSettings();
  };
}

function showSettings() {
  clearCrtNavigationSelection();
  renderThemeList();
  initDisplaySettings();
  initSessionEngineSettings();
  document.getElementById('settings-modal').classList.add('active');
}

function hideSettings() {
  document.getElementById('settings-modal').classList.remove('active');
  clearCrtNavigationSelection();
}

function loadAgents() {
  return fetch(farmingApiPath('/executables'), { cache: 'no-store' })
    .then(res => res.json())
    .then(data => {
      agents = data.agents || [];
      renderAgentList();
      console.log(`Loaded ${agents.length} CLI agents`);
    })
    .catch(err => console.error('Failed to load agents:', err));
}

function renderAgentList() {
  const container = document.getElementById('agent-list');

  if (agents.length === 0) {
    container.innerHTML = '<p style="color: #888; font-size: 12px;">No CLI agents found in PATH</p>';
    return;
  }

  container.innerHTML = '';
  const defaultAgentIndex = findDefaultNewAgentIndex(agents, globalSettings.defaultLaunchAgent);

  const groups = [
    {
      title: 'coding agents',
      items: agents
        .map((agent, index) => ({ agent, index }))
        .filter(({ agent }) => agent.category === 'coding')
    },
    {
      title: 'others',
      items: agents
        .map((agent, index) => ({ agent, index }))
        .filter(({ agent }) => agent.category !== 'coding')
    }
  ];

  groups.forEach((group) => {
    if (group.items.length === 0) return;

    const title = document.createElement('div');
    title.className = 'agent-list-group-title';
    title.textContent = group.title;
    container.appendChild(title);

    group.items.forEach(({ agent, index }) => {
      const item = document.createElement('div');
      item.className = 'agent-item';
      item.dataset.index = index;
      item.dataset.crtNavKey = `new-agent:provider:${index}`;
      if (index === defaultAgentIndex) item.dataset.crtNavDefault = 'true';
      item.tabIndex = -1;
      item.setAttribute('role', 'button');

      const keyNum = index < 9 ? index + 1 : 0;

      item.innerHTML = `
        <div class="name">${agent.name}<span class="key-hint">[${keyNum}]</span></div>
        <div class="description">${agent.description}</div>
      `;

      item.onclick = () => selectAgent(index);
      container.appendChild(item);
    });
  });
  if (!restoreCrtNavigationSelection()) selectDefaultNewAgentNavigation();
}

function selectDefaultNewAgentNavigation() {
  const defaultAgentIndex = findDefaultNewAgentIndex(agents, globalSettings.defaultLaunchAgent);
  if (defaultAgentIndex < 0) return false;
  const defaultItem = getCrtNavigationItems().find((item) => (
    item.dataset.crtNavKey === `new-agent:provider:${defaultAgentIndex}`
  ));
  return defaultItem ? setCrtNavigationSelection(defaultItem) : false;
}

function formatCrtHistoryAge(timestamp, now = Date.now()) {
  if (!timestamp || !Number.isFinite(timestamp)) return '';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 56) return `${Math.floor(days / 7)}w`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(days / 365)}y`;
}

function crtHistoryItemTitle(item) {
  if (item.kind === 'run') {
    return item.entry.title || item.entry.task || item.entry.command || 'History agent';
  }
  if (item.kind === 'agent') return getCrtAgentTitle(item.agent);
  return item.session.title || `${item.session.providerName || item.session.provider || 'Agent'} session`;
}

function crtHistoryAgentName(command) {
  const program = crtCommandProgram(command).toLowerCase();
  return CRT_AGENT_DISPLAY_NAMES[program] || (program ? `${program.slice(0, 1).toUpperCase()}${program.slice(1)}` : 'Agent');
}

function crtHistoryItemMeta(item) {
  if (item.kind === 'run') {
    return [
      crtHistoryAgentName(item.entry.command),
      formatWorkspaceForDisplay(item.entry.projectWorkspace || item.entry.cwd || '')
    ].filter(Boolean).join(' · ');
  }
  if (item.kind === 'agent') {
    return [
      crtHistoryAgentName(item.agent.providerSessionProvider || item.agent.command || item.agent.engineName),
      formatWorkspaceForDisplay(item.agent.projectWorkspace || item.agent.cwd || '')
    ].filter(Boolean).join(' · ');
  }
  const effort = item.session.effort
    ? `${item.session.effort.slice(0, 1).toUpperCase()}${item.session.effort.slice(1)}`
    : '';
  return [
    item.session.providerName || item.session.provider,
    item.session.model,
    effort,
    formatWorkspaceForDisplay(item.session.workspace || item.session.cwd || '')
  ].filter(Boolean).join(' · ');
}

function crtHistoryPrimaryAction(item) {
  if (item.kind === 'run') return 'Continue';
  if (item.kind === 'agent') return 'Open';
  return 'Resume';
}

function setCrtMainView(view) {
  const previousView = crtMainView;
  crtMainView = ['history', 'search', 'billing'].includes(view) ? view : 'agents';
  const mapArea = document.getElementById('map-area');
  const historyArea = document.getElementById('history-area');
  const searchArea = document.getElementById('search-area');
  const billingArea = document.getElementById('billing-area');
  const historySidebarItem = document.getElementById('history-sidebar-item');
  const searchSidebarItem = document.getElementById('search-sidebar-item');
  const billingSidebarItem = document.getElementById('billing-sidebar-item');
  if (previousView === 'billing' && crtMainView !== 'billing') stopCrtBillingRefresh({ abort: true });
  if (mapArea) mapArea.classList.toggle('hidden', crtMainView !== 'agents');
  if (historyArea) historyArea.classList.toggle('hidden', crtMainView !== 'history');
  if (searchArea) searchArea.classList.toggle('hidden', crtMainView !== 'search');
  if (billingArea) billingArea.classList.toggle('hidden', crtMainView !== 'billing');
  if (historySidebarItem) historySidebarItem.classList.toggle('active', crtMainView === 'history');
  if (searchSidebarItem) searchSidebarItem.classList.toggle('active', crtMainView === 'search');
  if (billingSidebarItem) billingSidebarItem.classList.toggle('active', crtMainView === 'billing');
}

function getCrtSearchResults() {
  return buildCrtSearchResults({
    query: searchQuery,
    agents: state && Array.isArray(state.agents) ? state.agents : [],
    sessions: searchAgentSessions,
    mainAgentId: state && state.mainAgentId ? state.mainAgentId : '',
    projectNames: globalSettings.projectNames,
  });
}

function crtSearchResultTitle(result) {
  if (result.kind === 'agent') return getCrtAgentTitle(result.agent);
  return result.session.title || `${result.session.providerName || crtHistoryAgentName(result.session.provider)} Session`;
}

function crtSearchResultMeta(result) {
  if (result.kind === 'agent') {
    return [
      `LIVE ${String(result.agent.status || 'running').toUpperCase()}`,
      crtHistoryAgentName(result.agent.providerSessionProvider || result.agent.command || result.agent.engineName),
      getCrtProjectName(result.agent),
      formatWorkspaceForDisplay(result.agent.projectWorkspace || result.agent.cwd || ''),
    ].filter(Boolean).join(' · ');
  }
  return [
    result.session.archived === true ? 'ARCHIVED SESSION' : 'PROVIDER SESSION',
    result.session.providerName || crtHistoryAgentName(result.session.provider),
    formatWorkspaceForDisplay(result.session.workspace || result.session.cwd || ''),
  ].filter(Boolean).join(' · ');
}

function renderCrtSearch() {
  const list = document.getElementById('search-list');
  const status = document.getElementById('search-status');
  const resultStatus = document.getElementById('search-result-status');
  if (!list || !status || !resultStatus) return;

  const results = getCrtSearchResults();
  searchSelectionIndex = results.length > 0
    ? Math.max(0, Math.min(results.length - 1, searchSelectionIndex))
    : 0;
  list.replaceChildren();
  status.classList.toggle('is-busy', searchLoading || Boolean(searchActionPendingKey));
  status.classList.toggle('is-error', Boolean(searchError));
  status.textContent = searchActionPendingKey
    ? 'OPENING RECORD'
    : searchError
      ? 'INDEX ERROR'
      : searchLoading
        ? 'SCANNING INDEX'
        : searchQuery
          ? 'SCAN COMPLETE'
          : 'STANDBY';
  resultStatus.textContent = `${results.length} RECORD${results.length === 1 ? '' : 'S'}`;

  if (!searchQuery) {
    list.appendChild(createCrtHistoryMessage('search-message', 'ENTER A PROJECT, AGENT, OR SESSION QUERY.'));
    return;
  }
  if (searchError && results.length === 0) {
    list.appendChild(createCrtHistoryMessage('search-message is-error', searchError));
    return;
  }
  if (results.length === 0 && searchLoading) {
    list.appendChild(createCrtHistoryMessage('search-message', 'SCANNING PROVIDER SESSION INDEX...'));
    return;
  }
  if (results.length === 0) {
    list.appendChild(createCrtHistoryMessage('search-message', 'NO MATCHING RECORDS.'));
    return;
  }

  results.forEach((result, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `search-row${index === searchSelectionIndex ? ' is-selected' : ''}${searchActionPendingKey === result.searchKey ? ' is-pending' : ''}`;
    row.dataset.searchIndex = String(index);
    row.tabIndex = -1;
    row.disabled = Boolean(searchActionPendingKey);

    const recordIndex = document.createElement('span');
    recordIndex.className = 'search-row-index';
    recordIndex.textContent = String(index + 1).padStart(3, '0');
    const copy = document.createElement('span');
    copy.className = 'search-row-copy';
    const title = document.createElement('strong');
    title.className = 'search-row-title';
    title.textContent = crtSearchResultTitle(result);
    const meta = document.createElement('span');
    meta.className = 'search-row-meta';
    meta.textContent = crtSearchResultMeta(result);
    copy.append(title, meta);
    const action = document.createElement('span');
    action.className = 'search-row-action';
    action.textContent = result.kind === 'agent' ? 'Open' : 'Resume';
    row.append(recordIndex, copy, action);
    row.onclick = () => {
      searchSelectionIndex = index;
      activateCrtSearchResult(result);
    };
    list.appendChild(row);
  });

  if (crtMainView === 'search') {
    const selected = list.querySelector('.search-row.is-selected');
    if (selected && typeof selected.scrollIntoView === 'function') {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }
}

function resetCrtSearch() {
  searchRequestSequence += 1;
  if (searchDebounceTimer !== null) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = null;
  }
  if (searchAbortController) {
    searchAbortController.abort();
    searchAbortController = null;
  }
  searchQuery = '';
  searchAgentSessions = [];
  searchLoading = false;
  searchError = '';
  searchSelectionIndex = 0;
  searchActionPendingKey = '';
  const input = document.getElementById('crt-search-input');
  if (input) input.value = '';
}

async function loadCrtSearchAgentSessions(query, requestSequence) {
  const controller = new window.AbortController();
  searchAbortController = controller;
  try {
    const params = new window.URLSearchParams({
      q: query,
      limit: String(CRT_SEARCH_RESULT_LIMIT),
      fresh: '1',
    });
    const response = await fetch(farmingApiPath(`/agent-sessions/search?${params.toString()}`), {
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && data.error ? data.error : `Search request failed (${response.status})`);
    if (requestSequence !== searchRequestSequence) return;
    searchAgentSessions = data && Array.isArray(data.sessions) ? data.sessions : [];
    searchError = '';
  } catch (error) {
    if (controller.signal.aborted || requestSequence !== searchRequestSequence) return;
    searchAgentSessions = [];
    searchError = error instanceof Error ? error.message : 'Failed to search Agent sessions';
  } finally {
    if (requestSequence === searchRequestSequence) {
      searchLoading = false;
      searchAbortController = null;
      renderCrtSearch();
    }
  }
}

function scheduleCrtSearch(query) {
  searchQuery = String(query || '').trim();
  searchSelectionIndex = 0;
  searchAgentSessions = [];
  searchError = '';
  searchRequestSequence += 1;
  const requestSequence = searchRequestSequence;
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  if (searchAbortController) searchAbortController.abort();
  searchDebounceTimer = null;
  searchAbortController = null;
  searchLoading = Boolean(searchQuery);
  renderCrtSearch();
  if (!searchQuery) return;

  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    void loadCrtSearchAgentSessions(searchQuery, requestSequence);
  }, CRT_SEARCH_DEBOUNCE_MS);
}

function moveCrtSearchSelection(direction) {
  const results = getCrtSearchResults();
  if (!results.length) return false;
  searchSelectionIndex = (searchSelectionIndex + direction + results.length) % results.length;
  renderCrtSearch();
  return true;
}

function activateCrtSearchResult(result = getCrtSearchResults()[searchSelectionIndex]) {
  if (!result || searchActionPendingKey) return false;
  if (result.kind === 'agent') {
    const agentId = result.agent.id;
    hideCrtSearch();
    openSession(agentId);
    return true;
  }
  void resumeCrtSearchSession(result.session, result.searchKey);
  return true;
}

function showCrtSearch() {
  clearCrtNavigationSelection();
  resetCrtSearch();
  setCrtMainView('search');
  renderCrtSearch();
  window.requestAnimationFrame(() => {
    const input = document.getElementById('crt-search-input');
    if (input) setCrtNavigationSelection(input);
  });
}

function hideCrtSearch() {
  resetCrtSearch();
  clearCrtNavigationSelection();
  setCrtMainView('agents');
  renderState();
}

function setupCrtSearchControls() {
  const input = document.getElementById('crt-search-input');
  if (!input || input.dataset.bound === 'true') return;
  input.dataset.bound = 'true';
  input.addEventListener('input', () => scheduleCrtSearch(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      moveCrtSearchSelection(event.key === 'ArrowDown' ? 1 : -1);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Enter') {
      activateCrtSearchResult();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'Escape') {
      hideCrtSearch();
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

function formatCrtUsageValue(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '--';
  if (numberValue >= 1_000_000_000) {
    const compact = numberValue / 1_000_000_000;
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}B`;
  }
  if (numberValue >= 1_000_000) {
    const compact = numberValue / 1_000_000;
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}M`;
  }
  if (numberValue >= 1_000) {
    const compact = numberValue / 1_000;
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}K`;
  }
  return String(numberValue < 10 ? Math.round(numberValue * 10) / 10 : Math.round(numberValue));
}

function formatCrtExactUsageValue(value) {
  if (value === null || value === undefined || value === '') return '--';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '--';
  return Math.round(numberValue).toLocaleString('en-US');
}

function formatCrtCompactTotalValue(value) {
  if (value === null || value === undefined || value === '') return '--';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '--';
  const units = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ];
  const unit = units.find(([threshold]) => numberValue >= threshold);
  if (!unit) return String(Math.round(numberValue));
  const compact = numberValue / unit[0];
  const precision = compact >= 100 ? 0 : compact >= 10 ? 1 : 2;
  return `${Number(compact.toFixed(precision))}${unit[1]}`;
}

function parseCrtBillingDate(dateValue) {
  const parts = String(dateValue || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(part => !Number.isFinite(part))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function crtBillingDayLabel(dateValue) {
  const date = parseCrtBillingDate(dateValue);
  if (!date) return String(dateValue || 'SELECT A DAY');
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
  return `${dateValue} · ${weekday}`;
}

function crtBillingDayPoint(dateValue = billingSelectedDate) {
  const points = billingSummary && billingSummary.daily && Array.isArray(billingSummary.daily.points)
    ? billingSummary.daily.points
    : [];
  return points.find(point => point && point.date === dateValue) || null;
}

function crtBillingSelectedDayIsCurrent(point = crtBillingDayPoint()) {
  const daily = billingSummary && billingSummary.daily;
  return Boolean(daily && point && point.date === daily.endDate);
}

function cancelCrtBillingTotalAnimation() {
  if (billingTotalAnimationFrame !== null) {
    window.cancelAnimationFrame(billingTotalAnimationFrame);
    billingTotalAnimationFrame = null;
  }
  billingTotalAnimationTarget = null;
}

function cancelCrtBillingMetricAnimations() {
  billingAnimatedMetrics.forEach((metric) => {
    if (metric.frame !== null) window.cancelAnimationFrame(metric.frame);
  });
  billingAnimatedMetrics.clear();
}

function updateCrtBillingAnimatedMetric(key, value, {
  date = '',
  live = false,
  write,
} = {}) {
  const target = Number(value);
  const existing = billingAnimatedMetrics.get(key);
  if (!Number.isFinite(target) || target < 0 || typeof write !== 'function') {
    if (existing && existing.frame !== null) window.cancelAnimationFrame(existing.frame);
    billingAnimatedMetrics.delete(key);
    write?.(null, null);
    return;
  }

  const roundedTarget = Math.round(target);
  if (existing && existing.frame !== null && existing.target === roundedTarget && existing.date === date) {
    existing.write = write;
    return;
  }
  if (existing && existing.frame !== null) window.cancelAnimationFrame(existing.frame);
  const shouldSnap = !live
    || !existing
    || existing.date !== date
    || !Number.isFinite(existing.value)
    || roundedTarget <= existing.value;
  if (shouldSnap) {
    const metric = { date, value: roundedTarget, target: roundedTarget, frame: null, write };
    billingAnimatedMetrics.set(key, metric);
    write(roundedTarget, roundedTarget);
    return;
  }

  const metric = {
    date,
    value: existing.value,
    target: roundedTarget,
    frame: null,
    write,
  };
  billingAnimatedMetrics.set(key, metric);
  const startValue = existing.value;
  const startedAt = window.performance.now();
  const step = (now) => {
    const current = billingAnimatedMetrics.get(key);
    if (current !== metric) return;
    const progress = Math.min(1, Math.max(0, (now - startedAt) / CRT_BILLING_TOTAL_ANIMATION_MS));
    const steppedProgress = Math.min(1, Math.floor(progress * 18) / 18);
    const easedProgress = 1 - ((1 - steppedProgress) ** 3);
    metric.value = Math.round(startValue + (roundedTarget - startValue) * easedProgress);
    metric.write(metric.value, roundedTarget);
    if (progress < 1) {
      metric.frame = window.requestAnimationFrame(step);
      return;
    }
    metric.value = roundedTarget;
    metric.frame = null;
    metric.write(roundedTarget, roundedTarget);
  };
  metric.frame = window.requestAnimationFrame(step);
}

function updateCrtBillingExactMetric(id, value, { date = '', live = false } = {}) {
  const element = document.getElementById(id);
  if (!element) return;
  updateCrtBillingAnimatedMetric(id, value, {
    date,
    live,
    write: (displayed, target) => {
      element.textContent = formatCrtExactUsageValue(displayed);
      element.dataset.displayedValue = displayed === null ? '' : String(displayed);
      element.dataset.targetValue = target === null ? '' : String(target);
    },
  });
}

function writeCrtBillingTotalDisplay(value, target, { live = false } = {}) {
  const total = document.getElementById('billing-day-total');
  const compact = document.getElementById('billing-day-total-compact');
  const meter = document.getElementById('billing-day-total-meter');
  const numericValue = Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;
  const numericTarget = Number.isFinite(Number(target)) ? Math.max(0, Math.round(Number(target))) : null;
  if (total) total.textContent = formatCrtExactUsageValue(numericValue);
  if (compact) compact.textContent = formatCrtCompactTotalValue(numericValue);
  if (meter) {
    meter.classList.toggle('is-live', live);
    meter.dataset.displayedTotal = numericValue === null ? '' : String(numericValue);
    meter.dataset.targetTotal = numericTarget === null ? '' : String(numericTarget);
    meter.setAttribute('aria-label', numericTarget === null
      ? 'Total tokens unavailable'
      : `${formatCrtExactUsageValue(numericTarget)} total tokens${live ? ', live refresh every 5 seconds' : ''}`);
  }
}

function updateCrtBillingTotalDisplay(value, { date = '', live = false } = {}) {
  const target = Number(value);
  if (!Number.isFinite(target) || target < 0) {
    cancelCrtBillingTotalAnimation();
    billingDisplayedTotalDate = date;
    billingDisplayedTotalValue = null;
    writeCrtBillingTotalDisplay(null, null, { live });
    return;
  }

  const roundedTarget = Math.round(target);
  const shouldSnap = !live
    || billingDisplayedTotalDate !== date
    || !Number.isFinite(billingDisplayedTotalValue)
    || roundedTarget <= billingDisplayedTotalValue;
  if (shouldSnap) {
    cancelCrtBillingTotalAnimation();
    billingDisplayedTotalDate = date;
    billingDisplayedTotalValue = roundedTarget;
    writeCrtBillingTotalDisplay(roundedTarget, roundedTarget, { live });
    return;
  }
  if (billingTotalAnimationFrame !== null && billingTotalAnimationTarget === roundedTarget) return;

  cancelCrtBillingTotalAnimation();
  const startValue = billingDisplayedTotalValue;
  const startedAt = window.performance.now();
  billingTotalAnimationTarget = roundedTarget;
  const step = (now) => {
    const progress = Math.min(1, Math.max(0, (now - startedAt) / CRT_BILLING_TOTAL_ANIMATION_MS));
    const steppedProgress = Math.min(1, Math.floor(progress * 18) / 18);
    const easedProgress = 1 - ((1 - steppedProgress) ** 3);
    billingDisplayedTotalValue = Math.round(startValue + (roundedTarget - startValue) * easedProgress);
    writeCrtBillingTotalDisplay(billingDisplayedTotalValue, roundedTarget, { live: true });
    if (progress < 1) {
      billingTotalAnimationFrame = window.requestAnimationFrame(step);
      return;
    }
    billingDisplayedTotalValue = roundedTarget;
    billingTotalAnimationFrame = null;
    billingTotalAnimationTarget = null;
    writeCrtBillingTotalDisplay(roundedTarget, roundedTarget, { live: true });
  };
  billingTotalAnimationFrame = window.requestAnimationFrame(step);
}

const CRT_BILLING_OVERRANGE_BASE = 1_000_000_000;

function crtBillingOverrangeTier(value) {
  const total = Math.max(0, Number(value) || 0);
  if (total < CRT_BILLING_OVERRANGE_BASE) return 0;
  return Math.min(4, Math.floor(Math.log2(total / CRT_BILLING_OVERRANGE_BASE)) + 1);
}

function crtBillingOverrangeLabel(tier) {
  return tier > 0 ? `${2 ** (tier - 1)}B+ OVERRANGE` : '';
}

function crtBillingHeatThresholds(values) {
  const activeValues = (Array.isArray(values) ? values : [])
    .map(value => Math.max(0, Number(value) || 0))
    .filter(value => value > 0 && value < CRT_BILLING_OVERRANGE_BASE)
    .sort((left, right) => left - right);
  if (activeValues.length === 0) return [];
  return [0.2, 0.4, 0.6, 0.8].map(quantile => (
    activeValues[Math.min(activeValues.length - 1, Math.ceil(activeValues.length * quantile) - 1)]
  ));
}

function crtBillingHeatLevel(value, thresholds) {
  const total = Math.max(0, Number(value) || 0);
  if (total <= 0) return 0;
  const bands = Array.isArray(thresholds) ? thresholds : [];
  return Math.max(1, Math.min(5, 1 + bands.filter(threshold => total > threshold).length));
}

function crtBillingDayDetailHasHourlyActivity(detail) {
  return Boolean(detail && Array.isArray(detail.hours) && detail.hours.some(hour => (
    Math.max(0, Number(hour && hour.totalTokens) || 0) > 0
  )));
}

function crtBillingHourlyPath(hours, valueForHour, maximum) {
  const width = 600;
  const height = 120;
  const points = Array.isArray(hours) ? hours : [];
  if (points.length === 0 || maximum <= 0) return '';
  return points.map((hour, index) => {
    const startX = index / points.length * width;
    const endX = (index + 1) / points.length * width;
    const value = Math.max(0, Number(valueForHour(hour)) || 0);
    const y = height - Math.min(1, value / maximum) * height;
    return `${index === 0 ? 'M' : 'L'}${startX.toFixed(1)} ${y.toFixed(1)} L${endX.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function renderCrtBillingDayInsight() {
  const cachedEntry = billingDayDetailCache.get(billingSelectedDate);
  const selectedDetail = billingDayDetail && billingDayDetail.date === billingSelectedDate
    ? billingDayDetail
    : cachedEntry && cachedEntry.detail || null;
  const point = crtBillingDayPoint();
  const hours = selectedDetail && Array.isArray(selectedDetail.hours) ? selectedDetail.hours : [];
  const state = document.getElementById('billing-day-insight-state');
  const totalPath = document.getElementById('billing-day-total-path');
  const cachePath = document.getElementById('billing-day-cache-path');
  const scale = document.getElementById('billing-day-curve-scale');
  const maximumLabel = document.getElementById('billing-day-curve-max');
  const hourStrip = document.getElementById('billing-day-hour-strip');
  const hourReadout = document.getElementById('billing-day-hour-readout');
  const shares = document.getElementById('billing-day-provider-shares');
  const maximum = Math.max(0, ...hours.map(hour => Math.max(0, Number(hour && hour.totalTokens) || 0)));

  if (totalPath) totalPath.setAttribute('d', crtBillingHourlyPath(hours, hour => hour.totalTokens, maximum));
  if (cachePath) cachePath.setAttribute('d', crtBillingHourlyPath(
    hours,
    hour => (Number(hour.cacheReadTokens) || 0) + (Number(hour.cacheWriteTokens) || 0),
    maximum,
  ));
  const isToday = crtBillingSelectedDayIsCurrent(point);
  updateCrtBillingAnimatedMetric('billing-day-curve-scale', maximum > 0 ? maximum : null, {
    date: point && point.date || '',
    live: isToday,
    write: displayed => {
      if (scale) scale.textContent = displayed === null ? '-- TOK/H PEAK' : `${formatCrtUsageValue(displayed)} TOK/H PEAK`;
    },
  });
  updateCrtBillingAnimatedMetric('billing-day-curve-max', maximum > 0 ? maximum : null, {
    date: point && point.date || '',
    live: isToday,
    write: displayed => {
      if (maximumLabel) maximumLabel.textContent = displayed === null ? '--' : formatCrtUsageValue(displayed);
    },
  });
  if (hourStrip) {
    hourStrip.replaceChildren();
    if (hours.length > 0) {
      const heatThresholds = crtBillingHeatThresholds(hours.map(hour => hour && hour.totalTokens));
      if (!Number.isInteger(billingSelectedHour) || billingSelectedHour < 0 || billingSelectedHour >= hours.length) {
        billingSelectedHour = hours.reduce((peakIndex, hour, index) => (
          Number(hour && hour.totalTokens) > Number(hours[peakIndex] && hours[peakIndex].totalTokens) ? index : peakIndex
        ), 0);
      }
      const selectHour = (index, { focus = false } = {}) => {
        billingSelectedHour = index;
        hourStrip.querySelectorAll('.billing-day-hour-cell').forEach((cell, cellIndex) => {
          const selected = cellIndex === index;
          cell.classList.toggle('selected', selected);
          cell.setAttribute('aria-selected', selected ? 'true' : 'false');
          cell.tabIndex = selected ? 0 : -1;
        });
        const hour = hours[index] || {};
        const hourValue = Number.isFinite(Number(hour.hour)) ? Number(hour.hour) : index;
        const total = Math.max(0, Number(hour.totalTokens) || 0);
        const cache = Math.max(0, (Number(hour.cacheReadTokens) || 0) + (Number(hour.cacheWriteTokens) || 0));
        if (hourReadout) {
          const endHour = hourValue + 1;
          const cacheShare = total > 0 ? `${(cache / total * 100).toFixed(1)}% CACHE` : 'NO ACTIVITY';
          hourReadout.textContent = `[${String(hourValue).padStart(2, '0')}:00—${String(endHour).padStart(2, '0')}:00]  TOTAL ${formatCrtUsageValue(total)}  //  CACHE ${formatCrtUsageValue(cache)}  //  ${cacheShare}`;
          hourReadout.title = `${String(hourValue).padStart(2, '0')}:00—${String(endHour).padStart(2, '0')}:00 · ${formatCrtExactUsageValue(total)} total tokens · ${formatCrtExactUsageValue(cache)} cache tokens`;
        }
        if (focus) hourStrip.children[index]?.focus();
      };
      hours.forEach((hour, index) => {
        const total = Math.max(0, Number(hour && hour.totalTokens) || 0);
        const cache = Math.max(0, (Number(hour && hour.cacheReadTokens) || 0) + (Number(hour && hour.cacheWriteTokens) || 0));
        const hourValue = Number.isFinite(Number(hour && hour.hour)) ? Number(hour.hour) : index;
        const overrangeTier = crtBillingOverrangeTier(total);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'billing-day-hour-cell';
        cell.dataset.level = overrangeTier ? 'overrange' : String(crtBillingHeatLevel(total, heatThresholds));
        if (overrangeTier) cell.dataset.overrange = String(overrangeTier);
        cell.dataset.hour = String(hourValue);
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-label', `${String(hourValue).padStart(2, '0')}:00 to ${String(hourValue + 1).padStart(2, '0')}:00, ${formatCrtExactUsageValue(total)} total tokens, ${formatCrtExactUsageValue(cache)} cache tokens`);
        cell.tabIndex = index === billingSelectedHour ? 0 : -1;
        cell.addEventListener('click', () => selectHour(index));
        cell.addEventListener('mouseenter', () => selectHour(index));
        cell.addEventListener('focus', () => selectHour(index));
        cell.addEventListener('keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          selectHour(Math.max(0, Math.min(hours.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))), { focus: true });
        });
        hourStrip.appendChild(cell);
      });
      selectHour(billingSelectedHour);
    } else if (hourReadout) {
      hourReadout.textContent = billingDayDetailLoading ? 'READING HOURLY COORDINATES' : 'NO HOURLY ACTIVITY';
      hourReadout.removeAttribute('title');
    }
  }
  if (state) {
    state.classList.toggle('is-error', Boolean(billingDayDetailError && !selectedDetail));
    state.textContent = billingDayDetailError && selectedDetail
      ? '24 HOURLY BINS READY · STALE'
      : billingDayDetailError
        ? 'DAY SIGNAL LOST'
        : billingDayDetailLoading && !selectedDetail
          ? 'READING 24 HOURLY BINS'
          : selectedDetail && maximum > 0
            ? '24 HOURLY BINS READY'
            : selectedDetail
              ? 'NO HOURLY ACTIVITY'
              : 'SELECTED DAY DETAIL';
  }

  if (!shares) return;
  shares.replaceChildren();
  const providerUsage = selectedDetail && selectedDetail.providers
    ? selectedDetail.providers
    : point && point.providers || {};
  const providerRows = Object.entries(providerUsage)
    .map(([provider, usage]) => ({ provider, total: Math.max(0, Number(usage && usage.totalTokens) || 0) }))
    .filter(row => row.total > 0)
    .sort((left, right) => right.total - left.total);
  const providerTotal = providerRows.reduce((total, row) => total + row.total, 0);
  if (providerRows.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'billing-day-share-empty';
    empty.textContent = billingDayDetailLoading ? 'READING AGENT TYPES' : 'NO ATTRIBUTED TOKEN DATA';
    shares.appendChild(empty);
    return;
  }
  providerRows.forEach(({ provider, total }) => {
    const percentage = providerTotal > 0 ? total / providerTotal * 100 : 0;
    const row = document.createElement('div');
    row.className = 'billing-day-share-row';
    const copy = document.createElement('div');
    copy.className = 'billing-day-share-copy';
    const name = document.createElement('span');
    name.textContent = provider.toUpperCase();
    const value = document.createElement('strong');
    value.textContent = `${percentage.toFixed(1)}% · ${formatCrtExactUsageValue(total)}`;
    copy.append(name, value);
    const track = document.createElement('div');
    track.className = 'billing-day-share-track';
    track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.style.width = `${percentage.toFixed(2)}%`;
    track.appendChild(fill);
    row.append(copy, track);
    row.setAttribute('aria-label', `${provider}: ${percentage.toFixed(1)} percent, ${formatCrtExactUsageValue(total)} tokens`);
    shares.appendChild(row);
  });
}

function renderCrtBillingSelectedDay({ preferSummary = false } = {}) {
  const daily = billingSummary && billingSummary.daily;
  const point = crtBillingDayPoint();
  const cachedEntry = billingDayDetailCache.get(billingSelectedDate);
  const selectedDetail = billingDayDetail && billingDayDetail.date === billingSelectedDate
    ? billingDayDetail
    : cachedEntry && cachedEntry.detail || null;
  const displayDetail = preferSummary ? null : selectedDetail;
  const displayPoint = displayDetail && displayDetail.total || point;
  const displayProviders = displayDetail && displayDetail.providers || point && point.providers;
  const isToday = crtBillingSelectedDayIsCurrent(point);
  const date = document.getElementById('billing-day-date');
  const stateLabel = document.getElementById('billing-day-state');
  const providers = document.getElementById('billing-day-providers');
  if (date) date.textContent = crtBillingDayLabel(point && point.date);
  updateCrtBillingTotalDisplay(displayPoint && displayPoint.totalTokens, {
    date: point && point.date || '',
    live: isToday,
  });
  const selectedDate = point && point.date || '';
  updateCrtBillingExactMetric('billing-day-input', displayPoint && displayPoint.inputTokens, { date: selectedDate, live: isToday });
  updateCrtBillingExactMetric('billing-day-output', displayPoint && displayPoint.outputTokens, { date: selectedDate, live: isToday });
  updateCrtBillingExactMetric('billing-day-cache-read', displayPoint && displayPoint.cacheReadTokens, { date: selectedDate, live: isToday });
  updateCrtBillingExactMetric('billing-day-cache-write', displayPoint && displayPoint.cacheWriteTokens, { date: selectedDate, live: isToday });
  if (providers) {
    const providerTotals = displayProviders ? Object.entries(displayProviders) : [];
    providers.textContent = providerTotals
      .map(([provider, usage]) => `${provider.toUpperCase()} ${formatCrtExactUsageValue(usage && usage.totalTokens)}`)
      .join(' · ') || '--';
    providers.title = providers.textContent;
  }
  if (stateLabel) {
    const notes = isToday ? ['LIVE 5S', 'PARTIAL DAY', 'INCL CACHE'] : ['COMPLETE DAY', 'INCL CACHE'];
    if (daily && daily.partial) notes.push('PARTIAL SOURCE');
    if (point && Number(point.unattributedTokens) > 0) {
      notes.push(`${formatCrtUsageValue(point.unattributedTokens)} UNCLASSIFIED`);
    }
    stateLabel.textContent = point ? notes.join(' · ') : 'LOCAL HISTORY';
  }
  document.querySelectorAll('#billing-calendar-grid .billing-calendar-day').forEach((cell) => {
    const selected = cell.dataset.date === billingSelectedDate;
    cell.classList.toggle('selected', selected);
    cell.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  renderCrtBillingDayInsight();
}

function selectCrtBillingDay(dateValue, { focus = false } = {}) {
  if (!crtBillingDayPoint(dateValue)) return false;
  cancelCrtBillingDayDetailRetry();
  billingSelectedDate = dateValue;
  billingSelectedHour = null;
  const isToday = crtBillingSelectedDayIsCurrent(crtBillingDayPoint(dateValue));
  billingDayDetail = billingDayDetailCache.get(dateValue)?.detail || null;
  billingDayDetailError = '';
  renderCrtBillingSelectedDay({ preferSummary: isToday });
  void loadCrtBillingDayDetail(dateValue, { force: isToday, live: isToday });
  if (focus) {
    const cell = document.querySelector(`#billing-calendar-grid .billing-calendar-day[data-date="${dateValue}"]`);
    if (cell) {
      cell.focus({ preventScroll: true });
      scrollCrtBillingSelectedDayIntoView();
    }
  }
  return true;
}

function cancelCrtBillingDayDetailRetry() {
  if (billingDayDetailRetryTimer !== null) {
    clearTimeout(billingDayDetailRetryTimer);
    billingDayDetailRetryTimer = null;
  }
}

async function loadCrtBillingDayDetail(dateValue, { force = false, live = false, retryCount = 0 } = {}) {
  const date = String(dateValue || '').trim();
  if (!crtBillingDayPoint(date)) return;
  if (retryCount === 0) cancelCrtBillingDayDetailRetry();
  const cachedEntry = billingDayDetailCache.get(date);
  const cached = cachedEntry && cachedEntry.detail;
  const cacheMaxAge = live ? CRT_BILLING_LIVE_DAY_REFRESH_MS : CRT_BILLING_DAY_DETAIL_CACHE_MS;
  const cacheFresh = cachedEntry && Date.now() - cachedEntry.fetchedAt <= cacheMaxAge;
  if (cached && cacheFresh && !force) {
    if (billingSelectedDate === date) {
      billingDayDetail = cached;
      billingDayDetailLoading = false;
      billingDayDetailError = '';
      renderCrtBillingSelectedDay();
    }
    return;
  }

  billingDayDetailRequestSequence += 1;
  const requestSequence = billingDayDetailRequestSequence;
  if (billingDayDetailAbortController) billingDayDetailAbortController.abort();
  const controller = new window.AbortController();
  billingDayDetailAbortController = controller;
  billingDayDetailLoading = true;
  billingDayDetailError = '';
  if (billingSelectedDate === date) {
    if (!cached) billingDayDetail = null;
    renderCrtBillingDayInsight();
  }
  let shouldRetry = false;
  try {
    const response = await fetch(farmingApiPath(`/usage/day?date=${encodeURIComponent(date)}${live ? '&live=1' : ''}`), {
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.detail) {
      throw new Error(data && data.error ? data.error : `Usage day request failed (${response.status})`);
    }
    if (requestSequence !== billingDayDetailRequestSequence) return;
    const previousDetail = cached || (billingDayDetail && billingDayDetail.date === date ? billingDayDetail : null);
    const nextTotal = Math.max(0, Number(data.detail.total && data.detail.total.totalTokens) || 0);
    if (
      nextTotal > 0
      && crtBillingDayDetailHasHourlyActivity(previousDetail)
      && !crtBillingDayDetailHasHourlyActivity(data.detail)
    ) {
      throw new Error('Usage day response omitted previously available hourly bins');
    }
    billingDayDetailCache.set(date, { detail: data.detail, fetchedAt: Date.now() });
    if (billingSelectedDate === date) billingDayDetail = data.detail;
    if (live) renderCrtBillingDaily();
  } catch (error) {
    if (controller.signal.aborted || requestSequence !== billingDayDetailRequestSequence) return;
    if (billingSelectedDate === date && retryCount < CRT_BILLING_DAY_DETAIL_MAX_RETRIES) {
      shouldRetry = true;
    } else if (billingSelectedDate === date) {
      billingDayDetailError = error instanceof Error ? error.message : 'Failed to load selected day';
    }
  } finally {
    if (requestSequence === billingDayDetailRequestSequence) {
      billingDayDetailAbortController = null;
      if (shouldRetry) {
        billingDayDetailLoading = true;
        cancelCrtBillingDayDetailRetry();
        const retryDelay = CRT_BILLING_DAY_DETAIL_RETRY_MS * (2 ** retryCount);
        billingDayDetailRetryTimer = setTimeout(() => {
          billingDayDetailRetryTimer = null;
          if (billingSelectedDate !== date || crtMainView !== 'billing') {
            billingDayDetailLoading = false;
            return;
          }
          void loadCrtBillingDayDetail(date, { force: true, live, retryCount: retryCount + 1 });
        }, retryDelay);
      } else {
        billingDayDetailLoading = false;
      }
      if (billingSelectedDate === date) renderCrtBillingSelectedDay();
    }
  }
}

function scrollCrtBillingSelectedDayIntoView() {
  const scroll = document.getElementById('billing-daily-scroll');
  const cell = billingSelectedDate
    ? document.querySelector(`#billing-calendar-grid .billing-calendar-day[data-date="${billingSelectedDate}"]`)
    : null;
  if (!scroll || !cell) return;
  const left = cell.offsetLeft;
  const right = left + cell.offsetWidth;
  if (left < scroll.scrollLeft) scroll.scrollLeft = left;
  else if (right > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = right - scroll.clientWidth;
}

function selectCrtBillingDayByArrow(key) {
  if (crtMainView !== 'billing' || billingMode !== 'days') return false;
  const points = billingSummary && billingSummary.daily && Array.isArray(billingSummary.daily.points)
    ? billingSummary.daily.points
    : [];
  if (points.length === 0) return false;
  let index = points.findIndex(point => point.date === billingSelectedDate);
  if (index < 0) index = points.length - 1;
  const delta = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -7 : 7;
  const nextIndex = Math.max(0, Math.min(points.length - 1, index + delta));
  return selectCrtBillingDay(points[nextIndex].date, { focus: true });
}

function renderCrtBillingDaily(summary = billingSummary) {
  const daily = summary && summary.daily;
  const points = daily && Array.isArray(daily.points) ? daily.points : [];
  const totals = daily && daily.summary || {};
  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = formatCrtUsageValue(value);
  };
  const todayDetail = daily && billingDayDetailCache.get(daily.endDate)?.detail;
  const todayTokens = todayDetail && todayDetail.total ? todayDetail.total.totalTokens : totals.todayTokens;
  updateCrtBillingAnimatedMetric('billing-today-total', todayTokens, {
    date: daily && daily.endDate || '',
    live: true,
    write: (displayed, target) => {
      const element = document.getElementById('billing-today-total');
      if (!element) return;
      element.textContent = formatCrtUsageValue(displayed);
      element.dataset.displayedValue = displayed === null ? '' : String(displayed);
      element.dataset.targetValue = target === null ? '' : String(target);
    },
  });
  setValue('billing-7d-total', totals.sevenDayTokens);
  setValue('billing-30d-total', totals.thirtyDayTokens);
  setValue('billing-period-total', totals.periodTokens);
  const activeDays = points.filter(point => Number(point && point.totalTokens) > 0).length;
  const billionDays = points.filter(point => Number(point && point.totalTokens) >= 1_000_000_000).length;
  setValue('billing-active-days', activeDays);
  setValue('billing-billion-days', billionDays);
  const peak = document.getElementById('billing-peak-day');
  if (peak) peak.textContent = totals.peakDate
    ? `PEAK ${totals.peakDate.slice(5)} · ${formatCrtUsageValue(totals.peakTokens)}`
    : 'PEAK --';
  const range = document.getElementById('billing-daily-range');
  if (range) {
    const coverage = daily && Array.isArray(daily.coverage) ? daily.coverage : [];
    const availableSources = coverage.filter(source => source && source.available !== false).length;
    range.textContent = daily
      ? `${daily.startDate} — ${daily.endDate} · ${String(daily.timeZone || 'LOCAL').toUpperCase()}${coverage.length ? ` · ${availableSources}/${coverage.length} SOURCES` : ''}`
      : 'LOCAL TIME';
  }

  const calendar = document.getElementById('billing-calendar-grid');
  const months = document.getElementById('billing-calendar-months');
  if (!calendar || !months) return;
  const signature = points.map(point => [
    point.date,
    point.totalTokens,
    point.cacheReadTokens,
    point.cacheWriteTokens,
  ].join(':')).join('|');
  if (signature !== billingDailyRenderSignature) {
    billingDailyRenderSignature = signature;
    calendar.replaceChildren();
    months.replaceChildren();

    const chartPoints = points.slice(-(52 * 7));
    const heatThresholds = crtBillingHeatThresholds(chartPoints.map(point => point && point.totalTokens));
    const firstDate = parseCrtBillingDate(chartPoints[0] && chartPoints[0].date);
    const leadingDays = firstDate ? (firstDate.getDay() + 6) % 7 : 0;
    const weekCount = Math.max(1, Math.ceil((leadingDays + chartPoints.length) / 7));
    calendar.style.setProperty('--billing-calendar-weeks', String(weekCount));
    months.style.setProperty('--billing-calendar-weeks', String(weekCount));
    Array.from({ length: leadingDays }).forEach(() => {
      const spacer = document.createElement('span');
      spacer.className = 'billing-calendar-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      calendar.appendChild(spacer);
    });

    const monthLabels = Array.from({ length: weekCount }, () => '');
    chartPoints.forEach((point, index) => {
      const pointDate = parseCrtBillingDate(point.date);
      const weekIndex = Math.floor((leadingDays + index) / 7);
      if (pointDate && (index === 0 || pointDate.getDate() === 1) && !monthLabels[weekIndex]) {
        monthLabels[weekIndex] = pointDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
      }
      const total = Math.max(0, Number(point.totalTokens) || 0);
      const cache = Math.min(total, Math.max(0, Number(point.cacheReadTokens) || 0)
        + Math.max(0, Number(point.cacheWriteTokens) || 0));
      const overrangeTier = crtBillingOverrangeTier(total);
      const overrangeLabel = crtBillingOverrangeLabel(overrangeTier);
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'billing-calendar-day';
      day.dataset.date = point.date;
      day.dataset.level = overrangeTier ? 'overrange' : String(crtBillingHeatLevel(total, heatThresholds));
      if (overrangeTier) day.dataset.overrange = String(overrangeTier);
      day.setAttribute('role', 'gridcell');
      day.setAttribute('aria-label', `${point.date}: ${formatCrtExactUsageValue(total)} tokens, ${formatCrtExactUsageValue(cache)} cache tokens${overrangeLabel ? `, ${overrangeLabel}` : ''}`);
      day.setAttribute('aria-selected', 'false');
      day.tabIndex = -1;
      day.title = `${point.date} · ${formatCrtExactUsageValue(total)} total · ${formatCrtExactUsageValue(cache)} cache${overrangeLabel ? ` · ${overrangeLabel}` : ''}`;
      day.addEventListener('click', () => selectCrtBillingDay(point.date));
      calendar.appendChild(day);
    });
    const trailingDays = weekCount * 7 - leadingDays - chartPoints.length;
    Array.from({ length: trailingDays }).forEach(() => {
      const spacer = document.createElement('span');
      spacer.className = 'billing-calendar-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      calendar.appendChild(spacer);
    });
    monthLabels.forEach((label) => {
      const month = document.createElement('span');
      month.textContent = label;
      months.appendChild(month);
    });
    calendar.setAttribute('aria-label', `${chartPoints.length}-day token activity: ${activeDays} active days, ${billionDays} days at or above one billion tokens`);

    if (!billingSelectedDate || !points.some(point => point.date === billingSelectedDate)) {
      billingSelectedDate = daily && daily.endDate || points.at(-1)?.date || '';
    }
    window.requestAnimationFrame(() => {
      scrollCrtBillingSelectedDayIntoView();
    });
  }
  renderCrtBillingSelectedDay();
}

function setCrtBillingMode(mode) {
  billingMode = mode === 'live' ? 'live' : 'days';
  const daysView = document.getElementById('billing-days-view');
  const liveView = document.getElementById('billing-live-view');
  const daysTab = document.getElementById('billing-days-tab');
  const liveTab = document.getElementById('billing-live-tab');
  if (daysView) daysView.classList.toggle('hidden', billingMode !== 'days');
  if (liveView) liveView.classList.toggle('hidden', billingMode !== 'live');
  if (daysTab) {
    daysTab.classList.toggle('active', billingMode === 'days');
    daysTab.setAttribute('aria-selected', billingMode === 'days' ? 'true' : 'false');
  }
  if (liveTab) {
    liveTab.classList.toggle('active', billingMode === 'live');
    liveTab.setAttribute('aria-selected', billingMode === 'live' ? 'true' : 'false');
  }
  const status = document.getElementById('billing-status');
  if (status && billingSummary && !billingLoading && !billingError) {
    status.textContent = billingMode === 'days' ? 'HISTORY READY' : 'SIGNAL LOCKED';
  }
  if (billingMode === 'live') window.requestAnimationFrame(() => drawCrtBillingScope());
}

function formatCrtBillingWindow(windowMinutes) {
  const minutes = Number(windowMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'WINDOW';
  if (minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)}W`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${Math.round(minutes)}M`;
}

function formatCrtBillingReset(resetsAt, now = Date.now()) {
  const timestamp = Number(resetsAt);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'RESET --';
  const remainingMinutes = Math.max(0, Math.round((timestamp - now) / 60_000));
  if (remainingMinutes >= 24 * 60) return `RESET ${Math.floor(remainingMinutes / (24 * 60))}D ${Math.floor((remainingMinutes % (24 * 60)) / 60)}H`;
  if (remainingMinutes >= 60) return `RESET ${Math.floor(remainingMinutes / 60)}H ${remainingMinutes % 60}M`;
  return `RESET ${remainingMinutes}M`;
}

function crtBillingCurrentRate(summary = billingSummary) {
  const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
  return providers.reduce((total, provider) => {
    const rate = Number(provider && provider.tokenUsage && provider.tokenUsage.tokensPerMinute);
    return total + (Number.isFinite(rate) ? Math.max(0, rate) : 0);
  }, 0);
}

function appendCrtBillingMessage(container, text, isError = false) {
  const message = document.createElement('div');
  message.className = `billing-message${isError ? ' is-error' : ''}`;
  message.textContent = text;
  container.appendChild(message);
}

function renderCrtBillingQuota(summary = billingSummary) {
  const container = document.getElementById('billing-quota-list');
  if (!container) return;
  container.replaceChildren();
  const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
  let rowCount = 0;

  providers.forEach((provider) => {
    const quota = provider && provider.quota;
    if (!quota || quota.available === false) return;
    [quota.primary, quota.secondary].filter(Boolean).forEach((limit) => {
      const usedPercent = Math.max(0, Math.min(100, Number(limit.usedPercent) || 0));
      const remainingPercent = Math.max(0, 100 - usedPercent);
      const row = document.createElement('div');
      row.className = `billing-quota-row${remainingPercent <= 25 ? ' is-warning' : ''}`;
      const copy = document.createElement('div');
      copy.className = 'billing-quota-copy';
      const label = document.createElement('strong');
      label.textContent = `${String(provider.providerName || provider.provider || 'PROVIDER').toUpperCase()} ${formatCrtBillingWindow(limit.windowMinutes)}`;
      const reset = document.createElement('small');
      reset.textContent = formatCrtBillingReset(limit.resetsAt);
      copy.append(label, reset);
      const track = document.createElement('div');
      track.className = 'billing-quota-track';
      track.setAttribute('role', 'meter');
      track.setAttribute('aria-label', `${label.textContent} remaining`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(remainingPercent)));
      const fill = document.createElement('span');
      fill.className = 'billing-quota-fill';
      fill.style.width = `${remainingPercent}%`;
      fill.title = `${Math.round(remainingPercent)}% remaining`;
      track.appendChild(fill);
      row.append(copy, track);
      container.appendChild(row);
      rowCount += 1;
    });
  });

  if (rowCount === 0) appendCrtBillingMessage(container, 'NO QUOTA TELEMETRY. LOCAL TOKEN SIGNAL REMAINS AVAILABLE.');
}

function renderCrtBillingProviders(summary = billingSummary) {
  const container = document.getElementById('billing-provider-list');
  if (!container) return;
  container.replaceChildren();
  const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
  if (providers.length === 0) {
    appendCrtBillingMessage(container, 'NO PROVIDER CHANNELS.');
    return;
  }

  providers.forEach((provider) => {
    const row = document.createElement('div');
    row.className = 'billing-provider-row';
    const copy = document.createElement('div');
    copy.className = 'billing-provider-copy';
    const name = document.createElement('strong');
    name.textContent = String(provider.providerName || provider.provider || 'PROVIDER').toUpperCase();
    const source = document.createElement('small');
    const usageAvailable = provider.tokenUsage && provider.tokenUsage.available !== false;
    const authStatus = usageAvailable
      ? (provider.auth && provider.auth.available ? provider.auth.status : 'LOCAL TELEMETRY')
      : (provider.tokenUsage && provider.tokenUsage.reason || 'NO TOKEN TELEMETRY');
    source.textContent = String(authStatus || 'AVAILABLE').toUpperCase();
    source.title = provider.tokenUsage && provider.tokenUsage.source || '';
    copy.append(name, source);
    const rate = document.createElement('strong');
    rate.className = 'billing-provider-rate';
    rate.textContent = usageAvailable
      ? `${formatCrtUsageValue(provider.tokenUsage && provider.tokenUsage.tokensPerMinute)} TOK/MIN`
      : 'NO TOKEN DATA';
    row.append(copy, rate);
    container.appendChild(row);
  });
}

function drawCrtBillingScope(summary = billingSummary) {
  const canvas = document.getElementById('billing-scope');
  if (!canvas || crtMainView !== 'billing') return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.floor(rect.width * pixelRatio));
  const height = Math.max(1, Math.floor(rect.height * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const timeline = summary && summary.timeline;
  const points = timeline && Array.isArray(timeline.points) ? timeline.points : [];
  const values = points.map(point => Math.max(0, Number(point.tokensPerMinute) || 0));
  const providerNames = points.length > 0 ? Object.keys(points[0].providers || {}) : [];
  const peak = Math.max(1, Number(timeline && timeline.peakTokensPerMinute) || 0, ...values);
  const paddingX = 9;
  const paddingY = 11;
  const graphWidth = Math.max(1, rect.width - paddingX * 2);
  const graphHeight = Math.max(1, rect.height - paddingY * 2);
  const bucketMinutes = Math.max(1 / 60, Number(timeline && timeline.bucketMs) / 60_000 || 1);
  const xAt = index => paddingX + (points.length <= 1 ? graphWidth : index / (points.length - 1) * graphWidth);
  const yAt = value => paddingY + graphHeight - Math.max(0, Math.min(1, value / peak)) * graphHeight;

  const strokeSeries = (series, color, lineWidth, dash = []) => {
    if (!series.length) return;
    context.save();
    context.beginPath();
    series.forEach((value, index) => {
      const x = xAt(index);
      const y = yAt(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.setLineDash(dash);
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.stroke();
    context.restore();
  };

  providerNames.forEach((provider, providerIndex) => {
    const series = points.map(point => Math.max(0, Number(point.providers && point.providers[provider]) || 0) / bucketMinutes);
    strokeSeries(series, providerIndex % 2 === 0 ? 'rgba(61, 190, 108, 0.46)' : 'rgba(129, 255, 168, 0.3)', 1, providerIndex % 2 === 0 ? [5, 4] : [2, 4]);
  });

  if (values.length > 0) {
    context.save();
    context.beginPath();
    values.forEach((value, index) => {
      const x = xAt(index);
      const y = yAt(value);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.lineTo(xAt(values.length - 1), paddingY + graphHeight);
    context.lineTo(xAt(0), paddingY + graphHeight);
    context.closePath();
    const fill = context.createLinearGradient(0, paddingY, 0, paddingY + graphHeight);
    fill.addColorStop(0, 'rgba(82, 255, 142, 0.17)');
    fill.addColorStop(1, 'rgba(12, 204, 104, 0.01)');
    context.fillStyle = fill;
    context.fill();
    context.restore();

    context.save();
    context.shadowColor = 'rgba(96, 255, 151, 0.92)';
    context.shadowBlur = 9;
    strokeSeries(values, 'rgba(116, 255, 167, 0.98)', 1.6);
    context.restore();

    const lastIndex = values.length - 1;
    context.save();
    context.beginPath();
    context.arc(xAt(lastIndex), yAt(values[lastIndex]), 2.4, 0, Math.PI * 2);
    context.fillStyle = 'rgba(175, 255, 202, 1)';
    context.shadowColor = 'rgba(96, 255, 151, 1)';
    context.shadowBlur = 12;
    context.fill();
    context.restore();
  }
}

function renderCrtBilling() {
  const status = document.getElementById('billing-status');
  const refresh = document.getElementById('billing-refresh');
  const empty = document.getElementById('billing-scope-empty');
  const timeline = billingSummary && billingSummary.timeline;
  const hasSignal = Boolean(timeline && Number(timeline.totalTokens) > 0);
  if (status) {
    status.classList.toggle('is-busy', billingLoading);
    status.classList.toggle('is-error', Boolean(billingError));
    status.textContent = billingError
      ? 'TELEMETRY ERROR'
      : billingLoading
        ? (billingSummary ? 'REFRESHING' : 'SCANNING LOGS')
        : billingSummary
          ? (billingMode === 'days' ? 'HISTORY READY' : 'SIGNAL LOCKED')
          : 'STANDBY';
  }
  if (refresh) refresh.disabled = billingLoading;

  const currentRate = document.getElementById('billing-current-rate');
  const windowTotal = document.getElementById('billing-window-total');
  const peakRate = document.getElementById('billing-peak-rate');
  const dutyCycle = document.getElementById('billing-duty-cycle');
  const scopeScale = document.getElementById('billing-scope-scale');
  if (currentRate) currentRate.textContent = formatCrtUsageValue(crtBillingCurrentRate());
  if (windowTotal) windowTotal.textContent = formatCrtUsageValue(timeline && timeline.totalTokens);
  if (peakRate) peakRate.textContent = formatCrtUsageValue(timeline && timeline.peakTokensPerMinute);
  if (dutyCycle) dutyCycle.textContent = timeline ? `${timeline.activeBucketCount}/${timeline.bucketCount}` : '--';
  if (scopeScale) scopeScale.textContent = `${formatCrtUsageValue(timeline && timeline.peakTokensPerMinute)} TOK/MIN PEAK`;
  if (empty) {
    empty.classList.toggle('hidden', hasSignal);
    empty.textContent = billingError ? 'SIGNAL LOST' : billingLoading ? 'ACQUIRING SIGNAL' : 'NO TOKEN SIGNAL';
  }
  setCrtBillingMode(billingMode);
  renderCrtBillingDaily();
  renderCrtBillingQuota();
  renderCrtBillingProviders();
  if (billingCanvasFrame !== null) window.cancelAnimationFrame(billingCanvasFrame);
  billingCanvasFrame = window.requestAnimationFrame(() => {
    billingCanvasFrame = null;
    drawCrtBillingScope();
  });
}

async function loadCrtBilling({ fresh = false } = {}) {
  billingRequestSequence += 1;
  const requestSequence = billingRequestSequence;
  if (billingAbortController) billingAbortController.abort();
  const controller = new window.AbortController();
  billingAbortController = controller;
  billingLoading = true;
  billingError = '';
  renderCrtBilling();
  try {
    const response = await fetch(farmingApiPath(`/usage${fresh ? '?fresh=1' : ''}`), {
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.usage) throw new Error(data && data.error ? data.error : `Usage request failed (${response.status})`);
    if (requestSequence !== billingRequestSequence) return;
    billingSummary = data.usage;
  } catch (error) {
    if (controller.signal.aborted || requestSequence !== billingRequestSequence) return;
    billingError = error instanceof Error ? error.message : 'Failed to load token telemetry';
  } finally {
    if (requestSequence === billingRequestSequence) {
      billingLoading = false;
      billingAbortController = null;
      renderCrtBilling();
      if (!billingError && billingSelectedDate) {
        void loadCrtBillingDayDetail(billingSelectedDate, {
          force: fresh,
          live: crtBillingSelectedDayIsCurrent(),
        });
      }
    }
  }
}

function stopCrtBillingRefresh({ abort = false } = {}) {
  if (billingRefreshTimer !== null) {
    clearInterval(billingRefreshTimer);
    billingRefreshTimer = null;
  }
  if (billingLiveDayRefreshTimer !== null) {
    clearInterval(billingLiveDayRefreshTimer);
    billingLiveDayRefreshTimer = null;
  }
  if (abort && billingAbortController) {
    billingRequestSequence += 1;
    billingAbortController.abort();
    billingAbortController = null;
    billingLoading = false;
  }
  if (abort && billingDayDetailAbortController) {
    billingDayDetailRequestSequence += 1;
    billingDayDetailAbortController.abort();
    billingDayDetailAbortController = null;
    billingDayDetailLoading = false;
  }
  if (abort) {
    cancelCrtBillingDayDetailRetry();
    cancelCrtBillingTotalAnimation();
    cancelCrtBillingMetricAnimations();
  }
}

function startCrtBillingRefresh() {
  stopCrtBillingRefresh();
  billingRefreshTimer = setInterval(() => {
    if (crtMainView === 'billing' && document.visibilityState !== 'hidden') void loadCrtBilling();
  }, CRT_BILLING_REFRESH_MS);
  billingLiveDayRefreshTimer = setInterval(() => {
    if (
      crtMainView !== 'billing'
      || billingMode !== 'days'
      || document.visibilityState === 'hidden'
      || billingDayDetailLoading
      || !crtBillingSelectedDayIsCurrent()
    ) return;
    void loadCrtBillingDayDetail(billingSelectedDate, { force: true, live: true });
  }, CRT_BILLING_LIVE_DAY_REFRESH_MS);
}

function refreshCrtBilling() {
  if (crtMainView !== 'billing' || billingLoading) return;
  void loadCrtBilling({ fresh: true });
}

function showCrtBilling() {
  clearCrtNavigationSelection();
  billingMode = 'days';
  setCrtMainView('billing');
  renderCrtBilling();
  startCrtBillingRefresh();
  void loadCrtBilling({ fresh: true });
  window.requestAnimationFrame(() => {
    const refresh = document.getElementById('billing-refresh');
    const daysTab = document.getElementById('billing-days-tab');
    if (daysTab || refresh) setCrtNavigationSelection(daysTab || refresh);
  });
}

function hideCrtBilling() {
  clearCrtNavigationSelection();
  setCrtMainView('agents');
  renderState();
}

function getCrtHistoryItems() {
  return buildCrtHistoryItems({
    taskHistory: state && Array.isArray(state.taskHistory) ? state.taskHistory : [],
    agents: state && Array.isArray(state.agents) ? state.agents : [],
    sessions: historyAgentSessions,
    mainPageSessionKeys: globalSettings.mainPageSessionKeys
  });
}

function createCrtHistoryMessage(className, text) {
  const message = document.createElement('div');
  message.className = className;
  message.textContent = text;
  return message;
}

function calculateCrtHistoryPageSize(availableHeight, rowHeight = 68) {
  const height = Number(availableHeight);
  const itemHeight = Number(rowHeight);
  if (!Number.isFinite(height) || !Number.isFinite(itemHeight) || height <= 0 || itemHeight <= 0) return 1;
  return Math.max(1, Math.floor(height / itemHeight));
}

function getCrtHistoryPage(items, page, pageSize) {
  const source = Array.isArray(items) ? items : [];
  const size = Math.max(1, Math.floor(Number(pageSize) || 1));
  const totalPages = Math.max(1, Math.ceil(source.length / size));
  const currentPage = Math.max(0, Math.min(totalPages - 1, Math.floor(Number(page) || 0)));
  const start = currentPage * size;
  return {
    items: source.slice(start, start + size),
    page: currentPage,
    pageSize: size,
    totalItems: source.length,
    totalPages,
    start
  };
}

function updateCrtHistoryPagination(pageState) {
  const status = document.getElementById('history-page-status');
  const previous = document.getElementById('history-page-prev');
  const next = document.getElementById('history-page-next');
  if (status) status.textContent = `${pageState.page + 1}/${pageState.totalPages} · ${pageState.totalItems}`;
  if (previous) previous.disabled = pageState.page <= 0;
  if (next) next.disabled = pageState.page >= pageState.totalPages - 1;
}

function renderCrtHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';

  const historyItems = getCrtHistoryItems();
  historyPageSize = calculateCrtHistoryPageSize(list.clientHeight);
  const selectedIndex = historyItems.findIndex((item) => (
    crtNavigationKey === `history:${item.historyKey}`
    || crtNavigationKey === `history:${item.historyKey}:restore`
  ));
  if (selectedIndex >= 0) historyPage = Math.floor(selectedIndex / historyPageSize);
  const pageState = getCrtHistoryPage(historyItems, historyPage, historyPageSize);
  historyPage = pageState.page;
  updateCrtHistoryPagination(pageState);
  if (historyError) list.appendChild(createCrtHistoryMessage('history-error', historyError));
  if (historyLoading && historyItems.length === 0) {
    list.appendChild(createCrtHistoryMessage('history-loading', 'Loading history...'));
    return;
  }
  if (historyItems.length === 0) {
    list.appendChild(createCrtHistoryMessage('history-empty', 'No history yet.'));
    return;
  }

  pageState.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `history-row${historyActionPendingKey === item.historyKey ? ' is-pending' : ''}`;
    row.dataset.crtNavKey = `history:${item.historyKey}`;
    if (index === 0) row.dataset.crtNavDefault = 'true';
    row.tabIndex = -1;
    row.setAttribute('role', 'button');

    const copy = document.createElement('div');
    copy.className = 'history-copy';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = crtHistoryItemTitle(item);
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.textContent = crtHistoryItemMeta(item);
    copy.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'history-actions';
    const age = document.createElement('span');
    age.className = 'history-age';
    age.textContent = formatCrtHistoryAge(item.updatedAt);
    const primary = document.createElement('span');
    primary.className = 'history-action-label';
    primary.textContent = crtHistoryPrimaryAction(item);
    actions.append(age, primary);

    if (item.kind === 'agent') {
      const restoreButton = document.createElement('button');
      restoreButton.type = 'button';
      restoreButton.className = 'history-action';
      restoreButton.dataset.crtNavKey = `history:${item.historyKey}:restore`;
      restoreButton.textContent = 'Restore';
      restoreButton.onclick = (event) => {
        event.stopPropagation();
        void restoreCrtArchivedAgent(item.agent.id, false, item.historyKey);
      };
      actions.appendChild(restoreButton);
    }

    row.append(copy, actions);
    row.onclick = () => void activateCrtHistoryItem(item);
    list.appendChild(row);
  });

  if (crtMainView !== 'history') return;
  if (!restoreCrtNavigationSelection()) {
    const defaultRow = list.querySelector('[data-crt-nav-default="true"]');
    if (defaultRow) setCrtNavigationSelection(defaultRow);
  }
}

function changeCrtHistoryPage(direction) {
  const historyItems = getCrtHistoryItems();
  const current = getCrtHistoryPage(historyItems, historyPage, historyPageSize);
  const nextPage = Math.max(0, Math.min(current.totalPages - 1, current.page + direction));
  if (nextPage === current.page) return false;
  historyPage = nextPage;
  const next = getCrtHistoryPage(historyItems, historyPage, historyPageSize);
  const target = direction > 0 ? next.items[0] : next.items[next.items.length - 1];
  crtNavigationKey = target ? `history:${target.historyKey}` : '';
  renderCrtHistory();
  return true;
}

async function loadCrtHistoryAgentSessions() {
  historyLoading = true;
  historyError = '';
  renderCrtHistory();
  try {
    const response = await fetch(farmingApiPath('/agent-sessions?limit=60&fresh=1'), { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && data.error ? data.error : `History request failed (${response.status})`);
    historyAgentSessions = data && Array.isArray(data.sessions) ? data.sessions : [];
  } catch (error) {
    historyError = error instanceof Error ? error.message : 'Failed to load history';
  } finally {
    historyLoading = false;
    renderCrtHistory();
  }
}

function showHistory() {
  clearCrtNavigationSelection();
  historyPage = 0;
  setCrtMainView('history');
  renderCrtHistory();
  void loadCrtHistoryAgentSessions();
}

function hideHistory() {
  clearCrtNavigationSelection();
  setCrtMainView('agents');
  renderState();
}

async function requestCrtSessionResume(resumed, customTitle = '') {
  const response = await fetch(farmingApiPath(`/agent-sessions/${encodeURIComponent(resumed.provider)}/${encodeURIComponent(resumed.sessionId)}/resume`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      unarchiveArchived: true,
      providerHomeId: resumed.providerHomeId || 'default',
      ...(customTitle ? { customTitle } : {})
    })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.agentId) {
    throw new Error(data && data.error ? data.error : `Failed to resume session (${response.status})`);
  }
  return data.agentId;
}

async function resumeCrtHistorySession(resumed, customTitle, historyKey) {
  if (!resumed || historyActionPendingKey) return;
  historyActionPendingKey = historyKey;
  historyError = '';
  renderCrtHistory();
  try {
    pendingProviderSessionOpenAgentId = await requestCrtSessionResume(resumed, customTitle);
    historyActionPendingKey = '';
    hideHistory();
    openPendingProviderSessionAgentIfReady();
  } catch (error) {
    historyActionPendingKey = '';
    historyError = error instanceof Error ? error.message : 'Failed to resume session';
    renderCrtHistory();
  }
}

async function resumeCrtSearchSession(session, searchKey) {
  const resumed = crtHistoryItemResumeSession({ kind: 'session', session });
  if (!resumed || searchActionPendingKey) return;
  searchActionPendingKey = searchKey;
  searchError = '';
  renderCrtSearch();
  try {
    pendingProviderSessionOpenAgentId = await requestCrtSessionResume(resumed);
    searchActionPendingKey = '';
    hideCrtSearch();
    openPendingProviderSessionAgentIfReady();
  } catch (error) {
    searchActionPendingKey = '';
    searchError = error instanceof Error ? error.message : 'Failed to resume session';
    renderCrtSearch();
  }
}

async function restoreCrtArchivedAgent(agentId, openAfterRestore, historyKey) {
  if (!agentId || historyActionPendingKey) return;
  historyActionPendingKey = historyKey;
  historyError = '';
  renderCrtHistory();
  try {
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agentId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data && data.error ? data.error : `Failed to restore Agent (${response.status})`);
    crtNavigationKey = `agent:${agentId}`;
    if (openAfterRestore) pendingProviderSessionOpenAgentId = agentId;
    historyActionPendingKey = '';
    hideHistory();
    openPendingProviderSessionAgentIfReady();
  } catch (error) {
    historyActionPendingKey = '';
    historyError = error instanceof Error ? error.message : 'Failed to restore Agent';
    renderCrtHistory();
  }
}

function continueCrtHistoryRun(entry) {
  const resumed = crtResumedSessionFromSource(entry.source);
  if (resumed) {
    void resumeCrtHistorySession(resumed, entry.customTitle || '', `run:${entry.id}`);
    return;
  }
  hideHistory();
  showInputDialog({
    command: entry.command || '',
    workspace: entry.projectWorkspace || entry.cwd || '',
    task: entry.task || '',
    workflowTemplate: entry.workflowTemplate || '',
    customTitle: entry.customTitle || ''
  });
}

function activateCrtHistoryItem(item) {
  if (!item || historyActionPendingKey) return;
  if (item.kind === 'run') {
    continueCrtHistoryRun(item.entry);
    return;
  }
  if (item.kind === 'agent') {
    void restoreCrtArchivedAgent(item.agent.id, true, item.historyKey);
    return;
  }
  const resumed = crtHistoryItemResumeSession(item);
  void resumeCrtHistorySession(resumed, '', item.historyKey);
}

function openPendingProviderSessionAgentIfReady() {
  if (!pendingProviderSessionOpenAgentId || !state) return false;
  const agent = state.agents.find((candidate) => candidate.id === pendingProviderSessionOpenAgentId);
  if (!agent || agent.archived === true) return false;
  const agentId = pendingProviderSessionOpenAgentId;
  pendingProviderSessionOpenAgentId = '';
  openSession(agentId);
  return true;
}

function getRememberedWorkspace() {
  return normalizeWorkspaceValue(globalSettings.workspace);
}

function needsMainAgent(currentState = state) {
  const mainAgent = currentState && currentState.mainAgentId
    ? currentState.agents.find((agent) => agent.id === currentState.mainAgentId)
    : null;
  return !currentState || !currentState.mainAgentId || !isCrtLiveAgent(mainAgent);
}

function getDefaultWorkspaceForDialog(asMainAgent) {
  return asMainAgent ? getRememberedWorkspace() : '';
}

function resolveWorkspaceToStart(workspaceInput, asMainAgent) {
  const normalizedInput = normalizeWorkspaceValue(workspaceInput);
  if (normalizedInput) {
    return normalizedInput;
  }

  return asMainAgent ? (getDefaultWorkspaceForDialog(true) || null) : null;
}

function normalizeWorkspaceValue(workspace) {
  return typeof workspace === 'string' ? workspace.trim() : '';
}

function shouldRememberWorkspace(workspace) {
  const value = normalizeWorkspaceValue(workspace);
  return Boolean(value)
    && value !== '/tmp'
    && !value.startsWith('/tmp/')
    && value !== '/private/tmp'
    && !value.startsWith('/private/tmp/')
    && value !== '/var/tmp'
    && !value.startsWith('/var/tmp/')
    && value !== '/private/var/tmp'
    && !value.startsWith('/private/var/tmp/')
    && value !== '/var/folders'
    && !value.startsWith('/var/folders/')
    && value !== '/private/var/folders'
    && !value.startsWith('/private/var/folders/');
}

function buildWorkspaceHistory(workspace, history = []) {
  const merged = [workspace, ...(Array.isArray(history) ? history : [])]
    .map(normalizeWorkspaceValue)
    .filter((entry) => shouldRememberWorkspace(entry));
  const deduped = [];
  const seen = new Set();

  merged.forEach((entry) => {
    if (seen.has(entry)) {
      return;
    }
    seen.add(entry);
    deduped.push(entry);
  });

  return deduped.slice(0, MAX_WORKSPACE_HISTORY);
}

function syncWorkspaceSettings() {
  const history = buildWorkspaceHistory(globalSettings.workspace, globalSettings.workspaceHistory);
  globalSettings.workspaceHistory = history;
  const normalizedWorkspace = normalizeWorkspaceValue(globalSettings.workspace);
  globalSettings.workspace = shouldRememberWorkspace(normalizedWorkspace)
    ? (history[0] || normalizedWorkspace)
    : (history[0] || '');
}

function getWorkspaceHistory() {
  if (!Array.isArray(globalSettings.workspaceHistory)) {
    return [];
  }
  return globalSettings.workspaceHistory;
}

function rememberWorkspace(workspace) {
  if (!shouldRememberWorkspace(workspace)) {
    return;
  }
  const history = buildWorkspaceHistory(workspace, getWorkspaceHistory());
  globalSettings.workspaceHistory = history;
}

function formatWorkspaceForDisplay(workspace) {
  const value = normalizeWorkspaceValue(workspace);
  if (!value) {
    return '~/.farming';
  }

  const homeDir = '/Users/';
  if (value.startsWith(homeDir)) {
    const parts = value.split('/');
    if (parts.length > 3) {
      return `~/${parts.slice(3).join('/')}`;
    }
  }

  return value;
}

function syncWorkspaceHistorySelectionWithInput() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) return;
  const currentValue = normalizeWorkspaceValue(workspaceInput.value);
  workspaceHistorySelection = getWorkspaceHistory().findIndex((entry) => entry === currentValue);
  renderWorkspaceHistoryUI();
}

function resetWorkspaceHistorySelection() {
  workspaceHistorySelection = -1;
  workspaceHistoryExpanded = false;
  renderWorkspaceHistoryUI();
}

function selectWorkspaceHistory(index, { focusInput = true } = {}) {
  const history = getWorkspaceHistory();
  if (!history.length) {
    return false;
  }

  const normalizedIndex = ((index % history.length) + history.length) % history.length;
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) {
    return false;
  }

  workspaceHistorySelection = normalizedIndex;
  workspaceHistoryExpanded = true;
  workspaceInput.value = history[normalizedIndex];
  workspaceInput.placeholder = history[normalizedIndex];
  renderWorkspaceHistoryUI();

  if (focusInput) {
    workspaceInput.focus();
    workspaceInput.setSelectionRange(workspaceInput.value.length, workspaceInput.value.length);
  }

  return true;
}

function moveWorkspaceHistorySelection(direction) {
  const history = getWorkspaceHistory();
  if (!history.length) {
    return false;
  }

  workspaceHistoryExpanded = true;
  const nextIndex = workspaceHistorySelection === -1
    ? (direction > 0 ? 0 : history.length - 1)
    : workspaceHistorySelection + direction;
  return selectWorkspaceHistory(nextIndex);
}

function renderWorkspaceHistoryUI() {
  const wrapper = document.getElementById('workspace-history');
  const list = document.getElementById('workspace-history-list');
  if (!wrapper || !list) return;

  const history = getWorkspaceHistory();
  list.innerHTML = '';

  if (!history.length) {
    wrapper.style.display = 'none';
    return;
  }

  wrapper.style.display = workspaceHistoryExpanded ? 'block' : 'none';

  if (!workspaceHistoryExpanded) {
    return;
  }

  history.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'workspace-history-item';
    item.dataset.crtNavKey = `new-agent:workspace-history:${index}`;
    if (index === workspaceHistorySelection) {
      item.classList.add('active');
    }
    item.innerHTML = `
      <span class="workspace-history-index">[${index + 1}]</span>
      <span class="workspace-history-path">${formatWorkspaceForDisplay(entry)}</span>
      ${index === 0 ? '<span class="workspace-history-badge">latest</span>' : ''}
    `;
    item.onmousedown = (event) => {
      event.preventDefault();
      selectWorkspaceHistory(index);
    };
    list.appendChild(item);
  });
  restoreCrtNavigationSelection();
}

function refreshWorkspaceMemoryUI() {
  renderWorkspaceHistoryUI();
}

function seedWorkspaceInput() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput) return;
  workspaceInput.value = '';
  workspaceInput.placeholder = pendingMainAgentLaunch
    ? formatWorkspaceForDisplay(getDefaultWorkspaceForDialog(true))
    : '/path/to/workspace';
  workspaceHistorySelection = -1;
  workspaceHistoryExpanded = getWorkspaceHistory().length > 0;
  refreshWorkspaceMemoryUI();
}

function setupWorkspaceHistoryControls() {
  const workspaceInput = document.getElementById('workspace-input');
  if (!workspaceInput || workspaceInput.dataset.historyReady === 'true') {
    return;
  }

  workspaceInput.dataset.historyReady = 'true';

  workspaceInput.addEventListener('focus', () => {
    syncWorkspaceHistorySelectionWithInput();
  });

  workspaceInput.addEventListener('input', () => {
    syncWorkspaceHistorySelectionWithInput();
    if (!workspaceInput.value.trim()) {
      workspaceHistorySelection = -1;
    }
    workspaceHistoryExpanded = false;
    renderWorkspaceHistoryUI();
  });

  workspaceInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      if (moveWorkspaceHistorySelection(1)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      if (moveWorkspaceHistorySelection(-1)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      confirmStartAgent();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      backToAgentList();
    }
  });
}

async function confirmStartAgent() {
  if (waitingForAgent || selectedAgentIndex === null || selectedAgentIndex < 0 || selectedAgentIndex >= agents.length) return;

  const agent = agents[selectedAgentIndex];
  const workspaceInput = normalizeWorkspaceValue(document.getElementById('workspace-input').value);
  const asMainAgent = pendingMainAgentLaunch;
  const workspaceToUse = resolveWorkspaceToStart(workspaceInput, asMainAgent);

  console.log('Starting agent:', agent.name, 'workspace:', workspaceToUse || 'default');

  waitingForAgent = true;
  const previousHistory = JSON.stringify(getWorkspaceHistory());
  if (workspaceToUse) {
    rememberWorkspace(workspaceToUse);
  }
  if (JSON.stringify(getWorkspaceHistory()) !== previousHistory) {
    refreshWorkspaceMemoryUI();
    await saveGlobalSettings();
  }

  ws.send(JSON.stringify({
    type: 'start-agent',
    command: agent.name,
    workspace: workspaceToUse,
    asMain: asMainAgent,
    ...(pendingAgentLaunchPrefill && pendingAgentLaunchPrefill.task
      ? { task: pendingAgentLaunchPrefill.task }
      : {}),
    ...(pendingAgentLaunchPrefill && pendingAgentLaunchPrefill.workflowTemplate
      ? { workflowTemplate: pendingAgentLaunchPrefill.workflowTemplate }
      : {}),
    ...(pendingAgentLaunchPrefill && pendingAgentLaunchPrefill.customTitle
      ? { customTitle: pendingAgentLaunchPrefill.customTitle }
      : {})
  }));
}

function backToAgentList() {
  clearCrtNavigationSelection();
  selectedAgentIndex = null;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  resetWorkspaceHistorySelection();
  selectDefaultNewAgentNavigation();
}

function selectAgent(index) {
  if (index < 0 || index >= agents.length) return;

  const agent = agents[index];

  console.log('Selected agent:', agent.name);
  clearCrtNavigationSelection();
  selectedAgentIndex = index;

  if (pendingMainAgentLaunch) {
    document.getElementById('agent-list').style.display = 'none';
    document.getElementById('workspace-input-container').style.display = 'none';

    setTimeout(() => {
      confirmStartAgent();
    }, 100);
  } else {
    document.getElementById('agent-list').style.display = 'none';
    document.getElementById('workspace-input-container').style.display = 'block';
    seedWorkspaceInput();
    const workspaceInput = document.getElementById('workspace-input');
    workspaceInput.focus();
    workspaceInput.setSelectionRange(workspaceInput.value.length, workspaceInput.value.length);
  }
}

function requestedCrtAgentId(search = typeof window !== 'undefined' ? window.location.search : '') {
  return new globalThis.URLSearchParams(search).get('agent') || '';
}

function openCrtAgentDeeplinkIfReady() {
  if (didApplyAgentDeeplink || !state) return false;
  didApplyAgentDeeplink = true;
  crtReadingAnchorApi()?.importFromSearch(window.location.search);

  const agentId = requestedCrtAgentId();
  const agent = agentId
    ? state.agents.find((candidate) => candidate.id === agentId && isCrtLiveAgent(candidate))
    : null;
  if (!agent) return false;

  openSession(agent.id);
  return true;
}

function connect() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  loadThemes();
  loadGlobalSettings();

  const socket = new WebSocket(farmingWebSocketUrl());
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    console.log('Connected to server');
    socket.send(JSON.stringify({ type: 'protocol-hello', protocolVersion: CRT_PROTOCOL_VERSION }));
    const activeAgentId = isCrtSessionOpen() ? focusedAgentId : null;
    getSessionClient()?.focusAgent(activeAgentId, {
      streamScope: 'focused',
      previewScope: activeAgentId ? 'none' : 'all',
    });
    if (activeAgentId && terminal) {
      if (crtTerminalReplication) {
        clearPendingCrtTerminalFitResize(crtTerminalReplication);
        crtTerminalReplication.lastResizeCols = null;
        crtTerminalReplication.lastResizeRows = null;
        if (crtTerminalReplication.checkpointRetryTimer) {
          clearTimeout(crtTerminalReplication.checkpointRetryTimer);
          crtTerminalReplication.checkpointRetryTimer = null;
        }
        TERMINAL_REPLAY.resetRecovery(crtTerminalReplication.replayState);
        TERMINAL_REPLAY.beginRecovery(crtTerminalReplication.replayState);
        requestCrtTerminalReplay();
      }
    }
    loadAgents();
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    const data = JSON.parse(event.data);
    if (data.type === 'protocol-hello') {
      if (data.protocolVersion !== CRT_PROTOCOL_VERSION) {
        socket.close(4002, `Unsupported Farming protocol version ${data.protocolVersion}`);
      }
      return;
    }
    if (data.type === 'protocol-error') {
      console.error(data.message || 'Farming protocol error');
      return;
    }
    if (data.type === 'state') {
      const prevAgentCount = state ? state.agents.length : 0;
      state = data.state;
      pruneCrtStructuredPreviews(state);
      const activeAgentIds = new Set(state.agents.map((agent) => agent.id));
      terminalPreviewSnapshots.forEach((_snapshot, agentId) => {
        if (!activeAgentIds.has(agentId)) terminalPreviewSnapshots.delete(agentId);
      });
      state.agents.forEach((agent) => {
        if (terminalPreviewSnapshots.has(agent.id)) {
          agent.previewSnapshot = terminalPreviewSnapshots.get(agent.id);
        }
      });
      const dashboardRendered = renderCrtDashboardIfNeeded();
      scheduleCrtRenderedStructuredPreviews();
      if (dashboardRendered && crtMainView === 'history') renderCrtHistory();
      if (crtMainView === 'search') renderCrtSearch();
      generateKeyMap();
      checkMainAgentStatus();

      if (waitingForAgent && state.agents.length > prevAgentCount) {
        waitingForAgent = false;
        hideInputDialog();
      }
      openPendingProviderSessionAgentIfReady();
      openPendingRuntimeSwitchAgentIfReady();
      if (focusedAgentId) {
        const focusedAgent = state.agents.find((agent) => agent.id === focusedAgentId);
        updateCrtRuntimeSwitchControl(focusedAgent);
        if (focusedAgent && isStructuredRuntimeAgent(focusedAgent)) {
          updateStructuredComposerState(focusedAgent);
        }
      }
      const runtime = getSessionRuntime();
      if (runtime) {
        const sessionState = runtime.handleStateMessage(state);
        focusedAgentId = sessionState.focusedAgentId;
      }
      openCrtAgentDeeplinkIfReady();
    } else if (data.type === 'agent-started') {
      selectCrtStartedAgent(data.agentId);
    } else if (data.type === 'agent-update') {
      const update = data.update;
      const agent = update && state && state.agents.find(candidate => candidate.id === update.agentId);
      if (agent && update.patch && typeof update.patch === 'object') {
        Object.assign(agent, update.patch);
        renderCrtDashboardIfNeeded();
        if (agent.id === focusedAgentId) updateCrtRuntimeSwitchControl(agent);
      }
    } else if (data.type === 'session-preview') {
      const preview = data.preview;
      if (preview && preview.agentId) {
        terminalPreviewSnapshots.set(preview.agentId, preview.previewSnapshot || null);
        const agent = state && state.agents.find((candidate) => candidate.id === preview.agentId);
        if (agent) {
          const previousSnapshot = agent.previewSnapshot;
          const previousText = getAgentDisplayText(agent);
          const previewChanged = typeof preview.previewText === 'string'
            && preview.previewText !== agent.previewText;
          agent.previewText = preview.previewText || agent.previewText;
          agent.previewCols = preview.cols || agent.previewCols;
          agent.previewRows = preview.rows || agent.previewRows;
          agent.previewSnapshot = preview.previewSnapshot || null;
          if (preview.terminalStatus) agent.terminalStatus = preview.terminalStatus;
          if (preview.runtimeObservation) agent.runtimeObservation = preview.runtimeObservation;
          if (isCrtSessionOpen()) dashboardRenderDeferred = true;
          else scheduleCrtPreviewCardRender(agent, previousSnapshot, previousText, previewChanged);
        }
      }
    } else if (data.type === 'session-output') {
      if (crtTerminalReplication) {
        handleCrtTerminalStream(data.stream);
        return;
      }
      const runtime = getSessionRuntime();
      const sessionToken = runtime ? runtime.getSessionToken() : 0;
      const runtimeResult = runtime ? runtime.handleStreamMessage(data.stream) : null;
      const patch = runtimeResult
        ? runtimeResult.patch
        : deriveSessionStreamPatch(data.stream, focusedAgentId, getActiveSessionSource());
      const shouldApply = runtime
        ? runtime.isCurrentSession(runtimeResult.focusedAgentId, sessionToken)
        : Boolean(focusedAgentId && focusedAgentId === data.stream.agentId);
      if (patch && terminal && shouldApply) {
        terminal.write(patch.text);
        refreshSessionTerminalUi({ preserveSearchIndex: true });
        if (runtimeResult) {
          focusedAgentId = runtimeResult.focusedAgentId;
        } else if (focusedAgentId) {
          setSessionOutputLength(getSessionOutputLength() + patch.nextLengthDelta);
        }
      }
    } else if (data.type === 'agent-activity') {
      const activity = data.activity;
      const agent = activity && state && state.agents.find((candidate) => candidate.id === activity.agentId);
      if (agent) {
        Object.assign(agent, activity);
        renderCrtDashboardIfNeeded();
      }
    } else if (data.type === 'system-stats') {
      updateSystemStats(data.stats, data.uptime, data.usageRate);
    } else if (data.type === 'error') {
      waitingForAgent = false;
      alert('Error: ' + data.message);
    }
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    console.log('Disconnected from server');
    if (crtTerminalReplication) {
      clearPendingCrtTerminalFitResize(crtTerminalReplication);
      crtTerminalReplication.lastResizeCols = null;
      crtTerminalReplication.lastResizeRows = null;
      crtTerminalReplication.checkpointSeq += 1;
      crtTerminalReplication.checkpointAbortController?.abort();
      crtTerminalReplication.checkpointAbortController = null;
      crtTerminalReplication.checkpointInFlight = false;
      if (crtTerminalReplication.checkpointRetryTimer) {
        clearTimeout(crtTerminalReplication.checkpointRetryTimer);
        crtTerminalReplication.checkpointRetryTimer = null;
      }
      TERMINAL_REPLAY.resetRecovery(crtTerminalReplication.replayState);
      TERMINAL_REPLAY.beginRecovery(crtTerminalReplication.replayState);
    }
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        connect();
      }, 1000);
    }
  };

  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    socket.close();
  };
}

function suspendCrtPageConnection() {
  document.body.classList.add('page-hidden');
  stopCrtBillingRefresh({ abort: true });
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const socket = ws;
  ws = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}

function resumeCrtPageConnection() {
  if (document.visibilityState === 'hidden') return;
  document.body.classList.remove('page-hidden');
  connect();
  if (crtMainView === 'billing') {
    startCrtBillingRefresh();
    void loadCrtBilling();
  }
}

function checkMainAgentStatus() {
  if (!state) return;

  const mainAgent = state.mainAgentId
    ? state.agents.find(a => a.id === state.mainAgentId)
    : null;

  if (!state.mainAgentId || !isCrtLiveAgent(mainAgent)) {
    showInputDialog();
  }
}

function formatSystemClock(timestamp, timeZone) {
  if (!Number.isFinite(timestamp)) return '--';
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString(undefined, { hour12: false });
  }
}

function formatCrtTokenRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) return '--';
  const rounded = rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate);
  if (rounded >= 1_000_000) {
    const compact = rounded / 1_000_000;
    return `~${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}M`;
  }
  if (rounded >= 1_000) {
    const compact = rounded / 1_000;
    return `~${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}K`;
  }
  return `~${rounded}`;
}

function updateSystemStats(stats, uptime, usageRate) {
  if (stats.cpu !== undefined) {
    document.getElementById('cpu-usage').textContent = stats.cpu;
  }

  if (stats.memory) {
    document.getElementById('mem-percentage').textContent = stats.memory.percentage;
  }

  if (stats.ip) {
    document.getElementById('system-ip').textContent = stats.ip;
  }

  if (stats.timestamp !== undefined) {
    document.getElementById('system-time').textContent = formatSystemClock(stats.timestamp, stats.timeZone);
  }

  const tokensPerMinute = document.getElementById('tokens-per-minute');
  if (tokensPerMinute) {
    tokensPerMinute.textContent = formatCrtTokenRate(usageRate && usageRate.estimatedTokensPerMinute);
  }

  if (uptime !== undefined) {
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    let uptimeStr = '';
    if (hours > 0) {
      uptimeStr = `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      uptimeStr = `${minutes}m ${seconds}s`;
    } else {
      uptimeStr = `${seconds}s`;
    }

    document.getElementById('uptime').textContent = uptimeStr;
  }
}

function isCrtLiveAgent(agent) {
  return Boolean(
    agent
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
  );
}

function getCrtLiveAgents(currentState = state) {
  if (!currentState || !Array.isArray(currentState.agents)) return [];
  return currentState.agents.filter(isCrtLiveAgent);
}

function getCrtRegularAgents(currentState = state) {
  if (!currentState || !Array.isArray(currentState.agents)) return [];
  return getCrtLiveAgents(currentState).filter((agent) => (
    agent.id !== currentState.mainAgentId && agent.isMain !== true
  ));
}

function getCrtAgentRemovalFallback(currentState, removedAgentId) {
  const liveAgents = getCrtLiveAgents(currentState);
  const removedIndex = liveAgents.findIndex((agent) => agent.id === removedAgentId);
  const remaining = liveAgents.filter((agent) => agent.id !== removedAgentId);
  if (!remaining.length) return '';
  if (removedIndex < 0) return remaining[0].id;
  return remaining[Math.min(removedIndex, remaining.length - 1)].id;
}

function updateCrtAgentPageStatus(pageState) {
  const item = document.getElementById('agent-page-item');
  const status = document.getElementById('agent-page-status');
  if (item) item.hidden = pageState.totalPages <= 1;
  if (status) status.textContent = `${pageState.page + 1}/${pageState.totalPages}`;
}

function isCrtAgentOnCurrentPage(agentId) {
  const regularAgents = getCrtRegularAgents();
  const index = regularAgents.findIndex((agent) => agent.id === agentId);
  if (index < 0) return false;
  const start = crtAgentPage * crtAgentPageSize;
  return index >= start && index < start + crtAgentPageSize;
}

function moveCrtAgentPageSelection(key) {
  if (crtMainView !== 'agents' || (key !== 'ArrowUp' && key !== 'ArrowDown')) return false;
  const selected = document.querySelector('#map-area .agent-block.crt-nav-selected[data-agent-id]');
  if (!selected) return false;
  const regularAgents = getCrtRegularAgents();
  const itemIndex = regularAgents.findIndex((agent) => agent.id === selected.dataset.agentId);
  const targetIndex = getCrtAgentVerticalPageTarget({
    itemIndex,
    totalItems: regularAgents.length,
    pageSize: crtAgentPageSize,
    columns: crtAgentPageColumns,
    key,
  });
  if (targetIndex < 0) return false;
  crtNavigationKey = `agent:${regularAgents[targetIndex].id}`;
  crtAgentPage = Math.floor(targetIndex / crtAgentPageSize);
  renderState();
  return restoreCrtNavigationSelection();
}

function renderState() {
  if (!state) return;
  lastCrtDashboardSignature = crtDashboardStateSignature(state);

  // 更新吊顶的 Agent 数量
  const visibleAgents = getCrtLiveAgents(state);
  const activeAgents = visibleAgents.filter(a => a.status === 'running').length;
  const totalAgents = visibleAgents.length;
  document.getElementById('active-agents').textContent = activeAgents;
  document.getElementById('total-agents').textContent = totalAgents;
  updateCrtBrandState(state);

  const mapArea = document.getElementById('map-area');
  const emptyState = document.getElementById('empty-state');
  const mainAgentPanel = document.getElementById('main-agent-panel');
  const mainAgentBlock = document.getElementById('main-agent-block');

  const agentBlocks = mapArea.querySelectorAll('.agent-block');
  agentBlocks.forEach(block => block.remove());

  mainAgentBlock.innerHTML = '';
  mainAgentBlock.removeAttribute('data-agent-id');
  mainAgentBlock.removeAttribute('data-crt-nav-key');

  if (visibleAgents.length === 0) {
    emptyState.style.display = 'flex';
    mainAgentPanel.style.display = 'none';
    updateCrtAgentPageStatus(getCrtAgentPage([], 0, 1));
    showInputDialog();
    return;
  }

  emptyState.style.display = 'none';

  const regularAgents = getCrtRegularAgents(state);
  const pageLayout = calculateCrtAgentPageLayout(
    mapArea.clientWidth,
    mapArea.clientHeight,
    regularAgents.length,
  );
  crtAgentPageSize = pageLayout.pageSize;
  crtAgentPageColumns = pageLayout.columns;
  const selectedRegularAgentIndex = regularAgents.findIndex((agent) => (
    crtNavigationKey === `agent:${agent.id}`
  ));
  if (selectedRegularAgentIndex >= 0) {
    crtAgentPage = Math.floor(selectedRegularAgentIndex / crtAgentPageSize);
  }
  const agentPage = getCrtAgentPage(regularAgents, crtAgentPage, crtAgentPageSize);
  crtAgentPage = agentPage.page;
  updateCrtAgentPageStatus(agentPage);
  mapArea.style.setProperty('--crt-agent-page-columns', String(pageLayout.columns));
  mapArea.style.setProperty('--crt-agent-page-rows', String(pageLayout.rows));

  // 渲染 Main Agent 到右下角
  if (state.mainAgentId) {
    const mainAgent = state.agents.find(a => a.id === state.mainAgentId);
    if (isCrtLiveAgent(mainAgent)) {
      mainAgentPanel.style.display = 'block';
      mainAgentBlock.dataset.crtNavKey = `agent:${mainAgent.id}`;
      mainAgentBlock.dataset.agentId = mainAgent.id;
      mainAgentBlock.tabIndex = -1;
      mainAgentBlock.setAttribute('role', 'button');

      const header = document.createElement('div');
      header.className = 'agent-header';
      header.textContent = getCrtAgentTitle(mainAgent);
      mainAgentBlock.appendChild(header);

      const status = document.createElement('div');
      status.className = 'agent-status';
      status.textContent = `${mainAgent.status} | ${mainAgent.activityLevel}`;
      mainAgentBlock.appendChild(status);

      const output = document.createElement('div');
      output.className = 'agent-output';
      output.style.height = '80px';
      renderCrtAgentOutput(output, mainAgent, { main: true });
      mainAgentBlock.appendChild(output);

      mainAgentBlock.onclick = () => openSession(mainAgent.id);
    } else {
      mainAgentPanel.style.display = 'none';
    }
  } else {
    mainAgentPanel.style.display = 'none';
  }

  // 渲染其他普通 agents 到地图
  agentPage.items.forEach((agent, pageItemIndex) => {
    const keyIndex = agentPage.start + pageItemIndex + 1;

    const block = document.createElement('div');
    const activityClass = globalSettings.crtDynamicHeatEnabled === true ? agent.activityLevel : '';
    block.className = `agent-block ${activityClass} ${agent.status} ${isCrtAgentWorking(agent) ? 'working' : ''} ${agent.unread === true ? 'unread' : ''}`;
    block.dataset.agentId = agent.id;
    block.dataset.crtNavKey = `agent:${agent.id}`;
    if (keyIndex === 1) block.dataset.crtNavDefault = 'true';
    block.tabIndex = -1;
    block.setAttribute('role', 'button');

    const keyHint = document.createElement('div');
    keyHint.className = 'key-hint';
    keyHint.textContent = `[${keyIndex}]`;
    block.appendChild(keyHint);

    const header = document.createElement('div');
    header.className = 'agent-header';
    header.textContent = getCrtAgentTitle(agent);
    header.title = getCrtAgentTitle(agent);
    block.appendChild(header);

    const status = document.createElement('div');
    status.className = 'agent-status';
    const projectName = getCrtProjectName(agent);
    status.textContent = [agent.status, agent.activityLevel, projectName].filter(Boolean).join(' | ');
    status.title = agent.projectWorkspace || agent.cwd || '';
    block.appendChild(status);

    const output = document.createElement('div');
    output.className = 'agent-output';
    renderCrtAgentOutput(output, agent);
    block.appendChild(output);

    block.onclick = () => openSession(agent.id);

    mapArea.appendChild(block);
  });
  restoreCrtNavigationSelection();
}

function generateKeyMap() {
  if (!state) return;

  keyMap = {};
  let keyIndex = 1;
  getCrtRegularAgents(state).forEach((agent) => {
    keyMap[keyIndex] = agent.id;
    keyIndex++;
  });
}

function showInputDialog(prefill = null) {
  clearCrtNavigationSelection();
  void loadAgents();
  const title = document.getElementById('dialog-title');
  const cancelButtonContainer = document.getElementById('cancel-button-container');
  const needMainAgent = needsMainAgent();
  pendingMainAgentLaunch = needMainAgent;
  pendingAgentLaunchPrefill = prefill && typeof prefill === 'object' ? prefill : null;

  if (needMainAgent) {
    title.textContent = 'Start Main Agent';
    cancelButtonContainer.style.display = 'none';
  } else {
    title.textContent = 'Start New Agent';
    cancelButtonContainer.style.display = 'block';
  }

  selectedAgentIndex = null;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  document.getElementById('map-area').classList.add('hidden');
  document.getElementById('input-dialog').classList.add('active');
  resetWorkspaceHistorySelection();
  refreshWorkspaceMemoryUI();
  if (pendingAgentLaunchPrefill && !needMainAgent) {
    const requestedProgram = crtCommandProgram(pendingAgentLaunchPrefill.command || '');
    const requestedAgentIndex = agents.findIndex((agent) => crtCommandProgram(agent.name || '') === requestedProgram);
    if (requestedAgentIndex >= 0) {
      selectAgent(requestedAgentIndex);
      const workspaceInput = document.getElementById('workspace-input');
      workspaceInput.value = normalizeWorkspaceValue(pendingAgentLaunchPrefill.workspace);
      workspaceInput.placeholder = workspaceInput.value || '/path/to/workspace';
      workspaceInput.setSelectionRange(workspaceInput.value.length, workspaceInput.value.length);
      return;
    }
  }
  selectDefaultNewAgentNavigation();
}

function hideInputDialog() {
  const needMainAgent = needsMainAgent();

  if (needMainAgent) {
    return;
  }

  selectedAgentIndex = null;
  clearCrtNavigationSelection();
  pendingMainAgentLaunch = false;
  pendingAgentLaunchPrefill = null;
  waitingForAgent = false;
  document.getElementById('agent-list').style.display = 'block';
  document.getElementById('workspace-input-container').style.display = 'none';
  document.getElementById('input-dialog').classList.remove('active');
  document.getElementById('map-area').classList.toggle('hidden', crtMainView !== 'agents');
  resetWorkspaceHistorySelection();
}

function selectCrtStartedAgent(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (!normalizedAgentId) return false;
  waitingForAgent = false;
  hideInputDialog();
  crtNavigationKey = `agent:${normalizedAgentId}`;
  return restoreCrtNavigationSelection();
}

function isCrtAgentInteractive(agent) {
  return Boolean(agent && (agent.status === 'running' || agent.status === 'pending'));
}

function structuredRuntimeKind(agent) {
  const kind = agent && agent.runtimeBinding && agent.runtimeBinding.kind;
  if (kind === 'acp') return 'ACP';
  if (kind === 'json') return 'JSON';
  if (kind === 'app-server') return 'APP SERVER';
  return '';
}

function isStructuredRuntimeAgent(agent) {
  return Boolean(structuredRuntimeKind(agent));
}

function crtRuntimeView(agent) {
  return isStructuredRuntimeAgent(agent) ? 'chat' : 'terminal';
}

function canSwitchCrtAgentRuntime(agent) {
  const freshCodexTerminal = agent
    && agent.providerSessionProvider === 'codex'
    && agent.runtimeBinding?.kind === 'terminal'
    && agent.providerSessionTemporary === true
    && agent.terminalInputReceived !== true;
  return Boolean(
    agent
    && ['codex', 'claude', 'opencode', 'qoder'].includes(agent.providerSessionProvider || '')
    && (agent.providerSessionTemporary !== true || freshCodexTerminal)
    && String(agent.providerSessionId || '').trim()
  );
}

function isCrtRuntimeSwitchShortcut(event) {
  return Boolean(
    event
    && event.altKey
    && !event.ctrlKey
    && !event.shiftKey
    && !event.metaKey
    && (event.code === 'KeyM' || String(event.key || '').toLowerCase() === 'm')
  );
}

function hasCrtStructuredLocalEscapeAction(context = {}) {
  return Boolean(
    context.structuredTranscriptFocused
    || context.structuredToolFocused
    || context.structuredMenuItemFocused
    || context.structuredInterruptFocused
    || (context.structuredInputFocused && context.structuredComposerMenuOpen)
  );
}

function resolveCrtSessionKeyboardCommand(event, context = {}) {
  if (!event) return '';
  const key = String(event.key || '').toLowerCase();
  const primaryModifier = Boolean(event.ctrlKey || event.metaKey);

  // Session-wide commands must remain reachable from every focus owner,
  // including the hidden Terminal IME bridge and every structured Chat control.
  if (primaryModifier && key === 'k') return 'kill';
  if (primaryModifier && key === 'escape') return 'close';

  // Plain Escape closes an idle Chat only when a more local transition does
  // not own it. Terminal keeps plain Escape for the running TUI.
  if (
    context.structuredSessionActive === true
    && key === 'escape'
    && !event.altKey
    && !event.shiftKey
    && event.isComposing !== true
    && context.composing !== true
    && !hasCrtStructuredLocalEscapeAction(context)
  ) {
    return 'close';
  }

  return '';
}

function setCrtRuntimeSwitchStatus(message = '', error = false) {
  const status = document.getElementById('crt-runtime-switch-status');
  const messageNode = document.getElementById('crt-runtime-switch-message');
  if (!status || !messageNode) return;
  status.hidden = !message;
  status.classList.toggle('error', Boolean(error));
  messageNode.textContent = message;
}

function updateCrtRuntimeSwitchControl(agent) {
  const control = document.getElementById('crt-runtime-toggle');
  const chatButton = document.getElementById('crt-runtime-chat');
  const terminalButton = document.getElementById('crt-runtime-terminal');
  if (!control || !chatButton || !terminalButton) return;
  const supported = canSwitchCrtAgentRuntime(agent);
  const view = crtRuntimeView(agent);
  control.hidden = !supported;
  control.setAttribute('aria-busy', runtimeSwitchPending ? 'true' : 'false');
  chatButton.disabled = !supported || runtimeSwitchPending;
  terminalButton.disabled = !supported || runtimeSwitchPending;
  chatButton.classList.toggle('active', view === 'chat');
  terminalButton.classList.toggle('active', view === 'terminal');
  chatButton.setAttribute('aria-pressed', view === 'chat' ? 'true' : 'false');
  terminalButton.setAttribute('aria-pressed', view === 'terminal' ? 'true' : 'false');
}

function updateCrtSessionCloseControl(agent) {
  const closeButton = document.querySelector('#session-modal .close-btn');
  if (!closeButton) return;
  const chat = isStructuredRuntimeAgent(agent);
  closeButton.textContent = chat ? 'CLOSE [ESC]' : 'CLOSE [CTRL+ESC]';
  closeButton.setAttribute('aria-label', chat
    ? 'Close session, Escape'
    : 'Close session, Ctrl+Escape');
}

function resetCrtRuntimeSwitchState(cancelRequest = true) {
  if (cancelRequest) runtimeSwitchRequestSequence += 1;
  runtimeSwitchPending = false;
  pendingRuntimeSwitchAgentId = '';
  setCrtRuntimeSwitchStatus('');
}

function openPendingRuntimeSwitchAgentIfReady() {
  if (!pendingRuntimeSwitchAgentId || !state) return false;
  const agent = state.agents.find((candidate) => candidate.id === pendingRuntimeSwitchAgentId);
  if (!agent || agent.archived === true) return false;
  const agentId = pendingRuntimeSwitchAgentId;
  resetCrtRuntimeSwitchState(false);
  openSession(agentId);
  return true;
}

async function switchCrtSessionRuntimeMode(mode) {
  if (runtimeSwitchPending || !focusedAgentId || !state) return;
  const agent = state.agents.find((candidate) => candidate.id === focusedAgentId);
  if (!canSwitchCrtAgentRuntime(agent)) return;
  const targetMode = mode === 'terminal' ? 'terminal' : 'acp';
  if (crtRuntimeView(agent) === (targetMode === 'terminal' ? 'terminal' : 'chat')) return;

  const requestSequence = ++runtimeSwitchRequestSequence;
  runtimeSwitchPending = true;
  updateCrtRuntimeSwitchControl(agent);
  setCrtRuntimeSwitchStatus('RESTARTING AGENT...');
  try {
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agent.id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentRuntimeMode: targetMode })
    });
    const data = await response.json().catch(() => null);
    if (requestSequence !== runtimeSwitchRequestSequence) return;
    if (!response.ok || !data) {
      throw new Error(data && data.error ? data.error : `Failed to switch Agent runtime (${response.status})`);
    }
    pendingRuntimeSwitchAgentId = data.restartedAgentId || agent.id;
    setCrtRuntimeSwitchStatus('RESTORING SESSION...');
    openPendingRuntimeSwitchAgentIfReady();
  } catch (error) {
    if (requestSequence !== runtimeSwitchRequestSequence) return;
    runtimeSwitchPending = false;
    pendingRuntimeSwitchAgentId = '';
    updateCrtRuntimeSwitchControl(state.agents.find((candidate) => candidate.id === focusedAgentId));
    setCrtRuntimeSwitchStatus(error && error.message ? error.message : 'Failed to switch Agent runtime', true);
  }
}

function toggleCrtSessionRuntimeMode() {
  if (!focusedAgentId || !state) return;
  const agent = state.agents.find((candidate) => candidate.id === focusedAgentId);
  if (!canSwitchCrtAgentRuntime(agent)) return;
  void switchCrtSessionRuntimeMode(crtRuntimeView(agent) === 'chat' ? 'terminal' : 'acp');
}

function structuredTranscriptEndpoint(agent) {
  if (agent.runtimeBinding.kind === 'acp') return 'acp-transcript';
  if (agent.runtimeBinding.kind === 'json') return 'json-cli-transcript';
  return 'codex-app-server-transcript';
}

function structuredRuntimeStatus(agent) {
  if (!agent) return '';
  return agent.runtimeBinding?.state || 'idle';
}

function structuredRuntimeError(agent) {
  if (!agent) return '';
  return agent.runtimeBinding?.error || '';
}

function structuredComposerAction(agent, draft = '') {
  if (!isCrtAgentInteractive(agent) || structuredRuntimeError(agent)) return 'disabled';
  if (structuredComposerAttachments.some(item => item.status === 'uploading')) return 'disabled';
  const status = String(structuredRuntimeStatus(agent) || 'idle');
  const working = ['working', 'waiting-for-permission'].includes(status);
  if (working) {
    if (agent.runtimeBinding?.kind === 'acp' && String(draft || '').trim()) return 'send';
    if (agent.runtimeBinding?.kind === 'app-server' && String(draft || '').trim()) return 'steer';
    return 'interrupt';
  }
  if (['starting', 'interrupting'].includes(status)) return 'disabled';
  return String(draft || '').trim() || structuredComposerAttachments.some(item => item.status === 'ready')
    ? 'send'
    : 'disabled';
}

function queueStructuredComposerFollowUp(agentId, message) {
  const queue = structuredComposerPendingFollowUps.get(agentId) || [];
  queue.push(message);
  structuredComposerPendingFollowUps.set(agentId, queue);
}

function flushStructuredComposerFollowUp(agent) {
  if (!agent || structuredRuntimeStatus(agent) !== 'idle') return;
  const queue = structuredComposerPendingFollowUps.get(agent.id);
  if (!queue || queue.length === 0) return;
  const message = queue.shift();
  if (queue.length === 0) structuredComposerPendingFollowUps.delete(agent.id);
  if (!getSessionClient()?.sendComposerMessage(agent.id, message)) {
    queue.unshift(message);
    structuredComposerPendingFollowUps.set(agent.id, queue);
    return;
  }
  setTimeout(() => void refreshStructuredSession(agent.id, true), 160);
}

function formatStructuredUsage(session) {
  const tokens = Number(session && session.usage && session.usage.totalTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  return `${Math.round(tokens / 1000)}K TOK`;
}

function structuredSelectOptions(option) {
  if (!option || !Array.isArray(option.options)) return [];
  return option.options.flatMap((candidate) => (
    candidate && Array.isArray(candidate.options) ? candidate.options : [candidate]
  )).filter(Boolean);
}

function structuredVisibleConfigOptions(session) {
  const options = session && Array.isArray(session.configOptions) ? session.configOptions : [];
  return options.filter((option) => (
    String(option && option.id || '').toLowerCase() !== 'mode'
    && String(option && option.category || '').toLowerCase() !== 'mode'
  ));
}

function currentStructuredConfigLabel(session) {
  const options = structuredVisibleConfigOptions(session);
  const model = options.find((option) => option.type === 'select' && /(^|[\s_-])model([\s_-]|$)/i.test(`${option.id} ${option.name}`));
  if (!model) return 'CONFIG';
  const selected = structuredSelectOptions(model).find((option) => option.value === model.currentValue);
  return selected && selected.name ? selected.name : model.currentValue || 'CONFIG';
}

function structuredConfigValueLabel(option) {
  if (!option) return '';
  if (option.type === 'boolean') return option.currentValue ? 'ON' : 'OFF';
  const selected = structuredSelectOptions(option)
    .find((candidate) => candidate.value === option.currentValue);
  return selected && selected.name ? selected.name : String(option.currentValue || '');
}

function resetStructuredSessionControls() {
  structuredSessionSnapshot = null;
  structuredSessionControlsLoading = false;
  structuredSessionControlsRevision = '';
  structuredComposerMenu = '';
  structuredComposerMenuOpenerId = '';
  structuredComposerMenuFocusPending = false;
  structuredComposerConfigId = '';
  const menu = document.getElementById('crt-structured-composer-menu');
  const commandButton = document.getElementById('crt-structured-command');
  const modeButton = document.getElementById('crt-structured-mode');
  const configButton = document.getElementById('crt-structured-config');
  const usage = document.getElementById('crt-structured-composer-usage');
  if (menu) {
    menu.hidden = true;
    menu.replaceChildren();
  }
  if (commandButton) commandButton.hidden = true;
  if (modeButton) modeButton.hidden = true;
  if (configButton) configButton.hidden = true;
  if (usage) usage.textContent = '';
}

function setStructuredComposerMenu(menu, { focusFirst = false, opener = null } = {}) {
  if (opener && opener.id) structuredComposerMenuOpenerId = opener.id;
  structuredComposerMenu = structuredComposerMenu === menu ? '' : menu;
  if (structuredComposerMenu !== 'config') structuredComposerConfigId = '';
  structuredComposerMenuFocusPending = Boolean(structuredComposerMenu && focusFirst);
  renderStructuredSessionControls();
}

function structuredComposerToolbarButtons() {
  return [
    document.getElementById('crt-structured-attach'),
    document.getElementById('crt-structured-command'),
    document.getElementById('crt-structured-mode'),
    document.getElementById('crt-structured-config')
  ].filter((button) => button && !button.hidden && !button.disabled);
}

function focusStructuredComposerToolbarButton(current, offset = 0) {
  const buttons = structuredComposerToolbarButtons();
  if (!buttons.length) return false;
  const currentIndex = buttons.indexOf(current);
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + offset + buttons.length) % buttons.length;
  buttons[nextIndex].focus();
  return true;
}

function structuredComposerMenuButtons() {
  const menu = document.getElementById('crt-structured-composer-menu');
  if (!menu || menu.hidden) return [];
  return Array.from(menu.querySelectorAll('.crt-structured-menu-item'))
    .filter((button) => !button.disabled);
}

function focusStructuredComposerMenuButton(current, offset = 0) {
  const buttons = structuredComposerMenuButtons();
  if (!buttons.length) return false;
  const currentIndex = buttons.indexOf(current);
  const activeIndex = buttons.findIndex((button) => button.classList.contains('active'));
  const nextIndex = currentIndex < 0
    ? Math.max(0, activeIndex)
    : (currentIndex + offset + buttons.length) % buttons.length;
  buttons[nextIndex].focus();
  buttons[nextIndex].scrollIntoView({ block: 'nearest' });
  return true;
}

function structuredComposerMenuPath() {
  return `${structuredComposerMenu}:${structuredComposerConfigId}`;
}

function captureStructuredComposerMenuFocus(menu) {
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('.crt-structured-menu-item')
    : null;
  if (!focused || !menu.contains(focused)) return null;
  const buttons = structuredComposerMenuButtons();
  return {
    path: structuredComposerMenuPath(),
    key: focused.dataset.menuKey || '',
    index: buttons.indexOf(focused)
  };
}

function restoreStructuredComposerMenuFocus(snapshot) {
  if (!snapshot || snapshot.path !== structuredComposerMenuPath()) return false;
  const buttons = structuredComposerMenuButtons();
  if (!buttons.length) return false;
  const matching = snapshot.key
    ? buttons.find((button) => button.dataset.menuKey === snapshot.key)
    : null;
  const fallbackIndex = Math.min(Math.max(snapshot.index, 0), buttons.length - 1);
  const target = matching || buttons[fallbackIndex];
  target.focus();
  target.scrollIntoView({ block: 'nearest' });
  return true;
}

function closeStructuredComposerMenu({ restoreFocus = true } = {}) {
  structuredComposerMenu = '';
  structuredComposerConfigId = '';
  structuredComposerMenuFocusPending = false;
  renderStructuredSessionControls();
  if (!restoreFocus) return;
  const opener = structuredComposerMenuOpenerId
    ? document.getElementById(structuredComposerMenuOpenerId)
    : null;
  if (opener && !opener.hidden && !opener.disabled) opener.focus();
}

function backStructuredComposerMenu() {
  if (structuredComposerMenu === 'config' && structuredComposerConfigId) {
    structuredComposerConfigId = '';
    structuredComposerMenuFocusPending = true;
    renderStructuredSessionControls();
    return;
  }
  closeStructuredComposerMenu();
}

async function patchStructuredAcpSession(patch) {
  if (!focusedAgentId) return;
  const openerId = structuredComposerMenuOpenerId;
  const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(focusedAgentId)}/acp-session`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body && body.error ? body.error : `Failed to update ACP session (${response.status})`);
  structuredComposerMenu = '';
  structuredComposerConfigId = '';
  await refreshStructuredSessionControls(focusedAgentId, true);
  const opener = openerId ? document.getElementById(openerId) : null;
  if (opener && !opener.hidden && !opener.disabled) opener.focus();
}

function structuredMenuButton(label, description, active, onClick, menuKey = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `crt-structured-menu-item${active ? ' active' : ''}`;
  button.dataset.menuKey = menuKey;
  const title = document.createElement('span');
  title.textContent = label;
  button.appendChild(title);
  if (description) {
    const detail = document.createElement('small');
    detail.textContent = description;
    button.appendChild(detail);
  }
  button.onclick = onClick;
  return button;
}

function renderStructuredComposerMenu() {
  const menu = document.getElementById('crt-structured-composer-menu');
  if (!menu) return;
  const retainedFocus = captureStructuredComposerMenuFocus(menu);
  menu.replaceChildren();
  const session = structuredSessionSnapshot;
  if (!structuredComposerMenu || !session) {
    menu.hidden = true;
    return;
  }

  const selectedConfig = structuredComposerMenu === 'config'
    ? structuredVisibleConfigOptions(session).find((option) => option.id === structuredComposerConfigId)
    : null;
  const title = document.createElement('div');
  title.className = 'crt-structured-menu-title';
  title.textContent = structuredComposerMenu === 'commands'
    ? 'COMMAND DIRECTORY'
    : structuredComposerMenu === 'mode'
      ? 'AGENT MODE'
      : selectedConfig ? `SESSION CONFIG / ${selectedConfig.name}` : 'SESSION CONFIG';
  const items = document.createElement('div');
  items.className = 'crt-structured-menu-items';

  if (structuredComposerMenu === 'commands') {
    const input = document.getElementById('crt-structured-input');
    const commandMatch = String(input && input.value || '').match(/^\/([^\s]*)$/);
    const query = commandMatch ? commandMatch[1].toLowerCase() : '';
    (session.availableCommands || [])
      .filter((command) => !query || String(command.name || '').toLowerCase().includes(query))
      .slice(0, 12)
      .forEach((command) => {
        items.appendChild(structuredMenuButton(`/${command.name}`, command.description || (command.input && command.input.hint) || '', false, () => {
          if (!input) return;
          input.value = `/${command.name} `;
          resizeStructuredComposerInput(input);
          structuredComposerMenu = '';
          renderStructuredSessionControls();
          updateStructuredComposerState(state && state.agents.find((agent) => agent.id === focusedAgentId));
          input.focus();
        }, `command:${command.name}`));
      });
  } else if (structuredComposerMenu === 'mode') {
    const modes = session.modes && Array.isArray(session.modes.availableModes) ? session.modes.availableModes : [];
    const current = session.currentModeId || (session.modes && session.modes.currentModeId) || '';
    modes.forEach((mode) => {
      items.appendChild(structuredMenuButton(mode.name || mode.id, mode.description || '', mode.id === current, () => {
        void patchStructuredAcpSession({ modeId: mode.id }).catch(showStructuredComposerError);
      }, `mode:${mode.id}`));
    });
  } else if (!selectedConfig) {
    structuredVisibleConfigOptions(session).forEach((option) => {
      items.appendChild(structuredMenuButton(
        `${option.name}: ${structuredConfigValueLabel(option)}`,
        option.description || '',
        false,
        () => {
          structuredComposerConfigId = option.id;
          structuredComposerMenuFocusPending = true;
          renderStructuredSessionControls();
        },
        `config:${option.id}`
      ));
    });
  } else if (selectedConfig.type === 'boolean') {
    [false, true].forEach((value) => {
      items.appendChild(structuredMenuButton(value ? 'ON' : 'OFF', selectedConfig.description || '', selectedConfig.currentValue === value, () => {
        void patchStructuredAcpSession({ configId: selectedConfig.id, value }).catch(showStructuredComposerError);
      }, `boolean:${value}`));
    });
  } else {
    structuredSelectOptions(selectedConfig).forEach((candidate) => {
      items.appendChild(structuredMenuButton(candidate.name || candidate.value, candidate.description || '', candidate.value === selectedConfig.currentValue, () => {
        void patchStructuredAcpSession({ configId: selectedConfig.id, value: candidate.value }).catch(showStructuredComposerError);
      }, `option:${candidate.value}`));
    });
  }

  menu.append(title, items);
  menu.hidden = false;
  if (structuredComposerMenuFocusPending) {
    structuredComposerMenuFocusPending = false;
    window.requestAnimationFrame(() => focusStructuredComposerMenuButton(null, 0));
  } else {
    restoreStructuredComposerMenuFocus(retainedFocus);
  }
}

function renderStructuredSessionControls() {
  const session = structuredSessionSnapshot;
  const commandButton = document.getElementById('crt-structured-command');
  const modeButton = document.getElementById('crt-structured-mode');
  const configButton = document.getElementById('crt-structured-config');
  const usage = document.getElementById('crt-structured-composer-usage');
  if (!commandButton || !modeButton || !configButton || !usage) return;
  const commands = session && Array.isArray(session.availableCommands) ? session.availableCommands : [];
  const modes = session && session.modes && Array.isArray(session.modes.availableModes) ? session.modes.availableModes : [];
  const configs = structuredVisibleConfigOptions(session);
  commandButton.hidden = commands.length === 0;
  modeButton.hidden = modes.length === 0;
  configButton.hidden = configs.length === 0;
  const currentMode = modes.find((mode) => mode.id === (session && (session.currentModeId || (session.modes && session.modes.currentModeId))));
  modeButton.textContent = `[MODE ${currentMode ? currentMode.name : ''}]`;
  configButton.textContent = `[${currentStructuredConfigLabel(session)}]`;
  usage.textContent = formatStructuredUsage(session);
  renderStructuredComposerMenu();
}

async function refreshStructuredSessionControls(agentId = focusedAgentId, force = false) {
  if (!agentId || structuredSessionControlsLoading) return;
  const agent = state && state.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.runtimeBinding?.kind !== 'acp') {
    resetStructuredSessionControls();
    return;
  }
  const revision = String(agent.runtimeBinding.sessionUpdatedAt || '');
  if (!force && (
    (revision && revision === structuredSessionControlsRevision)
    || (!revision && structuredSessionSnapshot)
  )) return;
  structuredSessionControlsLoading = true;
  try {
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agentId)}/acp-session`));
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.session) {
      throw new Error(body && body.error ? body.error : `Failed to read ACP session (${response.status})`);
    }
    structuredSessionSnapshot = body.session;
    structuredSessionControlsRevision = revision || String(body.session.updatedAt || Date.now());
    renderStructuredSessionControls();
  } catch (error) {
    showStructuredComposerError(error);
  } finally {
    structuredSessionControlsLoading = false;
  }
}

function showStructuredComposerError(error) {
  const status = document.getElementById('crt-structured-composer-status');
  if (!status) return;
  status.textContent = error && error.message ? error.message : String(error || 'Structured session error');
  status.classList.add('error');
}

function resizeStructuredComposerInput(input) {
  if (!input) return;
  input.style.height = 'auto';
  const maxHeight = Number.parseFloat(window.getComputedStyle(input).maxHeight) || 168;
  const nextHeight = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden';
  requestAnimationFrame(updateStructuredTranscriptScrollState);
}

function updateStructuredTranscriptScrollState() {
  const container = document.getElementById('terminal-output');
  const status = document.getElementById('crt-structured-composer-status');
  if (!container || !status || !container.classList.contains('crt-structured-session')) return false;
  const scrollable = container.scrollHeight > container.clientHeight + 2;
  const active = scrollable && document.activeElement === container;
  container.tabIndex = scrollable ? 0 : -1;
  status.dataset.scrollActive = active ? 'true' : 'false';
  status.dataset.scrollHint = !scrollable
    ? ''
    : active
      ? '[↑/↓] SCROLL  [SHIFT+↑/↓] TOP/BOTTOM  [ENTER] LATEST  [ESC] INPUT'
      : '[TAB] SCROLL';
  return scrollable;
}

function focusStructuredTranscript() {
  const container = document.getElementById('terminal-output');
  if (!container || !updateStructuredTranscriptScrollState()) return false;
  container.focus({ preventScroll: true });
  updateStructuredTranscriptScrollState();
  return true;
}

function setStructuredComposerActive(active) {
  const composer = document.getElementById('crt-structured-composer');
  const input = document.getElementById('crt-structured-input');
  const statusNode = document.getElementById('crt-structured-composer-status');
  if (composer) composer.classList.toggle('active', active);
  if (!active && input) {
    input.value = '';
    input.disabled = false;
    resizeStructuredComposerInput(input);
  }
  if (!active) {
    structuredComposerRestoreFocusAfterInterrupt = false;
    structuredComposerAttachments = [];
    structuredComposerHistoryIndex = -1;
    resetStructuredSessionControls();
    renderStructuredComposerAttachments();
    const notices = document.getElementById('crt-structured-composer-notices');
    if (notices) notices.replaceChildren();
  }
  if (!active && statusNode) {
    statusNode.textContent = '';
    delete statusNode.dataset.scrollActive;
    delete statusNode.dataset.scrollHint;
    statusNode.classList.remove('error');
  }
}

function updateStructuredComposerState(agent) {
  const input = document.getElementById('crt-structured-input');
  const sendButton = document.getElementById('crt-structured-send');
  const statusNode = document.getElementById('crt-structured-composer-status');
  if (!input || !sendButton || !statusNode) return;

  const kind = structuredRuntimeKind(agent);
  const runtimeStatus = structuredRuntimeStatus(agent);
  const error = structuredRuntimeError(agent);
  const action = structuredComposerAction(agent, input.value);
  flushStructuredComposerFollowUp(agent);
  const busy = ['starting', 'interrupting'].includes(runtimeStatus);
  input.disabled = !isCrtAgentInteractive(agent) || Boolean(error) || busy;
  if (structuredComposerRestoreFocusAfterInterrupt && !input.disabled) {
    structuredComposerRestoreFocusAfterInterrupt = false;
    requestAnimationFrame(() => input.focus());
  }
  sendButton.disabled = action === 'disabled';
  sendButton.dataset.action = action;
  sendButton.textContent = action === 'interrupt'
    ? 'BREAK [ESC]'
    : action === 'steer' ? 'STEER [ENTER]' : 'SEND [ENTER]';
  input.placeholder = error
    ? 'Session unavailable'
    : (busy ? 'Agent is changing state...' : 'Type a message...');
  statusNode.textContent = error || `${kind} ${String(runtimeStatus || 'idle').toUpperCase()}`;
  statusNode.classList.toggle('error', Boolean(error));
  renderStructuredPermissions(agent);
  if (agent && agent.runtimeBinding?.kind === 'acp') void refreshStructuredSessionControls(agent.id);
}

function structuredAttachmentId(file) {
  return `crt-${Date.now()}-${String(file && file.name || 'attachment')}-${Math.random().toString(36).slice(2, 8)}`;
}

function structuredAttachmentBlock(current, block) {
  const text = String(current || '').trimEnd();
  const next = String(block || '').trimEnd();
  if (!next) return text;
  return `${text}${text ? '\n\n' : ''}${next}`;
}

function renderStructuredComposerAttachments() {
  const container = document.getElementById('crt-structured-attachments');
  if (!container) return;
  container.replaceChildren();
  structuredComposerAttachments.forEach((attachment) => {
    const row = document.createElement('div');
    row.className = 'crt-structured-attachment';
    const stateLabel = attachment.status === 'uploading'
      ? 'LOADING'
      : attachment.status === 'error' ? 'ERROR' : 'READY';
    const label = document.createElement('span');
    label.textContent = `[${stateLabel}] ${attachment.name}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '[REMOVE]';
    remove.setAttribute('aria-label', `Remove ${attachment.name}`);
    remove.onclick = () => {
      structuredComposerAttachments = structuredComposerAttachments.filter((item) => item.id !== attachment.id);
      renderStructuredComposerAttachments();
      updateStructuredComposerState(state && state.agents.find((agent) => agent.id === focusedAgentId));
    };
    row.append(label, remove);
    container.appendChild(row);
  });
}

function readStructuredTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onerror = () => reject(reader.error || new Error('File read failed'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

async function prepareStructuredAttachment(file) {
  const attachment = {
    id: structuredAttachmentId(file),
    name: file.name || 'attachment',
    status: 'uploading',
    messageBlock: ''
  };
  structuredComposerAttachments.push(attachment);
  renderStructuredComposerAttachments();
  try {
    if (String(file.type || '').startsWith('image/')) {
      const response = await fetch(farmingApiPath('/attachments/image'), {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'image/png' },
        body: file
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || !body.path) throw new Error(`Image upload failed (${response.status})`);
      attachment.messageBlock = `Attached image: ${body.name || attachment.name}\n\nImage path: ${body.path}`;
    } else {
      const content = await readStructuredTextFile(file);
      const limit = 50000;
      const truncated = content.length > limit;
      attachment.messageBlock = `Attached file: ${attachment.name}\n\n${content.slice(0, limit)}${truncated ? `\n\n[File truncated after ${limit} characters]` : ''}`;
    }
    attachment.status = 'ready';
  } catch (error) {
    attachment.status = 'error';
    attachment.messageBlock = '';
    attachment.error = error && error.message ? error.message : 'Attachment failed';
    showStructuredComposerError(error);
  }
  renderStructuredComposerAttachments();
  updateStructuredComposerState(state && state.agents.find((agent) => agent.id === focusedAgentId));
}

function addStructuredAttachmentFiles(files) {
  Array.from(files || []).forEach((file) => void prepareStructuredAttachment(file));
}

function structuredComposerMessage(draft) {
  return structuredComposerAttachments
    .filter((attachment) => attachment.status === 'ready' && attachment.messageBlock)
    .reduce((message, attachment) => structuredAttachmentBlock(message, attachment.messageBlock), String(draft || ''))
    .trim();
}

function structuredComposerHistoryFor(agentId) {
  if (!agentId) return [];
  return structuredComposerHistory.get(agentId) || [];
}

function addStructuredComposerHistory(agentId, value) {
  const draft = String(value || '').trim();
  if (!agentId || !draft) return;
  const history = structuredComposerHistoryFor(agentId).filter((entry) => entry !== draft);
  history.push(draft);
  structuredComposerHistory.set(agentId, history.slice(-50));
  structuredComposerHistoryIndex = -1;
}

function navigateStructuredComposerHistory(input, direction) {
  const history = structuredComposerHistoryFor(focusedAgentId);
  if (!history.length) return false;
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  if ((direction < 0 && !atStart) || (direction > 0 && !atEnd)) return false;
  if (direction < 0) {
    structuredComposerHistoryIndex = structuredComposerHistoryIndex < 0
      ? history.length - 1
      : Math.max(0, structuredComposerHistoryIndex - 1);
  } else if (structuredComposerHistoryIndex >= 0) {
    structuredComposerHistoryIndex += 1;
    if (structuredComposerHistoryIndex >= history.length) structuredComposerHistoryIndex = -1;
  } else {
    return false;
  }
  input.value = structuredComposerHistoryIndex < 0 ? '' : history[structuredComposerHistoryIndex];
  resizeStructuredComposerInput(input);
  const cursor = input.value.length;
  input.setSelectionRange(cursor, cursor);
  return true;
}

function renderStructuredPermissions(agent) {
  const container = document.getElementById('crt-structured-composer-notices');
  if (!container) return;
  container.replaceChildren();
  if (!agent || agent.runtimeBinding?.kind !== 'acp') return;
  const runtime = agent.runtimeBinding;
  const requests = Array.isArray(runtime.pendingPermissions) && runtime.pendingPermissions.length
    ? runtime.pendingPermissions
    : (runtime.pendingPermission ? [runtime.pendingPermission] : []);
  requests.forEach((request) => {
    const panel = document.createElement('section');
    panel.className = 'crt-structured-permission';
    const title = document.createElement('div');
    title.className = 'crt-structured-permission-title';
    title.textContent = `PERMISSION REQUEST / ${request.toolCall && request.toolCall.kind || 'TOOL'}`;
    const description = document.createElement('p');
    description.textContent = request.toolCall && request.toolCall.title || 'Agent requests permission to continue.';
    const actions = document.createElement('div');
    actions.className = 'crt-structured-permission-actions';
    (request.options || []).forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `[${option.name}]`;
      button.onclick = () => void respondToStructuredPermission(request.requestId, option.optionId, false);
      actions.appendChild(button);
    });
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.textContent = '[DECLINE]';
    decline.onclick = () => void respondToStructuredPermission(request.requestId, undefined, true);
    actions.appendChild(decline);
    panel.append(title, description, actions);
    container.appendChild(panel);
  });
}

async function respondToStructuredPermission(requestId, optionId, cancelled) {
  if (!focusedAgentId) return;
  const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(focusedAgentId)}/acp-permission`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId, optionId, cancelled: cancelled === true })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    showStructuredComposerError(new Error(body && body.error ? body.error : `Permission response failed (${response.status})`));
  }
}

function structuredTranscriptContentText(content) {
  return (Array.isArray(content) ? content : [])
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

function structuredTranscriptTurns(transcript) {
  if (transcript && Array.isArray(transcript.turns)) return transcript.turns;
  const entries = transcript && Array.isArray(transcript.entries) ? transcript.entries : [];
  const turns = [];
  let current = null;
  entries.forEach((entry) => {
    if (!entry || entry.internal === true || entry.type !== 'message') return;
    const text = structuredTranscriptContentText(entry.content);
    if (!text) return;
    if (entry.role === 'user') {
      current = { id: entry.id || `user-${turns.length}`, userMessage: text, finalMessage: '' };
      turns.push(current);
      return;
    }
    if (entry.role !== 'assistant') return;
    if (!current) {
      current = { id: entry.id || `assistant-${turns.length}`, userMessage: '', finalMessage: '' };
      turns.push(current);
    }
    current.finalMessage = text;
  });
  return turns;
}

function normalizeCrtStructuredPreviewText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function structuredTranscriptAttachmentLabel(content) {
  const labels = (Array.isArray(content) ? content : []).flatMap((block) => {
    const type = String(block && block.type || '').toLowerCase();
    if (type.includes('image')) return ['Image attachment'];
    if (type.includes('audio')) return ['Audio attachment'];
    if (type.includes('file') || type.includes('resource')) return ['File attachment'];
    return [];
  });
  return Array.from(new Set(labels)).join(' + ');
}

function crtStructuredPreviewMessageLines(transcript, limit = 8) {
  const maxLines = Math.max(1, Number(limit) || 8);
  const turnLines = structuredTranscriptTurns(transcript).flatMap((turn) => [
    turn && turn.userMessage
      ? { role: 'user', label: 'YOU', text: normalizeCrtStructuredPreviewText(turn.userMessage) }
      : null,
    turn && turn.finalMessage
      ? { role: 'assistant', label: 'AGENT', text: normalizeCrtStructuredPreviewText(turn.finalMessage) }
      : null,
  ]).filter(Boolean);
  if (turnLines.length > 0) return turnLines.slice(-maxLines);

  const entries = transcript && Array.isArray(transcript.entries)
    ? transcript.entries
      .filter((entry) => (
        entry
        && entry.internal !== true
        && entry.type === 'message'
        && (entry.role === 'user' || entry.role === 'assistant')
      ))
      .map((entry) => ({
        role: entry.role,
        label: entry.role === 'user' ? 'YOU' : 'AGENT',
        text: normalizeCrtStructuredPreviewText(structuredTranscriptContentText(entry.content))
          || structuredTranscriptAttachmentLabel(entry.content),
      }))
      .filter((line) => line.text)
    : [];
  return entries.slice(-maxLines);
}

function structuredEntryActivityText(entry) {
  if (!entry || entry.internal === true) return '';
  if (entry.type === 'tool') {
    const title = normalizeCrtStructuredPreviewText(entry.title || entry.kind || 'Tool activity', 160);
    const status = normalizeCrtStructuredPreviewText(entry.status, 40).replaceAll('_', ' ');
    return [title, status].filter(Boolean).join(' · ');
  }
  if (entry.type === 'thought') {
    return normalizeCrtStructuredPreviewText(structuredTranscriptContentText(entry.content), 180);
  }
  if (entry.type === 'plan') {
    const steps = Array.isArray(entry.entries) ? entry.entries : [];
    const current = steps.find((step) => step && step.status === 'in_progress')
      || [...steps].reverse().find((step) => step && step.status !== 'completed')
      || steps.at(-1);
    return normalizeCrtStructuredPreviewText(current && (current.content || current.title), 180);
  }
  return '';
}

function buildCrtStructuredPreview(transcript, agent = null) {
  const entries = transcript && Array.isArray(transcript.entries)
    ? transcript.entries.filter((entry) => entry && entry.internal !== true)
    : [];
  const turns = structuredTranscriptTurns(transcript);
  const latestTurn = turns.at(-1) || null;
  const messageLines = crtStructuredPreviewMessageLines(transcript);
  let userText = normalizeCrtStructuredPreviewText(latestTurn && latestTurn.userMessage);
  let assistantText = normalizeCrtStructuredPreviewText(latestTurn && latestTurn.finalMessage);
  let activityText = '';

  if (entries.length > 0) {
    const latestUserIndex = entries.findLastIndex((entry) => entry.type === 'message' && entry.role === 'user');
    const latestUser = latestUserIndex >= 0 ? entries[latestUserIndex] : null;
    if (latestUser) {
      userText = normalizeCrtStructuredPreviewText(structuredTranscriptContentText(latestUser.content))
        || structuredTranscriptAttachmentLabel(latestUser.content);
    }
    const turnEntries = latestUserIndex >= 0 ? entries.slice(latestUserIndex + 1) : entries;
    const latestAssistant = [...turnEntries].reverse().find((entry) => (
      entry.type === 'message' && entry.role === 'assistant'
    ));
    if (latestAssistant) {
      assistantText = normalizeCrtStructuredPreviewText(structuredTranscriptContentText(latestAssistant.content))
        || structuredTranscriptAttachmentLabel(latestAssistant.content);
    }
    activityText = [...turnEntries].reverse().map(structuredEntryActivityText).find(Boolean) || '';
  } else if (latestTurn && Array.isArray(latestTurn.processItems)) {
    const processItem = [...latestTurn.processItems].reverse().find(Boolean);
    activityText = normalizeCrtStructuredPreviewText(
      processItem && (processItem.detail || processItem.title),
      180,
    );
  }

  return {
    messageLines,
    userText,
    assistantText,
    activityText,
    state: String(structuredRuntimeStatus(agent) || (transcript && transcript.state) || ''),
  };
}

function crtStructuredPreviewRevision(agent) {
  if (!agent || !isStructuredRuntimeAgent(agent)) return '';
  const runtime = agent.runtimeBinding;
  return JSON.stringify([
    structuredRuntimeKind(agent),
    structuredRuntimeStatus(agent),
    runtime.sessionRevision || 0,
    runtime.sessionUpdatedAt || '',
    runtime.transcriptUpdatedAt || '',
    runtime.turnId || '',
    agent.lastActivity || 0,
  ]);
}

function pruneCrtStructuredPreviews(currentState = state) {
  const visibleIds = new Set(getCrtLiveAgents(currentState).map((agent) => agent.id));
  crtStructuredPreviewCache.forEach((_value, agentId) => {
    if (!visibleIds.has(agentId)) crtStructuredPreviewCache.delete(agentId);
  });
  crtStructuredPreviewTimers.forEach((timer, agentId) => {
    if (visibleIds.has(agentId)) return;
    clearTimeout(timer);
    crtStructuredPreviewTimers.delete(agentId);
  });
}

function scheduleCrtStructuredPreviewRefresh(agent) {
  if (!isCrtLiveAgent(agent) || !isStructuredRuntimeAgent(agent)) return;
  const revision = crtStructuredPreviewRevision(agent);
  const cached = crtStructuredPreviewCache.get(agent.id);
  if (cached && cached.revision === revision && (cached.loading || cached.ready)) return;
  if (crtStructuredPreviewTimers.has(agent.id)) return;
  const timer = setTimeout(() => {
    crtStructuredPreviewTimers.delete(agent.id);
    const currentAgent = state && state.agents.find((candidate) => candidate.id === agent.id);
    if (isCrtLiveAgent(currentAgent) && isStructuredRuntimeAgent(currentAgent)) {
      void refreshCrtStructuredPreview(currentAgent);
    }
  }, CRT_STRUCTURED_PREVIEW_REFRESH_MS);
  crtStructuredPreviewTimers.set(agent.id, timer);
}

async function refreshCrtStructuredPreview(agent) {
  const revision = crtStructuredPreviewRevision(agent);
  const cached = crtStructuredPreviewCache.get(agent.id);
  if (cached && cached.revision === revision && (cached.loading || cached.ready)) return;
  crtStructuredPreviewCache.set(agent.id, {
    revision,
    loading: true,
    ready: false,
    preview: cached && cached.preview || null,
    error: '',
  });

  try {
    const endpoint = structuredTranscriptEndpoint(agent);
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agent.id)}/${endpoint}?maxTurns=20`));
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.transcript) {
      throw new Error(body && body.error ? body.error : `Conversation preview failed (${response.status})`);
    }
    const currentAgent = state && state.agents.find((candidate) => candidate.id === agent.id);
    if (!isCrtLiveAgent(currentAgent) || crtStructuredPreviewRevision(currentAgent) !== revision) {
      if (isCrtLiveAgent(currentAgent)) scheduleCrtStructuredPreviewRefresh(currentAgent);
      return;
    }
    crtStructuredPreviewCache.set(agent.id, {
      revision,
      loading: false,
      ready: true,
      preview: buildCrtStructuredPreview(body.transcript, currentAgent),
      error: '',
    });
    if (isCrtSessionOpen()) dashboardRenderDeferred = true;
    else updateCrtAgentPreviewCard(currentAgent);
  } catch (error) {
    const currentAgent = state && state.agents.find((candidate) => candidate.id === agent.id);
    if (!isCrtLiveAgent(currentAgent) || crtStructuredPreviewRevision(currentAgent) !== revision) return;
    crtStructuredPreviewCache.set(agent.id, {
      revision,
      loading: false,
      ready: true,
      preview: cached && cached.preview || null,
      error: error && error.message ? error.message : 'Conversation preview unavailable',
    });
    if (isCrtSessionOpen()) dashboardRenderDeferred = true;
    else updateCrtAgentPreviewCard(currentAgent);
  }
}

function renderStructuredTranscript(transcript, force = false) {
  const container = document.getElementById('terminal-output');
  if (!container) return;
  const updatedAt = String(transcript && transcript.updatedAt || '');
  if (!force && updatedAt && updatedAt === structuredSessionRenderedAt) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  if (!nearBottom && focusedAgentId) saveCrtStructuredReadingAnchor(focusedAgentId);
  const transcriptNode = document.createElement('div');
  transcriptNode.className = 'crt-structured-transcript';
  const turns = structuredTranscriptTurns(transcript);

  if (!turns.length) {
    const empty = document.createElement('div');
    empty.className = 'crt-structured-empty';
    empty.textContent = 'No conversation yet.';
    transcriptNode.appendChild(empty);
  } else {
    turns.forEach((turn) => {
      const section = document.createElement('section');
      section.className = 'crt-structured-turn';
      section.dataset.readingAnchorId = String(turn.id || `${turn.userMessage || ''}\n${turn.finalMessage || ''}`.slice(0, 160));
      if (turn.userMessage) {
        const user = document.createElement('p');
        user.className = 'crt-structured-message user';
        user.textContent = turn.userMessage;
        section.appendChild(user);
      }
      if (turn.finalMessage) {
        const assistant = document.createElement('p');
        assistant.className = 'crt-structured-message assistant';
        assistant.textContent = turn.finalMessage;
        section.appendChild(assistant);
      }
      transcriptNode.appendChild(section);
    });
  }

  container.replaceChildren(transcriptNode);
  structuredSessionRenderedAt = updatedAt;
  if (!focusedAgentId || !restoreCrtStructuredReadingAnchor(focusedAgentId)) {
    if (force || nearBottom) container.scrollTop = container.scrollHeight;
  }
  container.onscroll = () => saveCrtStructuredReadingAnchor(focusedAgentId);
  requestAnimationFrame(updateStructuredTranscriptScrollState);
}

async function refreshStructuredSession(agentId = focusedAgentId, force = false) {
  if (!agentId || structuredSessionLoading) return;
  const agent = state && state.agents.find((candidate) => candidate.id === agentId);
  if (!agent || !isStructuredRuntimeAgent(agent)) return;
  structuredSessionLoading = true;
  try {
    const endpoint = structuredTranscriptEndpoint(agent);
    const response = await fetch(farmingApiPath(`/agents/${encodeURIComponent(agentId)}/${endpoint}?maxTurns=80`));
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || !body.transcript) {
      throw new Error(body && body.error ? body.error : `Failed to read conversation (${response.status})`);
    }
    renderStructuredTranscript(body.transcript, force);
    updateStructuredComposerState(agent);
  } catch (error) {
    const container = document.getElementById('terminal-output');
    if (container && !container.querySelector('.crt-structured-transcript')) {
      const message = document.createElement('div');
      message.className = 'crt-structured-error';
      message.textContent = error && error.message ? error.message : 'Failed to read conversation';
      container.replaceChildren(message);
    }
    updateStructuredComposerState(agent);
  } finally {
    structuredSessionLoading = false;
  }
}

function stopStructuredSessionPolling() {
  if (structuredSessionPoller) {
    clearInterval(structuredSessionPoller);
    structuredSessionPoller = null;
  }
  structuredSessionLoading = false;
  structuredSessionRenderedAt = '';
}

function startStructuredSessionPolling(agentId) {
  stopStructuredSessionPolling();
  structuredSessionPoller = setInterval(() => {
    if (focusedAgentId === agentId) void refreshStructuredSession(agentId);
  }, 1000);
}

function setupStructuredSessionComposer() {
  const composer = document.getElementById('crt-structured-composer');
  const input = document.getElementById('crt-structured-input');
  const fileInput = document.getElementById('crt-structured-file-input');
  const attachButton = document.getElementById('crt-structured-attach');
  const commandButton = document.getElementById('crt-structured-command');
  const modeButton = document.getElementById('crt-structured-mode');
  const configButton = document.getElementById('crt-structured-config');
  const menu = document.getElementById('crt-structured-composer-menu');
  if (!composer || !input || composer.dataset.bound === 'true') return;
  composer.dataset.bound = 'true';
  input.addEventListener('input', () => {
    resizeStructuredComposerInput(input);
    structuredComposerHistoryIndex = -1;
    const commandMatch = input.value.match(/^\/([^\s]*)$/);
    if (commandMatch && structuredSessionSnapshot && (structuredSessionSnapshot.availableCommands || []).length) {
      structuredComposerMenu = 'commands';
      renderStructuredSessionControls();
    } else if (structuredComposerMenu === 'commands') {
      structuredComposerMenu = '';
      renderStructuredSessionControls();
    }
    const agent = state && state.agents.find((candidate) => candidate.id === focusedAgentId);
    updateStructuredComposerState(agent);
  });
  input.addEventListener('paste', (event) => {
    const imageFiles = Array.from(event.clipboardData && event.clipboardData.files || [])
      .filter((file) => String(file.type || '').startsWith('image/'));
    if (!imageFiles.length) return;
    event.preventDefault();
    addStructuredAttachmentFiles(imageFiles);
  });
  input.addEventListener('compositionend', () => {
    structuredComposerCompositionEndAt = Date.now();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey && !structuredComposerMenu && focusStructuredTranscript()) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      const agent = state && state.agents.find((candidate) => candidate.id === focusedAgentId);
      if (structuredComposerAction(agent, input.value) === 'interrupt') {
        event.preventDefault();
        structuredComposerRestoreFocusAfterInterrupt = true;
        const interrupted = getSessionClient()?.interruptAgent(focusedAgentId);
        if (!interrupted) {
          structuredComposerRestoreFocusAfterInterrupt = false;
          showStructuredComposerError(new Error('Connection unavailable'));
          input.focus();
        }
        return;
      }
      if (structuredComposerMenu) {
        event.preventDefault();
        structuredComposerMenu = '';
        renderStructuredSessionControls();
        return;
      }
    }
    if (event.key === 'ArrowUp' && navigateStructuredComposerHistory(input, -1)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown') {
      if (structuredComposerHistoryIndex >= 0 && navigateStructuredComposerHistory(input, 1)) {
        event.preventDefault();
        return;
      }
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
      if (atEnd && focusStructuredComposerToolbarButton(null, 0)) {
        event.preventDefault();
        return;
      }
    }
    if (
      event.key === 'Enter'
      && !event.shiftKey
      && !event.isComposing
      && Date.now() - structuredComposerCompositionEndAt > 80
    ) {
      event.preventDefault();
      composer.requestSubmit();
    }
  });
  if (attachButton && fileInput) attachButton.addEventListener('click', () => fileInput.click());
  if (fileInput) fileInput.addEventListener('change', () => {
    addStructuredAttachmentFiles(fileInput.files);
    fileInput.value = '';
  });
  if (commandButton) commandButton.addEventListener('click', (event) => setStructuredComposerMenu('commands', { opener: event.currentTarget }));
  if (modeButton) modeButton.addEventListener('click', (event) => setStructuredComposerMenu('mode', { opener: event.currentTarget }));
  if (configButton) configButton.addEventListener('click', (event) => setStructuredComposerMenu('config', { opener: event.currentTarget }));
  composer.addEventListener('keydown', (event) => {
    const tool = event.target && event.target.closest
      ? event.target.closest('.crt-structured-tool')
      : null;
    if (!tool) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusStructuredComposerToolbarButton(tool, event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'Escape') {
      event.preventDefault();
      if (structuredComposerMenu) closeStructuredComposerMenu({ restoreFocus: false });
      input.focus();
      return;
    }
    const menuName = tool === commandButton
      ? 'commands'
      : tool === modeButton ? 'mode' : tool === configButton ? 'config' : '';
    if (menuName && (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown')) {
      event.preventDefault();
      setStructuredComposerMenu(menuName, { focusFirst: true, opener: tool });
    }
  });
  if (menu) menu.addEventListener('keydown', (event) => {
    const item = event.target && event.target.closest
      ? event.target.closest('.crt-structured-menu-item')
      : null;
    if (!item) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusStructuredComposerMenuButton(item, event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft') {
      event.preventDefault();
      backStructuredComposerMenu();
    }
  });
  const transcript = document.getElementById('terminal-output');
  if (transcript) {
    transcript.addEventListener('focus', updateStructuredTranscriptScrollState);
    transcript.addEventListener('blur', updateStructuredTranscriptScrollState);
    transcript.addEventListener('scroll', updateStructuredTranscriptScrollState, { passive: true });
    transcript.addEventListener('keydown', (event) => {
      if (!transcript.classList.contains('crt-structured-session')) return;
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (event.shiftKey) {
          transcript.scrollTop = event.key === 'ArrowUp' ? 0 : transcript.scrollHeight;
        } else {
          const direction = event.key === 'ArrowUp' ? -1 : 1;
          transcript.scrollTop += direction * Math.max(40, transcript.clientHeight * 0.85);
        }
        updateStructuredTranscriptScrollState();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        transcript.scrollTop = transcript.scrollHeight;
        input.focus();
        return;
      }
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        input.focus();
      }
    });
  }
  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const agent = state && state.agents.find((candidate) => candidate.id === focusedAgentId);
    const action = structuredComposerAction(agent, input.value);
    if (!agent || action === 'disabled') return;
    if (action === 'interrupt') {
      structuredComposerRestoreFocusAfterInterrupt = true;
      const interrupted = getSessionClient()?.interruptAgent(focusedAgentId);
      if (!interrupted) {
        structuredComposerRestoreFocusAfterInterrupt = false;
        showStructuredComposerError(new Error('Connection unavailable'));
        input.focus();
      }
      return;
    }
    const draft = input.value;
    const message = structuredComposerMessage(draft);
    if (!message) return;
    const sent = action === 'send' && structuredRuntimeStatus(agent) !== 'idle'
      ? (queueStructuredComposerFollowUp(focusedAgentId, message), true)
      : getSessionClient()?.sendComposerMessage(focusedAgentId, message);
    const statusNode = document.getElementById('crt-structured-composer-status');
    if (!sent) {
      if (statusNode) {
        statusNode.textContent = 'Connection unavailable';
        statusNode.classList.add('error');
      }
      return;
    }
    addStructuredComposerHistory(focusedAgentId, draft);
    input.value = '';
    structuredComposerAttachments = [];
    renderStructuredComposerAttachments();
    resizeStructuredComposerInput(input);
    if (statusNode) {
      statusNode.textContent = action === 'steer' ? 'STEERING...' : 'SENDING...';
      statusNode.classList.remove('error');
    }
    updateStructuredComposerState(agent);
    setTimeout(() => void refreshStructuredSession(focusedAgentId, true), 160);
  });
}

async function openStructuredSession(agent, sessionToken) {
  const runtime = getSessionRuntime();
  const container = document.getElementById('terminal-output');
  if (!container) return;
  container.classList.add('crt-structured-session');
  setStructuredComposerActive(true);
  setupStructuredSessionComposer();
  updateStructuredComposerState(agent);
  await refreshStructuredSessionControls(agent.id, true);
  await refreshStructuredSession(agent.id, true);
  if (runtime && !runtime.isCurrentSession(agent.id, sessionToken)) return;
  startStructuredSessionPolling(agent.id);
  const input = document.getElementById('crt-structured-input');
  if (input) {
    resizeStructuredComposerInput(input);
    if (!input.disabled) input.focus();
  }
}

function teardownSessionSurface() {
  stopSessionViewPolling();
  stopStructuredSessionPolling();
  disposeCrtTerminalReplication();
  disposeTerminal();
  setStructuredComposerActive(false);
  document.getElementById('terminal-output')?.classList.remove('crt-structured-session');
  if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.resetTerminalShell) {
    SESSION_MODAL_BRIDGE.resetTerminalShell(document);
    return;
  }

  const domState = getSessionModalDomState(document);
  if (domState.terminalContainer) {
    domState.terminalContainer.classList.remove('crt-structured-session');
    domState.terminalContainer.innerHTML = '';
    domState.terminalContainer.textContent = '';
  }
}

async function openSession(agentId) {
  if (!state) return;

  const agent = state.agents.find(a => a.id === agentId);
  if (!agent) return;
  crtNavigationKey = `agent:${agentId}`;
  void markCrtAgentReadIfNeeded(agent);

  const sessionModal = document.getElementById('session-modal');
  if (sessionModal && sessionModal.classList.contains('active')) {
    closeSession();
  }

  const modalState = createSessionModalState(agent, currentTheme, {
    ...themeSettings,
    crtEffects: globalSettings.crtSkinEffectsEnabled !== false
  });
  const runtime = getSessionRuntime();
  focusedAgentId = modalState.agentId;
  currentSessionTitle = modalState.title;
  resetSessionUiState();
  setupSessionSearchControls();
  const openResult = runtime ? runtime.open(document, modalState) : null;
  const sessionToken = runtime ? openResult.sessionToken : 0;
  if (runtime) {
    syncSessionRuntimeState();
  }
  updateSessionTitleDisplay(modalState.title);
  updateCrtRuntimeSwitchControl(agent);
  updateCrtSessionCloseControl(agent);

  // 更新吊顶的"当前关注地域"
  const focusRegion = document.getElementById('focus-region');
  const focusRegionName = document.getElementById('focus-region-name');
  if (focusRegion && focusRegionName) {
    focusRegion.style.display = 'block';
    focusRegionName.textContent = agent.command.split(' ')[0];
  }

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.focusAgent(agentId, {
      streamScope: 'focused',
      previewScope: 'none',
    });
  }

  currentSessionSkin = modalState.sessionSkin;
  const domState = runtime
    ? openResult.domState
    : (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.openShell
      ? SESSION_MODAL_BRIDGE.openShell(document, modalState)
      : getSessionModalDomState(document));
  const terminalContainer = domState.terminalContainer;

  if (isStructuredRuntimeAgent(agent)) {
    disposeTerminal();
    await openStructuredSession(agent, sessionToken);
    return;
  }

  const interactiveTerminal = isCrtAgentInteractive(agent);
  if (!interactiveTerminal) {
    updateSessionTitleDisplay(`${modalState.title} [READ ONLY]`);
  }

  let terminalBundle;
  try {
    terminalBundle = await createTerminalInstance({ disableStdin: !interactiveTerminal });
  } catch (error) {
    showCrtWebglFailure(error);
    return;
  }
  if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
    return;
  }
  if (!terminalBundle) {
    terminalContainer.innerHTML = '';
    terminalContainer.textContent = '';
    await refreshSessionView(true, agentId, sessionToken);
    if (shouldPollSessionView(modalState.sessionSource)) {
      startSessionViewPolling(agentId, sessionToken);
    }
    return;
  }

  disposeTerminal();
  disposeCrtTerminalReplication();
  crtTerminalReplication = createCrtTerminalReplication(agentId);
  let mountedTerminal = null;
  try {
    mountedTerminal = SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.mountTerminal
      ? SESSION_MODAL_BRIDGE.mountTerminal(document, terminalBundle, {
        authoritativeGeometry: true,
        initialOutput: shouldUseLiveSessionText(agent)
          ? (runtime ? runtime.prepareInitialOutput(agent.output) : agent.output)
          : '',
        onData: (data) => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          if (!interactiveTerminal) return;
          sendTerminalInput(data);
        },
        onResize: (cols, rows) => {
          void cols;
          void rows;
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          sendSessionResize(agentId);
        },
        hasSelection: hasAnySelection,
        focusTerminal: focusSessionTerminal,
        isSessionActive: () => runtime ? runtime.isCurrentSession(agentId, sessionToken) : focusedAgentId === agentId,
        afterFit: () => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          sendSessionResize(agentId);
        }
        })
      : null;
  } catch (error) {
    terminalBundle.terminal?.dispose?.();
    showCrtWebglFailure(error);
    return;
  }

  if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
    if (terminalBundle.terminal && typeof terminalBundle.terminal.dispose === 'function') {
      terminalBundle.terminal.dispose();
    }
    return;
  }

  terminal = mountedTerminal ? mountedTerminal.terminal : terminalBundle.terminal;
  fitAddon = mountedTerminal ? mountedTerminal.fitAddon : terminalBundle.fitAddon;
  registerTerminalLinks(terminal);
  if (terminal && typeof terminal.onTitleChange === 'function') {
    terminal.onTitleChange((title) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      updateSessionTitleDisplay(title || modalState.title);
    });
  }
  if (terminal && typeof terminal.onSelectionChange === 'function') {
    terminal.onSelectionChange(() => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      updateSessionSelectionStatus();
    });
  }
  if (terminal && typeof terminal.onScroll === 'function') {
    terminal.onScroll(() => saveCrtTerminalReadingAnchor(agentId, terminal));
  }
  if (runtime) {
    runtime.setLastOutputLength(mountedTerminal ? mountedTerminal.outputLength : (runtime.prepareInitialOutput(agent.output)).length);
    syncSessionRuntimeState();
  }
  if (!mountedTerminal) {
    terminal.loadAddon(fitAddon);
    terminal.onData((data) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!interactiveTerminal) return;
      sendTerminalInput(data);
    });
    terminal.onResize(({ cols, rows }) => {
      void cols;
      void rows;
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (crtTerminalReplication?.applyingLocalResize) return;
      sendSessionResize(agentId, { cols, rows });
    });

    terminalContainer.innerHTML = '';
    try {
      terminal.open(terminalContainer);
    } catch (error) {
      terminal.dispose();
      terminal = null;
      fitAddon = null;
      showCrtWebglFailure(error);
      return;
    }
    const restoreTerminalFocus = () => {
      if (hasAnySelection()) {
        return;
      }
      requestAnimationFrame(() => {
        focusSessionTerminal();
      });
    };
    terminalContainer.onclick = restoreTerminalFocus;
    terminalContainer.onwheel = restoreTerminalFocus;
    terminalContainer.onmouseup = restoreTerminalFocus;
    terminalContainer.ontouchstart = restoreTerminalFocus;
    requestAnimationFrame(() => {
      if (!terminal || !fitAddon) return;
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!runtime && focusedAgentId !== agentId) return;
      const initialOutput = runtime ? runtime.prepareInitialOutput(agent.output) : agent.output;
      if (initialOutput) {
        terminal.write(initialOutput);
      }
      refreshSessionTerminalUi();
      sendSessionResize(agentId);
      terminal.scrollToBottom();
      focusSessionTerminal();
    });
  }

  try {
    if (mountedTerminal && mountedTerminal.readyPromise) {
      await mountedTerminal.readyPromise;
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) {
        return;
      }
      refreshSessionTerminalUi();
    }
  } catch (error) {
    showCrtWebglFailure(error);
  }

  // Hydrate one authoritative reducer cut before reducing live transitions.
  await refreshSessionView(true, agentId, sessionToken);
  restoreCrtTerminalReadingAnchor(agentId, terminal);
  sendSessionResize(agentId);
  if (!crtTerminalReplication && shouldPollSessionView(modalState.sessionSource)) {
    startSessionViewPolling(agentId, sessionToken);
  }
}

function closeSession() {
  if (focusedAgentId) {
    if (terminal) saveCrtTerminalReadingAnchor(focusedAgentId, terminal);
    else saveCrtStructuredReadingAnchor(focusedAgentId);
  }
  resetCrtRuntimeSwitchState();
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.close(document);
    syncSessionRuntimeState();
  } else if (SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.closeShell) {
    SESSION_MODAL_BRIDGE.closeShell(document);
  } else {
    const domState = getSessionModalDomState(document);
    domState.modal.classList.remove('active');
    document.body.classList.remove('session-open');
    if (window.FarmingSkinBridge) {
      window.FarmingSkinBridge.applySessionSkin(document, null);
    }
  }
  currentSessionSkin = null;
  focusedAgentId = null;
  getSessionClient()?.focusAgent(null, {
    streamScope: 'focused',
    previewScope: 'all',
    refreshState: true,
  });
  teardownSessionSurface();
  resetSessionUiState();
  updateSessionTitleDisplay('Agent Session');

  // 隐藏吊顶的"当前关注地域"
  const focusRegion = document.getElementById('focus-region');
  if (focusRegion) {
    focusRegion.style.display = 'none';
  }
  if (dashboardRenderDeferred) {
    renderCrtDashboardIfNeeded(true);
    if (crtMainView === 'history') renderCrtHistory();
    generateKeyMap();
  }
  restoreCrtNavigationSelection();
}

function killCurrentAgent() {
  if (!focusedAgentId) return;

  const killedAgentId = focusedAgentId;
  const fallbackAgentId = getCrtAgentRemovalFallback(state, killedAgentId);
  crtNavigationKey = fallbackAgentId ? `agent:${fallbackAgentId}` : '';

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.killAgent(killedAgentId);
  }

  closeSession();
}

function sendTerminalInput(input) {
  if (!focusedAgentId) return;
  queueCrtTerminalInput(input);
}

function clearPendingCrtTerminalFitResize(replication) {
  if (!replication) return;
  if (replication.fitResizeTimer) clearTimeout(replication.fitResizeTimer);
  replication.fitResizeTimer = null;
  replication.pendingFitResize = null;
}

function commitCrtTerminalResize(agentId, normalizedDimensions) {
  const replication = crtTerminalReplication;
  if (
    !agentId ||
    !terminal ||
    !replication ||
    replication.disposed ||
    replication.agentId !== agentId ||
    replication.replayState.recovering ||
    (
      normalizedDimensions.cols === replication.lastResizeCols &&
      normalizedDimensions.rows === replication.lastResizeRows
    )
  ) return;
  if (terminal.cols !== normalizedDimensions.cols || terminal.rows !== normalizedDimensions.rows) {
    replication.applyingLocalResize = true;
    try {
      terminal.resize(normalizedDimensions.cols, normalizedDimensions.rows);
    } finally {
      replication.applyingLocalResize = false;
    }
  }
  const delivered = getSessionClient()?.resizeAgent(
    agentId,
    normalizedDimensions.cols,
    normalizedDimensions.rows
  );
  if (delivered) {
    replication.lastResizeCols = normalizedDimensions.cols;
    replication.lastResizeRows = normalizedDimensions.rows;
  }
}

function scheduleCrtTerminalFitResize(replication, agentId, normalizedDimensions) {
  if (replication.fitResizeTimer) clearTimeout(replication.fitResizeTimer);
  replication.pendingFitResize = normalizedDimensions;
  replication.fitResizeTimer = setTimeout(() => {
    replication.fitResizeTimer = null;
    const next = replication.pendingFitResize;
    replication.pendingFitResize = null;
    if (
      !next ||
      replication.disposed ||
      crtTerminalReplication !== replication ||
      replication.agentId !== agentId
    ) return;
    commitCrtTerminalResize(agentId, next);
  }, CRT_TERMINAL_RESIZE_SETTLE_MS);
}

function sendSessionResize(agentId = focusedAgentId, requestedDimensions = null) {
  const replication = crtTerminalReplication;
  if (
    !agentId ||
    !terminal ||
    !fitAddon ||
    !replication ||
    replication.agentId !== agentId ||
    replication.replayState.recovering
  ) return;
  const dimensions = requestedDimensions || (
    typeof fitAddon.proposeDimensions === 'function'
      ? fitAddon.proposeDimensions()
      : null
  );
  const normalizedDimensions = dimensions && {
    cols: Math.floor(Number(dimensions.cols)),
    rows: Math.floor(Number(dimensions.rows))
  };
  if (
    !normalizedDimensions ||
    !Number.isFinite(normalizedDimensions.cols) ||
    !Number.isFinite(normalizedDimensions.rows) ||
    normalizedDimensions.cols < CRT_TERMINAL_MIN_COLS ||
    normalizedDimensions.rows < CRT_TERMINAL_MIN_ROWS
  ) return;
  if (!requestedDimensions) {
    if (
      normalizedDimensions.cols === replication.lastResizeCols &&
      normalizedDimensions.rows === replication.lastResizeRows
    ) {
      clearPendingCrtTerminalFitResize(replication);
      return;
    }
    scheduleCrtTerminalFitResize(replication, agentId, normalizedDimensions);
    return;
  }
  clearPendingCrtTerminalFitResize(replication);
  commitCrtTerminalResize(agentId, normalizedDimensions);
}

async function refreshSessionView(_forceReplace = false, expectedAgentId = focusedAgentId, expectedSessionToken = getCurrentSessionToken()) {
  if (!expectedAgentId || !terminal) return;

  const runtime = getSessionRuntime();
  const replication = crtTerminalReplication;
  if (
    !replication ||
    replication.agentId !== expectedAgentId ||
    replication.replayState.halted ||
    replication.checkpointRetryTimer ||
    replication.checkpointInFlight
  ) return;

  const checkpointSeq = replication.checkpointSeq + 1;
  replication.checkpointSeq = checkpointSeq;
  replication.checkpointInFlight = true;
  TERMINAL_REPLAY.beginRecovery(replication.replayState);
  const controller = new globalThis.AbortController();
  replication.checkpointAbortController = controller;
  const timeout = setTimeout(
    () => controller.abort(),
    CRT_TERMINAL_CHECKPOINT_REQUEST_TIMEOUT_MS
  );

  try {
    const sessionClient = getSessionClient();
    if (!sessionClient) throw new Error('Terminal session client is unavailable');
    const payload = await sessionClient.getSessionView(expectedAgentId, {
      signal: controller.signal
    });
    if (
      !crtTerminalReplication ||
      crtTerminalReplication !== replication ||
      replication.checkpointSeq !== checkpointSeq
    ) return;
    if (runtime && !runtime.isCurrentSession(expectedAgentId, expectedSessionToken)) return;

    const currentAgent = state && state.agents
      ? state.agents.find((agent) => agent.id === expectedAgentId)
      : null;
    installCrtTerminalCheckpoint(normalizeSessionViewPayload(payload, currentAgent));
  } catch (error) {
    if (
      crtTerminalReplication === replication &&
      replication.checkpointSeq === checkpointSeq
    ) {
      retryCrtTerminalReplayAfterFailure(
        replication,
        TERMINAL_REPLAY.recordTransportFailure(replication.replayState),
        error
      );
    }
  } finally {
    clearTimeout(timeout);
    if (
      crtTerminalReplication === replication &&
      replication.checkpointSeq === checkpointSeq
    ) {
      replication.checkpointInFlight = false;
      replication.checkpointAbortController = null;
      finishCrtTerminalReplay(replication);
    }
  }
}
function startSessionViewPolling(agentId = focusedAgentId, sessionToken = getCurrentSessionToken()) {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.startPolling({ agentId, sessionToken });
    return null;
  }
  return null;
}

function stopSessionViewPolling() {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.stopPolling();
    return;
  }
}

if (typeof document !== 'undefined') {
  window.addEventListener('resize', () => {
    if (crtMainView === 'history') renderCrtHistory();
    if (crtMainView === 'search') renderCrtSearch();
    if (crtMainView === 'billing') {
      drawCrtBillingScope();
      window.requestAnimationFrame(() => scrollCrtBillingSelectedDayIntoView());
    }
    if (crtMainView === 'agents' && state) {
      if (crtAgentPageResizeFrame !== null) window.cancelAnimationFrame(crtAgentPageResizeFrame);
      crtAgentPageResizeFrame = window.requestAnimationFrame(() => {
        crtAgentPageResizeFrame = null;
        renderCrtDashboardIfNeeded(true);
      });
    }
    if (!terminal || !fitAddon || !focusedAgentId) return;

    sendSessionResize();
  });

  document.addEventListener('keydown', (event) => {
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    if (!sessionActive || !isCrtRuntimeSwitchShortcut(event)) return;
    const agent = state && state.agents.find((candidate) => candidate.id === focusedAgentId);
    if (!canSwitchCrtAgentRuntime(agent)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleCrtSessionRuntimeMode();
  }, true);

  document.addEventListener('keydown', (e) => {
    const dialogActive = document.getElementById('input-dialog').classList.contains('active');
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    const settingsActive = document.getElementById('settings-modal').classList.contains('active');
    const workspaceInputVisible = document.getElementById('workspace-input-container').style.display !== 'none';
    const workspaceInputFocused = document.activeElement === document.getElementById('workspace-input');
    const terminalFontSizeInputFocused = settingsActive
      && document.activeElement === document.getElementById('crt-terminal-font-size');
    const searchInputFocused = crtMainView === 'search'
      && document.activeElement === document.getElementById('crt-search-input');
    const navigationArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
    const billingHourCellFocused = crtMainView === 'billing'
      && document.activeElement?.classList?.contains('billing-day-hour-cell');

    if (terminalFontSizeInputFocused && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (searchInputFocused) return;
    if (billingHourCellFocused && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

    if (
      crtMainView === 'billing'
      && !sessionActive
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && navigationArrow
      && selectCrtBillingDayByArrow(e.key)
    ) {
      e.preventDefault();
      return;
    }

    if (
      crtMainView === 'history'
      && !sessionActive
      && !workspaceInputFocused
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      changeCrtHistoryPage(e.key === 'ArrowRight' ? 1 : -1);
      e.preventDefault();
      return;
    }

    if (
      !sessionActive
      && !workspaceInputFocused
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      && moveCrtAgentPageSelection(e.key)
    ) {
      e.preventDefault();
      return;
    }

    if (
      !sessionActive
      && !workspaceInputFocused
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && navigationArrow
      && moveCrtNavigationSelection(e.key)
    ) {
      e.preventDefault();
      return;
    }

    if (
      crtMainView === 'history'
      && !sessionActive
      && !workspaceInputFocused
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      && changeCrtHistoryPage(e.key === 'ArrowDown' ? 1 : -1)
    ) {
      e.preventDefault();
      return;
    }

    if (
      !sessionActive
      && !workspaceInputFocused
      && !e.ctrlKey
      && !e.metaKey
      && !e.altKey
      && e.key === 'Enter'
      && activateCrtNavigationSelection()
    ) {
      e.preventDefault();
      return;
    }

    if (settingsActive) {
      const themeOptions = getUiThemeOptions();
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9) {
        const index = num - 1;
        if (index < themeOptions.length) {
          activateUiTheme(themeOptions[index].id);
          e.preventDefault();
          return;
        }
      }
      if (e.key === '0' && themeOptions.length >= 10) {
        activateUiTheme(themeOptions[9].id);
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape') {
        hideSettings();
        e.preventDefault();
        return;
      }
    }

    if (dialogActive) {
      if (workspaceInputVisible) {
        if (workspaceInputFocused) {
          return;
        }
        if (e.key === 'ArrowDown') {
          if (moveWorkspaceHistorySelection(1)) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'ArrowUp') {
          if (moveWorkspaceHistorySelection(-1)) {
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Enter') {
          confirmStartAgent();
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          backToAgentList();
          e.preventDefault();
          return;
        }
      } else {
        if (agents.length > 0) {
          const num = parseInt(e.key);
          if (num >= 1 && num <= 9) {
            const index = num - 1;
            if (index < agents.length) {
              selectAgent(index);
              e.preventDefault();
              return;
            }
          }
          if (e.key === '0' && agents.length >= 10) {
            selectAgent(9);
            e.preventDefault();
            return;
          }
        }
        if (e.key === 'Escape') {
          hideInputDialog();
          e.preventDefault();
          return;
        }
      }
    }

    if (e.key === 'n' || e.key === 'N') {
      if (!dialogActive && !sessionActive) {
        showInputDialog();
        e.preventDefault();
      }
    }

    if (e.key === 'h' || e.key === 'H') {
      if (!dialogActive && !sessionActive && !settingsActive) {
        showHistory();
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'f' || e.key === 'F') {
      if (!dialogActive && !sessionActive && !settingsActive) {
        showCrtSearch();
        e.preventDefault();
        return;
      }
    }

    if (e.key === '$' || (e.key === '4' && e.shiftKey)) {
      if (!dialogActive && !sessionActive && !settingsActive) {
        showCrtBilling();
        e.preventDefault();
        return;
      }
    }

    if ((e.key === 'r' || e.key === 'R') && crtMainView === 'billing') {
      if (!dialogActive && !sessionActive && !settingsActive) {
        refreshCrtBilling();
        e.preventDefault();
        return;
      }
    }

    if ((e.key === 'd' || e.key === 'D') && crtMainView === 'billing') {
      setCrtBillingMode('days');
      e.preventDefault();
      return;
    }

    if ((e.key === 'l' || e.key === 'L') && crtMainView === 'billing') {
      setCrtBillingMode('live');
      e.preventDefault();
      return;
    }

    if (e.key === '0') {
      if (!dialogActive && !sessionActive && crtMainView === 'agents' && state && state.mainAgentId) {
        openSession(state.mainAgentId);
        e.preventDefault();
      }
    }

    if (e.key === 's' || e.key === 'S') {
      if (!dialogActive && !sessionActive && !settingsActive) {
        showSettings();
        e.preventDefault();
      }
    }

    if (sessionActive) {
      const structuredInput = document.getElementById('crt-structured-input');
      const structuredInputFocused = structuredInput && document.activeElement === structuredInput;
      const structuredSessionActive = document.getElementById('crt-structured-composer')?.classList.contains('active');
      const structuredTranscriptFocused = document.activeElement === document.getElementById('terminal-output');
      const structuredToolFocused = Boolean(document.activeElement?.closest?.('.crt-structured-tool'));
      const structuredMenuItemFocused = Boolean(document.activeElement?.closest?.('.crt-structured-menu-item'));
      const focusedAgent = state && state.agents.find((candidate) => candidate.id === focusedAgentId);
      const structuredInterruptFocused = Boolean(
        structuredInputFocused
        && structuredComposerAction(focusedAgent, structuredInput.value) === 'interrupt'
      );
      const sessionCommand = resolveCrtSessionKeyboardCommand(e, {
        structuredSessionActive,
        composing: e.isComposing,
        structuredInputFocused,
        structuredTranscriptFocused,
        structuredToolFocused,
        structuredMenuItemFocused,
        structuredInterruptFocused,
        structuredComposerMenuOpen: Boolean(structuredComposerMenu),
      });
      if (sessionCommand) {
        e.preventDefault();
        e.stopPropagation();
        if (sessionCommand === 'kill') killCurrentAgent();
        else closeSession();
        return;
      }
      if (structuredInputFocused) {
        return;
      }
      if (isCopyShortcut(e)) {
        if (hasAnySelection()) {
          e.preventDefault();
          e.stopPropagation();
          copyTerminalSelection();
          return;
        }
        if (e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          sendTerminalInput('\x03');
          return;
        }
        return;
      }
      if (isPasteShortcut(e)) {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (isBrowserShortcut(e)) {
        return;
      }
      return;
    }

    if (e.key === 'Escape' && crtMainView === 'history') {
      hideHistory();
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape' && crtMainView === 'search') {
      hideCrtSearch();
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape' && crtMainView === 'billing') {
      hideCrtBilling();
      e.preventDefault();
      return;
    }

    if (e.key === 'Escape' && crtNavigationKey) {
      clearCrtNavigationSelection();
      e.preventDefault();
      return;
    }

    if (keyMap[e.key] && !sessionActive && !dialogActive && crtMainView === 'agents') {
      openSession(keyMap[e.key]);
      e.preventDefault();
    }

  }, true);

  document.addEventListener('copy', (e) => {
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    if (!sessionActive) {
      return;
    }

    if (e.target && e.target.closest && e.target.closest('#crt-structured-composer')) {
      return;
    }

    const text = getTerminalSelectionText() || getDocumentSelectionText();
    if (!text) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    setClipboardText(e, text);
  }, true);

  document.addEventListener('paste', (e) => {
    const sessionActive = document.getElementById('session-modal').classList.contains('active');
    if (!sessionActive) {
      return;
    }

    if (e.target && e.target.closest && e.target.closest('#crt-structured-composer')) {
      return;
    }

    // xterm owns paste events targeting its textarea. Calling terminal.paste()
    // here as well would submit the same clipboard text twice.
    if (isCrtNativeTerminalPasteTarget(e.target)) {
      return;
    }

    const pastedText = e.clipboardData && e.clipboardData.getData
      ? e.clipboardData.getData('text/plain')
      : '';

    if (!pastedText) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    void pasteTerminalText(pastedText);
  }, true);

}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildCrtHistoryItems,
    buildCrtSearchResults,
    buildCrtStructuredPreview,
    calculateCrtAgentPageLayout,
    calculateCrtHistoryPageSize,
    crtHistoryAgentName,
    normalizeCrtTerminalFontSize,
    crtAgentSessionKey,
    crtResumedSessionFromSource,
    crtDashboardStateSignature,
    findDefaultNewAgentIndex,
    findDirectionalNavigationIndex,
    isBrowserShortcut,
    isCopyShortcut,
    isCrtNativeTerminalPasteTarget,
    isPasteShortcut,
    shouldUseLiveSessionText,
    shouldPollSessionView,
    deriveSessionTextPatch,
    replaceTerminalOutput,
    normalizeSessionViewPayload,
    deriveSessionStreamPatch,
    formatSystemClock,
    formatCrtTokenRate,
    formatCrtHistoryAge,
    formatCrtCompactTotalValue,
    getCrtHistoryPage,
    getCrtAgentPage,
    getCrtAgentVerticalPageTarget,
    getCrtLiveAgents,
    getCrtRegularAgents,
    getCrtAgentRemovalFallback,
    getAgentDisplayText,
    getCrtPreviewCellStyle,
    getCrtTerminalSnapshotRows,
    getCrtAgentTitle,
    getCrtProjectName,
    getCrtTerminalFontSize,
    isCrtAgentWorking,
    isCrtLiveAgent,
    getCrtAgentReadPatch,
    crtRuntimeView,
    canSwitchCrtAgentRuntime,
    isCrtRuntimeSwitchShortcut,
    hasCrtStructuredLocalEscapeAction,
    resolveCrtSessionKeyboardCommand,
    structuredComposerAction,
    structuredTranscriptTurns,
    crtStructuredPreviewMessageLines,
    getCrtBrandPaneKey,
    extractSessionLinks,
    formatSelectionStatus,
    deriveSessionSearchMatchesFromLines,
    buildWorkspaceHistory,
    shouldRememberWorkspace,
    normalizeWorkspaceValue,
    needsMainAgent,
    getDefaultWorkspaceForDialog,
    resolveWorkspaceToStart,
    requestedCrtAgentId,
    createSessionModalState,
    getSessionModalDomState
  };
} else {
  installCrtTerminalTestApi();
  setupWorkspaceHistoryControls();
  setupCrtSearchControls();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') suspendCrtPageConnection();
    else resumeCrtPageConnection();
  });
  window.addEventListener('pagehide', suspendCrtPageConnection);
  window.addEventListener('pageshow', resumeCrtPageConnection);
  connect();
}
