import { terminalInputReady } from './terminal-status.cjs';
import type { LifecycleOperationResult } from './agent-manager-lifecycle-types.js';

const express = require('express');
const crypto = require('crypto');
import { runtimeKind } from './agent-runtime-binding.cjs';
const DEFAULT_INITIAL_INPUT_TIMEOUT_MS = 30000;

interface ExpressRequest {
  body: Record<string, unknown>;
  get(name: string): string | undefined;
  params: Record<string, string>;
  query: Record<string, unknown>;
}

interface ExpressResponse {
  json(value: unknown): ExpressResponse;
  send(value: unknown): ExpressResponse;
  status(code: number): ExpressResponse;
  type(value: string): ExpressResponse;
}

type ExpressHandler = (
  request: ExpressRequest,
  response: ExpressResponse,
) => void | Promise<void>;

interface ExpressRouter {
  delete(path: string, handler: ExpressHandler): ExpressRouter;
  get(path: string, handler: ExpressHandler): ExpressRouter;
  post(path: string, handler: ExpressHandler): ExpressRouter;
  use(middleware: unknown): ExpressRouter;
}

interface ExpressFactory {
  Router(): ExpressRouter;
  json(options: { limit: string }): unknown;
}

interface TerminalStatus {
  cwd?: string;
  lastExitCode?: unknown;
  runningCommand?: string;
  source?: string;
  title?: string;
}

interface AgentRecord extends Record<string, unknown> {
  command?: string;
  cwd?: string | null;
  id: string;
  parentAgentId?: string;
  previewText?: string;
  runtimeEpoch?: string;
  sessionTitle?: string;
  startedAt?: unknown;
  status?: string;
  terminalBusy?: boolean | null;
  terminalInputReceived?: boolean;
  terminalStatus?: TerminalStatus;
}

interface AgentState {
  agents: AgentRecord[];
  mainAgentId?: string | null;
}

interface TerminalReadinessState {
  command?: string;
  cwd?: string | null;
  previewText: string;
  shellCommand: string;
  shellLastEvent: string;
  shellLastExitCode?: unknown;
  status?: string;
  terminalBusy: boolean | null;
  title: string;
}

interface TerminalReadinessOptions {
  expectedRuntimeEpoch?: unknown;
  expectedStartedAt?: unknown;
  timeoutMs?: unknown;
}

interface TerminalReadiness {
  expectedRuntimeEpoch: string;
  expectedStartedAt: number;
}

interface MutationResult {
  accepted?: boolean;
  cleared?: boolean;
  error?: string;
  reason?: string;
  sent?: boolean;
  status?: string;
}

interface CreateOutcome {
  body: Record<string, unknown>;
  status: number;
}

interface RecordedCreateResult extends LifecycleOperationResult {
  controlApi?: CreateOutcome;
}

interface CreateMetadata {
  createResult?: RecordedCreateResult;
  deduplicated?: boolean;
}

interface StartAgentOptions extends Record<string, unknown> {
  acpHistoryMode: 'load' | 'resume';
  agentRuntimeMode: 'acp' | 'chat' | 'terminal';
  createInitialInputSignature: string;
  createRequestId: string;
  dangerouslySkipPermissions: boolean;
  parentAgentId: string;
  providerSessionTitle: string;
  source: 'control-cli' | 'deployment-smoke';
  task: string;
  wantsMain: false;
}

interface KillRequest {
  completion: Promise<unknown>;
  result: MutationResult;
}

interface PersistCreateResult {
  error?: string;
}

interface ComposerMessageOptions {
  [key: string]: unknown;
  delivery?: 'prompt' | 'steer';
  requestId: string;
}

