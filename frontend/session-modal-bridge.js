// Generated from TypeScript. Do not edit.
"use strict";
(function attachSessionModalBridge(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(root);
        return;
    }
    root.FarmingSessionModalBridge = factory(root);
})((typeof window !== 'undefined' ? window : globalThis), function createSessionModalBridge(root) {
    function createModalState(agent, themeId, themeSettings) {
        const sessionSource = agent?.sessionSource || 'buffer';
        const sessionSkin = root.FarmingSkinBridge
            ? root.FarmingSkinBridge.getSessionSkin(themeId, themeSettings)
            : null;
        return {
            agentId: agent ? agent.id : null,
            sessionSource,
            sessionSkin,
            title: agent ? `${agent.command} (${agent.id})` : 'Agent Session',
        };
    }
    function shouldPollSessionView(_sessionSource) {
        return false;
    }
    function getDomState(documentRef) {
        return {
            modal: documentRef.getElementById('session-modal'),
            terminalContainer: documentRef.getElementById('terminal-output'),
            title: documentRef.getElementById('session-title'),
        };
    }
    function openShell(documentRef, modalState) {
        const domState = getDomState(documentRef);
        domState.title.textContent = modalState.title;
        domState.terminalContainer.innerHTML = '';
        root.FarmingSkinBridge?.applySessionSkin(documentRef, modalState.sessionSkin);
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
        if (fitAddon && terminal.loadAddon)
            terminal.loadAddon(fitAddon);
        if (terminal.onData && options.onData)
            terminal.onData(options.onData);
        if (terminal.onResize && options.onResize) {
            terminal.onResize(({ cols, rows }) => options.onResize?.(cols, rows));
        }
        terminalContainer.innerHTML = '';
        terminal.open(terminalContainer);
        const restoreFocus = () => {
            if (options.hasSelection?.())
                return;
            requestAnimationFrame(() => options.focusTerminal?.());
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
                if (fitAddon?.fit && options.authoritativeGeometry !== true)
                    fitAddon.fit();
                if (initialOutput)
                    terminal.write(initialOutput);
                options.afterFit?.();
                terminal.scrollToBottom?.();
                options.focusTerminal?.();
                resolve();
            });
        });
        return {
            domState,
            terminal,
            fitAddon,
            outputLength: initialOutput.length,
            readyPromise,
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
            options.onPollerChange?.(poller);
        }
        const runtime = {
            getState: () => ({
                focusedAgentId,
                sessionSource,
                lastOutputLength,
                poller,
                sessionToken,
                awaitingInitialSync,
            }),
            activate(modalState) {
                sessionToken += 1;
                focusedAgentId = modalState?.agentId || null;
                sessionSource = modalState?.sessionSource || null;
                lastOutputLength = 0;
                awaitingInitialSync = Boolean(focusedAgentId);
            },
            deactivate() {
                runtime.stopPolling();
                sessionToken += 1;
                focusedAgentId = null;
                sessionSource = null;
                lastOutputLength = 0;
                awaitingInitialSync = false;
            },
            syncFromState(state) {
                if (!focusedAgentId || !state || !Array.isArray(state.agents))
                    return;
                const focusedAgent = state.agents.find(agent => agent.id === focusedAgentId);
                sessionSource = focusedAgent ? (focusedAgent.sessionSource || 'buffer') : null;
            },
            handleStateMessage(state) {
                runtime.syncFromState(state);
                return { focusedAgentId, sessionSource, lastOutputLength };
            },
            getFocusedAgentId: () => focusedAgentId,
            getSessionSource: () => sessionSource,
            getLastOutputLength: () => lastOutputLength,
            getSessionToken: () => sessionToken,
            isAwaitingInitialSync: () => awaitingInitialSync,
            isCurrentSession: (agentId, token) => Boolean(focusedAgentId && agentId && focusedAgentId === agentId && sessionToken === token),
            setLastOutputLength: (length) => { lastOutputLength = length; },
            prepareInitialOutput: (_text) => '',
            markHydrated(nextLength = lastOutputLength) {
                awaitingInitialSync = false;
                lastOutputLength = nextLength;
            },
            open(documentRef, modalState) {
                runtime.activate(modalState);
                return { domState: openShell(documentRef, modalState), sessionToken };
            },
            close(documentRef) {
                runtime.deactivate();
                return closeShell(documentRef);
            },
            applyStream(stream) {
                if (!options.deriveSessionStreamPatch || awaitingInitialSync)
                    return null;
                const patch = options.deriveSessionStreamPatch(stream, focusedAgentId, sessionSource);
                if (patch)
                    lastOutputLength += patch.nextLengthDelta;
                return patch;
            },
            handleStreamMessage(stream) {
                const patch = runtime.applyStream(stream);
                return { patch, focusedAgentId, sessionSource, lastOutputLength };
            },
            startPolling(context = {}) {
                runtime.stopPolling();
                void context;
                return null;
            },
            stopPolling() {
                if (poller && options.clearPoll)
                    options.clearPoll(poller);
                poller = null;
                syncPoller();
            },
        };
        return runtime;
    }
    function closeShell(documentRef) {
        const domState = resetTerminalShell(documentRef);
        domState.modal.classList.remove('active');
        documentRef.body.classList.remove('session-open');
        root.FarmingSkinBridge?.applySessionSkin(documentRef, null);
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
        closeShell,
    };
});
