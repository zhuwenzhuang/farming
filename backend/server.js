const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { URLSearchParams } = require('url');
const AgentManager = require('./agent-manager');
const ConfigManager = require('./config-manager');
const ThemeManager = require('./theme-manager');
const TokenAuth = require('./auth');
const { getLocalIPs, getPrimaryLocalIP } = require('./network');
const { listAvailableAgents, resolveCompatibleCodexExecutable } = require('./executable-discovery');
const { readClaudeSettingsSummary } = require('./claude-settings');
const { listCodexModelOptions } = require('./codex-models');
const { listCodexSessions } = require('./codex-session-history');
const {
  buildAgentSessionResumeCommand,
  findAgentSession,
  isSafeSessionId,
  listAgentSessions,
  normalizeProvider,
} = require('./agent-session-history');
const {
  findActiveAgentClaimingSession,
  mainPageAgentSessionKey,
  mainPageAgentSessionsToAutoResume,
  resumedAgentSource,
} = require('./main-page-session');
const { discoverAgentWorkspaces } = require('./workspace-discovery');
const { createControlRouter } = require('./control-api');
const { WorkspaceFileService, WorkspaceFileError } = require('./workspace-file-service');
const { createWorkspaceFileRouter } = require('./workspace-file-router');
const { UsageMonitor } = require('./usage-monitor');
const { CodexContextWindowReader } = require('./codex-context-window');
const { DEFAULT_MAX_TURNS: DEFAULT_CODEX_TRANSCRIPT_MAX_TURNS, readCodexTranscript } = require('./codex-transcript');
const { AsyncCache } = require('./async-cache');
const { getMainAgentSkillsCatalog } = require('./main-agent-skills');
const { discoverSlashCommands } = require('./slash-command-discovery');
const { FarmingUpdateService } = require('./update-service');
const { isRestartBlockingAgent } = require('./agent-activity');
const { inputPartsFromMessage } = require('./input-parts');
const { AppServerApiBridge, createAppServerApiRouter } = require('./app-server-api');
const { cleanupTerminalRuntime } = require('./terminal-runtime-cleanup');
const { QrShareTicketStore, SHARE_TICKET_TTL_MS } = require('./qr-share-tickets');
const { ReviewStateStore } = require('./review-state-store');
const { createReviewStateRouter } = require('./review-state-router');
const { ReviewDiffService } = require('./review-diff-service');
const { createReviewDiffRouter } = require('./review-diff-router');
const { ReviewSessionStore } = require('./review-session-store');
const { ReviewSessionService } = require('./review-session-service');
const { createReviewSessionRouter } = require('./review-session-router');
const {
  normalizeBasePath,
  routePath,
  rewriteIndexHtmlForBasePath,
  appendIndexHtmlAssetToken,
} = require('./index-html');

const execFileAsync = promisify(execFile);

const BASE_PATH = normalizeBasePath(process.env.FARMING_BASE_PATH || '/');
const PORT = process.env.PORT || 3000;
const tokenAuth = new TokenAuth({ basePath: BASE_PATH || '/' });
const authEnabled = tokenAuth.isEnabled();
const WS_PATH = routePath(BASE_PATH, '/ws');
const encodeCookieToken = TokenAuth.encodeCookieToken;
const MAX_CODEX_TRANSCRIPT_TURNS = 1000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const configManager = new ConfigManager();
configManager.init();

function resolveCliBinDir() {
  if (process.env.FARMING_CLI_BIN_DIR) {
    return process.env.FARMING_CLI_BIN_DIR;
  }
  if (process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1') {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, '..', 'bin');
}

const agentManager = new AgentManager(configManager, {
  controlUrl: `http://127.0.0.1:${PORT}${BASE_PATH}`,
  tokenFile: tokenAuth.getTokenFile(),
  authDisabled: !authEnabled,
  cliBinDir: resolveCliBinDir(),
});
const themeManager = new ThemeManager({ configDir: configManager.farmingDir });
const workspaceFileService = new WorkspaceFileService();
const updateService = new FarmingUpdateService({
  rootDir: path.join(__dirname, '..'),
  configDir: configManager.farmingDir,
  platform: process.platform,
  arch: process.arch,
  packagedRuntime: Boolean(process.pkg || process.env.FARMING_PACKAGED_RUNTIME === '1'),
  getUpdateUrl: () => configManager.getSettings().updateUrl || '',
});
const appServerApiBridge = new AppServerApiBridge();
const usageMonitor = new UsageMonitor({ agentManager });
const codexContextWindowReader = new CodexContextWindowReader();
const usageSummaryCache = new AsyncCache(() => usageMonitor.getUsageSummary(), {
  ttlMs: 30_000,
  staleMs: 2 * 60_000,
});
const codexModelOptionsCache = new AsyncCache(() => listCodexModelOptions(), {
  ttlMs: 5 * 60_000,
  staleMs: 30 * 60_000,
});
function configuredProviderHomes() {
  const settings = configManager.getSettings();
  const agentHomes = settings.agentHomes && typeof settings.agentHomes === 'object' ? settings.agentHomes : {};
  const result = {};
  for (const [provider, homes] of Object.entries(agentHomes)) {
    if (!Array.isArray(homes)) continue;
    result[provider] = homes.map(home => ({
      id: String(home.id || 'default'),
      path: configManager.expandWorkspacePath(String(home.path || '')),
    })).filter(home => home.id && home.path);
  }
  return result;
}

const agentSessionsCache = new AsyncCache((key) => {
  let parsed = {};
  try {
    parsed = JSON.parse(key);
  } catch {
    parsed = {};
  }
  return listAgentSessions({
    limit: Number(parsed.limit) || 60,
    scanLimit: Number(parsed.scanLimit) || undefined,
    providerHomes: configuredProviderHomes(),
  });
}, {
  ttlMs: 30_000,
  staleMs: 5 * 60_000,
});
const qrShareTickets = new QrShareTicketStore({ ttlMs: SHARE_TICKET_TTL_MS });
const reviewStateStore = new ReviewStateStore(configManager.farmingDir, {
  seedReviews: {
    'review-demo-553987': {
      patchsets: {
        'Patchset 20': { reviewedPaths: ['clis/dataflow.py', 'clis/fetch_instance_log.py'], revision: 0 },
        'Patchset 19': { reviewedPaths: ['clis/fetch_instance_log.py'], revision: 0 },
      },
    },
  },
});
const reviewDiffService = new ReviewDiffService(agentManager, workspaceFileService);
const reviewSessionStore = new ReviewSessionStore(configManager.farmingDir);
const reviewSessionService = new ReviewSessionService(workspaceFileService, reviewSessionStore, reviewStateStore, {
  resolveAgentRoot: agentId => agentManager.getAgentWorkspaceRoot(agentId),
});
const workspaceDiscoveryCache = new AsyncCache((key) => {
  const request = JSON.parse(key);
  return discoverAgentWorkspaces({
    limit: request.limit,
    agent: request.agent,
  });
}, {
  ttlMs: 30_000,
  staleMs: 2 * 60_000,
});

const frontendDir = path.join(__dirname, '../frontend');
const crtFrontendDir = path.join(frontendDir, 'skins', 'crt');
const distDir = path.join(__dirname, '../dist');
const staticAppDir = fs.existsSync(distDir) ? distDir : frontendDir;
const xtermBrowserEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js');
const xtermFitEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js');
const xtermWebglEntryPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js');
const xtermCssPath = path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css');
const materialIconDir = path.join(__dirname, '..', 'node_modules', 'material-icon-theme', 'icons');

function getAvailableAgentsForRequest() {
  if (process.env.FARMING_E2E_FAKE_EXECUTABLES === '1') {
    return [
      {
        name: 'codex',
        command: 'codex',
        description: 'Codex CLI - OpenAI coding assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'claude',
        command: 'claude',
        description: 'Claude CLI - Anthropic assistant',
        category: 'coding',
        supported: true,
        interactive: true,
      },
      {
        name: 'bash',
        command: 'bash',
        description: 'Shell session',
        category: 'shell',
        supported: true,
        interactive: true,
      },
      {
        name: 'zsh',
        command: 'zsh',
        description: 'Z shell',
        category: 'shell',
        supported: true,
        interactive: true,
      },
    ];
  }

  return listAvailableAgents(process.env.PATH || '');
}

function normalizeWorkspaceCompletionInput(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return { raw: '', parent: os.homedir(), prefix: '', displayParent: '~', explicitDirectory: false };
  }

  const home = os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  const explicitDirectory = raw.endsWith(path.sep) || raw === '~';
  const parent = explicitDirectory ? expanded : path.dirname(expanded);
  const prefix = explicitDirectory ? '' : path.basename(expanded);
  const trimTrailingSeparator = (input) => {
    let next = input;
    while (next.length > 1 && next.endsWith(path.sep)) next = next.slice(0, -1);
    return next;
  };
  const displayParent = explicitDirectory
    ? trimTrailingSeparator(raw)
    : trimTrailingSeparator(raw.slice(0, raw.length - prefix.length));

  return {
    raw,
    parent: parent || path.sep,
    prefix,
    displayParent: displayParent || (path.isAbsolute(raw) ? path.sep : ''),
    explicitDirectory,
  };
}

