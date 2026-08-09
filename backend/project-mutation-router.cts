const express = require('express');

interface ExpressRequest {
  body?: Record<string, unknown>;
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
  patch(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
  post(path: string, middleware: unknown, handler: ExpressHandler): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface ProjectMutationRouterPort {
  canonicalWorkspace(workspace: string): Promise<string>;
  mountWorkspace(workspace: string): unknown;
  publishMembershipChange(): void;
  publishNameChange(): void;
  removeWorkspace(workspace: unknown): unknown;
  reorderWorkspace(
    workspace: unknown,
    position: { afterWorkspace?: string; beforeWorkspace?: string },
  ): unknown;
  setWorkspaceName(workspace: unknown, name: unknown): unknown;
  setWorkspacePinned(workspace: unknown, pinned: boolean): unknown;
}

const expressFactory = express as ExpressFactory;

function caughtError(value: unknown): Error {
  if (value instanceof Error) return value;
  const normalized = new Error(String(value));
  if (value && typeof value === 'object') Object.assign(normalized, value);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function createProjectMutationRouter(port: ProjectMutationRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.post('/mount', expressFactory.json(), async (req, res) => {
    try {
      const workspace = await port.canonicalWorkspace(
        typeof req.body?.workspace === 'string' ? req.body.workspace : '',
      );
      const membership = port.mountWorkspace(workspace);
      port.publishMembershipChange();
      res.json(membership);
    } catch (caught) {
      const error = caughtError(caught);
      res.status(400).json({ error: error.message || 'Failed to create Project' });
    }
  });

  router.post('/remove', expressFactory.json(), (req, res) => {
    try {
      const membership = port.removeWorkspace(req.body?.workspace);
      port.publishMembershipChange();
      res.json(membership);
    } catch (caught) {
      const error = caughtError(caught);
      res.status(400).json({ error: error.message || 'Failed to remove Project' });
    }
  });

  router.post('/pin', expressFactory.json(), (req, res) => {
    try {
      const membership = port.setWorkspacePinned(
        req.body?.workspace,
        req.body?.pinned === true,
      );
      port.publishMembershipChange();
      res.json(membership);
    } catch (caught) {
      const error = caughtError(caught);
      res.status(400).json({ error: error.message || 'Failed to update Project pin' });
    }
  });

  router.post('/reorder', expressFactory.json(), (req, res) => {
    try {
      const membership = port.reorderWorkspace(req.body?.workspace, {
        beforeWorkspace: optionalString(req.body?.beforeWorkspace),
        afterWorkspace: optionalString(req.body?.afterWorkspace),
      });
      port.publishMembershipChange();
      res.json(membership);
    } catch (caught) {
      const error = caughtError(caught);
      const status = error.message === 'Project does not exist' ? 404 : 409;
      res.status(status).json({ error: error.message || 'Failed to reorder Project' });
    }
  });

  router.patch('/name', expressFactory.json(), (req, res) => {
    try {
      const result = port.setWorkspaceName(req.body?.workspace, req.body?.name);
      port.publishNameChange();
      res.json(result);
    } catch (caught) {
      const error = caughtError(caught);
      res.status(400).json({ error: error.message || 'Failed to rename Project' });
    }
  });

  return router;
}

export {
  createProjectMutationRouter,
  type ProjectMutationRouterPort,
};
