import { normalizeBasePath, routePath } from './index-html.cjs';
import { SHARE_TICKET_TTL_MS } from './qr-share-tickets.cjs';

const express = require('express');

type ShareAccessMode = 'owner' | 'read-only';

interface QrShareRequest {
  authAccessMode?: 'none' | ShareAccessMode;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string>;
  protocol?: string;
  url?: string;
}

interface QrShareResponse {
  json(value: unknown): QrShareResponse;
  set(name: string, value: string): QrShareResponse;
  status(code: number): QrShareResponse;
}

type ExpressHandler = (
  request: QrShareRequest,
  response: QrShareResponse,
) => void;

type ExpressMiddleware = (
  request: QrShareRequest,
  response: QrShareResponse,
  next: () => void,
) => void;

interface ExpressRouter {
  delete(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
  use(handler: ExpressMiddleware): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

interface QrShareAuthPort {
  createReadOnlyToken(options: { expiresAt: number }): string;
  extractToken(request: QrShareRequest): string | null;
  getToken(): string;
  readOnlyTokenExpiresAt(token: unknown): number | null;
}

interface QrShareTicket {
  code: string;
  expiresAt: number;
  targetQuery: string;
}

interface QrShareTicketPort {
  create(token: unknown, options: {
    expiresAt: number;
    now: number;
    targetQuery: string;
  }): QrShareTicket;
  revoke(code: unknown): boolean;
}

interface QrShareRouterOptions {
  authEnabled: boolean;
  basePath: string;
  fallbackPort: string | number;
  now?: () => number;
  publicOrigin?: string;
}

interface EntryPathOptions {
  authEnabled?: boolean;
  basePath?: string;
  token?: string;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function shareTargetPositiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? String(number) : '';
}

function shareTargetString(value: unknown, maxLength: number) {
  const string = String(value || '').trim();
  if (!string || string.length > maxLength || string.includes('\0')) return '';
  return string;
}

function shareTargetQueryFromBody(body: unknown) {
  const bodyRecord = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const target = bodyRecord?.target;
  if (!target || typeof target !== 'object') return '';
  const targetRecord = target as Record<string, unknown>;

  const kind = targetRecord.kind === 'file'
    ? 'file'
    : targetRecord.kind === 'folder'
      ? 'folder'
      : targetRecord.kind === 'agent'
        ? 'agent'
        : '';
  const agentId = shareTargetString(targetRecord.agentId, 160);
  const absolutePath = shareTargetString(targetRecord.absolutePath, 2048);
  const projectLabel = shareTargetString(targetRecord.projectLabel, 160);
  const readingAnchor = shareTargetString(targetRecord.readingAnchor, 1800);
  if (!kind || kind === 'agent' && !agentId || kind !== 'agent' && !absolutePath && !agentId && !projectLabel) return '';

  const params = new URLSearchParams();
  params.set('ftarget', kind);
  if (agentId) params.set('agent', agentId);
  if (kind === 'agent' && readingAnchor && /^[A-Za-z0-9_-]+$/.test(readingAnchor)) params.set('fra', readingAnchor);
  if (absolutePath) params.set('path', absolutePath);
  if (projectLabel) params.set('project', projectLabel);

  if (kind === 'folder') {
    const folderPath = shareTargetString(targetRecord.folderPath, 2048);
    if (!absolutePath && !folderPath) return '';
    if (folderPath) params.set('folder', folderPath);
  } else if (kind === 'file') {
    const filePath = shareTargetString(targetRecord.filePath, 2048);
    if (!absolutePath && !filePath) return '';
    if (filePath) params.set('file', filePath);
    if (targetRecord.view === 'diff') params.set('view', 'diff');
    const line = shareTargetPositiveInteger(targetRecord.lineNumber);
    const column = shareTargetPositiveInteger(targetRecord.column);
    const endColumn = shareTargetPositiveInteger(targetRecord.endColumn);
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

function entryPathWithQuery(query = '', options: EntryPathOptions = {}) {
  const entryPath = normalizeBasePath(options.basePath) || '/';
  const params = new URLSearchParams(query || '');
  if (options.token && options.authEnabled) {
    params.set('token', options.token);
  }
  const queryString = params.toString();
  return queryString ? `${entryPath}?${queryString}` : entryPath;
}

function normalizedPublicOrigin(value: unknown) {
  const candidate = String(value || '').trim();
  if (!candidate) return '';
  const parsed = new URL(candidate);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('FARMING_PUBLIC_ORIGIN must be an HTTP(S) origin without a path, query, fragment, or credentials.');
  }
  return parsed.origin;
}

function requestOrigin(request: QrShareRequest, fallbackPort: string | number) {
  const protocol = ['http', 'https'].includes(String(request.protocol || '').toLowerCase())
    ? String(request.protocol).toLowerCase()
    : 'http';
  const fallbackHost = `127.0.0.1:${fallbackPort}`;
  const candidateHost = String(request.headers.host || '').trim() || fallbackHost;
  try {
    const parsed = new URL(`${protocol}://${candidateHost}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return `${protocol}://${fallbackHost}`;
    return parsed.origin;
  } catch {
    return `${protocol}://${fallbackHost}`;
  }
}

function absoluteClientUrl(request: QrShareRequest, urlPath: string, options: QrShareRouterOptions) {
  const origin = normalizedPublicOrigin(options.publicOrigin) || requestOrigin(request, options.fallbackPort);
  return `${origin}${urlPath}`;
}

function setNoStoreHeader(_request: QrShareRequest, response: QrShareResponse, next: () => void) {
  response.set('Cache-Control', 'no-store');
  next();
}

function createQrShareRouter(
  auth: QrShareAuthPort,
  tickets: QrShareTicketPort,
  options: QrShareRouterOptions,
): ExpressRouter {
  const router = expressFactory.Router();
  const now = options.now || Date.now;
  normalizedPublicOrigin(options.publicOrigin);
  router.use(setNoStoreHeader);
  const entryPathWithToken = (targetQuery = '', token = '') => entryPathWithQuery(targetQuery, {
    authEnabled: options.authEnabled,
    basePath: options.basePath,
    token,
  });

  router.post('/', expressFactory.json({ limit: '8kb' }), (req, res) => {
    try {
      if (!options.authEnabled) {
        res.status(409).json({ error: 'Read-only sharing requires token authentication.' });
        return;
      }
      const requestNow = now();
      const requesterAccessMode: ShareAccessMode = req.authAccessMode === 'read-only' ? 'read-only' : 'owner';
      const requesterToken = auth.extractToken(req);
      const requesterExpiresAt = requesterAccessMode === 'read-only'
        ? auth.readOnlyTokenExpiresAt(requesterToken)
        : null;
      if (requesterAccessMode === 'read-only' && !requesterExpiresAt) {
        res.status(401).json({ error: 'Read-only share credential expired.' });
        return;
      }
      const shareExpiresAt = Math.min(
        requestNow + SHARE_TICKET_TTL_MS,
        requesterExpiresAt || Number.POSITIVE_INFINITY,
      );
      if (shareExpiresAt <= requestNow + 1000) {
        res.status(410).json({ error: 'Read-only share credential is too close to expiry.' });
        return;
      }
      const targetQuery = shareTargetQueryFromBody(req.body);
      const readOnlyToken = auth.createReadOnlyToken({ expiresAt: shareExpiresAt });
      const qrToken = requesterAccessMode === 'owner' ? auth.getToken() : readOnlyToken;
      const ticket = tickets.create(qrToken, {
        expiresAt: shareExpiresAt,
        now: requestNow,
        targetQuery,
      });
      const shortPath = routePath(options.basePath, `/j/${ticket.code}`);
      const longPath = entryPathWithToken(ticket.targetQuery, readOnlyToken);
      const fullAccessPath = requesterAccessMode === 'owner'
        ? entryPathWithToken(ticket.targetQuery, qrToken)
        : '';
      res.json({
        code: ticket.code,
        expiresAt: ticket.expiresAt,
        ttlMs: SHARE_TICKET_TTL_MS,
        shortPath,
        shortUrl: absoluteClientUrl(req, shortPath, options),
        longUrl: absoluteClientUrl(req, longPath, options),
        shortUrlAccessMode: requesterAccessMode,
        longUrlAccessMode: 'read-only',
        tokenLabel: requesterAccessMode === 'owner' ? auth.getToken() : '',
        ...(fullAccessPath
          ? { fullAccessUrl: absoluteClientUrl(req, fullAccessPath, options) }
          : {}),
      });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(500).json({ error: error.message || 'Failed to create share ticket' });
    }
  });

  router.delete('/:code', (req, res) => {
    res.json({ revoked: tickets.revoke(req.params.code) });
  });

  return router;
}

export {
  createQrShareRouter,
  entryPathWithQuery,
  shareTargetQueryFromBody,
  type QrShareAuthPort,
  type QrShareRouterOptions,
  type QrShareTicketPort,
};
