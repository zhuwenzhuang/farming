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
import { GLOBAL_WORKSPACE_FILES_AGENT_ID, GLOBAL_WORKSPACE_FILES_ROOT, GLOBAL_WORKSPACE_ROOT_ID, WorkspaceRootRegistry } from './workspace-root-registry.cjs';
import type { WorkspaceRequest } from '../shared/browser-protocol.js';

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
  resolve(rootRef: unknown): WorkspaceRoot;
}

interface PreviewFileResult {
  buffer: Buffer;
  path: string;
  preview: { mediaType: string };
  sha1: string;
  size: number;
}

interface ResourceFileResult {
  buffer: Buffer;
  path: string;
  size: number;
}

interface TransportFileResult extends ResourceFileResult {
  mediaType: string;
  sha1: string;
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
  listTreeDecorations(root: string, userPath: unknown, entryPaths: unknown[]): Promise<unknown>;
  moveEntry(root: string, sourcePath: unknown, targetDirectory: unknown, options?: MutationVersionOptions): Promise<unknown>;
  readFile(root: string, userPath: unknown, options?: ReadOptions): Promise<unknown>;
  readPreviewFile(root: string, userPath: unknown, options?: ReadOptions): Promise<PreviewFileResult>;
  readResourceFile(root: string, userPath: unknown, options?: ReadOptions): Promise<ResourceFileResult>;
  readTransportFile(root: string, userPath: unknown, options?: ReadOptions): Promise<TransportFileResult>;
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
  createStatic(options: {
    accessMode?: 'owner' | 'read-only';
    authorizedRoot: string;
    baseDirectory: string;
    entryPath: string;
    rootId: string;
    scopeId?: string;
    workspaceRoot: string;
  }): PreviewSession;
  delete(
    sessionId: string,
    authority?: { accessMode?: 'owner' | 'read-only'; scopeId?: string },
  ): boolean;
  get(sessionId: string, authority?: { accessMode?: 'owner' | 'read-only' }): PreviewSession | null;
}

interface HttpRequest {
  authAccessMode?: 'owner' | 'read-only';
  baseUrl: string;
  body: InputRecord;
  params: Record<string, string> & { 0?: string };
  query: InputRecord;
}

interface HttpResponse {
  json(value: unknown): HttpResponse;
  send(value: unknown): HttpResponse;
  set(field: string, value: string): HttpResponse;
  status(code: number): HttpResponse;
  type(value: string): HttpResponse;
}

type HttpHandler = (request: HttpRequest, response: HttpResponse) => void | Promise<void>;

