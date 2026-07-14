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
let billingCanvasFrame = null;
let billingMode = 'days';
let billingSelectedDate = '';
let billingDailyRenderSignature = '';
let billingDayDetail = null;
let billingDayDetailLoading = false;
let billingDayDetailError = '';
let billingDayDetailRequestSequence = 0;
let billingDayDetailAbortController = null;
const billingDayDetailCache = new Map();
let crtAgentPage = 0;
let crtAgentPageSize = 1;
let crtAgentPageColumns = 1;
let crtAgentPageResizeFrame = null;
let dashboardRenderDeferred = false;
let lastCrtDashboardSignature = '';
let crtPreviewRenderTimer = null;
const pendingCrtPreviewRenders = new Map();
let sessionRuntime = null;
let legacySessionPoller = null;
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
let terminalInputBridge = null;
let terminalInputComposing = false;
let terminalInputLastBackspaceAt = 0;
let terminalInputLastDeleteAt = 0;
let terminalInputPendingTexts = [];
const terminalPreviewSnapshots = new Map();
const crtBrandPulseTimers = new Map();
const SESSION_INPUT_SETTINGS = {
  // xterm's native textarea is the same low-latency input path used by Farming Code.
  imeEnabled: false
};
const SESSION_LINK_LIMIT = 6;
const CRT_PREVIEW_RENDER_INTERVAL_MS = 1000;
const CRT_AGENT_CARD_MIN_WIDTH = 200;
const CRT_AGENT_CARD_MIN_HEIGHT = 160;
const CRT_AGENT_GRID_GAP = 15;
const CRT_AGENT_GRID_PADDING = 20;
const CRT_SEARCH_DEBOUNCE_MS = 180;
const CRT_SEARCH_RESULT_LIMIT = 100;
const CRT_BILLING_REFRESH_MS = 30_000;
const CRT_BILLING_DAY_DETAIL_CACHE_MS = 30_000;
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
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
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
    && agent.archived !== true
    && agent.status !== 'dead'
    && agent.status !== 'stopped'
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

function destroyTerminalInputBridge() {
  if (terminalInputBridge) {
    terminalInputBridge.remove();
    terminalInputBridge = null;
  }
  clearPendingPrintableInput();
  terminalInputComposing = false;
  document.body.removeAttribute('data-ime-input-focused');
  document.body.removeAttribute('data-ime-composing');
}

function clearPendingPrintableInput() {
  terminalInputPendingTexts.forEach((pending) => {
    clearTimeout(pending.timeoutId);
  });
  terminalInputPendingTexts = [];
}

function resetTerminalInputBridgeValue() {
  if (!terminalInputBridge) return;
  terminalInputBridge.value = ' ';
  terminalInputBridge.setSelectionRange(1, 1);
}

function schedulePrintableInput(text) {
  const pending = {
    text,
    timeoutId: setTimeout(() => {
      if (!terminalInputComposing) {
        sendTerminalInput(text);
        resetTerminalInputBridgeValue();
      }
      terminalInputPendingTexts = terminalInputPendingTexts.filter((item) => item !== pending);
    }, 0)
  };
  terminalInputPendingTexts.push(pending);
}

function focusTerminalInputBridge() {
  if (!SESSION_INPUT_SETTINGS.imeEnabled) return;
  if (!terminalInputBridge) return;
  if (isOverlayBlockingTerminalInput()) return;
  syncTerminalInputBridgePosition();
  terminalInputBridge.focus();
  resetTerminalInputBridgeValue();
}

function isOverlayBlockingTerminalInput() {
  const inputDialog = document.getElementById('input-dialog');
  if (inputDialog && inputDialog.classList.contains('active')) {
    return true;
  }

  const settingsModal = document.getElementById('settings-modal');
  if (settingsModal && settingsModal.classList.contains('active')) {
    return true;
  }

  return false;
}