async function listWorkspacePathCompletions(partialPath, limit = 12) {
  const query = normalizeWorkspaceCompletionInput(partialPath);
  const entries = await fs.promises.readdir(query.parent, { withFileTypes: true });
  const normalizedPrefix = query.prefix.toLowerCase();
  const maxResults = Math.max(1, Math.min(Number(limit) || 12, 100));

  return entries
    .filter(entry => entry.isDirectory())
    .filter(entry => normalizedPrefix.startsWith('.') || !entry.name.startsWith('.'))
    .filter(entry => !normalizedPrefix || entry.name.toLowerCase().startsWith(normalizedPrefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxResults)
    .map(entry => {
      const fullPath = path.join(query.parent, entry.name);
      const displayPath = query.raw.startsWith('~')
        ? path.join(query.displayParent || '~', entry.name)
        : fullPath;
      return {
        name: entry.name,
        path: `${displayPath}${path.sep}`,
      };
    });
}

app.get(['/favicon.ico', routePath(BASE_PATH, '/favicon.ico')], (_req, res) => {
  res.status(204).end();
});

app.get(routePath(BASE_PATH, '/j/:code'), (req, res) => {
  if (req.method === 'HEAD') {
    res.status(204).end();
    return;
  }

  const ticket = qrShareTickets.consume(req.params.code);
  if (!ticket || (authEnabled && !tokenAuth.verify(ticket.token))) {
    res.status(410).send('Farming share link expired.');
    return;
  }

  if (authEnabled) {
    res.setHeader(
      'Set-Cookie',
      `farming_token=${encodeCookieToken(ticket.token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }
  res.redirect(302, entryPathWithQuery(ticket.targetQuery));
});

// Token authentication middleware (before static files)
app.use(tokenAuth.middleware());

// Auth status endpoint (allowed without authentication via middleware)
app.get(routePath(BASE_PATH, '/api/auth/status'), (req, res) => {
  res.json({ authRequired: authEnabled });
});

function absoluteClientUrl(req, urlPath) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || `127.0.0.1:${PORT}`;
  return `${protocol}://${host}${urlPath}`;
}

function shareTargetPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? String(number) : '';
}

function shareTargetString(value, maxLength) {
  const string = String(value || '').trim();
  if (!string || string.length > maxLength || string.includes('\0')) return '';
  return string;
}

function shareTargetQueryFromBody(body) {
  const target = body && typeof body === 'object' ? body.target : null;
  if (!target || typeof target !== 'object') return '';

  const kind = target.kind === 'file' ? 'file' : target.kind === 'folder' ? 'folder' : target.kind === 'agent' ? 'agent' : '';
  const agentId = shareTargetString(target.agentId, 160);
  const absolutePath = shareTargetString(target.absolutePath, 2048);
  const projectLabel = shareTargetString(target.projectLabel, 160);
  if (!kind || kind === 'agent' && !agentId || kind !== 'agent' && !absolutePath && !agentId && !projectLabel) return '';

  const params = new URLSearchParams();
  params.set('ftarget', kind);
  if (agentId) params.set('agent', agentId);
  if (absolutePath) params.set('path', absolutePath);
  if (projectLabel) params.set('project', projectLabel);

  if (kind === 'folder') {
    const folderPath = shareTargetString(target.folderPath, 2048);
    if (!absolutePath && !folderPath) return '';
    if (folderPath) params.set('folder', folderPath);
  } else if (kind === 'file') {
    const filePath = shareTargetString(target.filePath, 2048);
    if (!absolutePath && !filePath) return '';
    if (filePath) params.set('file', filePath);
    if (target.view === 'diff') params.set('view', 'diff');
    const line = shareTargetPositiveInteger(target.lineNumber);
    const column = shareTargetPositiveInteger(target.column);
    const endColumn = shareTargetPositiveInteger(target.endColumn);
    if (line) params.set('line', line);
    if (column) params.set('column', column);
    if (endColumn) params.set('endColumn', endColumn);
  }

  if (absolutePath) {
    const absoluteParams = new URLSearchParams(params);
    absoluteParams.delete('agent');
    absoluteParams.delete(kind === 'folder' ? 'folder' : 'file');
    if (absoluteParams.toString().length <= 1800) return absoluteParams.toString();
    params.delete('path');
  }

  return params.toString();
}

function entryPathWithQuery(query = '', options = {}) {
  const entryPath = BASE_PATH || '/';
  const params = new URLSearchParams(query || '');
  if (options.includeToken && authEnabled) {
    params.set('token', tokenAuth.getToken());
  }
  const queryString = params.toString();
  return queryString ? `${entryPath}?${queryString}` : entryPath;
}

function entryPathWithToken(targetQuery = '') {
  return entryPathWithQuery(targetQuery, { includeToken: true });
}

app.post(routePath(BASE_PATH, '/api/share/qr-ticket'), express.json({ limit: '8kb' }), (req, res) => {
  try {
    const targetQuery = shareTargetQueryFromBody(req.body);
    const ticket = qrShareTickets.create(authEnabled ? tokenAuth.getToken() : '', { targetQuery });
    const shortPath = routePath(BASE_PATH, `/j/${ticket.code}`);
    const longPath = entryPathWithToken(ticket.targetQuery);
    res.json({
      code: ticket.code,
      expiresAt: ticket.expiresAt,
      ttlMs: SHARE_TICKET_TTL_MS,
      shortPath,
      shortUrl: absoluteClientUrl(req, shortPath),
      longUrl: absoluteClientUrl(req, longPath),
      tokenLabel: authEnabled ? tokenAuth.getToken() : '',
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to create share ticket' });
  }
});

app.delete(routePath(BASE_PATH, '/api/share/qr-ticket/:code'), (req, res) => {
  res.json({ revoked: qrShareTickets.revoke(req.params.code) });
});

// Terminal assets remain available to the standalone CRT skin when React is served from dist.
app.use(routePath(BASE_PATH, '/vendor'), express.static(path.join(frontendDir, 'vendor')));
app.get(routePath(BASE_PATH, '/vendor/xterm/xterm.js'), (_req, res) => {
  res.sendFile(xtermBrowserEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/addon-fit.js'), (_req, res) => {
  res.sendFile(xtermFitEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/addon-webgl.js'), (_req, res) => {
  res.sendFile(xtermWebglEntryPath);
});
app.get(routePath(BASE_PATH, '/vendor/xterm/xterm.css'), (_req, res) => {
  res.sendFile(xtermCssPath);
});
app.use(routePath(BASE_PATH, '/vendor/material-icons'), express.static(materialIconDir));
app.get(routePath(BASE_PATH, '/vendor/material-icons/:iconId.svg'), (req, res) => {
  const fallbackIcon = String(req.params.iconId || '').startsWith('folder-') ? 'folder.svg' : 'file.svg';
  res.sendFile(path.join(materialIconDir, fallbackIcon));
});
if (BASE_PATH) {
  app.use('/assets', express.static(path.join(staticAppDir, 'assets'), { index: false }));
  app.use('/farming-2', express.static(path.join(staticAppDir, 'farming-2'), { index: false }));
}
const crtEntryPath = routePath(BASE_PATH, '/crt');
app.get(crtEntryPath, (req, res) => {
  if (req.path.endsWith('/')) {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(crtFrontendDir, 'index.html'));
    return;
  }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.redirect(308, `${crtEntryPath}/${requestUrl.search}`);
});
app.use(`${crtEntryPath}/shared`, express.static(frontendDir, { index: false }));
app.use(`${crtEntryPath}/`, express.static(crtFrontendDir, { index: false }));
app.use(BASE_PATH || '/', express.static(staticAppDir, { index: false }));

app.use(routePath(BASE_PATH, '/api/files'), createWorkspaceFileRouter(agentManager, workspaceFileService));

app.use(routePath(BASE_PATH, '/api/review-sessions'), createReviewSessionRouter(reviewSessionService));
app.use(routePath(BASE_PATH, '/api/reviews'), createReviewDiffRouter(reviewDiffService, reviewSessionService));
app.use(routePath(BASE_PATH, '/api/reviews'), createReviewStateRouter(reviewStateStore));

app.use(routePath(BASE_PATH, '/api/control'), createControlRouter(agentManager, {
  notifyUpdate: broadcastState,
}));

app.use(routePath(BASE_PATH, '/api/app-server'), createAppServerApiRouter({
  bridge: appServerApiBridge,
}));

app.get([
  BASE_PATH || '/',
  `${BASE_PATH || ''}/`,
  routePath(BASE_PATH, '/code'),
  routePath(BASE_PATH, '/code/'),
  routePath(BASE_PATH, '/error-preview'),
  routePath(BASE_PATH, '/review'),
  routePath(BASE_PATH, '/review-demo'),
].filter(Boolean), (req, res) => {
  const indexPath = path.join(staticAppDir, 'index.html');
  fs.readFile(indexPath, 'utf8', (error, html) => {
    if (error) {
      res.status(500).send('Farming frontend is not built');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    const rewrittenHtml = rewriteIndexHtmlForBasePath(html, BASE_PATH);
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const requestToken = requestUrl.searchParams.has('token') ? tokenAuth.extractToken(req) : '';
    const htmlWithAssetToken = authEnabled && requestToken && tokenAuth.verify(requestToken)
      ? appendIndexHtmlAssetToken(rewrittenHtml, requestToken)
      : rewrittenHtml;
    res.send(htmlWithAssetToken);
  });
});

app.get(routePath(BASE_PATH, '/api/executables'), (req, res) => {
  const availableAgents = getAvailableAgentsForRequest();
  res.json({
    agents: availableAgents,
    total: availableAgents.length
  });
});

app.get(routePath(BASE_PATH, '/api/workspaces/complete'), async (req, res) => {
  try {
    const partialPath = typeof req.query.path === 'string' ? req.query.path : '';
    const requestedLimit = Number(req.query.limit);
    const suggestions = await listWorkspacePathCompletions(partialPath, requestedLimit);
    res.json({ suggestions });
  } catch (error) {
    res.status(200).json({
      suggestions: [],
      error: error.message || 'Failed to read directory',
    });
  }
});

app.get(routePath(BASE_PATH, '/api/skills'), (_req, res) => {
  res.json({ skills: getMainAgentSkillsCatalog() });
});

app.get(routePath(BASE_PATH, '/api/slash-commands'), (req, res) => {
  const provider = typeof req.query.provider === 'string' ? req.query.provider : '';
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
  res.json({ commands: discoverSlashCommands({ provider, workspace }) });
});

const IMAGE_ATTACHMENT_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const IMAGE_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_ATTACHMENT_GC_INTERVAL_MS = 60 * 60 * 1000;
const IMAGE_ATTACHMENT_FILENAME_RE = /^pasted-image-\d+-[a-f0-9]{8}\.(?:png|jpg|gif|webp)$/;
let lastImageAttachmentGcAt = 0;

function imageAttachmentExtension(contentType) {
  const normalized = String(contentType || '').split(';')[0].trim().toLowerCase();
  return IMAGE_ATTACHMENT_EXTENSIONS[normalized] || '';
}

function imageAttachmentsDir() {
  return path.join(configManager.farmingDir, 'attachments');
}

async function cleanupExpiredImageAttachments(options = {}) {
  const now = Date.now();
  if (!options.force && now - lastImageAttachmentGcAt < IMAGE_ATTACHMENT_GC_INTERVAL_MS) return;
  lastImageAttachmentGcAt = now;

  const attachmentsDir = imageAttachmentsDir();
  let entries = [];
  try {
    entries = await fs.promises.readdir(attachmentsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.warn('Failed to scan image attachments:', error.message || error);
    }
    return;
  }

  const cutoff = now - IMAGE_ATTACHMENT_RETENTION_MS;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !IMAGE_ATTACHMENT_FILENAME_RE.test(entry.name)) return;

    const filePath = path.join(attachmentsDir, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath);
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        console.warn('Failed to remove expired image attachment:', error && (error.message || error));
      }
    }
  }));
}

void cleanupExpiredImageAttachments({ force: true });

app.post(
  routePath(BASE_PATH, '/api/attachments/image'),
  express.raw({ type: 'image/*', limit: '12mb' }),
  (req, res) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const extension = imageAttachmentExtension(contentType);
    if (!extension) {
      res.status(415).json({ error: 'unsupported image type' });
      return;
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'empty image attachment' });
      return;
    }

    const attachmentsDir = imageAttachmentsDir();
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const filename = `pasted-image-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;
    const filePath = path.join(attachmentsDir, filename);
    fs.writeFileSync(filePath, req.body);
    void cleanupExpiredImageAttachments();

    res.status(201).json({
      path: filePath,
      name: filename,
      type: contentType,
      size: req.body.length,
    });
  }
);

app.get(routePath(BASE_PATH, '/api/codex/models'), async (req, res) => {
  const catalog = await codexModelOptionsCache.get('catalog');
  res.json(catalog);
});

app.get(routePath(BASE_PATH, '/api/claude/settings'), (req, res) => {
  res.json({ settings: readClaudeSettingsSummary() });
});

app.get(routePath(BASE_PATH, '/api/usage'), async (req, res) => {
  try {
    const usage = await usageSummaryCache.get('summary');
    res.json({ usage });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to read usage information' });
  }
});

app.post(routePath(BASE_PATH, '/api/codex/context-windows'), express.json(), async (req, res) => {
  try {
    const requestedIds = Array.isArray(req.body?.agentIds)
      ? req.body.agentIds
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .slice(0, 20)
      : [];
    const requestedIdSet = new Set(requestedIds);
    const agents = agentManager.getState().agents.filter(agent => requestedIdSet.has(agent.id));
    const contextWindows = await codexContextWindowReader.readForAgents(agents);
    res.json({ contextWindows });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to read Codex context windows' });
  }
});

function blockingUpdateAgents() {
  return agentManager.getState().agents
    .filter(isRestartBlockingAgent)
    .map(agent => ({
      id: agent.id,
      command: agent.command,
      task: agent.task || agent.customTitle || agent.sessionTitle || '',
      cwd: agent.cwd,
    }));
}

app.get(routePath(BASE_PATH, '/api/update'), async (req, res) => {
  try {
    const update = await updateService.check({ force: req.query.force === '1' });
    res.json({
      update: {
        ...update,
        blockingAgents: blockingUpdateAgents(),
      },
    });
  } catch (error) {
    res.status(502).json({ error: error.message || 'Failed to check for updates' });
  }
});

app.post(routePath(BASE_PATH, '/api/update/install'), express.json(), async (req, res) => {
  const blockers = blockingUpdateAgents();
  const force = req.body && req.body.force === true;
  if (blockers.length > 0 && !force) {
    res.status(409).json({
      error: 'Cannot upgrade while non-recoverable project agents are running',
      blockingAgents: blockers,
    });
    return;
  }

  try {
    const state = await updateService.startInstall({
      assetName: req.body && typeof req.body.assetName === 'string' ? req.body.assetName : '',
    });
    res.status(202).json({
      update: {
        state,
        blockingAgents: blockers,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to start update' });
  }
});

function warmCodexExecutableVersionCache() {
  const startedAt = Date.now();
  try {
    const result = resolveCompatibleCodexExecutable('');
    if (result.path) {
      console.log(`Codex executable ready: ${result.version || 'unknown version'} (${Date.now() - startedAt}ms)`);
    }
  } catch (error) {
    console.warn('Failed to warm Codex executable version cache:', error.message || error);
  }
}

app.get(routePath(BASE_PATH, '/api/codex/sessions'), async (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(1000, requestedLimit)) : 40;
  const requestedScanLimit = Number(req.query.scanLimit);
  const scanLimit = Number.isFinite(requestedScanLimit) ? Math.max(limit, Math.min(5000, requestedScanLimit)) : undefined;
  const sessions = await listCodexSessions({ limit, scanLimit });
  res.json({ sessions });
});

app.get(routePath(BASE_PATH, '/api/agent-sessions'), async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(1000, requestedLimit)) : 60;
    const requestedScanLimit = Number(req.query.scanLimit);
    const scanLimit = Number.isFinite(requestedScanLimit) ? Math.max(limit, Math.min(5000, requestedScanLimit)) : undefined;
    const sessions = await agentSessionsCache.get(JSON.stringify({ limit, scanLimit, homes: configManager.getSettings().agentHomes || {} }));
    const displayStateByKey = new Map(configManager.listAgentSessionRecords()
      .filter(record => record && record.providerSessionKey)
      .map(record => [record.providerSessionKey, record]));
    res.json({
      sessions: sessions.map(session => {
        const key = mainPageAgentSessionKey(session.provider, session.id, session.providerHomeId);
        const displayState = displayStateByKey.get(key);
        return typeof displayState?.displayPinned === 'boolean'
          ? { ...session, pinned: displayState.displayPinned }
          : session;
      }),
    });
  } catch (error) {
    console.error('Failed to read agent sessions:', error);
    res.status(500).json({ error: error.message || 'Failed to read agent sessions' });
  }
});

app.patch(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId'), express.json(), (req, res) => {
  const provider = normalizeProvider(req.params.provider);
  const sessionId = String(req.params.sessionId || '').trim();
  const providerHomeId = String(req.body?.providerHomeId || 'default').trim() || 'default';
  if (!provider || !isSafeSessionId(sessionId) || !/^[A-Za-z0-9._-]+$/.test(providerHomeId)) {
    res.status(400).json({ error: 'Invalid Agent session' });
    return;
  }
  if (typeof req.body?.pinned !== 'boolean') {
    res.status(400).json({ error: 'Pinned state is required' });
    return;
  }
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  configManager.setProviderSessionDisplayState(sessionKey, { pinned: req.body.pinned });
  res.json({ sessionKey, pinned: req.body.pinned });
});

app.get(routePath(BASE_PATH, '/api/themes'), (req, res) => {
  const currentTheme = configManager.getSettings().theme || 'terminal';
  res.json({
    themes: themeManager.getAllThemes(),
    current: currentTheme
  });
});

app.get(routePath(BASE_PATH, '/api/settings'), (req, res) => {
  res.json({
    settings: configManager.getSettings()
  });
});

app.get(routePath(BASE_PATH, '/api/workspaces/discovered'), (req, res) => {
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(20, requestedLimit)) : 12;
  const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
  const cacheToken = JSON.stringify({ limit, agent });
  workspaceDiscoveryCache.get(cacheToken)
    .then(workspaces => {
      res.json({ workspaces });
    })
    .catch(error => {
      console.error('Failed to discover workspaces:', error);
      res.status(500).json({ error: error.message || 'Failed to discover workspaces' });
    });
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/session-text'), async (req, res) => {
  const text = await agentManager.getAgentSessionText(req.params.agentId);
  if (text === null) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  res.type('text/plain');
  res.send(text);
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/session-view'), async (req, res) => {
  const sessionView = await agentManager.getAgentSessionView(req.params.agentId);
  if (!sessionView) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  res.json({ session: sessionView });
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/codex-transcript'), async (req, res) => {
  // Legacy JSONL transcript reader. New App Server Agents use the dedicated
  // structured endpoint below; Terminal Agents stay in their terminal UI.
  const providerSession = agentManager.getAgentProviderSession(req.params.agentId);
  if (!providerSession) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (
    providerSession.provider !== 'codex'
    || providerSession.temporary
    || !providerSession.sessionId
    || providerSession.sessionId.startsWith('tmp_uuid')
  ) {
    res.json({
      transcript: {
        available: false,
        reason: 'not-codex-provider-session',
        sessionId: providerSession.sessionId || '',
        turns: [],
      },
    });
    return;
  }

  try {
    const requestedMaxTurns = Number.parseInt(String(req.query.maxTurns || ''), 10);
    const maxTurns = Number.isFinite(requestedMaxTurns)
      ? Math.min(MAX_CODEX_TRANSCRIPT_TURNS, Math.max(20, requestedMaxTurns))
      : DEFAULT_CODEX_TRANSCRIPT_MAX_TURNS;
    const transcript = await readCodexTranscript(providerSession.sessionId, {
      maxTurns,
      codexHome: providerSession.codexRuntimeMode === 'app-server'
        ? (providerSession.codexAppServerHomePath || providerSession.providerHomePath || '')
        : (providerSession.providerHomePath || ''),
    });
    res.json({ transcript });
  } catch (error) {
    console.error('Failed to read Codex transcript:', error);
    res.status(500).json({ error: error.message || 'Failed to read Codex transcript' });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/codex-app-server-transcript'), async (req, res) => {
  try {
    const requestedMaxTurns = Number.parseInt(String(req.query.maxTurns || ''), 10);
    const maxTurns = Number.isFinite(requestedMaxTurns)
      ? Math.min(MAX_CODEX_TRANSCRIPT_TURNS, Math.max(20, requestedMaxTurns))
      : DEFAULT_CODEX_TRANSCRIPT_MAX_TURNS;
    const transcript = agentManager.getCodexAppServerTranscript(req.params.agentId, { maxTurns });
    res.json({ transcript });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to read Codex App Server transcript';
    res.status(/not using the Codex App Server runtime/i.test(message) ? 409 : 500).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/json-cli-transcript'), async (req, res) => {
  try {
    const transcript = agentManager.getJsonCliTranscript(req.params.agentId, {
      maxTurns: DEFAULT_CODEX_TRANSCRIPT_MAX_TURNS,
    });
    res.json({ transcript });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to read JSON CLI transcript';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-session'), async (req, res) => {
  try {
    res.json({
      session: agentManager.getAcpSession(req.params.agentId, {
        includeUpdates: req.query.includeUpdates === '1',
      }),
    });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to read ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-transcript'), async (req, res) => {
  try {
    const requestedMaxEntries = Number.parseInt(String(req.query.maxEntries || ''), 10);
    const maxEntries = Number.isFinite(requestedMaxEntries)
      ? Math.min(4_000, Math.max(100, requestedMaxEntries))
      : 600;
    res.json({ transcript: agentManager.getAcpTranscript(req.params.agentId, { maxEntries }) });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to read ACP transcript';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/acp-sessions'), async (req, res) => {
  try {
    const result = await agentManager.listAcpSessions(req.params.agentId, {
      cwd: typeof req.query.cwd === 'string' ? req.query.cwd : '',
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : '',
    });
    res.json(result);
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to list ACP sessions';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-permission'), express.json(), (req, res) => {
  try {
    const result = agentManager.respondToAcpPermission(
      req.params.agentId,
      req.body?.requestId,
      req.body?.optionId,
      req.body?.cancelled === true
    );
    res.json(result);
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to respond to ACP permission';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/authenticate'), express.json(), async (req, res) => {
  try {
    res.json(await agentManager.authenticateAcpAgent(req.params.agentId, req.body?.methodId));
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to authenticate ACP Agent';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/fork'), express.json(), async (req, res) => {
  try {
    res.json(await agentManager.forkAcpSession(req.params.agentId, req.body || {}));
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to fork ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.delete(routePath(BASE_PATH, '/api/agents/:agentId/acp-sessions/:sessionId'), async (req, res) => {
  try {
    res.json(await agentManager.deleteAcpSession(req.params.agentId, req.params.sessionId));
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to delete ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/acp-session/close'), async (req, res) => {
  try {
    res.json(await agentManager.closeAcpSession(req.params.agentId));
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to close ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.patch(routePath(BASE_PATH, '/api/agents/:agentId/acp-session'), express.json(), async (req, res) => {
  try {
    if (typeof req.body?.modeId === 'string') {
      res.json(await agentManager.setAcpSessionMode(req.params.agentId, req.body.modeId));
      return;
    }
    if (typeof req.body?.configId === 'string' && Object.prototype.hasOwnProperty.call(req.body, 'value')) {
      res.json(await agentManager.setAcpSessionConfigOption(
        req.params.agentId,
        req.body.configId,
        req.body.value
      ));
      return;
    }
    res.status(400).json({ error: 'ACP modeId or configId/value is required' });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to update ACP session';
    res.status(message === 'Agent not found' ? 404 : 409).json({ error: message });
  }
});

app.get(routePath(BASE_PATH, '/api/agents/:agentId/codex-goal'), async (req, res) => {
  try {
    const goal = await agentManager.getCodexAppServerGoal(req.params.agentId);
    res.json({ goal });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to read Codex goal';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

app.patch(routePath(BASE_PATH, '/api/agents/:agentId/codex-goal'), express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const goal = await agentManager.setCodexAppServerGoal(req.params.agentId, {
      objective: typeof body.objective === 'string' ? body.objective : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      ...(Object.prototype.hasOwnProperty.call(body, 'tokenBudget') ? { tokenBudget: body.tokenBudget } : {}),
    });
    res.json({ goal });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to update Codex goal';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

app.delete(routePath(BASE_PATH, '/api/agents/:agentId/codex-goal'), async (req, res) => {
  try {
    await agentManager.clearCodexAppServerGoal(req.params.agentId);
    res.json({ goal: null });
  } catch (error) {
    const message = error && error.message ? error.message : 'Failed to clear Codex goal';
    res.status(message === 'Agent not found' ? 404 : 400).json({ error: message });
  }
});

app.patch(routePath(BASE_PATH, '/api/agents/:agentId'), express.json(), async (req, res) => {
  const body = req.body || {};
  const updates = {};

  if (typeof body.customTitle === 'string') {
    const result = agentManager.renameAgent(req.params.agentId, body.customTitle);
    if (result.error) {
      res.status(404).json({ error: result.error });
      return;
    }
    updates.customTitle = result.customTitle;
  }

  if (typeof body.task === 'string') {
    const result = agentManager.setAgentTask(req.params.agentId, body.task);
    if (result.error) {
      res.status(404).json({ error: result.error });
      return;
    }
    updates.task = result.task;
  }

  const flagPatch = {};
  ['pinned', 'unread', 'archived'].forEach((flagName) => {
    if (typeof body[flagName] === 'boolean') {
      flagPatch[flagName] = body[flagName];
    }
  });
  if (typeof body.readAttentionSeq === 'number' && Number.isFinite(body.readAttentionSeq)) {
    flagPatch.readAttentionSeq = body.readAttentionSeq;
  }

  if (flagPatch.archived === true) {
    const result = await agentManager.archiveAgent(req.params.agentId);
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    Object.assign(updates, result);
    delete updates.agentId;
    delete flagPatch.archived;
  }

  if (Object.keys(flagPatch).length > 0) {
    const result = agentManager.updateAgentFlags(req.params.agentId, flagPatch);
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    Object.assign(updates, result);
    delete updates.agentId;
  }

  if (typeof body.launchPermissionMode === 'string') {
    const result = await agentManager.syncCodexTerminalPermissionMode(req.params.agentId, body.launchPermissionMode);
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    updates.launchPermissionMode = result.launchPermissionMode;
    if (result.restarted === true) updates.restarted = true;
    if (result.restartedAgentId) updates.restartedAgentId = result.restartedAgentId;
  }

  if (typeof body.agentRuntimeMode === 'string') {
    const result = await agentManager.restartAgentRuntimeMode(req.params.agentId, body.agentRuntimeMode);
    if (result.error) {
      const status = result.error === 'Agent not found' ? 404 : 400;
      res.status(status).json({ error: result.error });
      return;
    }
    updates.agentRuntimeMode = result.agentRuntimeMode;
    if (result.restarted === true) updates.restarted = true;
    if (result.restartedAgentId) updates.restartedAgentId = result.restartedAgentId;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'customTitle, task, pinned, unread, archived, readAttentionSeq, launchPermissionMode, or agentRuntimeMode is required' });
    return;
  }

  scheduleBroadcastState();
  res.json({ agentId: req.params.agentId, ...updates });
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/reorder'), express.json(), (req, res) => {
  const result = agentManager.reorderAgent(req.params.agentId, {
    beforeAgentId: req.body?.beforeAgentId,
    afterAgentId: req.body?.afterAgentId,
  });
  if (result.error) {
    const status = result.error === 'Agent not found' ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }
  scheduleBroadcastState();
  res.json(result);
});

app.post(routePath(BASE_PATH, '/api/agents/:agentId/fork'), express.json(), async (req, res) => {
  const mode = req.body && typeof req.body.mode === 'string' ? req.body.mode : 'same-worktree';
  const result = await agentManager.forkAgent(req.params.agentId, mode);
  if (result.error) {
    const status = result.error === 'Agent not found' ? 404 : 400;
    res.status(status).json({ error: result.error });
    return;
  }

  broadcastState();
  res.status(201).json(result);
});

app.post(routePath(BASE_PATH, '/api/projects/delete-worktree'), express.json(), async (req, res) => {
  const body = req.body || {};
  const workspace = typeof body.workspace === 'string' ? body.workspace : '';
  const result = await agentManager.deleteForkWorktreeProject(workspace, { force: body.force === true });
  if (result.error) {
    if (result.requiresForce) {
      res.status(409).json(result);
      return;
    }
    const status = result.error === 'Workspace not found' || result.error === 'Workspace is required' ? 404 : 400;
    res.status(status).json(result);
    return;
  }

  broadcastState();
  res.json(result);
});

app.post(routePath(BASE_PATH, '/api/codex/sessions/:sessionId/resume'), express.json(), async (req, res) => {
  await startResumedAgentSession(req, res, 'codex', req.params.sessionId);
});

app.post(routePath(BASE_PATH, '/api/agent-sessions/:provider/:sessionId/resume'), express.json(), async (req, res) => {
  await startResumedAgentSession(req, res, req.params.provider, req.params.sessionId);
});

const pendingResumeStarts = new Map();

function resumedAgentStartKey(provider, sessionId, options = {}) {
  return [
    provider,
    options.providerHomeId || 'default',
    sessionId,
    options.fork === true ? 'fork' : 'resume',
    options.asMain === true ? 'main' : 'agent',
  ].join(':');
}

function findResumedAgent(provider, sessionId, providerHomeId = '') {
  return findActiveAgentClaimingSession(agentManager.getState().agents, provider, { id: sessionId, providerHomeId });
}

function isMainAgentSessionWorkspace(session) {
  const values = [session && session.cwd, session && session.workspace];
  return values.some(value => {
    const normalized = String(value || '').trim().replace(/[\\/]+$/, '');
    return normalized === '~/.farming' || /(^|[/\\])\.farming$/.test(normalized);
  });
}

function rememberMainPageAgentSession(provider, sessionId, providerHomeId = '') {
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  if (typeof configManager.rememberMainPageSessionKey === 'function') {
    configManager.rememberMainPageSessionKey(sessionKey, {
      provider,
      providerSessionId: sessionId,
      providerSessionKey: sessionKey,
      providerHomeId: providerHomeId || 'default',
      source: 'resume',
    });
    return;
  }
  const currentKeys = typeof configManager.getMainPageSessionKeys === 'function'
    ? configManager.getMainPageSessionKeys()
    : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []);
  configManager.updateSettings({
    mainPageSessionKeys: [
      sessionKey,
      ...currentKeys.filter(key => key !== sessionKey),
    ],
  });
}

function forgetMainPageAgentSession(provider, sessionId, providerHomeId = '') {
  const sessionKey = mainPageAgentSessionKey(provider, sessionId, providerHomeId);
  if (typeof configManager.removeMainPageSessionKey === 'function') {
    configManager.removeMainPageSessionKey(sessionKey);
    return;
  }
  const currentKeys = typeof configManager.getMainPageSessionKeys === 'function'
    ? configManager.getMainPageSessionKeys()
    : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []);
  if (!currentKeys.includes(sessionKey)) return;
  configManager.updateSettings({
    mainPageSessionKeys: currentKeys.filter(key => key !== sessionKey),
  });
}

async function unarchiveCodexSession(sessionId, session = {}) {
  const codexResolution = resolveCompatibleCodexExecutable(session.cliVersion || '');
  if (!codexResolution.compatible) {
    return {
      error: codexResolution.error || 'Codex CLI is not compatible with this session',
      status: 400,
    };
  }

  try {
    await execFileAsync(codexResolution.path || 'codex', ['unarchive', sessionId], {
      cwd: session.cwd || session.workspace || os.homedir(),
      env: session.providerHomePath
        ? { ...process.env, CODEX_HOME: session.providerHomePath }
        : process.env,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { unarchived: true };
  } catch (error) {
    const message = [
      error && error.stdout ? String(error.stdout).trim() : '',
      error && error.stderr ? String(error.stderr).trim() : '',
      error && error.message ? String(error.message).trim() : '',
    ].filter(Boolean).join('\n') || 'failed to unarchive Codex session';
    return {
      error: message,
      status: 409,
    };
  }
}

async function resumeAgentSessionById(provider, rawSessionId, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const sessionId = String(rawSessionId || '').trim();
  const providerHomeId = typeof options.providerHomeId === 'string' && options.providerHomeId.trim() ? options.providerHomeId.trim() : 'default';
  if (!normalizedProvider || !isSafeSessionId(sessionId)) {
    return { error: 'invalid session id', status: 400 };
  }

  const shouldFork = options.fork === true;
  const requestedAsMain = options.asMain === true && !shouldFork;
  const shouldRememberMainPageSession = options.rememberMainPageSession !== false && !shouldFork && !requestedAsMain;
  const pendingResumeId = resumedAgentStartKey(normalizedProvider, sessionId, {
    fork: shouldFork,
    asMain: requestedAsMain,
    providerHomeId,
  });
  if (!shouldFork) {
    const existingAgent = findResumedAgent(normalizedProvider, sessionId, providerHomeId);
    if (existingAgent) {
      if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
      return { agentId: existingAgent.id, reused: true };
    }
  }
  const pendingStart = pendingResumeStarts.get(pendingResumeId);
  if (pendingStart) {
    const result = await pendingStart;
    if (result.error) {
      return result;
    }
    if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
    return {
      agentId: result.agentId,
      reused: true,
      pending: true,
      ...(result.claimed ? { claimed: true } : {}),
    };
  }

  const startPromise = (async () => {
    let session = await findAgentSession(normalizedProvider, sessionId, { limit: 200, providerHomeId, providerHomes: configuredProviderHomes() });
    if (session && session.archived && !shouldFork) {
      if (options.allowUnarchiveArchived === true && normalizedProvider === 'codex' && !requestedAsMain) {
        const unarchiveResult = await unarchiveCodexSession(sessionId, session);
        if (unarchiveResult.error) {
          return unarchiveResult;
        }
        session = await findAgentSession(normalizedProvider, sessionId, { limit: 200, providerHomeId, providerHomes: configuredProviderHomes() }) || {
          ...session,
          archived: false,
        };
      } else {
        forgetMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
        return {
          error: `${session.providerName || normalizedProvider} session is archived. Unarchive it before resuming.`,
          status: 409,
          archived: true,
        };
      }
    }
    if (!shouldFork && !requestedAsMain) {
      const claimingAgent = findActiveAgentClaimingSession(agentManager.getState().agents, normalizedProvider, {
        id: sessionId,
        providerHomeId,
        ...(session || {}),
      });
      if (claimingAgent) {
        if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
        return { agentId: claimingAgent.id, reused: true, claimed: true };
      }
    }

    const resumeAsMain = requestedAsMain && isMainAgentSessionWorkspace(session);
    if (requestedAsMain && !resumeAsMain) {
      return { error: 'session is not a Main Agent session', status: 400 };
    }

    const workingDirectory = session && (session.cwd || session.workspace) ? (session.cwd || session.workspace) : null;
    const command = buildAgentSessionResumeCommand(normalizedProvider, sessionId, {
      fork: shouldFork,
      cwd: workingDirectory,
    });

    if (!command) {
      return { error: 'invalid session id', status: 400 };
    }

    return new Promise((resolve) => {
      const resolvedProviderHomeId = session ? (session.providerHomeId || providerHomeId) : providerHomeId;
      const resumeSource = resumedAgentSource(normalizedProvider, sessionId, resolvedProviderHomeId);
      const startResult = agentManager.startAgent(command, workingDirectory, (agentId, error) => {
        if (error) {
          resolve({ error, status: 400 });
          return;
        }

        if (!agentId) {
          resolve({ error: 'failed to resume agent session', status: 500 });
          return;
        }

        resolve({ agentId });
      }, {
        wantsMain: resumeAsMain,
        task: session ? session.title : '',
        customTitle: typeof options.customTitle === 'string' ? options.customTitle : '',
        requiredCliVersion: normalizedProvider === 'codex' && session ? session.cliVersion : '',
        projectWorkspace: session ? (session.workspace || session.cwd || '') : '',
        source: shouldFork ? resumeSource.replace('-history:', '-history-fork:') : resumeSource,
        providerHomeId: resolvedProviderHomeId,
        providerHomePath: session ? (session.providerHomePath || '') : '',
        autoReadInitialAttention: options.autoReadInitialAttention === true,
      });
      Promise.resolve(startResult).catch((error) => {
        resolve({ error: error.message || 'failed to resume agent session', status: 500 });
      });
    });
  })();
  pendingResumeStarts.set(pendingResumeId, startPromise);

  const result = await startPromise;
  if (pendingResumeStarts.get(pendingResumeId) === startPromise) {
    pendingResumeStarts.delete(pendingResumeId);
  }

  if (result.error) {
    return result;
  }

  if (shouldRememberMainPageSession) rememberMainPageAgentSession(normalizedProvider, sessionId, providerHomeId);
  if (result.reused) {
    return {
      agentId: result.agentId,
      reused: true,
      ...(result.claimed ? { claimed: true } : {}),
    };
  }
  return { agentId: result.agentId };
}

async function startResumedAgentSession(req, res, provider, rawSessionId) {
  const shouldFork = req.body && req.body.fork === true;
  const requestedAsMain = req.body && req.body.asMain === true && !shouldFork;
  const allowUnarchiveArchived = req.body && req.body.unarchiveArchived === true && !shouldFork && !requestedAsMain;
  const result = await resumeAgentSessionById(provider, rawSessionId, {
    fork: shouldFork,
    asMain: requestedAsMain,
    allowUnarchiveArchived,
    providerHomeId: req.body && typeof req.body.providerHomeId === 'string' ? req.body.providerHomeId : '',
    customTitle: req.body && typeof req.body.customTitle === 'string' ? req.body.customTitle : '',
  });

  if (result.error) {
    res.status(result.status || 400).json({ error: result.error });
    return;
  }

  broadcastState();
  if (result.reused) {
    res.status(200).json({
      agentId: result.agentId,
      reused: true,
      ...(result.claimed ? { claimed: true } : {}),
      ...(result.pending ? { pending: true } : {}),
    });
    return;
  }

  res.status(201).json({ agentId: result.agentId });
}

async function autoResumeMainPageAgentSessions() {
  if (typeof agentManager.whenRecovered === 'function') {
    await agentManager.whenRecovered();
  }

  const sessions = mainPageAgentSessionsToAutoResume(configManager.getSettings());
  if (sessions.length === 0) return;

  let resumedCount = 0;
  for (const session of sessions) {
    try {
      const sessionDetails = await findAgentSession(session.provider, session.sessionId, { limit: 200, providerHomeId: session.providerHomeId || 'default', providerHomes: configuredProviderHomes() });
      if (!sessionDetails) {
        console.warn('Dropping stale main-page session from auto-resume:', session.provider, session.sessionId);
        forgetMainPageAgentSession(session.provider, session.sessionId, session.providerHomeId || 'default');
        continue;
      }

      const claimingAgent = findActiveAgentClaimingSession(agentManager.getState().agents, session.provider, {
        id: session.sessionId,
        ...(sessionDetails || {}),
      });
      if (claimingAgent) {
        continue;
      }

      const result = await resumeAgentSessionById(session.provider, session.sessionId, {
        rememberMainPageSession: false,
        providerHomeId: session.providerHomeId || 'default',
        autoReadInitialAttention: true,
      });
      if (result.error) {
        const message = String(result.error || '').toLowerCase();
        if (session.provider === 'qoder' && message.includes('invalid session identifier')) {
          console.warn('Dropping stale qoder session from auto-resume:', session.provider, session.sessionId, result.error);
          forgetMainPageAgentSession(session.provider, session.sessionId, session.providerHomeId || 'default');
          continue;
        }
        console.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, result.error);
      } else {
        resumedCount += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('Failed to auto-resume main page agent session:', session.provider, session.sessionId, message);
    }
  }

  if (resumedCount > 0) {
    broadcastState();
  }
}

app.post(routePath(BASE_PATH, '/api/settings'), express.json(), (req, res) => {
  configManager.updateSettings(req.body || {});
  agentSessionsCache.invalidate();
  res.json({
    success: true,
    settings: configManager.getSettings()
  });
  broadcastState();
});

app.post(routePath(BASE_PATH, '/api/themes/:themeId/set'), express.json(), (req, res) => {
  const theme = themeManager.getTheme(req.params.themeId);
  if (!theme) {
    res.status(404).json({ error: 'Theme not found' });
    return;
  }
  
  configManager.updateSettings({ theme: req.params.themeId });
  res.json({ success: true, theme: req.params.themeId });
});

app.get(routePath(BASE_PATH, '/api/themes/:themeId/settings'), (req, res) => {
  const theme = themeManager.getTheme(req.params.themeId);
  if (!theme) {
    res.status(404).json({ error: 'Theme not found' });
    return;
  }
  
  const settings = themeManager.getThemeSettings(req.params.themeId);
  res.json({ settings });
});

app.post(routePath(BASE_PATH, '/api/themes/:themeId/settings'), express.json(), (req, res) => {
  const theme = themeManager.getTheme(req.params.themeId);
  if (!theme) {
    res.status(404).json({ error: 'Theme not found' });
    return;
  }
  
  const success = themeManager.updateThemeSettings(req.params.themeId, req.body);
  if (success) {
    res.json({ success: true, settings: themeManager.getThemeSettings(req.params.themeId) });
  } else {
    res.status(500).json({ error: 'Failed to update theme settings' });
  }
});

app.get(routePath(BASE_PATH, '/api/themes/:themeId'), (req, res) => {
  const theme = themeManager.getTheme(req.params.themeId);
  if (!theme) {
    res.status(404).json({ error: 'Theme not found' });
    return;
  }
  
  const css = themeManager.getThemeCSS(req.params.themeId);
  res.json({
    theme,
    css
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== WS_PATH) {
    ws.close(1008, 'Invalid path');
    return;
  }

  // Verify token for WebSocket connections when auth is enabled.
  if (authEnabled && !tokenAuth.verifyWebSocket(req)) {
    ws.close(4001, 'Authentication required');
    return;
  }

  console.log('Client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  });
  
  ws.on('close', () => {
    clearWorkspaceFileWatch(ws);
    console.log('Client disconnected');
  });
  
  sendState(ws);
});

const MAIN_AGENT_RESTART_COMMANDS = new Set(['codex', 'claude', 'opencode', 'qoder', 'bash', 'zsh']);

function normalizeMainAgentRestartCommand(command) {
  const normalized = String(command || '').trim();
  return MAIN_AGENT_RESTART_COMMANDS.has(normalized) ? normalized : '';
}

function restartMainAgent(ws, command) {
  const normalizedCommand = normalizeMainAgentRestartCommand(command);
  if (!normalizedCommand) {
    ws.send(JSON.stringify({ type: 'error', message: 'Unsupported Main Agent restart command' }));
    return;
  }

  void (async () => {
    try {
      const state = agentManager.getState();
      const currentMain = state.agents.find(agent => (
        agent.id === state.mainAgentId || agent.isMain === true
      ));
      if (currentMain) {
        await agentManager.killAgent(currentMain.id);
      }

      await agentManager.startAgent(normalizedCommand, null, (agentId, error) => {
        if (error) {
          ws.send(JSON.stringify({ type: 'error', message: error }));
        } else if (agentId) {
          ws.agentId = agentId;
          broadcastState();
          ws.send(JSON.stringify({ type: 'agent-started', agentId }));
        }
      }, {
        wantsMain: true
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart Main Agent';
      ws.send(JSON.stringify({ type: 'error', message }));
      broadcastState();
    }
  })();
}

async function sendInputMessage(ws, data) {
  const targetAgentId = resolveInputTargetAgentId(ws, data);
  if (!targetAgentId) return;

  const inputParts = inputPartsFromMessage(data);
  if (inputParts.length === 0) return;
  await agentManager.sendInput(targetAgentId, inputParts);
}

async function sendComposerInputMessage(ws, data) {
  const targetAgentId = resolveInputTargetAgentId(ws, data);
  const message = typeof data.message === 'string' ? data.message : '';
  if (!targetAgentId || !message.trim()) return;
  try {
    await agentManager.sendComposerMessage(targetAgentId, message);
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: error && error.message ? error.message : 'Failed to send Composer message',
    }));
  }
}

async function respondToAppServerRequest(ws, data) {
  const targetAgentId = resolveInputTargetAgentId(ws, data);
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';
  if (!targetAgentId || !requestId) return;
  try {
    agentManager.respondToCodexAppServerRequest(targetAgentId, requestId, data.result, {
      reject: data.reject === true,
      reason: typeof data.reason === 'string' ? data.reason : '',
    });
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      message: error && error.message ? error.message : 'Failed to respond to Codex App Server request',
    }));
  }
}

function handleMessage(ws, data) {
  switch (data.type) {
    case 'start-agent': {
      const workspace = data.workspace || null;
      agentManager.startAgent(data.command, workspace, (agentId, error) => {
        if (error) {
          ws.send(JSON.stringify({ type: 'error', message: error }));
        } else if (agentId) {
          ws.agentId = agentId;
          broadcastState();
          ws.send(JSON.stringify({ type: 'agent-started', agentId }));
        }
      }, {
        wantsMain: data.asMain === true,
        projectWorkspace: typeof data.projectWorkspace === 'string' ? data.projectWorkspace : '',
        task: typeof data.task === 'string' ? data.task : '',
        workflowTemplate: typeof data.workflowTemplate === 'string' ? data.workflowTemplate : '',
        customTitle: typeof data.customTitle === 'string' ? data.customTitle : '',
        codexApprovalMode: typeof data.codexApprovalMode === 'string' ? data.codexApprovalMode : undefined,
        codexRuntimeMode: data.codexRuntimeMode === 'app-server' || data.codexRuntimeMode === 'cli'
          ? data.codexRuntimeMode
          : undefined,
        agentRuntimeMode: ['json', 'acp'].includes(data.agentRuntimeMode) ? data.agentRuntimeMode : 'terminal',
        acpHistoryMode: data.acpHistoryMode === 'resume' ? 'resume' : 'load',
        providerHomeId: typeof data.providerHomeId === 'string' ? data.providerHomeId : '',
        ...(data.dangerouslySkipPermissions === true ? { dangerouslySkipPermissions: true } : {}),
      });
      break;
    }
    case 'input':
      {
        void sendInputMessage(ws, data);
      }
      break;

    case 'composer-input':
      {
        void sendComposerInputMessage(ws, data);
      }
      break;

    case 'app-server-request-response':
      {
        void respondToAppServerRequest(ws, data);
      }
      break;

    case 'acp-permission-response':
      try {
        agentManager.respondToAcpPermission(
          data.agentId,
          data.requestId,
          data.optionId,
          data.cancelled === true
        );
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          message: error && error.message ? error.message : 'Failed to respond to ACP permission',
        }));
      }
      break;

    case 'interrupt-agent':
      if (data.agentId) {
        agentManager.interruptAgent(data.agentId);
      }
      break;
      
    case 'focus-agent':
      ws.focusedAgentId = data.agentId;
      if (data.streamScope === 'focused' || data.streamScope === 'all') {
        ws.streamScope = data.streamScope;
      }
      if (data.previewScope === 'none' || data.previewScope === 'focused' || data.previewScope === 'all') {
        ws.previewScope = data.previewScope;
      }
      if (data.refreshState === true) {
        sendState(ws);
      }
      break;

    case 'resize-agent':
      if (data.agentId && Number.isFinite(data.cols) && Number.isFinite(data.rows)) {
        agentManager.resizeAgentSession(data.agentId, data.cols, data.rows);
      }
      break;

    case 'watch-workspace-files':
      watchWorkspaceFiles(ws, data);
      break;

    case 'unwatch-workspace-files':
      clearWorkspaceFileWatch(ws, data.agentId);
      break;
      
    case 'kill-agent':
      agentManager.killAgent(data.agentId);
      broadcastState();
      break;

    case 'restart-main-agent':
      restartMainAgent(ws, data.command);
      break;
      
    default:
      console.log('Unknown message type:', data.type);
  }
}

const { resolveInputTargetAgentId } = require('./input-routing');

function sendWorkspaceFileWatchError(ws, error) {
  const message = error instanceof WorkspaceFileError ? error.message : 'failed to watch workspace files';
  ws.send(JSON.stringify({ type: 'error', message }));
}

function clearWorkspaceFileWatch(ws, agentId = null) {
  const watches = ws.workspaceFileUnsubscribes;
  if (!watches) return;

  const entries = agentId
    ? [[agentId, watches.get(agentId)]]
    : Array.from(watches.entries());

  entries.forEach(([watchedAgentId, unsubscribe]) => {
    if (!unsubscribe) return;
    watches.delete(watchedAgentId);
    Promise.resolve(unsubscribe()).catch((error) => {
      console.error('Failed to clear workspace file watch:', error);
    });
  });

  if (watches.size === 0) {
    ws.workspaceFileUnsubscribes = null;
  }
}

async function watchWorkspaceFiles(ws, data) {
  try {
    if (!data.agentId) {
      throw new WorkspaceFileError('agentId is required', 400);
    }
    if (!ws.workspaceFileUnsubscribes) {
      ws.workspaceFileUnsubscribes = new Map();
    }
    if (ws.workspaceFileUnsubscribes.has(data.agentId)) {
      ws.send(JSON.stringify({
        type: 'workspace-file-watch',
        agentId: data.agentId,
        watching: true,
      }));
      return;
    }

    const root = agentManager.getAgentWorkspaceRoot(data.agentId);
    if (!root) {
      throw new WorkspaceFileError('agent not found', 404);
    }

    const unsubscribe = await workspaceFileService.subscribe(root, (event) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'workspace-file-event',
        event: {
          agentId: data.agentId,
          ...event,
        },
      }));
    });
    ws.workspaceFileUnsubscribes.set(data.agentId, unsubscribe);
    ws.send(JSON.stringify({
      type: 'workspace-file-watch',
      agentId: data.agentId,
      watching: true,
    }));
  } catch (error) {
    sendWorkspaceFileWatchError(ws, error);
  }
}

function buildStatePayload() {
  return {
    ...agentManager.getState(),
    mainPageSessionKeys: typeof configManager.getMainPageSessionKeys === 'function'
      ? configManager.getMainPageSessionKeys()
      : (Array.isArray(configManager.getSettings().mainPageSessionKeys) ? configManager.getSettings().mainPageSessionKeys : []),
  };
}

function sendState(ws) {
  const state = buildStatePayload();
  ws.send(JSON.stringify({ type: 'state', state }));
  agentManager.getPreviewPayloads().forEach((preview) => {
    sendPreview(ws, preview);
  });
}

function sendPreview(ws, preview) {
  ws.send(JSON.stringify({
    type: 'session-preview',
    preview,
  }));
}

const STATE_BROADCAST_INTERVAL_MS = 120;
const PREVIEW_BROADCAST_INTERVAL_MS = 500;
const SESSION_STREAM_BROADCAST_INTERVAL_MS = 33;
const MAX_SESSION_STREAM_CLIENT_BUFFERED_AMOUNT = 4 * 1024 * 1024;
let stateBroadcastTimer = null;
let lastStateBroadcastAt = 0;
const pendingPreviewBroadcasts = new Map();
const pendingSessionStreams = new Map();
let sessionStreamBroadcastTimer = null;
let shutdownStarted = false;

function broadcastState() {
  lastStateBroadcastAt = Date.now();
  stateBroadcastTimer = null;
  const state = buildStatePayload();
  const message = JSON.stringify({ type: 'state', state });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function scheduleBroadcastState() {
  const now = Date.now();
  const elapsed = now - lastStateBroadcastAt;

  if (elapsed >= STATE_BROADCAST_INTERVAL_MS) {
    broadcastState();
    return;
  }

  if (stateBroadcastTimer) {
    return;
  }

  stateBroadcastTimer = setTimeout(() => {
    broadcastState();
  }, STATE_BROADCAST_INTERVAL_MS - elapsed);
}

function broadcastSessionPreview(preview) {
  const message = JSON.stringify({
    type: 'session-preview',
    preview,
  });

  wss.clients.forEach((client) => {
    const previewAllowed = client.previewScope !== 'none'
      && (client.previewScope !== 'focused' || client.focusedAgentId === preview.agentId);
    if (client.readyState === WebSocket.OPEN && previewAllowed) {
      client.send(message);
    }
  });
}

function schedulePreviewBroadcast(preview) {
  const agentId = preview && preview.agentId;
  if (!agentId) {
    broadcastSessionPreview(preview);
    return;
  }

  const now = Date.now();
  const entry = pendingPreviewBroadcasts.get(agentId) || {
    lastAt: 0,
    timer: null,
    preview: null,
  };
  entry.preview = preview;

  const elapsed = now - entry.lastAt;
  if (elapsed >= PREVIEW_BROADCAST_INTERVAL_MS) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.lastAt = now;
    const latest = entry.preview;
    entry.preview = null;
    pendingPreviewBroadcasts.set(agentId, entry);
    broadcastSessionPreview(latest);
    return;
  }

  if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.lastAt = Date.now();
      const latest = entry.preview;
      entry.preview = null;
      pendingPreviewBroadcasts.set(agentId, entry);
      if (latest) {
        broadcastSessionPreview(latest);
      }
    }, PREVIEW_BROADCAST_INTERVAL_MS - elapsed);
  }

  pendingPreviewBroadcasts.set(agentId, entry);
}

agentManager.onUpdate(() => {
  scheduleBroadcastState();
});

agentManager.on('provider-session-updated', () => {
  agentSessionsCache.invalidate();
  scheduleBroadcastState();
});

function sessionStreamKey(stream) {
  return `${stream.agentId || ''}\0${stream.sessionSource || ''}`;
}

function broadcastSessionStream(stream) {
  const message = JSON.stringify({
    type: 'session-output',
    stream
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      if (client.streamScope === 'focused' && client.focusedAgentId !== stream.agentId) return;
      if (client.bufferedAmount > MAX_SESSION_STREAM_CLIENT_BUFFERED_AMOUNT) return;
      client.send(message);
    }
  });
}

function flushSessionStreams() {
  sessionStreamBroadcastTimer = null;
  const streams = Array.from(pendingSessionStreams.values());
  pendingSessionStreams.clear();
  streams.forEach(broadcastSessionStream);
}

function scheduleSessionStreamBroadcast(stream) {
  if (!stream || !stream.agentId) return;
  const key = sessionStreamKey(stream);
  const existing = pendingSessionStreams.get(key);
  const data = typeof stream.data === 'string' ? stream.data : String(stream.data || '');
  const outputSeq = Number.isFinite(stream.outputSeq) ? stream.outputSeq : undefined;

  if (existing) {
    pendingSessionStreams.set(key, {
      ...stream,
      data: stream.replace === true ? data : `${existing.data || ''}${data}`,
      replace: existing.replace || stream.replace === true,
      outputSeq: outputSeq ?? existing.outputSeq,
    });
  } else {
    pendingSessionStreams.set(key, {
      ...stream,
      data,
      replace: stream.replace === true,
      outputSeq,
    });
  }

  if (!sessionStreamBroadcastTimer) {
    sessionStreamBroadcastTimer = setTimeout(flushSessionStreams, SESSION_STREAM_BROADCAST_INTERVAL_MS);
    if (typeof sessionStreamBroadcastTimer.unref === 'function') sessionStreamBroadcastTimer.unref();
  }
}

function clearBroadcastTimers() {
  if (stateBroadcastTimer) {
    clearTimeout(stateBroadcastTimer);
    stateBroadcastTimer = null;
  }
  for (const entry of pendingPreviewBroadcasts.values()) {
    if (entry && entry.timer) {
      clearTimeout(entry.timer);
    }
  }
  pendingPreviewBroadcasts.clear();
  if (sessionStreamBroadcastTimer) {
    clearTimeout(sessionStreamBroadcastTimer);
    sessionStreamBroadcastTimer = null;
  }
  pendingSessionStreams.clear();
}

function closeHttpServer() {
  return new Promise(resolve => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.warn('Failed to close HTTP server:', error.message || error);
      }
      resolve();
    });
  });
}

function closeWebSocketServer() {
  for (const client of wss.clients) {
    clearWorkspaceFileWatch(client);
    try {
      client.close(1001, 'Farming server shutting down');
    } catch {
      // ignore shutdown races
    }
  }
  return new Promise(resolve => {
    wss.close(() => resolve());
    setTimeout(resolve, 250).unref?.();
  });
}

async function shutdownServer(options = {}) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const preserveTerminalHost = options.preserveTerminalHost !== undefined
    ? options.preserveTerminalHost === true
    : process.env.FARMING_NATIVE_PTY_HOST_PERSIST !== '0';

  clearBroadcastTimers();
  tokenAuth.cleanup();
  await Promise.allSettled([
    closeWebSocketServer(),
    workspaceFileService.dispose(),
    agentManager.dispose({ preserveTerminalHost }),
    closeHttpServer(),
  ]);

  if (options.exit === true) {
    process.exit(options.exitCode || 0);
  }
}

agentManager.onSessionStream((stream) => {
  scheduleSessionStreamBroadcast(stream);
});

agentManager.onSessionPreview((preview) => {
  schedulePreviewBroadcast(preview);
});

agentManager.onSystemStats((systemStats) => {
  const usageSnapshot = agentManager.getAgentUsageSnapshots();
  const message = JSON.stringify({ 
    type: 'system-stats', 
    stats: {
      ...systemStats,
      ip: getPrimaryLocalIP(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    uptime: agentManager.getUptime(),
    usageRate: {
      windowMs: usageSnapshot.windowMs,
      estimatedTokensPerMinute: usageSnapshot.estimatedTokensPerMinute,
      source: usageSnapshot.source,
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

let serverStarted = false;
let terminalRuntimeCleanupPromise = null;

function runTerminalRuntimeStartupCleanup() {
  if (!terminalRuntimeCleanupPromise) {
    terminalRuntimeCleanupPromise = cleanupTerminalRuntime({ configDir: configManager.farmingDir })
      .catch(error => {
        console.warn('Failed to clean terminal runtime leftovers:', error && (error.message || error));
        return null;
      });
  }
  return terminalRuntimeCleanupPromise;
}

function startServer() {
  if (serverStarted) return server;
  serverStarted = true;

  void runTerminalRuntimeStartupCleanup().finally(() => {
    if (shutdownStarted) return;
    server.listen(PORT, () => {
      const token = tokenAuth.getToken();
      const localIPs = getLocalIPs();
      const entryPath = BASE_PATH || '/';
      const entrySuffix = authEnabled ? `${entryPath}?token=${token}` : entryPath;

      console.log('');
      console.log('  Farming server running on:');
      console.log('');
      console.log(`  Local:   http://localhost:${PORT}${entrySuffix}`);
      localIPs.forEach(ip => {
        console.log(`  Network: http://${ip}:${PORT}${entrySuffix}`);
      });
      console.log('');
      if (authEnabled) {
        console.log(`  Token: ${token}`);
        const tokenInfo = tokenAuth.getTokenInfo();
        if (tokenInfo) {
          console.log(`  Token style: ${tokenInfo.style} (${tokenInfo.source}, ~${tokenInfo.entropyBits} bits)`);
        }
      } else {
        console.log('  Token auth: disabled');
      }
      console.log('');
      setTimeout(warmCodexExecutableVersionCache, 100);
      void autoResumeMainPageAgentSessions();
    });
  });

  process.on('SIGINT', () => {
    void shutdownServer({ exit: true });
  });
  process.on('SIGTERM', () => {
    void shutdownServer({ exit: true });
  });

  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  server,
  wss,
  agentManager,
  appServerApiBridge,
  workspaceFileService,
  handleMessage,
  resolveCliBinDir,
  resolveInputTargetAgentId,
  rewriteIndexHtmlForBasePath,
  appendIndexHtmlAssetToken,
  startServer,
  shutdownServer,
  runTerminalRuntimeStartupCleanup,
};