interface ExpressRouter {
  get(path: string, handler: HttpHandler): ExpressRouter;
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

interface WorkspaceRequestOptions extends RouterOptions {
  accessMode?: 'owner' | 'read-only';
  maxInlineResponseBytes?: number;
  previewScopeId?: string;
  signal?: AbortSignal;
}

const expressFactory = express as ExpressFactory;
const ROOT_REGISTRIES = new WeakMap<AgentManager, WorkspaceRootRegistryLike>();

function isRecord(value: unknown): value is InputRecord {
  return typeof value === 'object' && value !== null;
}

function isGlobalWorkspaceFilesAgentId(agentId: unknown): boolean {
  return agentId === GLOBAL_WORKSPACE_FILES_AGENT_ID || agentId === GLOBAL_WORKSPACE_ROOT_ID;
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

const WORKSPACE_MUTATION_OPERATIONS = new Set<WorkspaceRequest['operation']>([
  'save-file',
  'move-entry',
  'create-entry',
  'rename-entry',
  'delete-entry',
  'switch-branch',
]);

function workspaceOperationIsMutation(operation: WorkspaceRequest['operation']): boolean {
  return WORKSPACE_MUTATION_OPERATIONS.has(operation);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

async function executeWorkspaceFileRequest(
  agentManager: AgentManager,
  fileService: WorkspaceFileServiceLike,
  request: WorkspaceRequest,
  options: WorkspaceRequestOptions = {},
): Promise<unknown> {
  const rootRegistry = options.rootRegistry || workspaceRootRegistryFor(agentManager);
  const previewSessions = options.previewSessionManager || new PreviewSessionManager();
  if (options.accessMode === 'read-only' && workspaceOperationIsMutation(request.operation)) {
    throw new WorkspaceFileError('This Farming share is read-only.', 403);
  }

  const resolveRequestRoot = (source: unknown): { kind: string; root: string; rootId: string } => {
    const workspaceRoot = rootRegistry.resolve(workspaceRef(source));
    return {
      kind: String(workspaceRoot.kind || ''),
      root: workspaceRoot.canonicalPath,
      rootId: workspaceRoot.rootId,
    };
  };

  switch (request.operation) {
    case 'tree': {
      const tree = isGlobalWorkspaceFilesAgentId(request.rootId)
        ? await listGlobalWorkspaceTree(agentManager, fileService, request.path || '')
        : await fileService.listTree(
          resolveRequestRoot(request).root,
          request.path || '',
          readOptionsForAgent(agentManager, request.rootId),
        );
      return tree;
    }
    case 'tree-decorations': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        return { path: request.path || '', items: [] };
      }
      return fileService.listTreeDecorations(
        resolveRequestRoot(request).root,
        request.path || '',
        request.entryPaths,
      );
    }
    case 'read-file': {
      let requestPath = request.path;
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        if (request.exactExternal) {
          assertExactExternalFileAccess({ authAccessMode: options.accessMode } as HttpRequest);
          requestPath = assertExactExternalFileReadable(request.path);
        } else {
          assertGlobalWorkspacePathAllowed(agentManager, requestPath);
        }
      }
      const file = await fileService.readFile(
        resolveRequestRoot(request).root,
        requestPath,
        readOptionsForAgent(agentManager, request.rootId),
      ) as InputRecord;
      const maxInlineBytes = options.maxInlineResponseBytes || Number.MAX_SAFE_INTEGER;
      if (serializedBytes(file) <= maxInlineBytes) return file;
      return {
        ...file,
        content: '',
        transfer: { kind: 'http' },
      };
    }
    case 'create-preview': {
      let entryPath = request.path.trim();
      if (!/\.html?$/i.test(entryPath)) {
        throw new WorkspaceFileError('HTML preview requires an .html or .htm file', 415);
      }
      let authorizedRoot;
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        if (request.exactExternal) {
          assertExactExternalFileAccess({ authAccessMode: options.accessMode } as HttpRequest);
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
      const { root, rootId } = resolveRequestRoot(request);
      await fileService.readFile(root, entryPath, { allowedExternalRoots: [] });
      const session = previewSessions.createStatic({
        accessMode: options.accessMode === 'read-only' ? 'read-only' : 'owner',
        rootId,
        scopeId: options.previewScopeId,
        workspaceRoot: root,
        authorizedRoot: realPathIfPresent(authorizedRoot || root),
        entryPath,
        baseDirectory: path.posix.dirname(entryPath) === '.' ? '' : path.posix.dirname(entryPath),
      });
      return { id: session.id, kind: session.kind, expiresAt: session.expiresAt };
    }
    case 'delete-preview':
      return {
        deleted: previewSessions.delete(request.previewId, {
          accessMode: options.accessMode === 'read-only' ? 'read-only' : 'owner',
          scopeId: options.previewScopeId,
        }),
      };
    case 'save-file': {
      assertWritableWorkspaceAgent(request.rootId);
      const { kind, root } = resolveRequestRoot(request);
      if (kind === 'agent-home') await fs.promises.mkdir(root, { recursive: true });
      return fileService.writeFile(root, request.path, request.content, {
        baseSha1: request.baseSha1,
        overwrite: request.overwrite === true,
      });
    }
    case 'move-entry': {
      assertWritableWorkspaceAgent(request.rootId);
      return fileService.moveEntry(
        resolveRequestRoot(request).root,
        request.sourcePath,
        request.targetDirectory,
        { expectedVersion: request.expectedVersion },
      );
    }
    case 'create-entry': {
      assertWritableWorkspaceAgent(request.rootId);
      return fileService.createEntry(
        resolveRequestRoot(request).root,
        request.parentPath,
        request.name,
        request.entryType,
        '',
      );
    }
    case 'rename-entry': {
      assertWritableWorkspaceAgent(request.rootId);
      return fileService.renameEntry(
        resolveRequestRoot(request).root,
        request.path,
        request.name,
        { expectedVersion: request.expectedVersion },
      );
    }
    case 'delete-entry': {
      assertWritableWorkspaceAgent(request.rootId);
      return fileService.deleteEntry(
        resolveRequestRoot(request).root,
        request.path,
        { expectedVersion: request.expectedVersion },
      );
    }
    case 'search': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        assertGlobalWorkspacePathAllowed(agentManager, request.path || '');
      }
      const settings = agentManager.configManager?.getSettings?.() || {};
      return fileService.search(resolveRequestRoot(request).root, request.query, {
        includeIgnored: request.includeIgnored === true,
        path: request.path || '',
        limit: request.limit,
        timeoutMs: settings.searchTimeoutMs,
        signal: options.signal,
      });
    }
    case 'diff': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        assertGlobalWorkspacePathAllowed(agentManager, request.path, { allowMissing: true });
      }
      return fileService.diff(resolveRequestRoot(request).root, request.path);
    }
    case 'changes': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support workspace changes', 403);
      }
      return fileService.changes(resolveRequestRoot(request).root, { limit: request.limit });
    }
    case 'branch': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      return fileService.gitBranch(resolveRequestRoot(request).root);
    }
    case 'branches': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support git branches', 403);
      }
      return agentManager.inspectProjectBranches(resolveRequestRoot(request).root);
    }
    case 'switch-branch': {
      assertWritableWorkspaceAgent(request.rootId);
      const { kind, root } = resolveRequestRoot(request);
      if (kind !== 'directory') throw new WorkspaceFileError('branch switching requires a Project root', 403);
      const branch = requiredBoundedString(request.branch, 'branch', 1024);
      const expectedBranch = requiredBoundedString(request.expectedBranch, 'expectedBranch', 1024, true);
      const expectedHead = requiredBoundedString(request.expectedHead, 'expectedHead', 64, true);
      const operationId = requiredBoundedString(request.operationId, 'operationId', 160);
      if (!/^[A-Za-z0-9._:-]+$/.test(operationId)) throw new WorkspaceFileError('operationId is invalid', 400);
      if (expectedHead && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHead)) {
        throw new WorkspaceFileError('expectedHead is invalid', 400);
      }
      const result = await agentManager.switchProjectBranch(root, {
        branch,
        expectedBranch,
        expectedHead,
        requestId: operationId,
      });
      if (result.switched) fileService.invalidateGitStatus?.(root);
      return { ...result, requestId: operationId };
    }
    case 'worktrees': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support git worktrees', 403);
      }
      const root = resolveRequestRoot(request).root;
      const info = await inspectGitWorktree(root, { cacheMs: 0 });
      return info
        ? { isGitRepo: true, commonDir: info.commonDir, currentWorkspace: info.workspace, mainWorkspace: info.mainWorkspace, items: info.worktrees }
        : { isGitRepo: false, commonDir: '', currentWorkspace: root, mainWorkspace: '', items: [] };
    }
    case 'history': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      return fileService.gitHistory(resolveRequestRoot(request).root, {
        limit: request.limit,
        skip: request.skip,
        scope: request.scope,
      });
    }
    case 'history-changes': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        throw new WorkspaceFileError('global files do not support git history', 403);
      }
      return fileService.gitHistoryChanges(
        resolveRequestRoot(request).root,
        request.commit,
        request.parent,
        { limit: request.limit },
      );
    }
    case 'line-changes': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) {
        assertGlobalWorkspacePathAllowed(agentManager, request.path);
      }
      return fileService.lineChanges(
        resolveRequestRoot(request).root,
        request.path,
        request.lineNumber,
        request.mode,
      );
    }
    case 'blame': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) assertGlobalWorkspacePathAllowed(agentManager, request.path);
      return fileService.blame(resolveRequestRoot(request).root, request.path);
    }
    case 'blame-capability': {
      if (isGlobalWorkspaceFilesAgentId(request.rootId)) assertGlobalWorkspacePathAllowed(agentManager, request.path);
      return fileService.blameCapability(
        resolveRequestRoot(request).root,
        request.path,
        readOptionsForAgent(agentManager, request.rootId),
      );
    }
  }
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

  const resolveRequestRoot = (source: unknown): { kind: string; root: string; rootId: string } => {
    const workspaceRoot = rootRegistry.resolve(workspaceRef(source));
    return {
      kind: String(workspaceRoot.kind || ''),
      root: workspaceRoot.canonicalPath,
      rootId: workspaceRoot.rootId,
    };
  };

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
      const transfer = req.query.transfer === '1';
      const file = transfer
        ? await fileService.readTransportFile(root, requestPath, readOptionsForAgent(agentManager, rootRef))
        : await fileService.readPreviewFile(root, requestPath, readOptionsForAgent(agentManager, rootRef));
      const expectedSha1 = String(req.query.sha1 || '');
      if (transfer && expectedSha1 && file.sha1 !== expectedSha1) {
        throw new WorkspaceFileError('file changed before transfer started', 409, {
          expectedSha1,
          currentSha1: file.sha1,
        });
      }
      res
        .status(200)
        .type(transfer
          ? (file as TransportFileResult).mediaType
          : (file as PreviewFileResult).preview.mediaType)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Length', String(file.size))
        .send(file.buffer);
    } catch (error: unknown) {
      sendWorkspaceFileError(res, error);
    }
  });

  router.get('/previews/:sessionId/:scope/*', async (req: HttpRequest, res: HttpResponse) => {
    try {
      const session = previewSessions.get(req.params.sessionId, {
        accessMode: req.authAccessMode === 'read-only' ? 'read-only' : 'owner',
      });
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

  return router;
}

export {
  createWorkspaceFileRouter,
  resolveWorkspaceRoot,
  executeWorkspaceFileRequest,
};
