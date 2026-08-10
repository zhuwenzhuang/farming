const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  TerminalLinkInteractionController,
  TERMINAL_OPEN_ACTIVATION_FENCE_MS,
  TERMINAL_PATH_RESOLVE_CACHE_TTL_MS,
  createTerminalLinkHandlersCommitLatch,
  createTerminalLinkHandlersRevisionTracker,
} = importTsModule('src/lib/terminal-link-interaction.ts');

const { TerminalSessionRegistry } = importTsModule('src/lib/terminal-session-registry.ts');

const CELL_WIDTH = 10;
const CELL_HEIGHT = 20;
const WORKSPACE_PATH_LINE = 'src/lib/terminal-links.ts:12:5 failed to link';
const ESCAPED_PATH_LINE = '../../../etc/shadow:3:1 failed to link';
const URL_LINE = 'see https://example.test/docs for details';

// A candidate is only openable when it resolves inside the captured
// workspace. An escaped path stays plain text.
function resolveWorkspacePath(target, workspace) {
  const root = workspace === 'b' ? '/workspace-b/' : '/workspace/';
  if (target.path.startsWith(root)) return target;
  if (target.path.startsWith('..') || target.path.startsWith('/')) return null;
  return { ...target, path: `${root}${target.path}` };
}

interface TestCommittedLinkHandlersRef {
  current: {
    onPathOpen?: (agentId, target) => void;
    onPathResolve?: (agentId, target) => unknown;
    onSearchOpen?: (agentId, query) => void;
  };
}

// The hook hands the pool one stable wrapper per link handler, so the wrapper
// identity can never report a replacement; only what `current` holds decides
// which resolver and opener a call reaches.
function createCommittedLinkWrappers(ref: TestCommittedLinkHandlersRef) {
  return {
    onPathOpen: (agentId, target) => ref.current.onPathOpen?.(agentId, target),
    onPathResolve: (agentId, target) => ref.current.onPathResolve?.(agentId, target) ?? null,
    onSearchOpen: (agentId, query) => ref.current.onSearchOpen?.(agentId, query),
  };
}

function flush() {
  return new Promise(resolve => setImmediate(resolve));
}

function createTarget() {
  const registered = [];
  return {
    registered,
    addEventListener(type, listener, capture) {
      registered.push({ type, listener, capture });
    },
    removeEventListener(type, listener, capture) {
      const index = registered.findIndex(entry => (
        entry.type === type && entry.listener === listener && entry.capture === capture
      ));
      if (index >= 0) registered.splice(index, 1);
    },
    dispatch(type, event) {
      for (const entry of [...registered]) {
        if (entry.type === type) entry.listener({ type, ...event });
      }
    },
  };
}

function createEvent(overrides = {}) {
  const event = {
    button: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() { event.propagationStopped = true; },
    stopImmediatePropagation() { event.propagationStopped = true; },
    ...overrides,
  };
  return event;
}

function createFixture(options: {
  lines?: string[];
  withLinkProvider?: boolean;
  withSearchOpen?: boolean;
  deferResolve?: boolean;
  withoutPathResolve?: boolean;
  throwingResolve?: boolean;
  linkHandlersRef?: TestCommittedLinkHandlersRef;
  installedLinkWrappers?: { current: ReturnType<typeof createCommittedLinkWrappers> | null };
} = {}) {
  const lines = options.lines ?? [WORKSPACE_PATH_LINE];
  const classes = new Set();
  const hostTarget = createTarget();
  const windowTarget = createTarget();
  const state = {
    now: 1_000,
    attached: true,
    generation: 1,
    revision: 0,
    mobile: false,
    workspace: 'a',
  };
  const opened = { paths: [], urls: [], searches: [], focusInputCount: 0, clearSelectionCount: 0 };
  const resolveCalls = [];
  const provider = { current: null, disposeCount: 0 };
  const pendingQueue = [];
  let pendingResolve = null;

  const hostEl = {
    classList: {
      toggle(token, force) {
        if (force) classes.add(token);
        else classes.delete(token);
      },
    },
    dataset: {} as Record<string, string | undefined>,
    title: '',
    removeAttribute(name) {
      if (name === 'title') hostEl.title = '';
    },
    contains: () => true,
    addEventListener: hostTarget.addEventListener,
    removeEventListener: hostTarget.removeEventListener,
  };

  // A record installs exactly one owner's wrappers at a time. The slot models
  // `record.pathOpenHandler`/`pathResolveHandler`/`searchOpenHandler`, which only
  // an attach replaces.
  const installedLinkWrappers = options.installedLinkWrappers ?? null;
  const linkHandlersRef = options.linkHandlersRef;
  const committedLinkWrappers = linkHandlersRef ? createCommittedLinkWrappers(linkHandlersRef) : null;

  const controller = new TerminalLinkInteractionController({
    agentId: 'agent-1',
    hostEl,
    windowTarget,
    isXterm: true,
    registerLinkProvider: options.withLinkProvider
      ? registered => {
        provider.current = registered;
        return { dispose: () => { provider.disposeCount += 1; } };
      }
      : null,
    now: () => state.now,
    isMacPlatform: () => true,
    language: () => 'en',
    isMobileViewport: () => state.mobile,
    isAttached: () => state.attached,
    attachmentOperation: () => ({ generation: state.generation, revision: state.revision }),
    isCurrentAttachmentOperation: operation => (
      state.attached
      && state.generation === operation.generation
      && state.revision === operation.revision
    ),
    cellFromEvent: event => ({
      col: Math.floor(event.clientX / CELL_WIDTH),
      row: Math.floor(event.clientY / CELL_HEIGHT),
    }),
    cellMetrics: () => ({ width: CELL_WIDTH, height: CELL_HEIGHT }),
    elementFromPoint: () => null,
    logicalLineAtCell: cell => (
      lines[cell.row] === undefined
        ? null
        : { text: lines[cell.row], col: cell.col, startRow: cell.row, cols: 80 }
    ),
    logicalLineAtBufferRow: bufferRow => (
      lines[bufferRow] === undefined
        ? null
        : { text: lines[bufferRow], col: 0, startRow: bufferRow, cols: 80 }
    ),
    previousLogicalLines: beforeBufferRow => lines.slice(0, beforeBufferRow).reverse(),
    pathOpenHandler: () => {
      if (installedLinkWrappers) return installedLinkWrappers.current?.onPathOpen ?? null;
      if (committedLinkWrappers) return committedLinkWrappers.onPathOpen;
      const workspace = state.workspace;
      return (agentId, target) => opened.paths.push({ agentId, target, workspace });
    },
    pathResolveHandler: () => {
      if (installedLinkWrappers) return installedLinkWrappers.current?.onPathResolve ?? null;
      if (committedLinkWrappers) return committedLinkWrappers.onPathResolve;
      if (options.withoutPathResolve) return null;
      const workspace = state.workspace;
      return (agentId, target) => {
        resolveCalls.push({ path: target.path, workspace });
        if (options.throwingResolve) throw new Error('resolver unavailable');
        if (options.deferResolve) {
          return new Promise(resolve => {
            pendingResolve = () => resolve(resolveWorkspacePath(target, workspace));
            pendingQueue.push(pendingResolve);
          });
        }
        return resolveWorkspacePath(target, workspace);
      };
    },
    searchOpenHandler: () => {
      if (installedLinkWrappers) return installedLinkWrappers.current?.onSearchOpen ?? null;
      if (committedLinkWrappers) return committedLinkWrappers.onSearchOpen;
      return options.withSearchOpen
        ? (agentId, query) => opened.searches.push({ agentId, query })
        : null;
    },
    openUrl: url => opened.urls.push(url),
    clearSelection: () => { opened.clearSelectionCount += 1; },
    focusInput: () => { opened.focusInputCount += 1; },
  });

  controller.install();
  return {
    controller,
    hostEl,
    hostTarget,
    windowTarget,
    state,
    opened,
    provider,
    resolveCalls,
    classes,
    resolvePending: () => {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve?.();
    },
    resolveQueued: index => {
      const resolve = pendingQueue[index];
      if (resolve === pendingResolve) pendingResolve = null;
      resolve?.();
    },
  };
}

