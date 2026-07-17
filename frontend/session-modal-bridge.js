(function attachSessionModalBridge(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(root);
    return;
  }

  root.FarmingSessionModalBridge = factory(root);
})(
  typeof window !== 'undefined' ? window : globalThis,
  function createSessionModalBridge(root) {
    function createModalState(agent, themeId, themeSettings) {
      const sessionSource = agent && agent.sessionSource ? agent.sessionSource : 'buffer';
      const sessionSkin = root && root.FarmingSkinBridge
        ? root.FarmingSkinBridge.getSessionSkin(themeId, themeSettings)
        : null;

      return {
        agentId: agent ? agent.id : null,
        sessionSource,
        sessionSkin,
        title: agent ? `${agent.command} (${agent.id})` : 'Agent Session'
      };
    }

    function shouldPollSessionView(_sessionSource) {
      return false;
    }

    function getDomState(documentRef) {
      return {
        modal: documentRef.getElementById('session-modal'),
        terminalContainer: documentRef.getElementById('terminal-output'),
        title: documentRef.getElementById('session-title')
      };
    }

    function openShell(documentRef, modalState) {
      const domState = getDomState(documentRef);
      domState.title.textContent = modalState.title;
      domState.terminalContainer.innerHTML = '';

      if (root && root.FarmingSkinBridge) {
        root.FarmingSkinBridge.applySessionSkin(documentRef, modalState.sessionSkin);
      }

      documentRef.body.classList.add('session-open');
      domState.modal.classList.add('active');
      return domState;
    }

    function mountTerminal(documentRef, terminalBundle, options = {}) {
      const domState = getDomState(documentRef);
      const terminalContainer = domState.terminalContainer;
      const terminal = terminalBundle.terminal;
      const fitAddon = terminalBundle.fitAddon;
      const initialOutput = options.initialOutput || '';

      if (fitAddon && terminal.loadAddon) {
        terminal.loadAddon(fitAddon);
      }

      if (terminal.onData && options.onData) {
        terminal.onData(options.onData);
      }

      if (terminal.onResize && options.onResize) {
        terminal.onResize(({ cols, rows }) => {
          options.onResize(cols, rows);
        });
      }

      terminalContainer.innerHTML = '';
      terminal.open(terminalContainer);

      const restoreFocus = () => {
        if (options.hasSelection && options.hasSelection()) {
          return;
        }

        requestAnimationFrame(() => {
          if (options.focusTerminal) {
            options.focusTerminal();
          }
        });
      };

      terminalContainer.onclick = restoreFocus;
      terminalContainer.onwheel = restoreFocus;
      terminalContainer.onmouseup = restoreFocus;
      terminalContainer.ontouchstart = restoreFocus;

      const readyPromise = new Promise((resolve) => {
        requestAnimationFrame(() => {
          if (options.isSessionActive && !options.isSessionActive()) {
            resolve();
            return;
          }

          if (fitAddon && fitAddon.fit && options.authoritativeGeometry !== true) {
            fitAddon.fit();
          }

          if (initialOutput) {
            terminal.write(initialOutput);
          }

          if (options.afterFit) {
            options.afterFit();
          }

          if (terminal.scrollToBottom) {
            terminal.scrollToBottom();
          }

          if (options.focusTerminal) {
            options.focusTerminal();
          }

          resolve();
        });
      });

      return {
        domState,
        terminal,
        fitAddon,
        outputLength: initialOutput.length,
        readyPromise
      };
    }

    function resetTerminalShell(documentRef) {
      const domState = getDomState(documentRef);
      const terminalContainer = domState.terminalContainer;

      terminalContainer.onclick = null;
      terminalContainer.onwheel = null;
      terminalContainer.onmouseup = null;
      terminalContainer.ontouchstart = null;
      terminalContainer.innerHTML = '';

      return domState;
    }

    function createRuntime(options = {}) {
      let focusedAgentId = null;
      let sessionSource = null;
      let lastOutputLength = 0;
      let poller = null;
      let sessionToken = 0;
      let awaitingInitialSync = false;

      function syncPoller() {
        if (options.onPollerChange) {
          options.onPollerChange(poller);
        }
      }

      return {
        getState() {
          return {
            focusedAgentId,
            sessionSource,
            lastOutputLength,
            poller,
            sessionToken,
            awaitingInitialSync
          };
        },

        activate(modalState) {
          sessionToken += 1;
          focusedAgentId = modalState ? modalState.agentId : null;
          sessionSource = modalState ? modalState.sessionSource : null;
          lastOutputLength = 0;
          awaitingInitialSync = Boolean(focusedAgentId);
        },

        deactivate() {
          this.stopPolling();
          sessionToken += 1;
          focusedAgentId = null;
          sessionSource = null;
          lastOutputLength = 0;
          awaitingInitialSync = false;
        },

        syncFromState(state) {
          if (!focusedAgentId || !state || !Array.isArray(state.agents)) {
            return;
          }

          const focusedAgent = state.agents.find((agent) => agent.id === focusedAgentId);
          sessionSource = focusedAgent ? (focusedAgent.sessionSource || 'buffer') : null;
        },

        handleStateMessage(state) {
          this.syncFromState(state);
          return {
            focusedAgentId,
            sessionSource,
            lastOutputLength
          };
        },

        getFocusedAgentId() {
          return focusedAgentId;
        },

        getSessionSource() {
          return sessionSource;
        },

        getLastOutputLength() {
          return lastOutputLength;
        },

        getSessionToken() {
          return sessionToken;
        },

        isAwaitingInitialSync() {
          return awaitingInitialSync;
        },

        isCurrentSession(agentId, token) {
          if (!focusedAgentId || !agentId) {
            return false;
          }
          return focusedAgentId === agentId && sessionToken === token;
        },

        setLastOutputLength(length) {
          lastOutputLength = length;
        },

        prepareInitialOutput(_text) {
          return '';
        },

        markHydrated(nextLength = lastOutputLength) {
          awaitingInitialSync = false;
          lastOutputLength = nextLength;
        },

        open(documentRef, modalState) {
          this.activate(modalState);
          return {
            domState: openShell(documentRef, modalState),
            sessionToken
          };
        },

        close(documentRef) {
          this.deactivate();
          return closeShell(documentRef);
        },

        applyStream(stream) {
          if (!options.deriveSessionStreamPatch) {
            return null;
          }

          if (awaitingInitialSync) {
            return null;
          }

          const patch = options.deriveSessionStreamPatch(stream, focusedAgentId, sessionSource);
          if (patch) {
            lastOutputLength += patch.nextLengthDelta;
          }
          return patch;
        },

        handleStreamMessage(stream) {
          const patch = this.applyStream(stream);
          return {
            patch,
            focusedAgentId,
            sessionSource,
            lastOutputLength
          };
        },

        startPolling(context = {}) {
          this.stopPolling();
          void context;
          return null;
        },

        stopPolling() {
          if (poller && options.clearPoll) {
            options.clearPoll(poller);
          }
          poller = null;
          syncPoller();
        }
      };
    }

    function closeShell(documentRef) {
      const domState = resetTerminalShell(documentRef);
      domState.modal.classList.remove('active');
      documentRef.body.classList.remove('session-open');

      if (root && root.FarmingSkinBridge) {
        root.FarmingSkinBridge.applySessionSkin(documentRef, null);
      }

      return domState;
    }

    return {
      createModalState,
      shouldPollSessionView,
      getDomState,
      openShell,
      mountTerminal,
      resetTerminalShell,
      createRuntime,
      closeShell
    };
  }
);
