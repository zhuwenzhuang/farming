const express = require('express');
const { runtimeKind } = require('./agent-runtime-binding');
const { terminalInputReady } = require('./terminal-status');

const DEFAULT_INITIAL_INPUT_TIMEOUT_MS = 30000;

function ensureTrailingNewline(value) {
  const text = String(value || '');
  return text.endsWith('\r') || text.endsWith('\n') ? text : `${text}\r`;
}

function findAgent(state, agentId) {
  return state.agents.find((agent) => agent.id === agentId) || null;
}

function normalizeTail(value, fallback = 4000) {
  const tail = Number(value);
  if (!Number.isFinite(tail)) return fallback;
  return Math.max(0, Math.min(100000, Math.floor(tail)));
}

function terminalReadinessOptions(agent) {
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

function waitForTerminalInputReadiness(agentManager, agentId, options = {}) {
  const expectedStartedAt = Number(options.expectedStartedAt);
  const initialRuntimeEpoch = typeof options.expectedRuntimeEpoch === 'string'
    ? options.expectedRuntimeEpoch
    : '';
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_INITIAL_INPUT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let expectedRuntimeEpoch = initialRuntimeEpoch;
    const removeUpdateListener = () => {
      if (typeof agentManager.off === 'function') agentManager.off('update', inspect);
      else if (typeof agentManager.removeListener === 'function') agentManager.removeListener('update', inspect);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeUpdateListener();
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (code, message) => {
      const error = new Error(message);
      error.code = code;
      finish(error);
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

function createControlRouter(agentManager, options = {}) {
  const router = express.Router();
  const notifyUpdate = typeof options.notifyUpdate === 'function' ? options.notifyUpdate : () => {};
  const initialInputTimeoutMs = Number.isFinite(options.initialInputTimeoutMs)
    ? Math.max(1, options.initialInputTimeoutMs)
    : DEFAULT_INITIAL_INPUT_TIMEOUT_MS;

  async function runTerminalMutation(agentId, expectedRuntimeEpoch, operation) {
    const current = findAgent(agentManager.getState(), agentId);
    if (!current || current.runtimeEpoch !== expectedRuntimeEpoch) {
      return { status: 'rejected', reason: 'runtime-epoch-mismatch' };
    }
    return operation({ expectedRuntimeEpoch });
  }

  router.use(express.json({ limit: '1mb' }));

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

    if (!command) {
      res.status(400).json({ error: 'command is required' });
      return;
    }

    agentManager.startAgent(command, workspace, (agentId, error) => {
      if (error) {
        res.status(400).json({ error });
        return;
      }

      if (!agentId) {
        res.status(500).json({ error: 'failed to start agent' });
        return;
      }

      void (async () => {
        if (!initialInput) {
          notifyUpdate();
          res.status(201).json({ agentId, initialInputDelivered: false });
          return;
        }

        const started = findAgent(agentManager.getState(), agentId);
        if (!started) throw Object.assign(new Error('Agent disappeared before initial input delivery'), {
          code: 'agent-removed',
        });
        const structuredRuntime = runtimeKind(started) !== 'terminal';
        if (structuredRuntime) {
          await agentManager.sendComposerMessage(agentId, initialInput);
          notifyUpdate();
          res.status(201).json({ agentId, initialInputDelivered: true, inputMode: 'structured' });
          return;
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
        res.status(201).json({ agentId, initialInputDelivered: true, inputMode: 'terminal' });
      })().catch((deliveryError) => {
        const status = deliveryError?.code === 'initial-input-timeout' ? 504 : 409;
        res.status(status).json({
          error: deliveryError?.message || 'Initial input delivery failed',
          code: deliveryError?.code || 'initial-input-failed',
          agentId,
          initialInputDelivered: false,
        });
      });
    }, {
      wantsMain: false,
      parentAgentId: typeof body.parentAgentId === 'string' ? body.parentAgentId : '',
      task,
      source: 'control-cli',
      agentRuntimeMode: ['json', 'acp', 'chat'].includes(body.agentRuntimeMode) ? body.agentRuntimeMode : 'terminal',
      acpHistoryMode: body.acpHistoryMode === 'resume' ? 'resume' : 'load',
      providerSessionTitle: typeof body.providerSessionTitle === 'string' ? body.providerSessionTitle : '',
      ...(Array.isArray(body.additionalDirectories) ? { additionalDirectories: body.additionalDirectories } : {}),
      ...(Array.isArray(body.mcpServers) ? { mcpServers: body.mcpServers } : {}),
      dangerouslySkipPermissions: body.dangerouslySkipPermissions === true,
    });
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
    const expectedRuntimeEpoch = typeof findAgent(agentManager.getState(), agentId)?.runtimeEpoch === 'string'
      ? findAgent(agentManager.getState(), agentId).runtimeEpoch
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
    const expectedRuntimeEpoch = typeof findAgent(agentManager.getState(), agentId)?.runtimeEpoch === 'string'
      ? findAgent(agentManager.getState(), agentId).runtimeEpoch
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
    const state = agentManager.getState();
    if (!findAgent(state, agentId)) {
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    await agentManager.killAgent(agentId);
    notifyUpdate();
    res.json({ success: true });
  });

  return router;
}

module.exports = {
  DEFAULT_INITIAL_INPUT_TIMEOUT_MS,
  createControlRouter,
  ensureTrailingNewline,
  waitForTerminalInputReadiness,
};