interface AgentManager {
  agentSupportsTerminalInput?(agentId: string): boolean;
  clearAgentSessionBuffer(
    agentId: string,
    options: { expectedRuntimeEpoch: string },
  ): Promise<MutationResult> | MutationResult;
  getAgentSessionText(agentId: string): Promise<unknown> | unknown;
  getState(): AgentState;
  off?(event: 'update', listener: () => void): void;
  on?(event: 'update', listener: () => void): void;
  recordCreateRequestResult(
    agentId: string,
    requestId: string,
    result: RecordedCreateResult,
  ): PersistCreateResult;
  removeListener?(event: 'update', listener: () => void): void;
  requestKillAgent(
    agentId: string,
    options: { recordHistory: boolean },
  ): Promise<KillRequest>;
  sendComposerMessage(
    agentId: string,
    input: string,
    options?: ComposerMessageOptions,
  ): Promise<unknown> | unknown;
  sendInput(
    agentId: string,
    input: string,
    options: { expectedRuntimeEpoch: string },
  ): Promise<MutationResult | undefined> | MutationResult | undefined;
  setAgentAdaptiveTitle(
    agentId: string,
    title: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  startAgent(
    command: string,
    workspace: string | null,
    callback: (agentId?: string | null, error?: string | null, metadata?: CreateMetadata) => void,
    options: StartAgentOptions,
  ): unknown;
}

interface ControlRouterOptions {
  allowConcurrentTestControl?: boolean;
  initialInputTimeoutMs?: unknown;
  notifyUpdate?: () => void;
}

interface CreateAdmission {
  promise: Promise<CreateOutcome>;
  signature: string;
}

interface ControlError extends Error {
  code: string;
}

const expressFactory = express as ExpressFactory;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : fallback;
}

function errorCode(error: unknown, fallback: string): string {
  return isRecord(error) && error.code ? String(error.code) : fallback;
}

function controlError(code: string, message: string): ControlError {
  return Object.assign(new Error(message), { code });
}

function isRequestedRuntimeMode(value: unknown): value is 'acp' | 'chat' {
  return value === 'acp' || value === 'chat';
}

function ensureTrailingNewline(value: unknown): string {
  const text = String(value || '');
  return text.endsWith('\r') || text.endsWith('\n') ? text : `${text}\r`;
}

function findAgent(state: AgentState, agentId: string): AgentRecord | null {
  return state.agents.find((agent) => agent.id === agentId) || null;
}

function normalizeTail(value: unknown, fallback = 4000): number {
  const tail = Number(value);
  if (!Number.isFinite(tail)) return fallback;
  return Math.max(0, Math.min(100000, Math.floor(tail)));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = stableJsonValue((value as Record<string, unknown>)[key]);
    return result;
  }, {});
}

function requestSignature(value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableJsonValue(value)))
    .digest('hex');
}

function terminalReadinessOptions(agent: AgentRecord): TerminalReadinessState {
  return {
    command: agent.command,
    cwd: agent.terminalStatus?.cwd || agent.cwd,
    status: agent.status === 'running' ? 'running' : agent.status,
    title: agent.terminalStatus?.title || agent.sessionTitle || '',
    previewText: agent.previewText || '',
    terminalBusy: typeof agent.terminalBusy === 'boolean' ? agent.terminalBusy : null,
    shellLastEvent: agent.terminalStatus?.source === 'shell-status-marker' ? 'finish' : '',
    shellLastExitCode: agent.terminalStatus?.lastExitCode,
    shellCommand: agent.terminalStatus?.runningCommand || '',
  };
}

