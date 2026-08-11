const assert = require('assert');

const sessionModalBridge = require('../../frontend/session-modal-bridge.js');

interface FakeClassList {
  values: Set<string>;
  add(name: string): void;
  remove(name: string): void;
  contains(name: string): boolean;
}

interface FakeElement {
  textContent: string;
  classList: FakeClassList;
  onclick: ((event?: unknown) => unknown) | null;
  onwheel: ((event?: unknown) => unknown) | null;
  onmouseup: ((event?: unknown) => unknown) | null;
  ontouchstart: ((event?: unknown) => unknown) | null;
}

function createFakeElement(): FakeElement {
  return {
    textContent: '',
    onclick: null,
    onwheel: null,
    onmouseup: null,
    ontouchstart: null,
    classList: {
      values: new Set(),
      add(name) {
        this.values.add(name);
      },
      remove(name) {
        this.values.delete(name);
      },
      contains(name) {
        return this.values.has(name);
      }
    }
  };
}

function run() {
  const originalRequestAnimationFrame = global.requestAnimationFrame;
  global.requestAnimationFrame = callback => {
    callback(0);
    return 0;
  };

  assert(sessionModalBridge, 'session modal bridge should be loadable');
  assert.strictEqual(typeof sessionModalBridge.createModalState, 'function');
  assert.strictEqual(typeof sessionModalBridge.openShell, 'function');
  assert.strictEqual(typeof sessionModalBridge.mountTerminal, 'function');
  assert.strictEqual(typeof sessionModalBridge.resetTerminalShell, 'function');
  assert.strictEqual(typeof sessionModalBridge.createRuntime, 'function');
  assert.strictEqual(typeof sessionModalBridge.closeShell, 'function');
  const modalState = sessionModalBridge.createModalState(
    { id: 'agent-1', command: 'claude', sessionSource: 'live-text' },
    'terminal',
    { crtEffects: false }
  );
  assert.strictEqual(modalState.title, 'claude (agent-1)');
  assert.strictEqual(modalState.sessionSource, 'live-text');

  const modal = createFakeElement();
  const terminalContainer = createFakeElement();
  const title = createFakeElement();
  const bodyClassList = createFakeElement().classList;
  const documentRef = {
    body: {
      classList: bodyClassList
    },
    getElementById(id) {
      if (id === 'session-modal') return modal;
      if (id === 'terminal-output') return terminalContainer;
      if (id === 'session-title') return title;
      return null;
    }
  };

  const domState = sessionModalBridge.openShell(documentRef, modalState);
  assert.strictEqual(domState.modal, modal);
  assert.strictEqual(title.textContent, 'claude (agent-1)');
  assert.strictEqual(modal.classList.contains('active'), true);
  assert.strictEqual(bodyClassList.contains('session-open'), true);

  let fitCalls = 0;
  let dataHandler = null;
  let resizeHandler = null;
  let focusCalls = 0;
  const fakeTerminal: {
    addon?: unknown;
    container?: FakeElement;
    cleared?: boolean;
    written?: string;
    scrolled?: boolean;
    loadAddon(addon: unknown): void;
    onData(handler: (data: string) => void): void;
    onResize(handler: (size: unknown) => void): void;
    open(container: FakeElement): void;
    clear(): void;
    write(text: string): void;
    scrollToBottom(): void;
  } = {
    loadAddon(addon) {
      this.addon = addon;
    },
    onData(handler) {
      dataHandler = handler;
    },
    onResize(handler) {
      resizeHandler = handler;
    },
    open(container) {
      this.container = container;
    },
    clear() {
      this.cleared = true;
    },
    write(text) {
      this.written = text;
    },
    scrollToBottom() {
      this.scrolled = true;
    }
  };
  const fakeFitAddon = {
    fit() {
      fitCalls += 1;
    }
  };

  const mounted = sessionModalBridge.mountTerminal(documentRef, {
    terminal: fakeTerminal,
    fitAddon: fakeFitAddon
  }, {
    initialOutput: 'hello world',
    onData: () => {},
    onResize: () => {},
    hasSelection: () => false,
    focusTerminal: () => {
      focusCalls += 1;
    },
    isSessionActive: () => true,
    afterFit: () => {}
  });

  assert.strictEqual(mounted.outputLength, 11);
  assert.strictEqual(fakeTerminal.container, terminalContainer);
  assert.strictEqual(fakeTerminal.written, 'hello world');
  assert.strictEqual(fakeTerminal.cleared, undefined);
  assert.strictEqual(typeof dataHandler, 'function');
  assert.strictEqual(typeof resizeHandler, 'function');
  assert.strictEqual(fitCalls > 0, true);
  assert.strictEqual(focusCalls > 0, true);
  assert.strictEqual(typeof terminalContainer.onclick, 'function');

  sessionModalBridge.resetTerminalShell(documentRef);
  assert.strictEqual(terminalContainer.onclick, null);
  assert.strictEqual(terminalContainer.onwheel, null);
  assert.strictEqual(terminalContainer.onmouseup, null);
  assert.strictEqual(terminalContainer.ontouchstart, null);

  const runtime = sessionModalBridge.createRuntime({
    deriveSessionStreamPatch(stream, focusedAgentId, sessionSource) {
      if (stream.agentId !== focusedAgentId || sessionSource !== 'live-text') {
        return null;
      }
      return {
        text: stream.data,
        nextLengthDelta: stream.data.length
      };
    }
  });

  runtime.activate(modalState);
  assert.strictEqual(runtime.getFocusedAgentId(), 'agent-1');
  assert.strictEqual(runtime.getSessionSource(), 'live-text');
  assert.strictEqual(runtime.getLastOutputLength(), 0);
  const initialToken = runtime.getSessionToken();
  assert.deepStrictEqual(runtime.getState(), {
    focusedAgentId: 'agent-1',
    sessionSource: 'live-text',
    lastOutputLength: 0,
    sessionToken: initialToken,
    awaitingInitialSync: true
  });
  assert.strictEqual(runtime.isCurrentSession('agent-1', initialToken), true);
  assert.strictEqual(runtime.isCurrentSession('agent-1', initialToken + 1), false);
  assert.strictEqual(runtime.isAwaitingInitialSync(), true);
  assert.strictEqual(runtime.prepareInitialOutput('seed output'), '');

  const patch = runtime.applyStream({ agentId: 'agent-1', data: 'abc' });
  assert.strictEqual(patch, null);
  assert.strictEqual(runtime.getLastOutputLength(), 0);

  runtime.markHydrated(3);
  assert.strictEqual(runtime.isAwaitingInitialSync(), false);

  const hydratedPatch = runtime.applyStream({ agentId: 'agent-1', data: 'abc' });
  assert.deepStrictEqual(hydratedPatch, { text: 'abc', nextLengthDelta: 3 });
  assert.strictEqual(runtime.getLastOutputLength(), 6);

  assert.deepStrictEqual(
    runtime.handleStateMessage({
      agents: [
        { id: 'agent-1', sessionSource: 'buffer' }
      ]
    }),
    {
      focusedAgentId: 'agent-1',
      sessionSource: 'buffer',
      lastOutputLength: 6
    }
  );

  assert.deepStrictEqual(
    runtime.handleStreamMessage({ agentId: 'agent-1', data: 'xy' }),
    {
      patch: null,
      focusedAgentId: 'agent-1',
      sessionSource: 'buffer',
      lastOutputLength: 6
    }
  );

  runtime.setLastOutputLength(8);
  assert.strictEqual(runtime.getLastOutputLength(), 8);

  runtime.close(documentRef);
  assert.strictEqual(runtime.getFocusedAgentId(), null);
  assert.strictEqual(runtime.getSessionSource(), null);
  assert.strictEqual(runtime.getLastOutputLength(), 0);
  assert.strictEqual(runtime.getSessionToken() > initialToken, true);
  assert.strictEqual(modal.classList.contains('active'), false);
  assert.strictEqual(bodyClassList.contains('session-open'), false);

  const reopenResult = runtime.open(documentRef, modalState);
  assert.strictEqual(reopenResult.sessionToken, runtime.getSessionToken());
  assert.strictEqual(runtime.getFocusedAgentId(), 'agent-1');
  assert.strictEqual(runtime.isAwaitingInitialSync(), true);
  assert.strictEqual(modal.classList.contains('active'), true);
  assert.strictEqual(bodyClassList.contains('session-open'), true);

  runtime.deactivate();
  assert.strictEqual(runtime.getFocusedAgentId(), null);
  assert.strictEqual(runtime.getSessionSource(), null);
  assert.strictEqual(runtime.getLastOutputLength(), 0);

  sessionModalBridge.closeShell(documentRef);
  assert.strictEqual(modal.classList.contains('active'), false);
  assert.strictEqual(bodyClassList.contains('session-open'), false);

  global.requestAnimationFrame = originalRequestAnimationFrame;

  console.log('test-session-modal-bridge-files passed');
}

run();