async function testStaleResolverAfterDetach() {
  const fixture = createFixture({ deferResolve: true });
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-hover'), false,
    'hover decoration waits for the authoritative resolution');

  fixture.state.attached = false;
  fixture.state.generation = 2;
  fixture.resolvePending();
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-hover'), false,
    'a hover resolution that outlived its attachment cannot decorate the parked host');
  assert.strictEqual(fixture.hostEl.dataset.terminalOpenTarget, undefined);

  fixture.state.attached = true;
  assert.strictEqual(
    fixture.controller.resolvedPathLinkAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'a stale completion cannot commit a resolved candidate for the new generation',
  );
}

async function testStaleResolverAfterAttachmentOperationAdvances() {
  const fixture = createFixture({ deferResolve: true });
  const pending = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();

  fixture.state.revision += 1;
  fixture.resolvePending();

  assert.strictEqual(await pending, null,
    'a resolver from an older operation cannot commit after same-generation recovery advances');
  assert.strictEqual(
    fixture.controller.resolvedPathLinkAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'the stale operation does not populate the current attachment cache',
  );
}

async function testHoverCommitsForTheLatestHoverIdentity() {
  const fixture = createFixture({
    deferResolve: true,
    lines: [WORKSPACE_PATH_LINE, 'plain output line'],
  });
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 5 }));
  await flush();
  const stalePathHover = fixture.resolvePending;
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 15, clientY: 25 }));
  await flush();
  stalePathHover();
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-path'), false,
    'a superseded hover resolution cannot decorate the cell the pointer already left');

  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 5 }));
  await flush();
  fixture.resolvePending();
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-path'), true);
  assert.strictEqual(fixture.hostEl.dataset.terminalOpenTarget, 'path');
  assert.strictEqual(fixture.hostEl.title, 'Click to open file or folder');

  fixture.hostTarget.dispatch('mouseleave', createEvent());
  assert.strictEqual(fixture.classes.has('terminal-open-target-path'), false);
  assert.strictEqual(fixture.hostEl.title, '');
}

async function testModifierChangeDrivesUrlHover() {
  const fixture = createFixture({ lines: [URL_LINE] });
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 65, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-url'), false,
    'a URL is only an open target while the modifier is held');

  fixture.windowTarget.dispatch('keydown', { key: 'Meta', metaKey: true });
  assert.strictEqual(fixture.classes.has('terminal-open-target-url'), true);
  assert.strictEqual(fixture.hostEl.title, 'Cmd-click to open link');

  fixture.windowTarget.dispatch('keyup', { key: 'Meta', metaKey: false });
  assert.strictEqual(fixture.classes.has('terminal-open-target-url'), false);

  fixture.windowTarget.dispatch('keydown', { key: 'Meta', metaKey: true });
  assert.strictEqual(fixture.classes.has('terminal-open-target-url'), true);
  fixture.state.attached = false;
  fixture.windowTarget.dispatch('keydown', { key: 'Meta', metaKey: true });
  assert.strictEqual(fixture.classes.has('terminal-open-target-url'), false,
    'a detached terminal drops its hover decoration and modifier state');
}

