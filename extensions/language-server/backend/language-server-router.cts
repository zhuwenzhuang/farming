import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSameOrDescendantPath } from '../../../backend/path-containment.cjs';
interface WorkspaceRoot {
  canonicalPath: string;
  kind: string;
  rootId: string;
}

interface WorkspaceRootRegistry {
  resolve(rootId: unknown): WorkspaceRoot;
}

interface LanguageServerClient {
  capability(options?: { force?: boolean }): Promise<unknown>;
  request(body: unknown): Promise<unknown>;
}

const REJECTED_LANGUAGE_SERVER_LOCATION = Symbol('rejected-language-server-location');
const SUPPORTED_METHODS = new Set([
  'hover',
  'definition',
  'references',
  'implementation',
  'documentHighlights',
  'semanticTokens',
  'inlayHints',
  'documentSymbols',
  'workspaceSymbols',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
  'prepareTypeHierarchy',
  'supertypes',
  'subtypes',
  'diagnostics',
]);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function resolveFile(root: WorkspaceRoot, filePath: unknown): string {
  if (root.kind === 'global') {
    const error = new Error('Language Server requires a Project workspace') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const relativePath = String(filePath || '').trim().replace(/\\/g, '/');
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    const error = new Error('A relative Project file path is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  const absolutePath = path.resolve(root.canonicalPath, relativePath);
  const relative = path.relative(root.canonicalPath, absolutePath);
  if (!relative || !isSameOrDescendantPath(root.canonicalPath, absolutePath)) {
    const error = new Error('Language Server file is outside the Project') as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  let realPath = '';
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    const error = new Error('Language Server file was not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  const realRelative = path.relative(root.canonicalPath, realPath);
  if (!realRelative || !isSameOrDescendantPath(root.canonicalPath, realPath)) {
    const error = new Error('Language Server file resolves outside the Project') as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  return realPath;
}

function locationWithinRoot(rootPath: string, uri: unknown): { path: string } | null {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null;
  let absolutePath = '';
  try {
    absolutePath = decodeURIComponent(new URL(uri).pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(absolutePath)) absolutePath = absolutePath.slice(1);
  } catch {
    return null;
  }
  let realPath = '';
  try {
    realPath = fs.realpathSync(absolutePath);
  } catch {
    return null;
  }
  const relative = path.relative(rootPath, realPath);
  if (!relative || !isSameOrDescendantPath(rootPath, realPath)) return null;
  return { path: relative.split(path.sep).join('/') };
}

function sanitizeLanguageServerValue(rootPath: string, value: unknown): unknown | typeof REJECTED_LANGUAGE_SERVER_LOCATION {
  if (Array.isArray(value)) {
    return value
      .map(item => sanitizeLanguageServerValue(rootPath, item))
      .filter(item => item !== REJECTED_LANGUAGE_SERVER_LOCATION);
  }
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if ('uri' in source) {
    const location = locationWithinRoot(rootPath, source.uri);
    if (!location) return REJECTED_LANGUAGE_SERVER_LOCATION;
    result.path = location.path;
  }
  for (const [key, item] of Object.entries(source)) {
    if (key === 'uri') continue;
    const sanitized = sanitizeLanguageServerValue(rootPath, item);
    if (sanitized === REJECTED_LANGUAGE_SERVER_LOCATION && key === 'item') {
      return REJECTED_LANGUAGE_SERVER_LOCATION;
    }
    if (sanitized !== REJECTED_LANGUAGE_SERVER_LOCATION) result[key] = sanitized;
  }
  return result;
}

function sanitizeLanguageServerResult(rootPath: string, value: unknown): unknown {
  const sanitized = sanitizeLanguageServerValue(rootPath, value);
  return sanitized === REJECTED_LANGUAGE_SERVER_LOCATION ? null : sanitized;
}

async function executeLanguageServerCapability(
  client: LanguageServerClient,
  force = false,
): Promise<unknown> {
  return client.capability({ force });
}

async function executeLanguageServerRequest(
  client: LanguageServerClient,
  roots: WorkspaceRootRegistry,
  bodyValue: unknown,
): Promise<{ result: unknown; supported: boolean }> {
  const body = recordValue(bodyValue);
  const method = String(body.method || '');
  if (!SUPPORTED_METHODS.has(method)) {
    const error = new Error('Unsupported Language Server method') as Error & { code?: string; status?: number };
    error.status = 400;
    error.code = 'LANGUAGE_SERVER_METHOD_UNSUPPORTED';
    throw error;
  }
  const root = roots.resolve(body.rootId);
  const payload: Record<string, unknown> = {
    method,
    workspace: pathToFileURL(root.canonicalPath).toString(),
  };
  if (body.filePath !== undefined) payload.uri = pathToFileURL(resolveFile(root, body.filePath)).toString();
  for (const key of ['position', 'range', 'query', 'itemId']) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  const response = recordValue(await client.request(payload));
  return {
    result: sanitizeLanguageServerResult(root.canonicalPath, response.result),
    supported: response.supported !== false,
  };
}

export {
  executeLanguageServerCapability,
  executeLanguageServerRequest,
  sanitizeLanguageServerResult,
};
