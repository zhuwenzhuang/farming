const express = require('express');

const DEFAULT_INITIAL_INPUT_DELAY_MS = 2500;

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

function createControlRouter(agentManager, options = {}) {
  const router = express.Router();
  const notifyUpdate = typeof options.notifyUpdate === 'function' ? options.notifyUpdate : () => {};
  const initialInputDelayMs = Number.isFinite(options.initialInputDelayMs)
    ? Math.max(0, options.initialInputDelayMs)
    : DEFAULT_INITIAL_INPUT_DELAY_MS;

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

      if (initialInput) {
        setTimeout(() => {
          if (!findAgent(agentManager.getState(), agentId)) return;
          agentManager.sendInput(agentId, ensureTrailingNewline(initialInput)).catch(() => {});
        }, initialInputDelayMs);
      }

      notifyUpdate();
      res.status(201).json({
        agentId,
        scheduledInitialInput: Boolean(initialInput),
      });
    }, {
      wantsMain: false,
      parentAgentId: typeof body.parentAgentId === 'string' ? body.parentAgentId : '',
      task,
      source: 'control-cli',
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

    const input = typeof req.body.input === 'string' ? req.body.input : '';
    await agentManager.sendInput(agentId, input);
    notifyUpdate();
    res.json({ success: true });
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
  createControlRouter,
  ensureTrailingNewline,
};