async function testExactOpenClick() {
  const fixture = createFixture();
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 117, clientY: 6 }));
  await flush();
  assert.deepStrictEqual(
    fixture.opened.paths.map(entry => entry.target.path),
    ['/workspace/src/lib/terminal-links.ts'],
    'an exact click opens the resolved workspace target',
  );
  assert.strictEqual(fixture.opened.paths[0].target.lineNumber, 12);
  assert.strictEqual(fixture.controller.isActivationSuppressed, true);

  const suppressedClick = createEvent({ clientX: 117, clientY: 6 });
  fixture.hostTarget.dispatch('click', suppressedClick);
  await flush();
  assert.strictEqual(suppressedClick.defaultPrevented, true);
  assert.strictEqual(fixture.opened.paths.length, 1, 'the activation fence opens the target exactly once');

  fixture.state.now += TERMINAL_OPEN_ACTIVATION_FENCE_MS;
  assert.strictEqual(fixture.controller.isActivationSuppressed, false);
  assert.strictEqual(fixture.resolveCalls.length, 1, 'the lexical candidate is resolved once per attachment');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'a committed resolution is synchronous evidence of an openable target',
  );
  fixture.hostTarget.dispatch('click', createEvent({ clientX: 117, clientY: 6 }));
  await flush();
  assert.deepStrictEqual(
    fixture.opened.paths.map(entry => entry.target.path),
    ['/workspace/src/lib/terminal-links.ts', '/workspace/src/lib/terminal-links.ts'],
    'a later click reuses the committed resolution',
  );

  fixture.state.now += TERMINAL_PATH_RESOLVE_CACHE_TTL_MS + 1;
  assert.strictEqual(
    fixture.controller.resolvedPathLinkAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'an expired resolution is not evidence of a current openable target',
  );
}

async function testDraggedClickAndDetachBetweenMouseDownAndMouseUp() {
  const dragged = createFixture();
  dragged.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  dragged.hostTarget.dispatch('mouseup', createEvent({ clientX: 160, clientY: 5 }));
  await flush();
  assert.strictEqual(dragged.opened.paths.length, 0, 'a drag across a path selects text instead of opening it');
  assert.strictEqual(dragged.controller.isActivationSuppressed, true);

  const detached = createFixture();
  detached.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  detached.state.generation = 2;
  detached.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(detached.opened.paths.length, 0,
    'a mousedown from a previous attachment cannot open a file after reattachment');
}

async function testEscapedPathStaysPlainText() {
  const fixture = createFixture({ lines: [ESCAPED_PATH_LINE] });
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.opened.paths.length, 0,
    'a path that escapes the captured workspace stays plain text');
  assert.strictEqual(fixture.opened.focusInputCount, 1,
    'an unresolved candidate returns focus to the terminal input');

  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.classes.has('terminal-open-target-hover'), false);
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
  );
}

async function testResetAndDispose() {
  const fixture = createFixture();
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.resolveCalls.length, 1);

  fixture.controller.reset();
  assert.strictEqual(fixture.controller.isActivationSuppressed, false,
    'reset drops the activation fence with the rest of the transient interaction state');
  assert.strictEqual(fixture.classes.size, 0);
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.resolveCalls.length, 2,
    'reset clears the resolved-path cache so the next attachment resolves again');

  const openedBeforeDispose = fixture.opened.paths.length;
  assert.strictEqual(fixture.controller.dispose(), true);
  assert.strictEqual(fixture.controller.dispose(), false, 'dispose is terminal and idempotent');
  assert.strictEqual(fixture.hostTarget.registered.length, 0, 'dispose removes every host listener it added');
  assert.strictEqual(fixture.windowTarget.registered.length, 0, 'dispose removes every window listener it added');
  assert.strictEqual(fixture.controller.install(), false, 'a disposed controller cannot reinstall');
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.opened.paths.length, openedBeforeDispose);
  assert.strictEqual(await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }), null,
    'a disposed controller resolves nothing');
}

async function testModifierClickOpensUrlAndSearch() {
  const fixture = createFixture({ lines: [URL_LINE], withSearchOpen: true });
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 65, clientY: 5, metaKey: true }));
  await flush();
  assert.deepStrictEqual(fixture.opened.urls, ['https://example.test/docs']);
  assert.strictEqual(fixture.controller.isActivationSuppressed, true);

  fixture.state.now += TERMINAL_OPEN_ACTIVATION_FENCE_MS;
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 5, clientY: 5, metaKey: true }));
  await flush();
  assert.deepStrictEqual(fixture.opened.searches.map(entry => entry.query), ['see']);
}

async function provideLinks(fixture, bufferLineNumber) {
  let links;
  fixture.provider.current.provideLinks(bufferLineNumber, provided => { links = provided; });
  await flush();
  return links;
}

