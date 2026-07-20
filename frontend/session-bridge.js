(function attachSessionBridge(global) {
  function createClient(options = {}) {
    const getSocket = options.getSocket || (() => null);
    const fetchImpl = options.fetchImpl || global.fetch.bind(global);
    const composerResults = new Map();
    let composerRequestSequence = 0;

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

      sendTerminalInput(agentId, input) {
        return send({
          type: 'input',
          agentId,
          input,
        });
      },

      sendComposerMessage(agentId, message, attachments = [], options = {}) {
        const requestId = options.onResult
          ? `composer-${Date.now().toString(36)}-${++composerRequestSequence}`
          : '';
        const sent = send({
          type: 'composer-input',
          agentId,
          message,
          ...(requestId ? { requestId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (sent && requestId) composerResults.set(requestId, options.onResult);
        return sent;
      },

      handleServerMessage(message) {
        if (!message || message.type !== 'composer-input-result') return false;
        const callback = composerResults.get(message.requestId);
        if (!callback) return false;
        composerResults.delete(message.requestId);
        callback(message);
        return true;
      },

      rejectPendingComposerMessages(message = 'Connection unavailable') {
        composerResults.forEach(callback => callback({ accepted: false, message }));
        composerResults.clear();
      },

      interruptAgent(agentId) {
        return send({
          type: 'interrupt-agent',
          agentId,
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

      clearTerminal(agentId) {
        return send({
          type: 'clear-terminal',
          agentId,
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