function waitForTerminalInputReadiness(
  agentManager: AgentManager,
  agentId: string,
  options: TerminalReadinessOptions = {},
): Promise<TerminalReadiness> {
  const expectedStartedAt = Number(options.expectedStartedAt);
  const initialRuntimeEpoch = typeof options.expectedRuntimeEpoch === 'string'
    ? options.expectedRuntimeEpoch
    : '';
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_INITIAL_INPUT_TIMEOUT_MS;

  return new Promise<TerminalReadiness>((resolve, reject) => {
    let settled = false;
    let expectedRuntimeEpoch = initialRuntimeEpoch;
    const removeUpdateListener = () => {
      if (typeof agentManager.off === 'function') agentManager.off('update', inspect);
      else if (typeof agentManager.removeListener === 'function') agentManager.removeListener('update', inspect);
    };
    const finish = (error: ControlError | null, value?: TerminalReadiness) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeUpdateListener();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    const fail = (code: string, message: string) => {
      finish(controlError(code, message));
    };
    const inspect = () => {
      const agent = findAgent(agentManager.getState(), agentId);
      if (!agent) {
        fail('agent-removed', 'Agent disappeared before its initial Terminal task was delivered');
        return;
      }
      if (Number(agent.startedAt) !== expectedStartedAt) {
        fail('runtime-replaced', 'Agent runtime was replaced before its initial Terminal task was delivered');
        return;
      }
      if (agent.terminalInputReceived === true) {
        fail('terminal-already-used', 'Terminal received user input before its initial task was delivered');
        return;
      }
      if (agent.status === 'dead' || agent.status === 'stopped') {
        fail('runtime-exited', 'Agent exited before its initial Terminal task was delivered');
        return;
      }
      const runtimeEpoch = typeof agent.runtimeEpoch === 'string' ? agent.runtimeEpoch : '';
      if (!runtimeEpoch) return;
      if (expectedRuntimeEpoch && runtimeEpoch !== expectedRuntimeEpoch) {
        fail('runtime-replaced', 'Agent runtime changed before its initial Terminal task was delivered');
        return;
      }
      expectedRuntimeEpoch = runtimeEpoch;
      if (agent.status !== 'running' || !terminalInputReady(terminalReadinessOptions(agent))) return;
      finish(null, {
        expectedStartedAt,
        expectedRuntimeEpoch,
      });
    };
    const timeout = setTimeout(() => {
      fail('initial-input-timeout', 'Terminal did not become ready for its initial task before the timeout');
    }, timeoutMs);
    timeout.unref?.();
    if (typeof agentManager.on === 'function') agentManager.on('update', inspect);
    Promise.resolve().then(inspect);
  });
}