async function testLinkProviderLinks() {
  const pathFixture = createFixture({ withLinkProvider: true });
  const pathLinks = await provideLinks(pathFixture, 1);
  assert.strictEqual(pathLinks.length, 1);
  assert.strictEqual(pathLinks[0].text, 'src/lib/terminal-links.ts:12:5');
  assert.deepStrictEqual(pathLinks[0].decorations, { pointerCursor: true, underline: true },
    'a resolved workspace path is a plain-click open target');
  pathLinks[0].activate(createEvent({ clientX: 115, clientY: 5 }));
  assert.deepStrictEqual(
    pathFixture.opened.paths.map(entry => entry.target.path),
    ['/workspace/src/lib/terminal-links.ts'],
  );
  assert.strictEqual(pathFixture.controller.dispose(), true);
  assert.strictEqual(pathFixture.provider.disposeCount, 1, 'dispose releases the registered link provider');

  const urlFixture = createFixture({ lines: [URL_LINE], withLinkProvider: true });
  const urlLinks = await provideLinks(urlFixture, 1);
  assert.deepStrictEqual(urlLinks.map(link => link.text), ['https://example.test/docs']);
  assert.deepStrictEqual(urlLinks[0].decorations, { pointerCursor: false, underline: true });
  urlLinks[0].activate(createEvent({ clientX: 65, clientY: 5 }));
  assert.deepStrictEqual(urlFixture.opened.urls, [], 'a URL needs the modifier to be an open target');
  urlLinks[0].activate(createEvent({ clientX: 65, clientY: 5, metaKey: true }));
  assert.deepStrictEqual(urlFixture.opened.urls, ['https://example.test/docs']);
  urlLinks[0].activate(createEvent({ clientX: 65, clientY: 5, metaKey: true }));
  assert.deepStrictEqual(urlFixture.opened.urls, ['https://example.test/docs'],
    'the activation fence opens the link exactly once');

  const staleFixture = createFixture({ withLinkProvider: true, deferResolve: true });
  let staleLinks = 'pending';
  staleFixture.provider.current.provideLinks(1, provided => { staleLinks = provided; });
  await flush();
  staleFixture.state.generation = 2;
  staleFixture.resolvePending();
  await flush();
  assert.strictEqual(staleLinks, undefined,
    'a link resolution that outlived its attachment provides no links');
}

async function testLateResolveAfterReset() {
  const fixture = createFixture({ deferResolve: true });
  const pending = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();

  fixture.controller.reset();
  fixture.resolvePending();
  assert.strictEqual(await pending, null,
    'a resolution that lands after reset belongs to a revision this owner no longer holds');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'a post-reset resolution cannot repopulate the cleared resolve cache',
  );
}

async function testSupersededResolvePromise() {
  const fixture = createFixture({ deferResolve: true });
  const superseded = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();

  // The expired entry makes the next request start its own resolution for the
  // same candidate under the same fence.
  fixture.state.now += TERMINAL_PATH_RESOLVE_CACHE_TTL_MS + 1;
  const current = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();
  assert.strictEqual(fixture.resolveCalls.length, 2);

  fixture.resolveQueued(1);
  assert.strictEqual((await current)?.path, '/workspace/src/lib/terminal-links.ts',
    'the resolution the cache still tracks commits');
  fixture.resolveQueued(0);
  assert.strictEqual(await superseded, null,
    'a superseded resolution is not evidence for its own caller either');
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'the superseded completion cannot overwrite the committed resolution',
  );
  assert.strictEqual(fixture.resolveCalls.length, 2, 'the committed resolution is reused');
}

async function testConcurrentResolveConsumersShareTheCommittedResult() {
  const fixture = createFixture({ deferResolve: true });
  const providerResolution = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  const clickResolution = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();
  assert.strictEqual(fixture.resolveCalls.length, 1, 'concurrent consumers coalesce onto one resolver call');

  fixture.resolvePending();
  const [providerTarget, clickTarget] = await Promise.all([providerResolution, clickResolution]);
  assert.strictEqual(providerTarget?.path, '/workspace/src/lib/terminal-links.ts');
  assert.strictEqual(clickTarget?.path, '/workspace/src/lib/terminal-links.ts',
    'the second waiter must not mistake the first waiter committing for supersession');
}

async function testSynchronousResolverThrowIsAFailedResolution() {
  const fixture = createFixture({ throwingResolve: true });
  assert.strictEqual(await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }), null,
    'a resolver that throws synchronously fails the resolution instead of rejecting');

  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.opened.paths.length, 0, 'a failed resolution opens nothing');
  assert.strictEqual(fixture.opened.focusInputCount, 1,
    'a failed resolution returns focus to the terminal input');
}

async function testShortcutsRespectTheFence() {
  const withoutResolver = createFixture({ withoutPathResolve: true });
  assert.strictEqual(
    (await withoutResolver.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    'src/lib/terminal-links.ts',
    'without a resolver the lexical candidate is the target',
  );
  withoutResolver.state.attached = false;
  assert.strictEqual(await withoutResolver.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }), null,
    'a resolver-free shortcut still cannot answer for a parked attachment');
  withoutResolver.state.attached = true;
  withoutResolver.controller.dispose();
  assert.strictEqual(await withoutResolver.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }), null,
    'a disposed owner answers nothing, resolver or not');

  const globalRoot = createFixture();
  assert.strictEqual(
    (await globalRoot.controller.resolvePathTarget({ path: '/etc/hosts', globalRoot: true }))?.path,
    '/etc/hosts',
    'a global-root target is already authoritative',
  );
  assert.strictEqual(globalRoot.resolveCalls.length, 0);
  globalRoot.state.attached = false;
  assert.strictEqual(await globalRoot.controller.resolvePathTarget({ path: '/etc/hosts', globalRoot: true }), null,
    'a global-root shortcut cannot answer for a parked attachment');
}

/**
 * Mirrors how the hook now drives the pool: one revision tracker per mounted
 * owner, a token derived on every render from the three real handlers, and one
 * atomic commit per render that latches the token, makes the record this owner
 * already holds adopt it, and only then lets the stable wrappers reach the new
 * handlers. `resolveAttach` models the pool applying an attach that captured an
 * older token: it installs this owner's wrappers first and adopts the latched
 * revision instead, so a superseded commit cannot come back.
 *
 * `wrappers` and `installedWrappers` model handler ownership across mounts. An
 * owner configured with neither is the only owner of its record.
 */
