(function attachSessionBridge(global) {
  function createClient(options = {}) {
    const getSocket = options.getSocket || (() => null);
    const fetchImpl = options.fetchImpl || global.fetch.bind(global);

    function send(message) {
      const ws = getSocket();
      if (!ws || ws.readyState !== global.WebSocket.OPEN) {
        return false;
      }
      ws.send(JSON.stringify(message));
      return true;
    }

    return {
      focusAgent(agentId, options = {}) {
        return send({
          type: 'focus-agent',
          agentId,
          ...(options.streamScope ? { streamScope: options.streamScope } : {}),
          ...(options.previewScope ? { previewScope: options.previewScope } : {}),
          ...(options.refreshState === true ? { refreshState: true } : {}),
        });
      },

      sendTerminalInput(agentId, input, terminalControl) {
        return send({
          type: 'input',
          agentId,
          input,
          ...terminalControl,
        });
      },

      sendComposerMessage(agentId, message, attachments = []) {
        return send({
          type: 'composer-input',
          agentId,
          message,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      },

      interruptAgent(agentId, controller) {
        return send({
          type: 'interrupt-agent',
          agentId,
          ...(controller || {}),
        });
      },

      claimTerminalController(agentId, controller) {
        return send({
          type: 'terminal-controller-claim',
          agentId,
          ...controller,
        });
      },

      renewTerminalController(agentId, controller) {
        return send({
          type: 'terminal-controller-renew',
          agentId,
          ...controller,
        });
      },

      releaseTerminalController(agentId, controller) {
        return send({
          type: 'terminal-controller-release',
          agentId,
          ...controller,
        });
      },

      activateTerminalRenderer(agentId, controller) {
        return send({
          type: 'terminal-renderer-ready',
          agentId,
          ...controller,
        });
      },

      acknowledgeTerminalOutput(agentId, charCount, controller) {
        return send({
          type: 'terminal-output-ack',
          agentId,
          charCount,
          ...controller,
        });
      },

      acknowledgeTerminalCheckpoint(agentId, outputSeq, stateRevision, controller) {
        return send({
          type: 'terminal-checkpoint-applied',
          agentId,
          outputSeq,
          stateRevision,
          ...controller,
        });
      },

      resizeAgent(agentId, cols, rows, controller) {
        return send({
          type: 'resize-agent',
          agentId,
          cols,
          rows,
          ...controller,
        });
      },

      killAgent(agentId) {
        return send({
          type: 'kill-agent',
          agentId,
        });
      },

      async getSessionView(agentId, options = {}) {
        const path = global.FarmingRuntimePaths
          ? global.FarmingRuntimePaths.apiPath(`/agents/${agentId}/session-view`)
          : `/api/agents/${agentId}/session-view`;
        const response = await fetchImpl(path, {
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!response.ok) {
          throw new Error(`Failed to load session view: ${response.status}`);
        }
        return response.json();
      },
    };
  }

  global.FarmingSessionBridge = {
    createClient,
  };
})(window);
