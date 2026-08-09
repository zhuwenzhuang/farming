import type { Dirent } from 'fs';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

interface WorkspacePickerRouterPort {
  rememberWorkspace(workspace: unknown): string[];
}

interface ExpressRequest {
  body?: Record<string, unknown>;
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  get(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

const expressFactory = express as ExpressFactory;

function caughtError(error: unknown): Error {
  if (error instanceof Error) return error;
  const normalized = new Error(String(error));
  if (error && typeof error === 'object') Object.assign(normalized, error);
  return normalized;
}

function normalizeWorkspaceCompletionInput(value: string) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return { raw: '', parent: os.homedir(), prefix: '', displayParent: '~', explicitDirectory: false };
  }

  const home = os.homedir();
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  const explicitDirectory = raw.endsWith(path.sep) || raw === '~';
  const parent = explicitDirectory ? expanded : path.dirname(expanded);
  const prefix = explicitDirectory ? '' : path.basename(expanded);
  const trimTrailingSeparator = (input: string) => {
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

async function listWorkspacePathCompletions(partialPath: string, limit = 12) {
  const query = normalizeWorkspaceCompletionInput(partialPath);
  const entries = await fs.promises.readdir(query.parent, { withFileTypes: true });
  const normalizedPrefix = query.prefix.toLowerCase();
  const maxResults = Math.max(1, Math.min(Number(limit) || 12, 100));

  return entries
    .filter((entry: Dirent) => entry.isDirectory())
    .filter((entry: Dirent) => normalizedPrefix.startsWith('.') || !entry.name.startsWith('.'))
    .filter((entry: Dirent) => !normalizedPrefix || entry.name.toLowerCase().startsWith(normalizedPrefix))
    .sort((a: Dirent, b: Dirent) => a.name.localeCompare(b.name))
    .slice(0, maxResults)
    .map((entry: Dirent) => {
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

function createWorkspacePickerRouter(service: WorkspacePickerRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.get('/complete', async (req, res) => {
    try {
      const partialPath = typeof req.query.path === 'string' ? req.query.path : '';
      const requestedLimit = Number(req.query.limit);
      const suggestions = await listWorkspacePathCompletions(partialPath, requestedLimit);
      res.json({ suggestions });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(200).json({
        suggestions: [],
        error: error.message || 'Failed to read directory',
      });
    }
  });

  router.post('/recent', expressFactory.json({ limit: '8kb' }), (req, res) => {
    try {
      const workspaceHistory = service.rememberWorkspace(req.body?.workspace);
      res.json({ workspaceHistory });
    } catch (caught) {
      const error = caughtError(caught);
      res.status(400).json({
        error: error.message || 'Recent workspace is invalid',
      });
    }
  });

  return router;
}

export {
  createWorkspacePickerRouter,
  type WorkspacePickerRouterPort,
};