function focusSessionTerminal() {
  if (terminal && typeof terminal.focus === 'function') {
    terminal.focus();
  }
  focusTerminalInputBridge();
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

  sendTerminalInput(text.replace(/\r\n/g, '\n'));
  focusSessionTerminal();
  return true;
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

function routeSessionKey(event) {
  if (!focusedAgentId || terminalInputComposing || isBrowserShortcut(event)) {
    return false;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== 'Enter') {
    const controlChar = getControlChar(event.key);
    if (controlChar) {
      sendTerminalInput(controlChar);
      return true;
    }
  }

  const sequence = getTerminalSequenceForKey(event);
  if (sequence) {
    sendTerminalInput(sequence);
    return true;
  }

  return false;
}

function getControlChar(key) {
  const lower = key.toLowerCase();
  if (!/^[a-z]$/.test(lower)) return null;
  return String.fromCharCode(lower.charCodeAt(0) - 96);
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

function getTerminalSequenceForKey(event) {
  const { key, shiftKey, altKey, ctrlKey, metaKey } = event;

  if (metaKey) return null;

  if (altKey && !ctrlKey) {
    if (key === 'ArrowLeft') return '\x1bb';
    if (key === 'ArrowRight') return '\x1bf';
    if (key === 'Backspace') return '\x17';
  }

  switch (key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return shiftKey ? '\x1b[Z' : '\t';
    case 'Delete':
      return '\x1b[3~';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'PageUp':
      return '\x1b[5~';
    case 'PageDown':
      return '\x1b[6~';
    default:
      return null;
  }
}

function setupTerminalInputBridge() {
  destroyTerminalInputBridge();

  if (!SESSION_INPUT_SETTINGS.imeEnabled) {
    return;
  }

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('inputmode', 'text');
  input.setAttribute('aria-hidden', 'true');
  input.style.position = 'absolute';
  input.style.top = '0';
  input.style.left = '0';
  input.style.width = '200px';
  input.style.height = '24px';
  input.style.opacity = '0.01';
  input.style.background = 'transparent';
  input.style.color = 'transparent';
  input.style.caretColor = 'transparent';
  input.style.border = 'none';
  input.style.outline = 'none';
  input.style.fontSize = `${getCrtTerminalFontSize()}px`;
  input.style.fontFamily = TERMINAL_FONT_FAMILY;
  input.style.pointerEvents = 'none';
  input.style.zIndex = '2';

  input.addEventListener('compositionstart', () => {
    syncTerminalInputBridgePosition();
    clearPendingPrintableInput();
    terminalInputComposing = true;
    document.body.setAttribute('data-ime-composing', 'true');
  });

  input.addEventListener('compositionend', (event) => {
    terminalInputComposing = false;
    document.body.removeAttribute('data-ime-composing');
    clearPendingPrintableInput();
    if (event.data) {
      sendTerminalInput(event.data);
    }
    resetTerminalInputBridgeValue();
  });

  input.addEventListener('compositionupdate', syncTerminalInputBridgePosition);

  input.addEventListener('beforeinput', (event) => {
    if (terminalInputComposing) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'insertText' && inputEvent.data) {
      clearPendingPrintableInput();
      event.preventDefault();
      sendTerminalInput(inputEvent.data);
      resetTerminalInputBridgeValue();
    }
  });

  input.addEventListener('input', (event) => {
    if (terminalInputComposing) {
      return;
    }

    const inputEvent = event;
    if (inputEvent.inputType === 'deleteContentBackward') {
      clearPendingPrintableInput();
      const now = Date.now();
      if (now - terminalInputLastBackspaceAt > 50) {
        sendTerminalInput('\x7f');
      }
      terminalInputLastBackspaceAt = now;
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    if (inputEvent.inputType === 'deleteContentForward') {
      clearPendingPrintableInput();
      const now = Date.now();
      if (now - terminalInputLastDeleteAt > 50) {
        sendTerminalInput('\x1b[3~');
      }
      terminalInputLastDeleteAt = now;
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    clearPendingPrintableInput();
    resetTerminalInputBridgeValue();
  });

  input.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) {
      return;
    }

    if (isOverlayBlockingTerminalInput()) {
      return;
    }

    if (isBrowserShortcut(event)) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Escape') {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
      return;
    }

    if (terminalInputComposing) {
      return;
    }

    if (['Enter', 'Tab', 'Escape'].includes(event.key)) {
      event.preventDefault();
    }

    if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1 && event.key !== 'Enter') {
      clearPendingPrintableInput();
      const controlChar = getControlChar(event.key);
      if (controlChar) {
        event.preventDefault();
        sendTerminalInput(controlChar);
        resetTerminalInputBridgeValue();
      }
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      schedulePrintableInput(event.key);
      return;
    }

    if (event.key === 'Backspace') {
      clearPendingPrintableInput();
      terminalInputLastBackspaceAt = Date.now();
      sendTerminalInput('\x7f');
      requestAnimationFrame(() => {
        if (document.activeElement === input) {
          resetTerminalInputBridgeValue();
        }
      });
      return;
    }

    const sequence = getTerminalSequenceForKey(event);
    if (!sequence) {
      return;
    }

    if (event.key === 'Delete') {
      terminalInputLastDeleteAt = Date.now();
    }

    event.preventDefault();
    sendTerminalInput(sequence);
    if (event.key !== 'Tab') {
      resetTerminalInputBridgeValue();
    }
  });

  input.addEventListener('focus', () => {
    document.body.setAttribute('data-ime-input-focused', 'true');
    requestAnimationFrame(() => {
      if (document.activeElement === input) {
        resetTerminalInputBridgeValue();
      }
    });
  });

  input.addEventListener('blur', () => {
    document.body.removeAttribute('data-ime-input-focused');
    setTimeout(() => {
      const sessionActive = document.getElementById('session-modal')?.classList.contains('active');
      if (!sessionActive || terminalInputComposing || !terminalInputBridge || isOverlayBlockingTerminalInput()) {
        return;
      }
      focusTerminalInputBridge();
    }, 0);
  });

  const sessionModal = document.getElementById('session-modal');
  if (sessionModal) {
    sessionModal.appendChild(input);
  } else {
    document.body.appendChild(input);
  }
  terminalInputBridge = input;
  syncTerminalInputBridgePosition();
}

function calculateTerminalInputBridgePosition(cursor, dimensions, screenRect, parentRect) {
  if (!cursor || !dimensions || !screenRect || !parentRect) return null;
  if (dimensions.cols <= 0 || dimensions.rows <= 0) return null;

  const cellWidth = screenRect.width / dimensions.cols;
  const cellHeight = screenRect.height / dimensions.rows;
  return {
    left: Math.max(0, screenRect.left - parentRect.left + cursor.x * cellWidth),
    top: Math.max(0, screenRect.top - parentRect.top + cursor.y * cellHeight),
    height: Math.max(getCrtTerminalFontSize() + 2, cellHeight)
  };
}

