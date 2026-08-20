const express = require('express');

import { isAgentRuntimeModeRequest } from './agent-runtime-binding.cjs';

interface AgentMutationRecord {
  [key: string]: unknown;
  agentId?: string;
  agentRuntimeMode?: string;
  customTitle?: string;
  error?: string;
  launchPermissionMode?: string;
  requiresState?: boolean;
  restarted?: boolean;
  restartedAgentId?: string;
  stopped?: boolean;
  switchFailed?: boolean;
  task?: string;
  warning?: string;
}

interface ExpressRequest {
  body?: Record<string, unknown>;
  params: Record<string, string>;
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
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(): unknown;
}

interface AgentMutationRouterPort {
  archiveAgent(
    agentId: string,
    options: { acknowledgeUnprovenAcpExit: boolean },
  ): Promise<AgentMutationRecord>;
  publishAgentDelta(agentId: string): void;
  renameAgent(agentId: string, customTitle: string): AgentMutationRecord;
  restartAgentRuntimeMode(agentId: string, mode: string): Promise<AgentMutationRecord>;
  setAgentTask(agentId: string, task: string): AgentMutationRecord;
  syncLaunchPermissionMode(agentId: string, mode: string): Promise<AgentMutationRecord>;
  updateAgentFlags(agentId: string, patch: Record<string, unknown>): AgentMutationRecord;
  whenAgentLifecycleIdle(agentId: string): Promise<void>;
  whenRecovered(): Promise<void>;
}

const expressFactory = express as ExpressFactory;

function caughtError(value: unknown): Error {
  if (value instanceof Error) return value;
  const normalized = new Error(String(value));
  if (value && typeof value === 'object') Object.assign(normalized, value);
  return normalized;
}

function recordUpdateStatus(error: string): number {
  return error === 'Agent not found'
    ? 404
    : (error.startsWith('Failed to ') ? 500 : 409);
}

