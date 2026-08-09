declare const module: { exports: unknown } | undefined;

interface SessionModalAgent {
  id: string;
  command: string;
  sessionSource?: string;
}

interface SessionModalState {
  agentId: string | null;
  sessionSource: string;
  sessionSkin: unknown;
  title: string;
}

interface SessionModalDomState {
  modal: HTMLElement;
  terminalContainer: HTMLElement;
  title: HTMLElement;
}

interface SessionModalTerminal {
  loadAddon?(addon: unknown): void;
  onData?(callback: (data: string) => void): unknown;
  onResize?(callback: (size: { cols: number; rows: number }) => void): unknown;
  open(container: HTMLElement): void;
  write(data: string): void;
  scrollToBottom?(): void;
}

interface SessionModalFitAddon {
  fit?(): void;
}

interface SessionModalMountOptions {
  initialOutput?: string;
  authoritativeGeometry?: boolean;
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  hasSelection?: () => boolean;
  focusTerminal?: () => void;
  isSessionActive?: () => boolean;
  afterFit?: () => void;
}

interface SessionStreamPatch {
  nextLengthDelta: number;
  [key: string]: unknown;
}

interface SessionModalRuntimeOptions {
  deriveSessionStreamPatch?: (
    stream: unknown,
    focusedAgentId: string | null,
    sessionSource: string | null,
  ) => SessionStreamPatch | null;
}

interface SessionModalRuntime {
  getState(): {
    focusedAgentId: string | null;
    sessionSource: string | null;
    lastOutputLength: number;
    sessionToken: number;
    awaitingInitialSync: boolean;
  };
  activate(modalState: SessionModalState | null): void;
  deactivate(): void;
  syncFromState(state: { agents?: SessionModalAgent[] } | null): void;
  handleStateMessage(state: { agents?: SessionModalAgent[] } | null): {
    focusedAgentId: string | null;
    sessionSource: string | null;
    lastOutputLength: number;
  };
  getFocusedAgentId(): string | null;
  getSessionSource(): string | null;
  getLastOutputLength(): number;
  getSessionToken(): number;
  isAwaitingInitialSync(): boolean;
  isCurrentSession(agentId: string | null, token: number): boolean;
  setLastOutputLength(length: number): void;
  prepareInitialOutput(text: string): string;
  markHydrated(nextLength?: number): void;
  open(documentRef: Document, modalState: SessionModalState): {
    domState: SessionModalDomState;
    sessionToken: number;
  };
  close(documentRef: Document): SessionModalDomState;
  applyStream(stream: unknown): SessionStreamPatch | null;
  handleStreamMessage(stream: unknown): {
    patch: SessionStreamPatch | null;
    focusedAgentId: string | null;
    sessionSource: string | null;
    lastOutputLength: number;
  };
}

interface SessionModalBridge {
  createModalState(
    agent: SessionModalAgent | null,
    themeId?: string | null,
    themeSettings?: unknown,
  ): SessionModalState;
  getDomState(documentRef: Document): SessionModalDomState;
  openShell(documentRef: Document, modalState: SessionModalState): SessionModalDomState;
  mountTerminal(
    documentRef: Document,
    terminalBundle: { terminal: SessionModalTerminal; fitAddon?: SessionModalFitAddon | null },
    options?: SessionModalMountOptions,
  ): {
    domState: SessionModalDomState;
    terminal: SessionModalTerminal;
    fitAddon: SessionModalFitAddon | null | undefined;
    outputLength: number;
    readyPromise: Promise<void>;
  };
  resetTerminalShell(documentRef: Document): SessionModalDomState;
  createRuntime(options?: SessionModalRuntimeOptions): SessionModalRuntime;
  closeShell(documentRef: Document): SessionModalDomState;
}

type SessionModalRoot = typeof globalThis & {
  FarmingSkinBridge?: {
    getSessionSkin(themeId?: string | null, themeSettings?: unknown): unknown;
    applySessionSkin(documentRef: Document, skin: unknown): void;
  };
  FarmingSessionModalBridge?: SessionModalBridge;
};