function createHookOwner(controller, options: {
  latch?: ReturnType<typeof createTerminalLinkHandlersCommitLatch>;
  committedRef?: TestCommittedLinkHandlersRef;
  poolRecordLive?: boolean;
  agentId?: string;
  wrappers?: ReturnType<typeof createCommittedLinkWrappers>;
  installedWrappers?: { current: ReturnType<typeof createCommittedLinkWrappers> | null };
} = {}) {
  const latch = options.latch ?? createTerminalLinkHandlersCommitLatch();
  const tracker = createTerminalLinkHandlersRevisionTracker();
  const agentId = options.agentId ?? 'agent-1';
  const wrappers = options.wrappers ?? null;
  const installedWrappers = options.installedWrappers ?? null;
  let poolRecordLive = options.poolRecordLive !== false;
  let renderedRevision = null;
  let renderedHandlers = null;
  let committedRevision = null;

  const ownsInstalledWrappers = () => !wrappers || !installedWrappers || (
    installedWrappers.current?.onPathOpen === wrappers.onPathOpen
    && installedWrappers.current?.onPathResolve === wrappers.onPathResolve
    && installedWrappers.current?.onSearchOpen === wrappers.onSearchOpen
  );

  return {
    latch,
    render(handlers) {
      renderedHandlers = handlers;
      renderedRevision = tracker.revisionFor(handlers);
      return renderedRevision;
    },
    layoutCommit() {
      const candidate = { handlers: renderedHandlers, revision: renderedRevision };
      latch.commit(agentId, candidate.revision);
      // A record another owner's wrappers still serve may not adopt here: it
      // would resolve through those foreign handlers under this revision's
      // fence. The attach that installs these wrappers adopts the latch.
      const invalidated = poolRecordLive && ownsInstalledWrappers()
        ? controller.adoptHandlersRevision(candidate.revision)
        : false;
      if (options.committedRef) options.committedRef.current = candidate.handlers;
      committedRevision = candidate.revision;
      return invalidated;
    },
    // The effect cleanup owns exactly the revision its own commit latched, so a
    // cleanup that runs after a newer commit releases nothing.
    layoutCleanup(revision = committedRevision) {
      return latch.release(agentId, revision);
    },
    resolveAttach(capturedRevision) {
      poolRecordLive = true;
      const replaced = !ownsInstalledWrappers();
      if (installedWrappers) installedWrappers.current = wrappers;
      const invalidated = controller.adoptHandlersRevision(latch.committedRevision(agentId, capturedRevision));
      if (!invalidated && replaced) controller.notifyHandlersChanged();
      return invalidated;
    },
    adoptDirectly(revision) {
      return controller.adoptHandlersRevision(revision);
    },
  };
}

function createWorkspaceHandlers(workspace, log) {
  return {
    onPathOpen: (agentId, target) => log.opened.push({ workspace, path: target.path }),
    onPathResolve: (agentId, target) => {
      log.resolveCalls.push({ workspace, path: target.path });
      if (!log.defer) return resolveWorkspacePath(target, workspace);
      return new Promise(resolve => {
        log.queue.push(() => resolve(resolveWorkspacePath(target, workspace)));
      });
    },
    onSearchOpen: undefined,
  };
}

async function testAtomicCommitOrdersPoolAdoptionBeforeTheNewOpener() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const committedRef = { current: {} };
  const fixture = createFixture({
    lines: [WORKSPACE_PATH_LINE, 'src/lib/terminal-engine.ts:3:1 failed to link'],
    linkHandlersRef: committedRef,
  });
  const owner = createHookOwner(fixture.controller, { committedRef });

  const workspaceA = createWorkspaceHandlers('a', log);
  owner.render(workspaceA);
  assert.strictEqual(owner.layoutCommit(), false,
    'the first commit records the owner handler identity instead of invalidating it');
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'the committed handlers resolve the candidate',
  );

  log.defer = true;
  const pendingResolveOfA = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-engine.ts' });
  await flush();
  log.defer = false;

  // Render B is complete but its commit has not run yet: the pool still holds
  // A's resolutions, so the wrappers must still reach A's opener.
  const workspaceB = createWorkspaceHandlers('b', log);
  owner.render(workspaceB);
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.deepStrictEqual(log.opened, [{ workspace: 'a', path: '/workspace/src/lib/terminal-links.ts' }],
    'a rendered-but-uncommitted handler switch cannot open a resolution the previous handlers produced');
  assert.ok(log.resolveCalls.every(call => call.workspace === 'a'),
    'the uncommitted resolver is not reachable either');

  fixture.state.now += TERMINAL_OPEN_ACTIVATION_FENCE_MS;
  assert.strictEqual(owner.layoutCommit(), true,
    'the commit adopts the exact revision and invalidates the previous handlers');
  log.queue.splice(0).forEach(resolve => resolve());
  assert.strictEqual(await pendingResolveOfA, null,
    'a resolution the previous handlers were still producing cannot commit');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'a resolution cached for the previous handlers is not evidence for the committed ones',
  );

  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.deepStrictEqual(log.opened.slice(1), [{ workspace: 'b', path: '/workspace-b/src/lib/terminal-links.ts' }],
    'after the commit the wrappers reach the committed opener with its own resolution');
}

