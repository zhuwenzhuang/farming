const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
import { inspectGitWorktree } from './git-worktree-info.cjs';
import { isSameOrDescendantPath } from './path-containment.cjs';
import type {
  LocalBranchInventory,
  LocalBranchSwitchRequest,
  LocalBranchSwitchResult,
} from './worktree-git-service.cjs';
interface WorkspaceFileApiError extends Error {
  details: Record<string, unknown>;
  statusCode: number;
}

import { WorkspaceFileError } from './workspace-file-service.cjs';
import { PreviewSessionManager } from './preview-session-manager.cjs';
import { GLOBAL_WORKSPACE_FILES_AGENT_ID, GLOBAL_WORKSPACE_FILES_ROOT, GLOBAL_WORKSPACE_ROOT_ID, PROJECT_FILES_WORKSPACE_PREFIX, WorkspaceRootRegistry, projectWorkspaceFromLegacyRef } from './workspace-root-registry.cjs';

type InputRecord = Record<string, unknown>;

interface AgentManager {
  configManager?: {
    getSettings?: () => {
      projectWorkspaces?: unknown;
      searchTimeoutMs?: unknown;
      workspaceHistory?: unknown;
    };
  } | null;
  getState?: () => {
    agents?: InputRecord[];
    taskHistory?: InputRecord[];
  };
  inspectProjectBranches(workspace: string): Promise<LocalBranchInventory>;
  switchProjectBranch(
    workspace: string,
    request: LocalBranchSwitchRequest & { requestId: string },
  ): Promise<LocalBranchSwitchResult>;
}

interface WorkspaceRoot {
  canonicalPath: string;
  kind?: string;
  rootId: string;
}

interface WorkspaceRootRegistryLike {
  list(): unknown;
  resolve(rootRef: unknown): WorkspaceRoot;
}

interface PreviewFileResult {
  buffer: Buffer;
  path: string;
  preview: { mediaType: string };
  size: number;
}

interface ResourceFileResult {
  buffer: Buffer;
  path: string;
  size: number;
}

interface WorkspaceFileServiceLike {
  blame(root: string, userPath: unknown): Promise<unknown>;
  blameCapability(root: string, userPath: unknown, options?: ReadOptions): Promise<unknown>;
  changes(root: string, options?: InputRecord): Promise<unknown>;
  createEntry(root: string, parentPath: unknown, name: unknown, type: unknown, content: unknown): Promise<InputRecord>;
  deleteEntry(root: string, userPath: unknown, options?: MutationVersionOptions): Promise<unknown>;
  diff(root: string, userPath: unknown): Promise<unknown>;
  gitBranch(root: string): Promise<unknown>;
  gitHistory(root: string, options?: InputRecord): Promise<unknown>;
  gitHistoryChanges(root: string, commit: unknown, parent: unknown, options?: InputRecord): Promise<unknown>;
  invalidateGitStatus?(root: string): void;
  lineChanges(root: string, userPath: unknown, lineNumber: unknown, mode: unknown): Promise<unknown>;
  listTree(root: string, userPath: unknown, options?: ReadOptions): Promise<unknown>;
  moveEntry(root: string, sourcePath: unknown, targetDirectory: unknown, options?: MutationVersionOptions): Promise<unknown>;
  readFile(root: string, userPath: unknown, options?: ReadOptions): Promise<unknown>;
  readPreviewFile(root: string, userPath: unknown, options?: ReadOptions): Promise<PreviewFileResult>;
  readResourceFile(root: string, userPath: unknown, options?: ReadOptions): Promise<ResourceFileResult>;
  renameEntry(root: string, sourcePath: unknown, name: unknown, options?: MutationVersionOptions): Promise<unknown>;
  search(root: string, query: unknown, options?: InputRecord): Promise<unknown>;
  writeFile(root: string, userPath: unknown, content: unknown, options?: InputRecord): Promise<unknown>;
}