(function attachSessionModalBridge(
  root: SessionModalRoot,
  factory: (root: SessionModalRoot) => SessionModalBridge,
) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(root);
    return;
  }

  root.FarmingSessionModalBridge = factory(root);
})(
  (typeof window !== 'undefined' ? window : globalThis) as unknown as SessionModalRoot,
  function createSessionModalBridge(root) {
    function createModalState(
      agent: SessionModalAgent | null,
      themeId?: string | null,
      themeSettings?: unknown,
    ): SessionModalState {
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

    function getDomState(documentRef: Document): SessionModalDomState {
      return {
        modal: documentRef.getElementById('session-modal') as HTMLElement,
        terminalContainer: documentRef.getElementById('terminal-output') as HTMLElement,
        title: documentRef.getElementById('session-title') as HTMLElement,
      };
    }

    function openShell(documentRef: Document, modalState: SessionModalState) {
      const domState = getDomState(documentRef);
      domState.title.textContent = modalState.title;
      domState.terminalContainer.innerHTML = '';

      root.FarmingSkinBridge?.applySessionSkin(documentRef, modalState.sessionSkin);
      documentRef.body.classList.add('session-open');
      domState.modal.classList.add('active');
      return domState;
    }

    function mountTerminal(
      documentRef: Document,
      terminalBundle: { terminal: SessionModalTerminal; fitAddon?: SessionModalFitAddon | null },
      options: SessionModalMountOptions = {},
    ) {
      const domState = getDomState(documentRef);
      const terminalContainer = domState.terminalContainer;
      const terminal = terminalBundle.terminal;
      const fitAddon = terminalBundle.fitAddon;
      const initialOutput = options.initialOutput || '';

      if (fitAddon && terminal.loadAddon) terminal.loadAddon(fitAddon);
      if (terminal.onData && options.onData) terminal.onData(options.onData);
      if (terminal.onResize && options.onResize) {
        terminal.onResize(({ cols, rows }) => options.onResize?.(cols, rows));
      }

      terminalContainer.innerHTML = '';
      terminal.open(terminalContainer);

      const restoreFocus = () => {
        if (options.hasSelection?.()) return;
        requestAnimationFrame(() => options.focusTerminal?.());
      };

      terminalContainer.onclick = restoreFocus;
      terminalContainer.onwheel = restoreFocus;
      terminalContainer.onmouseup = restoreFocus;
      terminalContainer.ontouchstart = restoreFocus;

      const readyPromise = new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          if (options.isSessionActive && !options.isSessionActive()) {
            resolve();
            return;
          }

          if (fitAddon?.fit && options.authoritativeGeometry !== true) fitAddon.fit();
          if (initialOutput) terminal.write(initialOutput);
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

    function resetTerminalShell(documentRef: Document) {
      const domState = getDomState(documentRef);
      const terminalContainer = domState.terminalContainer;
      terminalContainer.onclick = null;
      terminalContainer.onwheel = null;
      terminalContainer.onmouseup = null;
      terminalContainer.ontouchstart = null;
      terminalContainer.innerHTML = '';
      return domState;
    }

    function createRuntime(options: SessionModalRuntimeOptions = {}): SessionModalRuntime {
      let focusedAgentId: string | null = null;
      let sessionSource: string | null = null;
      let lastOutputLength = 0;
      let sessionToken = 0;
      let awaitingInitialSync = false;

      const runtime: SessionModalRuntime = {
        getState: () => ({
          focusedAgentId,
          sessionSource,
          lastOutputLength,
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
          sessionToken += 1;
          focusedAgentId = null;
          sessionSource = null;
          lastOutputLength = 0;
          awaitingInitialSync = false;
        },

        syncFromState(state) {
          if (!focusedAgentId || !state || !Array.isArray(state.agents)) return;
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
        isCurrentSession: (agentId, token) => Boolean(
          focusedAgentId && agentId && focusedAgentId === agentId && sessionToken === token,
        ),
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
          if (!options.deriveSessionStreamPatch || awaitingInitialSync) return null;
          const patch = options.deriveSessionStreamPatch(stream, focusedAgentId, sessionSource);
          if (patch) lastOutputLength += patch.nextLengthDelta;
          return patch;
        },
        handleStreamMessage(stream) {
          const patch = runtime.applyStream(stream);
          return { patch, focusedAgentId, sessionSource, lastOutputLength };
        },
      };

      return runtime;
    }

    function closeShell(documentRef: Document) {
      const domState = resetTerminalShell(documentRef);
      domState.modal.classList.remove('active');
      documentRef.body.classList.remove('session-open');
      root.FarmingSkinBridge?.applySessionSkin(documentRef, null);
      return domState;
    }

    return {
      createModalState,
      getDomState,
      openShell,
      mountTerminal,
      resetTerminalShell,
      createRuntime,
      closeShell,
    };
  },
);
