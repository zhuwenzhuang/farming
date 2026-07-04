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
      focusAgent(agentId) {
        return send({
          type: 'focus-agent',
          agentId,
        });
      },

      sendInput(agentId, input) {
        return send({
          type: 'input',
          agentId,
          input,
        });
      },

      resizeAgent(agentId, cols, rows) {
        return send({
          type: 'resize-agent',
          agentId,
          cols,
          rows,
        });
      },

      killAgent(agentId) {
        return send({
          type: 'kill-agent',
          agentId,
        });
      },

      async getSessionView(agentId) {
        const response = await fetchImpl(`/api/agents/${agentId}/session-view`);
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