function syncTerminalInputBridgePosition() {
  if (!terminalInputBridge || !terminal) return;
  const sessionModal = document.getElementById('session-modal');
  const terminalElement = terminal.element;
  const screen = terminalElement && terminalElement.querySelector
    ? terminalElement.querySelector('.xterm-screen')
    : null;
  const activeBuffer = terminal.buffer && terminal.buffer.active;
  if (!sessionModal || !(screen instanceof HTMLElement) || !activeBuffer) return;

  const position = calculateTerminalInputBridgePosition(
    { x: activeBuffer.cursorX, y: activeBuffer.cursorY },
    { cols: terminal.cols, rows: terminal.rows },
    screen.getBoundingClientRect(),
    sessionModal.getBoundingClientRect()
  );
  if (!position) return;

  terminalInputBridge.style.left = `${position.left}px`;
  terminalInputBridge.style.top = `${position.top}px`;
  terminalInputBridge.style.height = `${position.height}px`;
  terminalInputBridge.style.lineHeight = `${position.height}px`;
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

function showCrtWebglFailure(error) {
  const terminalContainer = document.getElementById('terminal-output');
  if (!terminalContainer) return;
  terminalContainer.querySelector('.crt-webgl-error')?.remove();
  const panel = document.createElement('div');
  panel.className = 'crt-webgl-error';
  const title = document.createElement('strong');
  title.textContent = 'CRT WEBGL ERROR';
  const message = document.createElement('span');
  message.textContent = error && error.message
    ? error.message
    : 'Farming CRT requires WebGL2 hardware acceleration.';
  const detail = document.createElement('small');
  detail.textContent = 'The Agent is still running. Close and reopen this terminal after WebGL is available.';
  panel.append(title, message, detail);
  terminalContainer.appendChild(panel);
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

function renderCrtTerminalSnapshot(container, snapshot) {
  if (!container || !snapshot || !Array.isArray(snapshot.cells)) return false;
  container.classList.add('terminal-snapshot');
  snapshot.cells.forEach((cells) => {
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

function updateCrtAgentPreviewCard(agent) {
  if (typeof document === 'undefined' || !agent) return false;
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

  const outputTail = document.createElement('div');
  outputTail.className = 'agent-output-tail';
  const cleanOutput = getAgentDisplayText(agent);
  if (!renderCrtTerminalSnapshot(outputTail, agent.previewSnapshot)) {
    outputTail.textContent = isMain
      ? cleanOutput.slice(-150) || 'No output yet...'
      : cleanOutput || 'No output yet...';
  }
  output.replaceChildren(outputTail);
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
    if (!updateCrtAgentPreviewCard(agent)) {
      if (agent.id !== state.mainAgentId && !isCrtAgentOnCurrentPage(agent.id)) {
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
  if (
    agent.providerSessionProvider === 'codex' &&
    agent.codexRuntimeMode === 'app-server' &&
    ['working', 'waiting-for-input', 'interrupting'].includes(agent.codexAppServerState || '')
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
    outputSeq: Number.isFinite(session.outputSeq) ? session.outputSeq : null,
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

function applySessionReplayCursorVisibility(text, sessionView, agent) {
  if (!text) return text;
  if (/\x1b\[\?25[hl]/.test(text)) return text;

  const snapshotVisibility = sessionView
    && sessionView.previewSnapshot
    && sessionView.previewSnapshot.cursorVisible;
  if (typeof snapshotVisibility === 'boolean') {
    return `${text}\x1b[?25${snapshotVisibility ? 'h' : 'l'}`;
  }

  // Compatibility for a live native PTY host started before cursor visibility
  // was added to snapshots. Claude's TUI paints its own input cursor and hides
  // the hardware cursor, so its replay must not expose xterm's default cursor.
  return crtCommandProgram(agent && agent.command) === 'claude'
    ? `${text}\x1b[?25l`
    : text;
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
  return sessionSource === 'live-text';
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
      schedulePoll: (handler) => setInterval(handler, 350),
      clearPoll: (poller) => clearInterval(poller)
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

function isAwaitingInitialSessionSync() {
  const runtime = getSessionRuntime();
  return runtime ? runtime.isAwaitingInitialSync() : false;
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
  if (terminalInputBridge) terminalInputBridge.style.fontSize = `${fontSize}px`;
  if (terminal && fitAddon && focusedAgentId && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      if (!terminal || !fitAddon || !focusedAgentId) return;
      fitAddon.fit();
      syncTerminalInputBridgePosition();
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

function crtBillingLogPosition(value, minimum, maximum) {
  const total = Math.max(0, Number(value) || 0);
  if (total <= 0) return 0;
  if (total <= minimum || maximum <= minimum) return 2;
  const position = (Math.log10(total) - Math.log10(minimum))
    / (Math.log10(maximum) - Math.log10(minimum)) * 100;
  return Math.max(2, Math.min(100, position));
}

function crtBillingLogGuideValues(minimum, maximum) {
  const values = [];
  const firstExponent = Math.ceil(Math.log10(Math.max(1, minimum)));
  const lastExponent = Math.floor(Math.log10(Math.max(1, maximum)));
  for (let exponent = firstExponent; exponent <= lastExponent; exponent += 1) {
    const value = 10 ** exponent;
    if (value > minimum && value < maximum) values.push(value);
  }
  const upperThird = 3 * (10 ** lastExponent);
  if (upperThird > minimum && upperThird < maximum) values.push(upperThird);
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

function crtBillingHourlyPath(hours, valueForHour, maximum) {
  const width = 600;
  const height = 120;
  const points = Array.isArray(hours) ? hours : [];
  if (points.length === 0 || maximum <= 0) return '';
  return points.map((hour, index) => {
    const x = points.length === 1 ? 0 : index / (points.length - 1) * width;
    const value = Math.max(0, Number(valueForHour(hour)) || 0);
    const y = height - Math.min(1, value / maximum) * height;
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
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
  const shares = document.getElementById('billing-day-provider-shares');
  const maximum = Math.max(0, ...hours.map(hour => Math.max(0, Number(hour && hour.totalTokens) || 0)));

  if (totalPath) totalPath.setAttribute('d', crtBillingHourlyPath(hours, hour => hour.totalTokens, maximum));
  if (cachePath) cachePath.setAttribute('d', crtBillingHourlyPath(
    hours,
    hour => (Number(hour.cacheReadTokens) || 0) + (Number(hour.cacheWriteTokens) || 0),
    maximum,
  ));
  if (scale) scale.textContent = maximum > 0 ? `${formatCrtUsageValue(maximum)} TOK/H PEAK` : '-- TOK/H PEAK';
  if (maximumLabel) maximumLabel.textContent = maximum > 0 ? formatCrtUsageValue(maximum) : '--';
  if (state) {
    state.classList.toggle('is-error', Boolean(billingDayDetailError));
    state.textContent = billingDayDetailError
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

function renderCrtBillingSelectedDay() {
  const daily = billingSummary && billingSummary.daily;
  const point = crtBillingDayPoint();
  const date = document.getElementById('billing-day-date');
  const stateLabel = document.getElementById('billing-day-state');
  const total = document.getElementById('billing-day-total');
  const compactTotal = document.getElementById('billing-day-total-compact');
  const input = document.getElementById('billing-day-input');
  const output = document.getElementById('billing-day-output');
  const cacheRead = document.getElementById('billing-day-cache-read');
  const cacheWrite = document.getElementById('billing-day-cache-write');
  const providers = document.getElementById('billing-day-providers');
  if (date) date.textContent = crtBillingDayLabel(point && point.date);
  if (total) total.textContent = formatCrtExactUsageValue(point && point.totalTokens);
  if (compactTotal) compactTotal.textContent = formatCrtCompactTotalValue(point && point.totalTokens);
  if (input) input.textContent = formatCrtExactUsageValue(point && point.inputTokens);
  if (output) output.textContent = formatCrtExactUsageValue(point && point.outputTokens);
  if (cacheRead) cacheRead.textContent = formatCrtExactUsageValue(point && point.cacheReadTokens);
  if (cacheWrite) cacheWrite.textContent = formatCrtExactUsageValue(point && point.cacheWriteTokens);
  if (providers) {
    const providerTotals = point && point.providers ? Object.entries(point.providers) : [];
    providers.textContent = providerTotals
      .map(([provider, usage]) => `${provider.toUpperCase()} ${formatCrtExactUsageValue(usage && usage.totalTokens)}`)
      .join(' · ') || '--';
    providers.title = providers.textContent;
  }
  if (stateLabel) {
    const isToday = Boolean(daily && point && point.date === daily.endDate);
    const notes = [isToday ? 'PARTIAL DAY' : 'COMPLETE DAY', 'INCL CACHE'];
    if (daily && daily.partial) notes.push('PARTIAL SOURCE');
    if (point && Number(point.unattributedTokens) > 0) {
      notes.push(`${formatCrtUsageValue(point.unattributedTokens)} UNCLASSIFIED`);
    }
    stateLabel.textContent = point ? notes.join(' · ') : 'LOCAL HISTORY';
  }
  document.querySelectorAll('#billing-daily-bars .billing-daily-column').forEach((cell) => {
    const selected = cell.dataset.date === billingSelectedDate;
    cell.classList.toggle('selected', selected);
    cell.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  renderCrtBillingDayInsight();
}

function selectCrtBillingDay(dateValue, { focus = false } = {}) {
  if (!crtBillingDayPoint(dateValue)) return false;
  billingSelectedDate = dateValue;
  billingDayDetail = billingDayDetailCache.get(dateValue)?.detail || null;
  billingDayDetailError = '';
  renderCrtBillingSelectedDay();
  void loadCrtBillingDayDetail(dateValue);
  if (focus) {
    const cell = document.querySelector(`#billing-daily-bars .billing-daily-column[data-date="${dateValue}"]`);
    if (cell) {
      cell.focus({ preventScroll: true });
      scrollCrtBillingSelectedDayIntoView();
    }
  }
  return true;
}

async function loadCrtBillingDayDetail(dateValue, { force = false } = {}) {
  const date = String(dateValue || '').trim();
  if (!crtBillingDayPoint(date)) return;
  const cachedEntry = billingDayDetailCache.get(date);
  const cached = cachedEntry && cachedEntry.detail;
  const cacheFresh = cachedEntry && Date.now() - cachedEntry.fetchedAt <= CRT_BILLING_DAY_DETAIL_CACHE_MS;
  if (cached && cacheFresh && !force) {
    if (billingSelectedDate === date) {
      billingDayDetail = cached;
      billingDayDetailLoading = false;
      billingDayDetailError = '';
      renderCrtBillingDayInsight();
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
    billingDayDetail = null;
    renderCrtBillingDayInsight();
  }
  try {
    const response = await fetch(farmingApiPath(`/usage/day?date=${encodeURIComponent(date)}`), {
      signal: controller.signal,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.detail) {
      throw new Error(data && data.error ? data.error : `Usage day request failed (${response.status})`);
    }
    if (requestSequence !== billingDayDetailRequestSequence) return;
    billingDayDetailCache.set(date, { detail: data.detail, fetchedAt: Date.now() });
    if (billingSelectedDate === date) billingDayDetail = data.detail;
  } catch (error) {
    if (controller.signal.aborted || requestSequence !== billingDayDetailRequestSequence) return;
    if (billingSelectedDate === date) {
      billingDayDetailError = error instanceof Error ? error.message : 'Failed to load selected day';
    }
  } finally {
    if (requestSequence === billingDayDetailRequestSequence) {
      billingDayDetailLoading = false;
      billingDayDetailAbortController = null;
      if (billingSelectedDate === date) renderCrtBillingDayInsight();
    }
  }
}

function scrollCrtBillingSelectedDayIntoView() {
  const scroll = document.getElementById('billing-daily-scroll');
  const cell = billingSelectedDate
    ? document.querySelector(`#billing-daily-bars .billing-daily-column[data-date="${billingSelectedDate}"]`)
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
  setValue('billing-today-total', totals.todayTokens);
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

  const bars = document.getElementById('billing-daily-bars');
  const xAxis = document.getElementById('billing-daily-x-axis');
  const yAxis = document.getElementById('billing-y-axis');
  const guides = document.getElementById('billing-log-guides');
  const activity = document.getElementById('billing-activity-strip');
  if (!bars || !xAxis || !yAxis || !guides || !activity) return;
  const signature = points.map(point => [
    point.date,
    point.totalTokens,
    point.cacheReadTokens,
    point.cacheWriteTokens,
  ].join(':')).join('|');
  if (signature !== billingDailyRenderSignature) {
    billingDailyRenderSignature = signature;
    bars.replaceChildren();
    xAxis.replaceChildren();
    yAxis.replaceChildren();
    guides.replaceChildren();
    activity.replaceChildren();

    const chartPoints = points.slice(-120);
    const peakTokens = Math.max(1_000, ...chartPoints.map(point => Math.max(0, Number(point.totalTokens) || 0)));
    const maximum = peakTokens * 1.08;
    const minimum = Math.max(1, maximum / 1_000);
    crtBillingLogGuideValues(minimum, maximum).forEach((value) => {
      const position = crtBillingLogPosition(value, minimum, maximum);
      const guide = document.createElement('div');
      guide.className = 'billing-log-guide';
      guide.style.bottom = `${position}%`;
      guides.appendChild(guide);

      const axisLabel = document.createElement('span');
      axisLabel.className = 'billing-y-axis-label';
      axisLabel.style.bottom = `${position}%`;
      axisLabel.textContent = formatCrtUsageValue(value);
      yAxis.appendChild(axisLabel);
    });
    const floorLabel = document.createElement('span');
    floorLabel.className = 'billing-y-axis-label is-floor';
    floorLabel.style.bottom = '0';
    floorLabel.textContent = `≤${formatCrtUsageValue(minimum)}`;
    yAxis.appendChild(floorLabel);

    bars.style.setProperty('--billing-chart-days', String(Math.max(1, chartPoints.length)));
    xAxis.style.setProperty('--billing-chart-days', String(Math.max(1, chartPoints.length)));
    chartPoints.forEach((point, index) => {
      const pointDate = parseCrtBillingDate(point.date);
      const axisTick = document.createElement('span');
      const isFirst = index === 0;
      const isLast = index === chartPoints.length - 1;
      const isHalfMonth = pointDate && [1, 15].includes(pointDate.getDate());
      if (pointDate && (isFirst || isLast || isHalfMonth)) {
        const month = pointDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
        axisTick.textContent = `${month} ${String(pointDate.getDate()).padStart(2, '0')}`;
        axisTick.className = `has-label${isLast ? ' is-end' : ''}`;
      }
      xAxis.appendChild(axisTick);

      const total = Math.max(0, Number(point.totalTokens) || 0);
      const cache = Math.min(total, Math.max(0, Number(point.cacheReadTokens) || 0)
        + Math.max(0, Number(point.cacheWriteTokens) || 0));
      const direct = Math.max(0, total - cache);
      const column = document.createElement('button');
      column.type = 'button';
      column.className = 'billing-daily-column';
      column.dataset.date = point.date;
      column.dataset.billion = total >= 1_000_000_000 ? 'true' : 'false';
      column.setAttribute('role', 'gridcell');
      column.setAttribute('aria-label', `${point.date}: ${formatCrtExactUsageValue(total)} tokens, ${formatCrtExactUsageValue(cache)} cache tokens`);
      column.setAttribute('aria-selected', 'false');
      column.tabIndex = -1;
      column.title = `${point.date} · ${formatCrtExactUsageValue(total)} total · ${formatCrtExactUsageValue(cache)} cache`;
      column.addEventListener('click', () => selectCrtBillingDay(point.date));
      if (total > 0) {
        const bar = document.createElement('span');
        bar.className = 'billing-daily-bar';
        bar.style.height = `${crtBillingLogPosition(total, minimum, maximum)}%`;
        if (direct > 0) {
          const directSegment = document.createElement('span');
          directSegment.className = 'billing-daily-direct';
          directSegment.style.height = `${direct / total * 100}%`;
          bar.appendChild(directSegment);
        }
        if (cache > 0) {
          const cacheSegment = document.createElement('span');
          cacheSegment.className = 'billing-daily-cache';
          cacheSegment.style.height = `${cache / total * 100}%`;
          bar.appendChild(cacheSegment);
        }
        column.appendChild(bar);
      }
      bars.appendChild(column);
    });

    activity.style.setProperty('--billing-activity-days', String(Math.max(1, points.length)));
    activity.setAttribute('aria-label', `${points.length}-day activity: ${activeDays} active days, ${billionDays} days at or above one billion tokens`);
    points.forEach((point) => {
      const tick = document.createElement('span');
      const total = Math.max(0, Number(point.totalTokens) || 0);
      tick.className = `billing-activity-tick${total > 0 ? ' is-active' : ''}${total >= 1_000_000_000 ? ' is-billion' : ''}`;
      tick.title = `${point.date} · ${formatCrtExactUsageValue(total)} tokens`;
      activity.appendChild(tick);
    });

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
  if (fresh) {
    billingDayDetailCache.clear();
    billingDayDetail = null;
  }
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
        void loadCrtBillingDayDetail(billingSelectedDate, { force: fresh });
      }
    }
  }
}

function stopCrtBillingRefresh({ abort = false } = {}) {
  if (billingRefreshTimer !== null) {
    clearInterval(billingRefreshTimer);
    billingRefreshTimer = null;
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
}

function startCrtBillingRefresh() {
  stopCrtBillingRefresh();
  billingRefreshTimer = setInterval(() => {
    if (crtMainView === 'billing' && document.visibilityState !== 'hidden') void loadCrtBilling();
  }, CRT_BILLING_REFRESH_MS);
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
  return !currentState || !currentState.mainAgentId || (mainAgent && mainAgent.status === 'dead');
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

  const agentId = requestedCrtAgentId();
  const agent = agentId
    ? state.agents.find((candidate) => candidate.id === agentId && candidate.archived !== true)
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
    const activeAgentId = isCrtSessionOpen() ? focusedAgentId : null;
    getSessionClient()?.focusAgent(activeAgentId, {
      streamScope: 'focused',
      previewScope: activeAgentId ? 'none' : 'all',
    });
    if (activeAgentId && terminal) {
      void refreshSessionView(true, activeAgentId, getCurrentSessionToken());
    }
    loadAgents();
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    const data = JSON.parse(event.data);
    if (data.type === 'state') {
      const prevAgentCount = state ? state.agents.length : 0;
      state = data.state;
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
          if (isCrtSessionOpen()) dashboardRenderDeferred = true;
          else scheduleCrtPreviewCardRender(agent, previousSnapshot, previousText, previewChanged);
        }
      }
    } else if (data.type === 'session-output') {
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

  if (!state.mainAgentId || (mainAgent && mainAgent.status === 'dead')) {
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

function getCrtRegularAgents(currentState = state) {
  if (!currentState || !Array.isArray(currentState.agents)) return [];
  return currentState.agents.filter((agent) => agent.id !== currentState.mainAgentId);
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
  const activeAgents = state.agents.filter(a => a.status === 'running').length;
  const totalAgents = state.agents.length;
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

  if (state.agents.length === 0) {
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
    if (mainAgent) {
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
      const cleanOutput = getAgentDisplayText(mainAgent);
      const outputTail = document.createElement('div');
      outputTail.className = 'agent-output-tail';
      if (!renderCrtTerminalSnapshot(outputTail, mainAgent.previewSnapshot)) {
        outputTail.textContent = cleanOutput.slice(-150) || 'No output yet...';
      }
      output.appendChild(outputTail);
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
    const cleanOutput = getAgentDisplayText(agent);
    const outputTail = document.createElement('div');
    outputTail.className = 'agent-output-tail';
    if (!renderCrtTerminalSnapshot(outputTail, agent.previewSnapshot)) {
      outputTail.textContent = cleanOutput || 'No output yet...';
    }
    output.appendChild(outputTail);
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
  state.agents.forEach((agent) => {
    if (agent.id === state.mainAgentId) return; // 跳过 Main Agent
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
  if (!agent) return '';
  if (agent.agentRuntimeMode === 'acp') return 'ACP';
  if (agent.agentRuntimeMode === 'json') return 'JSON';
  if (agent.providerSessionProvider === 'codex' && agent.codexRuntimeMode === 'app-server') return 'APP SERVER';
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
    && agent.agentRuntimeMode === 'terminal'
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
  if (agent.agentRuntimeMode === 'acp') return 'acp-transcript';
  if (agent.agentRuntimeMode === 'json') return 'json-cli-transcript';
  return 'codex-app-server-transcript';
}

function structuredRuntimeStatus(agent) {
  if (!agent) return '';
  if (agent.agentRuntimeMode === 'acp') return agent.acpState || 'idle';
  if (agent.agentRuntimeMode === 'json') return agent.jsonCliState || 'idle';
  return agent.codexAppServerState || 'idle';
}

function structuredRuntimeError(agent) {
  if (!agent) return '';
  if (agent.agentRuntimeMode === 'acp') return agent.acpError || '';
  if (agent.agentRuntimeMode === 'json') return agent.jsonCliError || '';
  return agent.codexAppServerError || '';
}

function structuredComposerAction(agent, draft = '') {
  if (!isCrtAgentInteractive(agent) || structuredRuntimeError(agent)) return 'disabled';
  if (structuredComposerAttachments.some(item => item.status === 'uploading')) return 'disabled';
  const status = String(structuredRuntimeStatus(agent) || 'idle');
  const working = ['working', 'waiting-for-permission'].includes(status);
  if (working) {
    if (agent.agentRuntimeMode === 'acp' && String(draft || '').trim()) return 'send';
    if (
      agent.providerSessionProvider === 'codex'
      && agent.codexRuntimeMode === 'app-server'
      && String(draft || '').trim()
    ) return 'steer';
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

function structuredMenuButton(label, description, active, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `crt-structured-menu-item${active ? ' active' : ''}`;
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
        }));
      });
  } else if (structuredComposerMenu === 'mode') {
    const modes = session.modes && Array.isArray(session.modes.availableModes) ? session.modes.availableModes : [];
    const current = session.currentModeId || (session.modes && session.modes.currentModeId) || '';
    modes.forEach((mode) => {
      items.appendChild(structuredMenuButton(mode.name || mode.id, mode.description || '', mode.id === current, () => {
        void patchStructuredAcpSession({ modeId: mode.id }).catch(showStructuredComposerError);
      }));
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
        }
      ));
    });
  } else if (selectedConfig.type === 'boolean') {
    [false, true].forEach((value) => {
      items.appendChild(structuredMenuButton(value ? 'ON' : 'OFF', selectedConfig.description || '', selectedConfig.currentValue === value, () => {
        void patchStructuredAcpSession({ configId: selectedConfig.id, value }).catch(showStructuredComposerError);
      }));
    });
  } else {
    structuredSelectOptions(selectedConfig).forEach((candidate) => {
      items.appendChild(structuredMenuButton(candidate.name || candidate.value, candidate.description || '', candidate.value === selectedConfig.currentValue, () => {
        void patchStructuredAcpSession({ configId: selectedConfig.id, value: candidate.value }).catch(showStructuredComposerError);
      }));
    });
  }

  menu.append(title, items);
  menu.hidden = false;
  if (structuredComposerMenuFocusPending) {
    structuredComposerMenuFocusPending = false;
    window.requestAnimationFrame(() => focusStructuredComposerMenuButton(null, 0));
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
  if (!agent || agent.agentRuntimeMode !== 'acp') {
    resetStructuredSessionControls();
    return;
  }
  const revision = String(agent.acpSessionUpdatedAt || '');
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
  if (agent && agent.agentRuntimeMode === 'acp') void refreshStructuredSessionControls(agent.id);
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
  if (!agent || agent.agentRuntimeMode !== 'acp') return;
  const requests = Array.isArray(agent.acpPendingPermissions) && agent.acpPendingPermissions.length
    ? agent.acpPendingPermissions
    : (agent.acpPendingPermission ? [agent.acpPendingPermission] : []);
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
      current = { userMessage: text, finalMessage: '' };
      turns.push(current);
      return;
    }
    if (entry.role !== 'assistant') return;
    if (!current) {
      current = { userMessage: '', finalMessage: '' };
      turns.push(current);
    }
    current.finalMessage = text;
  });
  return turns;
}

function renderStructuredTranscript(transcript, force = false) {
  const container = document.getElementById('terminal-output');
  if (!container) return;
  const updatedAt = String(transcript && transcript.updatedAt || '');
  if (!force && updatedAt && updatedAt === structuredSessionRenderedAt) return;
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
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
  if (force || nearBottom) container.scrollTop = container.scrollHeight;
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
  disposeTerminal();
  destroyTerminalInputBridge();
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
  let mountedTerminal = null;
  try {
    mountedTerminal = SESSION_MODAL_BRIDGE && SESSION_MODAL_BRIDGE.mountTerminal
      ? SESSION_MODAL_BRIDGE.mountTerminal(document, terminalBundle, {
        initialOutput: shouldUseLiveSessionText(agent)
          ? (runtime ? runtime.prepareInitialOutput(agent.output) : agent.output)
          : '',
        onData: (data) => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          if (!interactiveTerminal) return;
          sendTerminalInput(data);
        },
        onResize: (cols, rows) => {
          if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
          if (!focusedAgentId) return;
          const sessionClient = getSessionClient();
          if (!sessionClient) return;
          sessionClient.resizeAgent(focusedAgentId, cols, rows);
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
  if (runtime) {
    runtime.setLastOutputLength(mountedTerminal ? mountedTerminal.outputLength : (runtime.prepareInitialOutput(agent.output)).length);
    syncSessionRuntimeState();
  }
  setupTerminalInputBridge();

  if (!mountedTerminal) {
    terminal.loadAddon(fitAddon);
    terminal.onData((data) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!interactiveTerminal) return;
      sendTerminalInput(data);
    });
    terminal.onResize(({ cols, rows }) => {
      if (runtime && !runtime.isCurrentSession(agentId, sessionToken)) return;
      if (!focusedAgentId) return;
      const sessionClient = getSessionClient();
      if (!sessionClient) return;
      sessionClient.resizeAgent(focusedAgentId, cols, rows);
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
      fitAddon.fit();
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

  await refreshSessionView(true, agentId, sessionToken);
  if (shouldPollSessionView(modalState.sessionSource)) {
    startSessionViewPolling(agentId, sessionToken);
  }
}

function closeSession() {
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
}

function killCurrentAgent() {
  if (!focusedAgentId) return;

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.killAgent(focusedAgentId);
  }

  closeSession();
}

function sendTerminalInput(input) {
  if (!focusedAgentId) return;

  const sessionClient = getSessionClient();
  if (sessionClient) {
    sessionClient.sendInput(focusedAgentId, input);
  }
}

function sendSessionResize(agentId = focusedAgentId) {
  if (!agentId || !terminal) return;
  if (!Number.isFinite(terminal.cols) || !Number.isFinite(terminal.rows)) return;
  const sessionClient = getSessionClient();
  if (!sessionClient) return;
  sessionClient.resizeAgent(agentId, terminal.cols, terminal.rows);
}

async function refreshSessionView(forceReplace = false, expectedAgentId = focusedAgentId, expectedSessionToken = getCurrentSessionToken()) {
  if (!expectedAgentId || !terminal) return;

  const runtime = getSessionRuntime();
  try {
    const sessionClient = getSessionClient();
    if (!sessionClient) return;
    let payload = null;
    const retryDelays = forceReplace ? [0, 60, 140] : [0];
    for (const delay of retryDelays) {
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      payload = await sessionClient.getSessionView(expectedAgentId);
      const candidate = normalizeSessionViewPayload(payload);
      const dimensionsMatch = !Number.isFinite(candidate.previewCols)
        || !Number.isFinite(candidate.previewRows)
        || (candidate.previewCols === terminal.cols && candidate.previewRows === terminal.rows);
      if (dimensionsMatch) {
        break;
      }
    }
    if (runtime && !runtime.isCurrentSession(expectedAgentId, expectedSessionToken)) {
      return;
    }
    const currentAgent = state && state.agents
      ? state.agents.find((agent) => agent.id === expectedAgentId)
      : null;
    const sessionView = normalizeSessionViewPayload(payload, currentAgent);
    const sessionText = sessionView.renderOutput || sessionView.output;
    const patch = deriveSessionTextPatch(sessionText, getSessionOutputLength(), forceReplace);

    if (patch.mode === 'replace') {
      replaceTerminalOutput(
        terminal,
        applySessionReplayCursorVisibility(patch.text, sessionView, currentAgent),
      );
      refreshSessionTerminalUi({ preserveSearchIndex: true });
      if (runtime) {
        runtime.markHydrated(patch.nextLength);
        syncSessionRuntimeState();
      }
      return;
    }

    if (patch.mode === 'append') {
      terminal.write(patch.text);
      refreshSessionTerminalUi({ preserveSearchIndex: true });
      if (runtime) {
        if (isAwaitingInitialSessionSync()) {
          runtime.markHydrated(patch.nextLength);
        } else {
          runtime.setLastOutputLength(patch.nextLength);
        }
        syncSessionRuntimeState();
      }
    }
  } catch (error) {
    console.error('Failed to refresh session view:', error);
    if (runtime && runtime.isCurrentSession(expectedAgentId, expectedSessionToken) && runtime.isAwaitingInitialSync()) {
      runtime.markHydrated(getSessionOutputLength());
      syncSessionRuntimeState();
    }
  }
}

function startSessionViewPolling(agentId = focusedAgentId, sessionToken = getCurrentSessionToken()) {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.startPolling({ agentId, sessionToken });
    return;
  }
  stopSessionViewPolling();
  legacySessionPoller = setInterval(() => {
    refreshSessionView(false, agentId, sessionToken);
  }, 350);
}

function stopSessionViewPolling() {
  const runtime = getSessionRuntime();
  if (runtime) {
    runtime.stopPolling();
    return;
  }
  if (legacySessionPoller) {
    clearInterval(legacySessionPoller);
    legacySessionPoller = null;
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

    fitAddon.fit();
    syncTerminalInputBridgePosition();
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

    if (terminalFontSizeInputFocused && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
    if (searchInputFocused) return;

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
      if (
        structuredSessionActive
        && e.key === 'Escape'
        && (e.ctrlKey || e.metaKey || !structuredComposerMenu)
        && !(!e.ctrlKey && !e.metaKey && structuredTranscriptFocused)
      ) {
        closeSession();
        e.preventDefault();
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
      if (e.isComposing || terminalInputComposing) {
        if (SESSION_INPUT_SETTINGS.imeEnabled) {
          e.preventDefault();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Escape') {
        closeSession();
        e.preventDefault();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        killCurrentAgent();
        e.preventDefault();
        return;
      }
      if (!SESSION_INPUT_SETTINGS.imeEnabled) {
        return;
      }
      if (
        SESSION_INPUT_SETTINGS.imeEnabled &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        e.key.length === 1 &&
        document.activeElement !== terminalInputBridge
      ) {
        e.preventDefault();
        schedulePrintableInput(e.key);
        focusTerminalInputBridge();
        return;
      }
      if (routeSessionKey(e)) {
        e.preventDefault();
        focusTerminalInputBridge();
        return;
      }
      if (!e.ctrlKey && !e.metaKey && e.key === 'Escape') {
        sendTerminalInput('\x1b');
        e.preventDefault();
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

    const pastedText = e.clipboardData && e.clipboardData.getData
      ? e.clipboardData.getData('text/plain')
      : '';

    if (!pastedText) {
      return;
    }

    e.preventDefault();
    pasteTerminalText(pastedText);
  }, true);

}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildCrtHistoryItems,
    buildCrtSearchResults,
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
    isPasteShortcut,
    getTerminalSequenceForKey,
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
    getAgentDisplayText,
    getCrtPreviewCellStyle,
    getCrtAgentTitle,
    getCrtProjectName,
    calculateTerminalInputBridgePosition,
    getCrtTerminalFontSize,
    isCrtAgentWorking,
    getCrtAgentReadPatch,
    crtRuntimeView,
    canSwitchCrtAgentRuntime,
    isCrtRuntimeSwitchShortcut,
    structuredComposerAction,
    structuredTranscriptTurns,
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