async function testLatchedCommitFencesALateAttachAgainstANewerCommit() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const committedRef = { current: {} };
  const fixture = createFixture({ linkHandlersRef: committedRef });
  // The pool record is still being created, so no controller can adopt yet.
  const owner = createHookOwner(fixture.controller, { committedRef, poolRecordLive: false });

  const revisionB = owner.render(createWorkspaceHandlers('b', log));
  assert.strictEqual(owner.layoutCommit(), false,
    'a record that does not exist yet has nothing to invalidate');
  const workspaceC = createWorkspaceHandlers('a', log);
  const revisionC = owner.render(workspaceC);
  assert.notStrictEqual(revisionC, revisionB);
  owner.layoutCommit();

  // The attach that captured B finally applies its options.
  assert.strictEqual(owner.resolveAttach(revisionB), false,
    'the first adoption of the latched revision invalidates nothing');
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'the committed handlers own the record the late attach installed',
  );
  assert.strictEqual(owner.adoptDirectly(revisionC), false,
    'the record adopted the newest committed revision, not the one the attach captured');
  const resolveCallsAfterCommit = log.resolveCalls.length;
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'a commit that changes nothing keeps the current resolution usable',
  );
  assert.strictEqual(log.resolveCalls.length, resolveCallsAfterCommit,
    'the committed resolution is reused instead of resolved again');
  assert.strictEqual(owner.adoptDirectly(revisionB), true,
    'the superseded revision is still a different identity, so this assertion had teeth');
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'adopting a different revision drops the cache and resolves again',
  );
  assert.strictEqual(log.resolveCalls.length, resolveCallsAfterCommit + 1);
}

async function testSameMountHandlerSwitchInvalidatesPreviousWorkspace() {
  const fixture = createFixture({
    deferResolve: true,
    lines: [WORKSPACE_PATH_LINE, 'src/lib/terminal-engine.ts:3:1 failed to link'],
  });
  const owner = createHookOwner(fixture.controller);
  const workspaceA = {
    onPathOpen: () => {},
    onPathResolve: () => null,
    onSearchOpen: undefined,
  };

  owner.render(workspaceA);
  assert.strictEqual(owner.layoutCommit(), false,
    'the initial commit records the owner handler identity instead of invalidating it');
  assert.strictEqual(owner.render(workspaceA), owner.render(workspaceA),
    'a StrictMode double render with the same handlers keeps one revision token');
  assert.strictEqual(owner.layoutCommit(), false,
    'a render that changes nothing semantic commits the same token');

  const lateResolveOfA = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' });
  await flush();
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 25 }));
  await flush();
  fixture.resolveQueued(1);
  await flush();
  for (let render = 0; render < 3; render += 1) {
    owner.render(workspaceA);
    assert.strictEqual(owner.layoutCommit(), false);
  }
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 25 }))?.path,
    '/workspace/src/lib/terminal-engine.ts',
    'repeated renders keep a committed resolution usable',
  );

  // The owner switched workspaces: the pool still holds the same stable
  // wrappers, so only the revision token reports that a different resolver and
  // opener are behind them now.
  fixture.state.workspace = 'b';
  owner.render({
    onPathOpen: () => {},
    onPathResolve: () => null,
    onSearchOpen: undefined,
  });
  assert.strictEqual(owner.layoutCommit(), true,
    'a same-mount handler switch invalidates the previous resolver through the token');

  fixture.resolveQueued(0);
  assert.strictEqual(await lateResolveOfA, null,
    'a resolution the previous workspace resolver produced cannot commit for the current opener');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 25 })),
    null,
    'a resolution cached for the previous workspace is not evidence for the current one',
  );

  const resolveCallsBeforeSwitchedClick = fixture.resolveCalls.length;
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.strictEqual(fixture.resolveCalls.length, resolveCallsBeforeSwitchedClick + 1,
    'the switched owner resolves the candidate again instead of trusting the previous cache');
  assert.strictEqual(fixture.resolveCalls.at(-1).workspace, 'b');
  fixture.resolvePending();
  await flush();
  assert.deepStrictEqual(
    fixture.opened.paths.map(entry => ({ path: entry.target.path, workspace: entry.workspace })),
    [{ path: '/workspace-b/src/lib/terminal-links.ts', workspace: 'b' }],
    'the current opener opens the target its own resolver produced',
  );
}

async function testDifferentMountAdoptsItsOwnHandlerIdentityAtAttach() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const latch = createTerminalLinkHandlersCommitLatch();
  const installedWrappers = { current: null };
  const firstRef = { current: {} };
  const secondRef = { current: {} };
  const fixture = createFixture({
    lines: [WORKSPACE_PATH_LINE, 'src/lib/terminal-engine.ts:3:1 failed to link'],
    installedLinkWrappers: installedWrappers,
  });

  const firstMount = createHookOwner(fixture.controller, {
    latch,
    committedRef: firstRef,
    wrappers: createCommittedLinkWrappers(firstRef),
    installedWrappers,
    poolRecordLive: false,
  });
  const firstRevision = firstMount.render(createWorkspaceHandlers('a', log));
  firstMount.layoutCommit();
  assert.strictEqual(firstMount.resolveAttach(firstRevision), false,
    'the first attach installs this owner wrappers and has nothing to invalidate');
  assert.strictEqual(
    (await fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'the record resolves through the wrappers it installed',
  );
  // Hover caches the resolution an event reaches, so the record holds both a
  // committed resolution and one still in flight when the next mount commits.
  fixture.hostTarget.dispatch('mousemove', createEvent({ clientX: 115, clientY: 5 }));
  await flush();
  log.defer = true;
  const pendingResolveOfFirstMount = fixture.controller.resolvePathTarget({ path: 'src/lib/terminal-engine.ts' });
  await flush();
  log.defer = false;

  // A different mount is a new hook owner with its own tracker, so its first
  // token is one this record has never seen. Its layout commit happens before the
  // attach that would install its wrappers.
  const secondMount = createHookOwner(fixture.controller, {
    latch,
    committedRef: secondRef,
    wrappers: createCommittedLinkWrappers(secondRef),
    installedWrappers,
  });
  const secondRevision = secondMount.render(createWorkspaceHandlers('b', log));
  assert.strictEqual(secondMount.layoutCommit(), false,
    'a commit against a record the previous mount wrappers still serve only latches the revision');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'that commit may not invalidate resolutions the installed wrappers produced and still own',
  );

  const resolveCallsBeforeAttach = log.resolveCalls.length;
  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.deepStrictEqual(log.opened, [{ workspace: 'a', path: '/workspace/src/lib/terminal-links.ts' }],
    'the record still routes to the installed wrappers, so the committing mount opener is unreachable');
  assert.ok(log.resolveCalls.slice(resolveCallsBeforeAttach).every(call => call.workspace === 'a'),
    'its resolver is unreachable too, so no foreign resolution enters the newly committed fence');

  fixture.state.now += TERMINAL_OPEN_ACTIVATION_FENCE_MS;
  assert.strictEqual(secondMount.resolveAttach(secondRevision), true,
    'the attach installs the new wrappers first and only then adopts the latched revision');
  log.queue.splice(0).forEach(resolve => resolve());
  assert.strictEqual(await pendingResolveOfFirstMount, null,
    'a resolution the previous mount resolver was still producing cannot commit for the new one');
  assert.strictEqual(
    fixture.controller.resolvedPathTargetAtEvent(createEvent({ clientX: 115, clientY: 5 })),
    null,
    'a resolution cached for the previous mount is not evidence for the mount that took over',
  );
  assert.strictEqual(secondMount.layoutCommit(), false,
    'a repeated commit of the mount that now owns the record repeats no invalidation');

  fixture.hostTarget.dispatch('mousedown', createEvent({ clientX: 115, clientY: 5 }));
  fixture.hostTarget.dispatch('mouseup', createEvent({ clientX: 116, clientY: 5 }));
  await flush();
  assert.deepStrictEqual(log.opened.slice(1), [{ workspace: 'b', path: '/workspace-b/src/lib/terminal-links.ts' }],
    'the mount that owns the record opens only the target its own resolver produced');
}