interface PreviewSession {
  authorizedRoot: string;
  baseDirectory: string;
  expiresAt: number;
  id: string;
  kind: string;
  workspaceRoot: string;
}

interface PreviewSessionManagerLike {
  createStatic(options: InputRecord): PreviewSession;
  delete(sessionId: string): boolean;
  get(sessionId: string): PreviewSession | null;
}

interface HttpRequest {
  authAccessMode?: 'owner' | 'read-only';
  baseUrl: string;
  body: InputRecord;
  params: Record<string, string> & { 0?: string };
  query: InputRecord;
}

interface HttpResponse {
  end(): void;
  json(value: unknown): HttpResponse;
  send(value: unknown): HttpResponse;
  set(field: string, value: string): HttpResponse;
  status(code: number): HttpResponse;
  type(value: string): HttpResponse;
}

type HttpHandler = (request: HttpRequest, response: HttpResponse) => void | Promise<void>;

interface ExpressRouter {
  delete(path: string, handler: HttpHandler): ExpressRouter;
  get(path: string, handler: HttpHandler): ExpressRouter;
  patch(path: string, handler: HttpHandler): ExpressRouter;
  post(path: string, handler: HttpHandler): ExpressRouter;
  put(path: string, handler: HttpHandler): ExpressRouter;
  use(handler: unknown): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

interface ReadOptions {
  allowedExternalRoots?: string[];
}

interface MutationVersionOptions {
  expectedVersion?: unknown;
}

interface GlobalPathOptions {
  allowAllowedRootAncestor?: boolean;
  allowMissing?: boolean;
}

interface RouterOptions {
  previewSessionManager?: PreviewSessionManagerLike;
  rootRegistry?: WorkspaceRootRegistryLike;
}

const expressFactory = express as ExpressFactory;
const ROOT_REGISTRIES = new WeakMap<AgentManager, WorkspaceRootRegistryLike>();

function isRecord(value: unknown): value is InputRecord {
  return typeof value === 'object' && value !== null;
}

function isGlobalWorkspaceFilesAgentId(agentId: unknown): boolean {
  return agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID || agentId === GLOBAL_WORKSPACE_ROOT_ID;
}

function projectWorkspaceFromFilesId(filesId: unknown): unknown {
  return projectWorkspaceFromLegacyRef(filesId);
}

function workspaceRootRegistryFor(agentManager: AgentManager): WorkspaceRootRegistryLike {
  let registry = ROOT_REGISTRIES.get(agentManager);
  if (!registry) {
    registry = new WorkspaceRootRegistry(agentManager) as WorkspaceRootRegistryLike;
    ROOT_REGISTRIES.set(agentManager, registry);
  }
  return registry;
}

function workspaceRef(source: unknown): unknown {
  if (!isRecord(source)) return undefined;
  return typeof source.rootId === 'string' && source.rootId.trim()
    ? source.rootId
    : source.agentId;
}

function normalizeAbsolutePath(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function realPathIfPresent(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

function previewAuthorizedRootForTarget(allowedRoots: string[], target: string): string {
  return allowedRoots
    .filter(root => isSameOrDescendantPath(root, target))
    .sort((left, right) => right.length - left.length)[0] || '';
}

function normalizePreviewAssetPath(value: unknown): string {
  const normalized = path.posix.normalize(String(value || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new WorkspaceFileError('preview path must stay inside the authorized root', 403);
  }
  return normalized;
}

function previewContentSecurityPolicy() {
  return [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function escapeHtmlAttribute(value: unknown): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewritePreviewHtmlRootReferences(source: unknown, rootUrl: string): string {
  const safeRootUrl = escapeHtmlAttribute(rootUrl);
  return String(source || '')
    .replace(/(\b(?:href|src|poster)\s*=\s*["'])\/(?!\/)/gi, `$1${safeRootUrl}`)
    .replace(/(url\(\s*["']?)\/(?!\/)/gi, `$1${safeRootUrl}`);
}

function globalUserPathToAbsolute(userPath: unknown = ''): string {
  const normalized = String(userPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  return path.resolve(GLOBAL_WORKSPACE_FILES_ROOT, normalized || '.');
}

function relativeGlobalPath(absolutePath: string): string {
  const relative = path.relative(GLOBAL_WORKSPACE_FILES_ROOT, absolutePath);
  return relative === '' ? '' : relative.replace(/\\/g, '/');
}

function collectCandidateAllowedRoots(agentManager: AgentManager) {
  const roots = [os.homedir()];
  const state = agentManager && typeof agentManager.getState === 'function'
    ? agentManager.getState()
    : {};
  for (const agent of state.agents || []) {
    const worktree = isRecord(agent.gitWorktree) ? agent.gitWorktree : {};
    roots.push(agent && agent.projectWorkspace);
    roots.push(agent && agent.cwd);
    roots.push(worktree.workspace);
  }
  for (const entry of state.taskHistory || []) {
    roots.push(entry && entry.projectWorkspace);
    roots.push(entry && entry.cwd);
  }

  const configManager = agentManager && agentManager.configManager;
  const settings = configManager && typeof configManager.getSettings === 'function'
    ? configManager.getSettings()
    : null;
  if (settings) {
    roots.push(...(Array.isArray(settings.workspaceHistory) ? settings.workspaceHistory : []));
    roots.push(...(Array.isArray(settings.projectWorkspaces) ? settings.projectWorkspaces : []));
  }
  return roots;
}

function globalWorkspaceAllowedRoots(agentManager: AgentManager) {
  const seen = new Set();
  return collectCandidateAllowedRoots(agentManager)
    .map(normalizeAbsolutePath)
    .filter(Boolean)
    .map(realPathIfPresent)
    .filter(root => {
      if (root === path.parse(root).root) return false;
      if (seen.has(root)) return false;
      seen.add(root);
      return true;
    });
}

function assertGlobalWorkspacePathAllowed(
  agentManager: AgentManager,
  userPath: unknown,
  options: GlobalPathOptions = {},
): { target: string; allowedRoots: string[] } {
  const allowedRoots = globalWorkspaceAllowedRoots(agentManager);
  const requestedTarget = globalUserPathToAbsolute(userPath);
  if (!allowedRoots.length) {
    throw new WorkspaceFileError('global files have no allowed roots', 403);
  }

  if (options.allowAllowedRootAncestor === true) {
    const isAllowedRootAncestor = allowedRoots.some(root => isSameOrDescendantPath(requestedTarget, root));
    if (isAllowedRootAncestor) return { target: requestedTarget, allowedRoots };
  }

  const allowed = allowedRoots.some(root => {
    if (options.allowMissing === true) {
      const realParent = realPathIfPresent(path.dirname(requestedTarget));
      return isSameOrDescendantPath(root, requestedTarget) && isSameOrDescendantPath(root, realParent);
    }
    const realTarget = realPathIfPresent(requestedTarget);
    return isSameOrDescendantPath(root, realTarget);
  });
  if (!allowed) {
    throw new WorkspaceFileError('global file path is outside allowed workspaces', 403);
  }
  return { target: requestedTarget, allowedRoots };
}

function assertExactExternalFileReadable(userPath: unknown): string {
  const requestedTarget = globalUserPathToAbsolute(userPath);
  let target;
  let stat;
  try {
    target = fs.realpathSync(requestedTarget);
    stat = fs.statSync(target);
    fs.accessSync(target, fs.constants.R_OK);
  } catch {
    throw new WorkspaceFileError('external file is not readable', 403);
  }
  if (!stat.isFile()) {
    throw new WorkspaceFileError('external path must be a file', 400);
  }
  return relativeGlobalPath(target);
}

function assertExactExternalFileAccess(request: HttpRequest): void {
  if (request.authAccessMode === 'read-only') {
    throw new WorkspaceFileError('read-only shares cannot access external files', 403);
  }
}

function globalSyntheticTree(agentManager: AgentManager, userPath: unknown = '') {
  const { target, allowedRoots } = assertGlobalWorkspacePathAllowed(agentManager, userPath, {
    allowAllowedRootAncestor: true,
  });
  const children = new Map();
  for (const root of allowedRoots) {
    if (!isSameOrDescendantPath(target, root) || target === root) continue;
    const relative = path.relative(target, root);
    const first = relative.split(path.sep).filter(Boolean)[0];
    if (!first) continue;
    const childAbsolute = path.join(target, first);
    children.set(first, {
      name: first,
      path: relativeGlobalPath(childAbsolute),
      type: 'directory',
      size: 0,
      mtimeMs: 0,
    });
  }
  return {
    path: relativeGlobalPath(target),
    items: Array.from(children.values()).sort((a, b) => a.name.localeCompare(b.name)),
    gitStatusPending: false,
  };
}

async function listGlobalWorkspaceTree(
  agentManager: AgentManager,
  fileService: WorkspaceFileServiceLike,
  userPath: unknown = '',
): Promise<unknown> {
  const { target, allowedRoots } = assertGlobalWorkspacePathAllowed(agentManager, userPath, {
    allowAllowedRootAncestor: true,
  });
  const insideAllowedRoot = allowedRoots.some(root => isSameOrDescendantPath(root, realPathIfPresent(target)));
  if (!insideAllowedRoot) {
    return globalSyntheticTree(agentManager, userPath);
  }
  return fileService.listTree(GLOBAL_WORKSPACE_FILES_ROOT, userPath || '');
}

function sendWorkspaceFileError(res: HttpResponse, error: unknown) {
  if (error instanceof WorkspaceFileError) {
    res.status(error.statusCode).json({
      error: error.message,
      ...(Object.keys(error.details || {}).length > 0 ? { details: error.details } : {}),
    });
    return;
  }

  console.error('Workspace file API error:', error);
  res.status(500).json({ error: 'workspace file operation failed' });
}

function resolveWorkspaceRoot(agentManager: AgentManager, rootRef: unknown): string {
  return workspaceRootRegistryFor(agentManager).resolve(rootRef).canonicalPath;
}

function assertWritableWorkspaceAgent(agentId: unknown): void {
  if (isGlobalWorkspaceFilesAgentId(agentId)) {
    throw new WorkspaceFileError('global files are read-only', 403);
  }
}

function requiredBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string') {
    throw new WorkspaceFileError(`${field} must be a string`, 400);
  }
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength || /[\0\r\n]/.test(normalized)) {
    throw new WorkspaceFileError(`${field} is invalid`, 400);
  }
  return normalized;
}

function readOptionsForAgent(agentManager: AgentManager, agentId: unknown): ReadOptions {
  return isGlobalWorkspaceFilesAgentId(agentId)
    ? {}
    : { allowedExternalRoots: globalWorkspaceAllowedRoots(agentManager) };
}

function createWorkspaceFileRouter(
  agentManager: AgentManager,
  fileService: WorkspaceFileServiceLike,
  options: RouterOptions = {},
): ExpressRouter {
  const router = expressFactory.Router();
  const rootRegistry = options.rootRegistry || workspaceRootRegistryFor(agentManager);
  const previewSessions = options.previewSessionManager || new PreviewSessionManager();

  router.use(expressFactory.json({ limit: '3mb' }));

  router.get('/roots', (_req: HttpRequest, res: HttpResponse) => {
    res.json({ roots: rootRegistry.list() });
  });

  const resolveRequestRoot = (source: unknown): { kind: string; root: string; rootId: string } => {
    const workspaceRoot = rootRegistry.resolve(workspaceRef(source));
    return {
      kind: String(workspaceRoot.kind || ''),
      root: workspaceRoot.canonicalPath,
      rootId: workspaceRoot.rootId,
    };
  };

  router.get('/tree', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      const { root, rootId } = resolveRequestRoot(req.query);
      const tree = isGlobalWorkspaceFilesAgentId(rootRef)
        ? await listGlobalWorkspaceTree(agentManager, fileService, req.query.path || '')
        : await fileService.listTree(root, req.query.path || '', readOptionsForAgent(agentManager, rootRef));
      res.json({ rootId, root, tree });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/file', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      const exactExternal = isGlobalWorkspaceFilesAgentId(rootRef) && req.query.exact === '1';
      if (exactExternal) assertExactExternalFileAccess(req);
      const requestPath = exactExternal
        ? assertExactExternalFileReadable(req.query.path || '')
        : req.query.path || '';
      if (isGlobalWorkspaceFilesAgentId(rootRef) && req.query.exact !== '1') {
        assertGlobalWorkspacePathAllowed(agentManager, requestPath);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const file = await fileService.readFile(root, requestPath, readOptionsForAgent(agentManager, rootRef));
      res.set('Cache-Control', 'no-store').json({ rootId, root, file });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/raw', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      const exactExternal = isGlobalWorkspaceFilesAgentId(rootRef) && req.query.exact === '1';
      if (exactExternal) assertExactExternalFileAccess(req);
      const requestPath = exactExternal
        ? assertExactExternalFileReadable(req.query.path || '')
        : req.query.path || '';
      if (isGlobalWorkspaceFilesAgentId(rootRef) && req.query.exact !== '1') {
        assertGlobalWorkspacePathAllowed(agentManager, requestPath);
      }
      const { root } = resolveRequestRoot(req.query);
      const file = await fileService.readPreviewFile(root, requestPath, readOptionsForAgent(agentManager, rootRef));
      res
        .status(200)
        .type(file.preview.mediaType)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Length', String(file.size))
        .send(file.buffer);
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/previews', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      let entryPath = String(body.path || '').trim();
      if (!/\.html?$/i.test(entryPath)) {
        throw new WorkspaceFileError('HTML preview requires an .html or .htm file', 415);
      }

      let authorizedRoot;
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        if (body.exact === true) {
          entryPath = assertExactExternalFileReadable(entryPath);
          authorizedRoot = path.dirname(realPathIfPresent(globalUserPathToAbsolute(entryPath)));
          if (authorizedRoot === path.parse(authorizedRoot).root) {
            throw new WorkspaceFileError('external HTML preview directory cannot be the filesystem root', 403);
          }
        } else {
          const authorization = assertGlobalWorkspacePathAllowed(agentManager, entryPath);
          authorizedRoot = previewAuthorizedRootForTarget(authorization.allowedRoots, realPathIfPresent(authorization.target));
          if (!authorizedRoot) throw new WorkspaceFileError('global file path is outside allowed workspaces', 403);
        }
      }

      const { root, rootId } = resolveRequestRoot(body);
      await fileService.readFile(root, entryPath, { allowedExternalRoots: [] });
      const session = previewSessions.createStatic({
        rootId,
        workspaceRoot: root,
        authorizedRoot: realPathIfPresent(authorizedRoot || root),
        entryPath,
        baseDirectory: path.posix.dirname(entryPath) === '.' ? '' : path.posix.dirname(entryPath),
      });
      res.status(201).json({
        preview: {
          id: session.id,
          kind: session.kind,
          expiresAt: session.expiresAt,
        },
      });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/previews/:sessionId/:scope/*', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const session = previewSessions.get(req.params.sessionId);
      if (!session) throw new WorkspaceFileError('preview session not found or expired', 404);
      const scope = req.params.scope;
      if (scope !== 'base' && scope !== 'root') {
        throw new WorkspaceFileError('preview scope is invalid', 400);
      }
      const assetPath = normalizePreviewAssetPath(req.params[0] || '');
      const resourcePath = scope === 'base'
        ? path.posix.join(session.baseDirectory, assetPath)
        : assetPath;
      if (!resourcePath) throw new WorkspaceFileError('preview resource path is required', 400);

      const absoluteTarget = realPathIfPresent(path.resolve(session.workspaceRoot, resourcePath));
      if (!isSameOrDescendantPath(session.authorizedRoot, absoluteTarget)) {
        throw new WorkspaceFileError('preview path must stay inside the authorized root', 403);
      }

      const file = await fileService.readResourceFile(session.workspaceRoot, resourcePath, {
        allowedExternalRoots: [],
      });
      const isHtml = /\.html?$/i.test(file.path);
      const body = isHtml
        ? Buffer.from(rewritePreviewHtmlRootReferences(
          file.buffer.toString('utf8'),
          `${req.baseUrl}/previews/${encodeURIComponent(session.id)}/root/`,
        ))
        : file.buffer;
      res
        .status(200)
        .type(path.extname(file.path) || 'application/octet-stream')
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Length', String(body.length));
      if (isHtml) res.set('Content-Security-Policy', previewContentSecurityPolicy());
      res.send(body);
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.delete('/previews/:sessionId', (req: HttpRequest, res: HttpResponse) => {
    const deleted = previewSessions.delete(req.params.sessionId);
    res.status(deleted ? 204 : 404).end();
  });

  router.put('/file', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { kind, root, rootId } = resolveRequestRoot(body);
      if (kind === 'agent-home') await fs.promises.mkdir(root, { recursive: true });
      const file = await fileService.writeFile(root, body.path || '', body.content, {
        baseSha1: body.baseSha1,
        overwrite: body.overwrite === true,
      });
      res.json({ rootId, root, file });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/move', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const move = await fileService.moveEntry(root, body.sourcePath || '', body.targetDirectory || '', {
        expectedVersion: body.expectedVersion,
      });
      res.json({ rootId, root, move });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/entry', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const created = await fileService.createEntry(root, body.parentPath || '', body.name || '', body.entryType || 'file', body.content || '');
      res.status(201).json({ rootId, root, ...created });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.patch('/entry', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { root, rootId } = resolveRequestRoot(body);
      const move = await fileService.renameEntry(root, body.path || '', body.name || '', {
        expectedVersion: body.expectedVersion,
      });
      res.json({ rootId, root, move });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.delete('/entry', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = req.body || {};
      const rootRef = workspaceRef(body) || workspaceRef(req.query);
      const targetPath = body.path || req.query.path || '';
      assertWritableWorkspaceAgent(rootRef);
      const workspaceRoot = rootRegistry.resolve(rootRef);
      const { canonicalPath: root, rootId } = workspaceRoot;
      const deleted = await fileService.deleteEntry(root, targetPath, {
        expectedVersion: body.expectedVersion || req.query.expectedVersion,
      });
      res.json({ rootId, root, deleted });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/search', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const settings = agentManager?.configManager?.getSettings?.() || {};
      const results = await fileService.search(root, req.query.q || '', {
        includeIgnored: req.query.includeIgnored === 'true',
        path: req.query.path || '',
        limit: req.query.limit,
        timeoutMs: settings.searchTimeoutMs,
      });
      res.json({ rootId, root, results });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/diff', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '', { allowMissing: true });
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const diff = await fileService.diff(root, req.query.path || '');
      res.json({ rootId, root, diff });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/changes', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support workspace changes', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.changes(root, {
        limit: req.query.limit,
      });
      res.json({ rootId, root, changes });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/branch', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const branch = await fileService.gitBranch(root);
      res.json({ rootId, root, branch });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/branches', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      const { root } = resolveRequestRoot(req.query);
      res.json(await agentManager.inspectProjectBranches(root));
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.post('/switch-branch', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const body = isRecord(req.body) ? req.body : {};
      const rootRef = workspaceRef(body);
      assertWritableWorkspaceAgent(rootRef);
      const { kind, root } = resolveRequestRoot(body);
      if (kind !== 'directory') {
        throw new WorkspaceFileError('branch switching requires a Project root', 403);
      }
      const branch = requiredBoundedString(body.branch, 'branch', 1024);
      const expectedBranch = requiredBoundedString(body.expectedBranch, 'expectedBranch', 1024, true);
      const expectedHead = requiredBoundedString(body.expectedHead, 'expectedHead', 64, true);
      const requestId = requiredBoundedString(body.requestId, 'requestId', 160);
      if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) {
        throw new WorkspaceFileError('requestId is invalid', 400);
      }
      if (expectedHead && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHead)) {
        throw new WorkspaceFileError('expectedHead is invalid', 400);
      }
      let result: LocalBranchSwitchResult;
      try {
        result = await agentManager.switchProjectBranch(root, {
          branch,
          expectedBranch,
          expectedHead,
          requestId,
        });
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        if (/^Project operation request .* was already used for different parameters$/.test(error.message)) {
          throw new WorkspaceFileError(error.message, 409);
        }
        throw caught;
      }
      if (result.switched) fileService.invalidateGitStatus?.(root);
      const response = {
        ...(result.inventory || {}),
        switched: result.switched,
        uncertain: result.uncertain,
        ...(result.error ? { error: result.error } : {}),
        ...(result.previousBranch !== undefined ? { previousBranch: result.previousBranch } : {}),
        ...(result.previousHead !== undefined ? { previousHead: result.previousHead } : {}),
        requestId,
      };
      res.status(result.switched ? 200 : result.uncertain ? 504 : 409).json(response);
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/worktrees', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git worktrees', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const info = await inspectGitWorktree(root, { cacheMs: 0 });
      res.json({
        rootId,
        root,
        worktrees: info
          ? {
            isGitRepo: true,
            commonDir: info.commonDir,
            currentWorkspace: info.workspace,
            mainWorkspace: info.mainWorkspace,
            items: info.worktrees,
          }
          : {
            isGitRepo: false,
            commonDir: '',
            currentWorkspace: root,
            mainWorkspace: '',
            items: [],
          },
      });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/history', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const history = await fileService.gitHistory(root, {
        limit: req.query.limit,
        skip: req.query.skip,
        scope: req.query.scope,
      });
      res.json({ rootId, root, history });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/history/changes', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.gitHistoryChanges(
        root,
        req.query.commit,
        req.query.parent,
        { limit: req.query.limit }
      );
      res.json({ rootId, root, changes });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/line-changes', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const changes = await fileService.lineChanges(
        root,
        req.query.path || '',
        req.query.lineNumber,
        req.query.mode || 'working'
      );
      res.json({ rootId, root, changes });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const blame = await fileService.blame(root, req.query.path || '');
      res.json({ rootId, root, blame });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/blame-capability', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const rootRef = workspaceRef(req.query);
      if (isGlobalWorkspaceFilesAgentId(rootRef)) {
        assertGlobalWorkspacePathAllowed(agentManager, req.query.path || '');
      }
      const { root, rootId } = resolveRequestRoot(req.query);
      const capability = await fileService.blameCapability(
        root,
        req.query.path || '',
        readOptionsForAgent(agentManager, rootRef)
      );
      res.json({ rootId, root, capability });
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  return router;
}

export {
  GLOBAL_WORKSPACE_FILES_AGENT_ID,
  GLOBAL_WORKSPACE_FILES_ROOT,
  PROJECT_FILES_WORKSPACE_PREFIX,
  assertGlobalWorkspacePathAllowed,
  assertExactExternalFileReadable,
  createWorkspaceFileRouter,
  globalWorkspaceAllowedRoots,
  isGlobalWorkspaceFilesAgentId,
  projectWorkspaceFromFilesId,
  resolveWorkspaceRoot,
  sendWorkspaceFileError,
};