function createAgentMutationRouter(port: AgentMutationRouterPort): ExpressRouter {
  const router = expressFactory.Router();

  router.patch('/:agentId', expressFactory.json(), async (req, res) => {
    try {
      await port.whenRecovered();
    } catch (caught) {
      const error = caughtError(caught);
      res.status(503).json({
        error: error?.message || 'Agent lifecycle recovery is unavailable',
        retryable: true,
      });
      return;
    }
    const body = req.body || {};
    const updates: Record<string, unknown> = {};
    const providedPatchFields = [
      'customTitle',
      'task',
      'followUp',
      'pinned',
      'unread',
      'archived',
      'acknowledgeUnprovenAcpExit',
      'readAttentionSeq',
      'readOutputEpoch',
      'readOutputSeq',
      'launchPermissionMode',
      'agentRuntimeMode',
    ].filter(field => Object.prototype.hasOwnProperty.call(body, field));
    const lifecyclePatchFields = providedPatchFields.filter(field => (
      field === 'launchPermissionMode'
      || field === 'agentRuntimeMode'
      || (field === 'archived' && body.archived === true)
    ));
    if (body.acknowledgeUnprovenAcpExit === true && body.archived !== true) {
      res.status(400).json({ error: 'Process-exit acknowledgement is only valid for Archive' });
      return;
    }
    const archivePatchFields = new Set(['archived', 'acknowledgeUnprovenAcpExit']);
    const hasMixedLifecyclePatch = body.archived === true
      ? providedPatchFields.some(field => !archivePatchFields.has(field))
      : lifecyclePatchFields.length > 0 && providedPatchFields.length > 1;
    if (hasMixedLifecyclePatch) {
      res.status(400).json({
        error: 'Archive, permission restart, and runtime switch must be requested separately from other Agent updates',
      });
      return;
    }
    const ordinaryPatchGroups = [
      providedPatchFields.includes('customTitle') ? 'customTitle' : '',
      providedPatchFields.includes('task') ? 'task' : '',
      providedPatchFields.some(field => [
        'followUp',
        'pinned',
        'unread',
        'archived',
        'readAttentionSeq',
        'readOutputEpoch',
        'readOutputSeq',
      ].includes(field)) ? 'flags' : '',
    ].filter(Boolean);
    if (ordinaryPatchGroups.length > 1) {
      res.status(400).json({
        error: 'Agent title, task, and flags must be updated in separate requests',
      });
      return;
    }

    await port.whenAgentLifecycleIdle(req.params.agentId);

    if (typeof body.customTitle === 'string') {
      const result = port.renameAgent(req.params.agentId, body.customTitle);
      if (result.error) {
        res.status(recordUpdateStatus(result.error)).json({ error: result.error });
        return;
      }
      updates.customTitle = result.customTitle;
    }

    if (typeof body.task === 'string') {
      const result = port.setAgentTask(req.params.agentId, body.task);
      if (result.error) {
        res.status(recordUpdateStatus(result.error)).json({ error: result.error });
        return;
      }
      updates.task = result.task;
    }

    const flagPatch: Record<string, unknown> = {};
    ['followUp', 'pinned', 'unread', 'archived'].forEach((flagName) => {
      if (typeof body[flagName] === 'boolean') {
        flagPatch[flagName] = body[flagName];
      }
    });
    if (typeof body.readAttentionSeq === 'number' && Number.isFinite(body.readAttentionSeq)) {
      flagPatch.readAttentionSeq = body.readAttentionSeq;
    }
    if (
      typeof body.readOutputEpoch === 'string'
      && body.readOutputEpoch
      && typeof body.readOutputSeq === 'number'
      && Number.isFinite(body.readOutputSeq)
    ) {
      flagPatch.readOutputEpoch = body.readOutputEpoch;
      flagPatch.readOutputSeq = body.readOutputSeq;
    }

    if (flagPatch.archived === true) {
      const result = await port.archiveAgent(req.params.agentId, {
        acknowledgeUnprovenAcpExit: body.acknowledgeUnprovenAcpExit === true,
      });
      if (result.error) {
        const status = result.stopped === true
          ? 409
          : (result.error === 'Agent not found' ? 404 : 400);
        res.status(status).json(result);
        return;
      }
      Object.assign(updates, result);
      delete updates.agentId;
      delete flagPatch.archived;
    }

    let flagUpdateRequiresState = false;
    if (Object.keys(flagPatch).length > 0) {
      const result = port.updateAgentFlags(req.params.agentId, flagPatch);
      if (result.error) {
        res.status(recordUpdateStatus(result.error)).json({ error: result.error });
        return;
      }
      Object.assign(updates, result);
      delete updates.agentId;
      flagUpdateRequiresState = 'requiresState' in result && result.requiresState === true;
    }

    if (typeof body.launchPermissionMode === 'string') {
      const result = await port.syncLaunchPermissionMode(req.params.agentId, body.launchPermissionMode);
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
      if (!isAgentRuntimeModeRequest(body.agentRuntimeMode)) {
        res.status(400).json({ error: 'Unsupported Agent runtime mode' });
        return;
      }
      const result = await port.restartAgentRuntimeMode(req.params.agentId, body.agentRuntimeMode);
      if (result.error) {
        const status = result.error === 'Agent not found' ? 404 : 400;
        res.status(status).json({ error: result.error });
        return;
      }
      updates.agentRuntimeMode = result.agentRuntimeMode;
      if (result.restarted === true) updates.restarted = true;
      if (result.restartedAgentId) updates.restartedAgentId = result.restartedAgentId;
      if (result.switchFailed === true) updates.switchFailed = true;
      if (result.warning) updates.warning = result.warning;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'customTitle, task, followUp, pinned, unread, archived, readAttentionSeq, readOutputEpoch/readOutputSeq, launchPermissionMode, or agentRuntimeMode is required' });
      return;
    }

    if (
      flagUpdateRequiresState
      || typeof body.task === 'string'
      || typeof body.customTitle === 'string'
      || typeof body.launchPermissionMode === 'string'
      || typeof body.agentRuntimeMode === 'string'
    ) {
      port.publishAgentDelta(req.params.agentId);
    }
    res.json({ agentId: req.params.agentId, ...updates });
  });

  return router;
}

export {
  createAgentMutationRouter,
  type AgentMutationRecord,
  type AgentMutationRouterPort,
};