/**
 * Mirrors how the pool destroys a session: `take` is the moment this destroy owns
 * the entry, so the latched commit it may release is the one visible then. Every
 * later step runs after an await, during which a new owner can commit its own
 * revisions and create a replacement entry for the same key.
 */
function createPoolDestroyModel(latch, registry) {
  return async function destroy(agentId) {
    const current = registry.take(agentId);
    if (!current) return { taken: false, failed: false, released: false };
    const takenRevision = latch.committedRevision(agentId);
    let failed = false;
    try {
      await current;
    } catch {
      failed = true;
    }
    return { taken: true, failed, released: latch.release(agentId, takenRevision) };
  };
}

async function testDestroyReleasesOnlyTheCommitItTook() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const latch = createTerminalLinkHandlersCommitLatch();
  const registry = new TerminalSessionRegistry();
  const destroy = createPoolDestroyModel(latch, registry);

  const previousRef = { current: {} };
  const previousFixture = createFixture({ linkHandlersRef: previousRef });
  const previousOwner = createHookOwner(previousFixture.controller, {
    latch,
    committedRef: previousRef,
  });
  const revisionA = previousOwner.render(createWorkspaceHandlers('a', log));
  previousOwner.layoutCommit();

  let settlePreviousRecord;
  registry.getOrCreate('agent-1', () => new Promise(resolve => {
    settlePreviousRecord = () => resolve({ agentId: 'agent-1' });
  }));
  const destroying = destroy('agent-1');
  assert.strictEqual(latch.committedRevision('agent-1'), revisionA,
    'the destroy captured the commit that was latched when it took the entry');

  // A replacement owner mounts for the same agent while that destroy is still
  // awaiting the bootstrap it took, commits B, then commits C.
  const replacementRef = { current: {} };
  const replacementFixture = createFixture({ linkHandlersRef: replacementRef });
  const replacementOwner = createHookOwner(replacementFixture.controller, {
    latch,
    committedRef: replacementRef,
    poolRecordLive: false,
  });
  const revisionB = replacementOwner.render(createWorkspaceHandlers('b', log));
  replacementOwner.layoutCommit();
  const revisionC = replacementOwner.render(createWorkspaceHandlers('a', log));
  replacementOwner.layoutCommit();
  assert.notStrictEqual(revisionC, revisionB);
  let settleReplacementRecord;
  const replacementEntry = registry.getOrCreate('agent-1', () => new Promise(resolve => {
    settleReplacementRecord = () => resolve({ agentId: 'agent-1' });
  }));

  settlePreviousRecord();
  assert.deepStrictEqual(await destroying, { taken: true, failed: false, released: false },
    'a destroy that took the previous entry may not release the replacement owner commit');
  assert.ok(registry.isCurrent('agent-1', replacementEntry),
    'the destroy took only the entry it owned, so the replacement bootstrap is still current');
  settleReplacementRecord();
  await flush();

  // The replacement session's attach applies the options it captured before C.
  assert.strictEqual(replacementOwner.resolveAttach(revisionB), false,
    'the first adoption of the latched revision invalidates nothing');
  assert.strictEqual(
    (await replacementFixture.controller.resolvePathTarget({ path: 'src/lib/terminal-links.ts' }))?.path,
    '/workspace/src/lib/terminal-links.ts',
    'the committed handlers resolve for the record the late attach installed',
  );
  const resolveCallsAfterAttach = log.resolveCalls.length;
  assert.strictEqual(replacementOwner.adoptDirectly(revisionC), false,
    'the late attach adopted the newest committed revision, not the one it captured');
  assert.strictEqual(replacementOwner.adoptDirectly(revisionB), true,
    'the superseded revision is still a different identity, so that assertion had teeth');
  assert.strictEqual(log.resolveCalls.length, resolveCallsAfterAttach,
    'the assertions above read the committed resolution instead of resolving again');
  assert.ok(log.resolveCalls.every(call => call.workspace === 'a'),
    'the superseded commit never became reachable through the wrappers');
}