function createControlRouter(
  agentManager: AgentManager,
  options: ControlRouterOptions = {},
): ExpressRouter {
  const router = expressFactory.Router();
  const createRequestAdmissions = new Map<string, CreateAdmission>();
  const notifyUpdate = typeof options.notifyUpdate === 'function' ? options.notifyUpdate : () => {};
  const initialInputTimeoutMs = (
    typeof options.initialInputTimeoutMs === 'number'
    && Number.isFinite(options.initialInputTimeoutMs)
  )
    ? Math.max(1, options.initialInputTimeoutMs)
    : DEFAULT_INITIAL_INPUT_TIMEOUT_MS;

  async function runTerminalMutation(
    agentId: string,
    expectedRuntimeEpoch: string,
    operation: (
      input: { expectedRuntimeEpoch: string },
    ) => Promise<MutationResult | undefined> | MutationResult | undefined,
  ): Promise<MutationResult | undefined> {
    const current = findAgent(agentManager.getState(), agentId);
    if (!current || current.runtimeEpoch !== expectedRuntimeEpoch) {
      return { status: 'rejected', reason: 'runtime-epoch-mismatch' };
    }
    return operation({ expectedRuntimeEpoch });
  }

  router.use(expressFactory.json({ limit: '1mb' }));

  router.get('/agents', (req, res) => {
    const state = agentManager.getState();
    const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
    const agents = parent
      ? state.agents.filter((agent) => agent.parentAgentId === parent)
      : state.agents;

    res.json({
      mainAgentId: state.mainAgentId,
      agents,
    });
  });

  router.post('/agents', (req, res) => {
    const body = req.body || {};
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    const workspace = typeof body.workspace === 'string' ? body.workspace : null;
    const task = typeof body.task === 'string' ? body.task.trim() : '';
    const initialInput = typeof body.initialInput === 'string' ? body.initialInput : task;
    const createRequestId = typeof body.requestId === 'string' && body.requestId.trim()
      ? body.requestId
      : req.get('Idempotency-Key') || '';
    const controlRequestSignature = requestSignature(body);

    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }

    const pendingRequest = createRequestId
      ? createRequestAdmissions.get(createRequestId)
      : null;
    if (pendingRequest) {
      if (pendingRequest.signature !== controlRequestSignature) {
        res.status(409).json({
          error: `Create request ${createRequestId} is already in progress with different parameters`,
        });
        return;
      }
      void pendingRequest.promise.then(outcome => {
        res.status(outcome.status).json(outcome.body);
      });
      return;
    }

    agentManager.startAgent(command, workspace, (agentId, error, metadata = {}) => {
      if (error) {
        res.status(400).json({ error });
        return;
      }

      if (!agentId) {
        res.status(500).json({ error: 'failed to start agent' });
        return;
      }

      if (metadata.deduplicated === true) {
        const recorded = metadata.createResult?.controlApi;
        if (recorded && Number.isInteger(recorded.status) && recorded.body) {
          res.status(recorded.status).json(recorded.body);
          return;
        }
        const admitted = createRequestId
          ? createRequestAdmissions.get(createRequestId)
          : null;
        if (admitted) {
          void admitted.promise.then(outcome => {
            res.status(outcome.status).json(outcome.body);
          });
          return;
        }
        res.status(409).json({
          error: 'Create succeeded, but the initial-input outcome is unknown; input was not replayed',
          code: 'create-result-unknown',
          agentId,
        });
        return;
      }

      const deliveryPromise = (async () => {
        if (!initialInput) {
          notifyUpdate();
          return {
            status: 201,
            body: { agentId, initialInputDelivered: false },
          };
        }

        const started = findAgent(agentManager.getState(), agentId);
        if (!started) throw Object.assign(new Error('Agent disappeared before initial input delivery'), {
          code: 'agent-removed',
        });
        const structuredRuntime = runtimeKind(started) !== 'terminal';
        if (structuredRuntime) {
          await agentManager.sendComposerMessage(agentId, initialInput);
          notifyUpdate();
          return {
            status: 201,
            body: { agentId, initialInputDelivered: true, inputMode: 'structured' },
          };
        }

        const readiness = await waitForTerminalInputReadiness(agentManager, agentId, {
          expectedStartedAt: started.startedAt,
          expectedRuntimeEpoch: started.runtimeEpoch,
          timeoutMs: initialInputTimeoutMs,
        });
        const result = await runTerminalMutation(
          agentId,
          readiness.expectedRuntimeEpoch,
          async ({ expectedRuntimeEpoch }) => {
            const current = findAgent(agentManager.getState(), agentId);
            if (
              !current ||
              Number(current.startedAt) !== readiness.expectedStartedAt ||
              current.runtimeEpoch !== readiness.expectedRuntimeEpoch ||
              current.terminalInputReceived === true ||
              current.status !== 'running' ||
              !terminalInputReady(terminalReadinessOptions(current))
            ) {
              return { status: 'rejected', reason: 'startup-state-changed' };
            }
            return agentManager.sendInput(agentId, ensureTrailingNewline(initialInput), {
              expectedRuntimeEpoch,
            });
          },
        );
        if (!result || result.status === 'rejected' || result.status === 'input-rejected') {
          const reason = result?.reason || 'initial-input-rejected';
          throw Object.assign(new Error(`Initial Terminal task was not delivered: ${reason}`), { code: reason });
        }
        notifyUpdate();
        return {
          status: 201,
          body: { agentId, initialInputDelivered: true, inputMode: 'terminal' },
        };
      })().catch((deliveryError: unknown) => {
        const code = errorCode(deliveryError, 'initial-input-failed');
        const status = code === 'initial-input-timeout' ? 504 : 409;
        return {
          status,
          body: {
            error: errorMessage(deliveryError, 'Initial input delivery failed'),
            code,
            agentId,
            initialInputDelivered: false,
          },
        };
      });
      const durableDeliveryPromise = deliveryPromise.then(outcome => {
        if (!createRequestId) return outcome;
        let persisted;
        try {
          persisted = agentManager.recordCreateRequestResult(
            agentId,
            createRequestId,
            { controlApi: outcome },
          );
        } catch (error) {
          persisted = { error: errorMessage(error, 'Create result persistence failed') };
        }
        if (persisted?.error) {
          return {
            status: 409,
            body: {
              error: `${persisted.error}; Create outcome was not persisted and initial input was not replayed`,
              code: 'create-result-not-durable',
              agentId,
              initialInputDelivered: outcome.body?.initialInputDelivered === true,
              createResultDurable: false,
            },
          };
        }
        return outcome;
      });
      if (createRequestId) {
        const admission = {
          signature: controlRequestSignature,
          promise: durableDeliveryPromise,
        };
        createRequestAdmissions.set(createRequestId, admission);
        void durableDeliveryPromise.finally(() => {
          if (createRequestAdmissions.get(createRequestId) === admission) {
            createRequestAdmissions.delete(createRequestId);
          }
        }).catch(() => {});
      }
      void durableDeliveryPromise.then(outcome => {
        res.status(outcome.status).json(outcome.body);
      });
    }, {
      wantsMain: false,
      parentAgentId: typeof body.parentAgentId === 'string' ? body.parentAgentId : '',
      task,
      source: body.source === 'deployment-smoke' ? 'deployment-smoke' : 'control-cli',
      createRequestId,
      createInitialInputSignature: requestSignature(initialInput),
      agentRuntimeMode: isRequestedRuntimeMode(body.agentRuntimeMode)
        ? body.agentRuntimeMode
        : 'terminal',
      acpHistoryMode: body.acpHistoryMode === 'resume' ? 'resume' : 'load',
      providerSessionTitle: typeof body.providerSessionTitle === 'string' ? body.providerSessionTitle : '',
      ...(Array.isArray(body.additionalDirectories) ? { additionalDirectories: body.additionalDirectories } : {}),
      ...(Array.isArray(body.mcpServers) ? { mcpServers: body.mcpServers } : {}),
      dangerouslySkipPermissions: body.dangerouslySkipPermissions === true,
    });
  });

  router.post('/agents/:agentId/messages', async (req, res) => {
    const agentId = req.params.agentId;
    if (!findAgent(agentManager.getState(), agentId)) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    const message = typeof req.body.message === 'string' ? req.body.message : '';
    if (!message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const requestId = (
      typeof req.body.requestId === 'string' && req.body.requestId.trim()
        ? req.body.requestId.trim()
        : req.get('Idempotency-Key') || ''
    );
    if (!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      res.status(400).json({ error: 'a valid requestId or Idempotency-Key is required' });
      return;
    }

    const delivery = req.body.delivery === 'prompt' || req.body.delivery === 'steer'
      ? req.body.delivery
      : undefined;
    try {
      const result = await agentManager.sendComposerMessage(agentId, message, {
        requestId,
        ...(delivery ? { delivery } : {}),
      });
      res.status(202).json({ accepted: true, agentId, requestId, result });
    } catch (error) {
      res.status(409).json({
        error: errorMessage(error, 'Agent message was not accepted'),
        requestId,
        uncertain: isRecord(error) && error.uncertain === true,
      });
    }
  });

  router.post('/agents/:agentId/input', async (req, res) => {
    const agentId = req.params.agentId;
    const state = agentManager.getState();
    if (!findAgent(state, agentId)) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    if (agentManager.agentSupportsTerminalInput?.(agentId) === false) {
      res.status(409).json({ error: 'raw input is only available for Terminal Agents' });
      return;
    }
    const currentAgent = findAgent(agentManager.getState(), agentId);
    const expectedRuntimeEpoch = typeof currentAgent?.runtimeEpoch === 'string'
      ? currentAgent.runtimeEpoch
      : '';
    if (!expectedRuntimeEpoch) {
      res.status(409).json({ error: 'terminal runtime is not ready' });
      return;
    }
    const input = typeof req.body.input === 'string' ? req.body.input : '';
    const result = await runTerminalMutation(agentId, expectedRuntimeEpoch, ({ expectedRuntimeEpoch: epoch }) => (
      agentManager.sendInput(agentId, input, { expectedRuntimeEpoch: epoch })
    ));
    if (!result || result.status === 'rejected' || result.status === 'input-rejected') {
      res.status(409).json({ error: result?.reason || 'terminal input rejected' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/agents/:agentId/title', async (req, res) => {
    const agentId = req.params.agentId;
    const title = typeof req.body.title === 'string' ? req.body.title : '';
    const result = await agentManager.setAgentAdaptiveTitle(agentId, title);
    if (typeof result.error === 'string' && result.error) {
      const status = result.error.includes('not found')
        ? 404
        : result.retryable === true
          ? 500
          : /lifecycle change|shutting down/.test(result.error)
            ? 409
            : 400;
      res.status(status).json(result);
      return;
    }
    res.json(result);
  });

  router.post('/agents/:agentId/clear', async (req, res) => {
    const agentId = req.params.agentId;
    const state = agentManager.getState();
    if (!findAgent(state, agentId)) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    if (agentManager.agentSupportsTerminalInput?.(agentId) === false) {
      res.status(409).json({ error: 'clear is only available for Terminal Agents' });
      return;
    }
    const currentAgent = findAgent(agentManager.getState(), agentId);
    const expectedRuntimeEpoch = typeof currentAgent?.runtimeEpoch === 'string'
      ? currentAgent.runtimeEpoch
      : '';
    if (!expectedRuntimeEpoch) {
      res.status(409).json({ error: 'terminal runtime is not ready' });
      return;
    }
    const result = await runTerminalMutation(agentId, expectedRuntimeEpoch, ({ expectedRuntimeEpoch: epoch }) => (
      agentManager.clearAgentSessionBuffer(agentId, { expectedRuntimeEpoch: epoch })
    ));
    if (!result || result.status === 'rejected' || result.cleared === false) {
      res.status(409).json({ error: result?.reason || result?.error || 'terminal clear rejected' });
      return;
    }
    notifyUpdate();
    res.json({ success: Boolean(result && result.cleared), ...result });
  });

  router.get('/agents/:agentId/output', async (req, res) => {
    const agentId = req.params.agentId;
    const state = agentManager.getState();
    if (!findAgent(state, agentId)) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    const output = await agentManager.getAgentSessionText(agentId);
    const tail = normalizeTail(req.query.tail);
    const text = tail > 0 ? String(output || '').slice(-tail) : String(output || '');

    res.type('text/plain');
    res.send(text);
  });

  router.delete('/agents/:agentId', async (req, res) => {
    const agentId = req.params.agentId;
    const recordHistory = req.query?.recordHistory !== '0';
    let requested;
    try {
      requested = await agentManager.requestKillAgent(agentId, { recordHistory });
    } catch (error) {
      res.status(503).json({
        error: errorMessage(error, 'Agent lifecycle recovery is unavailable'),
        retryable: true,
      });
      return;
    }
    const result = requested.result;
    if (result?.error) {
      res.status(409).json({ error: result.error });
      return;
    }
    if (result?.accepted) {
      void requested.completion.finally(() => notifyUpdate()).catch(() => {});
      res.status(202).json(result);
      return;
    }
    notifyUpdate();
    res.json({ success: true, agentId, ...result });
  });

  return router;
}

export {
  DEFAULT_INITIAL_INPUT_TIMEOUT_MS,
  createControlRouter,
  ensureTrailingNewline,
  waitForTerminalInputReadiness,
};