async function testDestroyWithoutAReplacementReleasesItsCommit() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const latch = createTerminalLinkHandlersCommitLatch();
  const registry = new TerminalSessionRegistry();
  const destroy = createPoolDestroyModel(latch, registry);

  const settledRef = { current: {} };
  const settledFixture = createFixture({ linkHandlersRef: settledRef });
  const settledOwner = createHookOwner(settledFixture.controller, {
    latch,
    committedRef: settledRef,
    agentId: 'agent-1',
  });
  const settledRevision = settledOwner.render(createWorkspaceHandlers('a', log));
  settledOwner.layoutCommit();
  registry.getOrCreate('agent-1', () => ({ agentId: 'agent-1' }));
  await flush();
  assert.deepStrictEqual(await destroy('agent-1'), { taken: true, failed: false, released: true },
    'a destroy with no replacement releases the commit it took');
  assert.strictEqual(latch.committedRevision('agent-1', settledRevision), settledRevision,
    'with the entry gone the next attach falls back to the revision it captured itself');
  assert.deepStrictEqual(await destroy('agent-1'), { taken: false, failed: false, released: false },
    'a repeated destroy owns no entry and releases nothing');

  const failedRef = { current: {} };
  const failedFixture = createFixture({ linkHandlersRef: failedRef });
  const failedOwner = createHookOwner(failedFixture.controller, {
    latch,
    committedRef: failedRef,
    agentId: 'agent-2',
    poolRecordLive: false,
  });
  failedOwner.render(createWorkspaceHandlers('b', log));
  failedOwner.layoutCommit();
  registry.getOrCreate('agent-2', () => Promise.reject(new Error('bootstrap failed')));
  assert.deepStrictEqual(await destroy('agent-2'), { taken: true, failed: true, released: true },
    'a bootstrap that rejected still releases the commit its destroy took');
  assert.strictEqual(latch.committedRevision('agent-2'), undefined,
    'a failed bootstrap leaves no latched commit behind');
}

async function testCommitWithoutARecordIsReleasedByItsOwnCleanup() {
  const log = { opened: [], resolveCalls: [], queue: [], defer: false };
  const latch = createTerminalLinkHandlersCommitLatch();
  const committedRef = { current: {} };
  const fixture = createFixture({ linkHandlersRef: committedRef });
  // The container is empty, so no record exists for this commit to reach.
  const owner = createHookOwner(fixture.controller, {
    latch,
    committedRef,
    poolRecordLive: false,
  });

  const revisionA = owner.render(createWorkspaceHandlers('a', log));
  owner.layoutCommit();
  assert.strictEqual(owner.layoutCleanup(), true,
    'a commit whose record never appeared is released by its own cleanup');
  assert.strictEqual(latch.committedRevision('agent-1'), undefined,
    'the released commit leaves no entry only a destroy could remove');
  assert.strictEqual(owner.layoutCleanup(revisionA), false,
    'a repeated cleanup of the same commit deletes nothing');

  owner.layoutCommit();
  const revisionB = owner.render(createWorkspaceHandlers('b', log));
  owner.layoutCommit();
  assert.strictEqual(owner.layoutCleanup(revisionA), false,
    'a cleanup that runs after a newer commit keeps the newer token');
  assert.strictEqual(latch.committedRevision('agent-1'), revisionB);

  // StrictMode invokes the layout effect, its cleanup, then the effect again.
  owner.layoutCommit();
  assert.strictEqual(owner.layoutCleanup(revisionB), true);
  owner.layoutCommit();
  assert.strictEqual(latch.committedRevision('agent-1'), revisionB,
    'a double invoke ends with the same commit latched');

  // A different mount takes over the same agent and commits before the previous
  // owner's cleanup runs.
  const successorRef = { current: {} };
  const successorFixture = createFixture({ linkHandlersRef: successorRef });
  const successor = createHookOwner(successorFixture.controller, {
    latch,
    committedRef: successorRef,
    poolRecordLive: false,
  });
  const successorRevision = successor.render(createWorkspaceHandlers('a', log));
  successor.layoutCommit();
  assert.strictEqual(owner.layoutCleanup(revisionB), false,
    'the unmounting owner cannot release the successor commit');
  assert.strictEqual(successor.resolveAttach(revisionB), false);
  assert.strictEqual(successor.adoptDirectly(successorRevision), false,
    'the successor record adopted its own commit instead of the token the attach captured');
}

async function run() {
  await testStaleResolverAfterDetach();
  await testStaleResolverAfterAttachmentOperationAdvances();
  await testHoverCommitsForTheLatestHoverIdentity();
  await testModifierChangeDrivesUrlHover();
  await testExactOpenClick();
  await testDraggedClickAndDetachBetweenMouseDownAndMouseUp();
  await testEscapedPathStaysPlainText();
  await testResetAndDispose();
  await testModifierClickOpensUrlAndSearch();
  await testLinkProviderLinks();
  await testLateResolveAfterReset();
  await testSupersededResolvePromise();
  await testConcurrentResolveConsumersShareTheCommittedResult();
  await testSynchronousResolverThrowIsAFailedResolution();
  await testShortcutsRespectTheFence();
  await testAtomicCommitOrdersPoolAdoptionBeforeTheNewOpener();
  await testLatchedCommitFencesALateAttachAgainstANewerCommit();
  await testSameMountHandlerSwitchInvalidatesPreviousWorkspace();
  await testDifferentMountAdoptsItsOwnHandlerIdentityAtAttach();
  await testDestroyReleasesOnlyTheCommitItTook();
  await testDestroyWithoutAReplacementReleasesItsCommit();
  await testCommitWithoutARecordIsReleasedByItsOwnCleanup();
  console.log('terminal link interaction keeps exact open ownership across stale resolution, handler switch, detach, and dispose');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
