const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

const {
  TerminalRendererEffectController,
  stableTerminalScrollbarOpacity,
} = importTsModule('src/lib/terminal-renderer-effects.ts');

function createClassList() {
  const values = new Set();
  return {
    contains: value => values.has(value),
    remove: value => values.delete(value),
    toggle: (value, force) => {
      if (force) values.add(value);
      else values.delete(value);
    },
  };
}

function createRenderer(name) {
  const calls = [];
  const renderer = {
    cursorVisible: true,
    render(...args) {
      calls.push({ name, receiver: this, args });
    },
  };
  return { renderer, calls, originalRender: renderer.render };
}

function createController(options: {
  supportsCursorSuppression?: boolean;
  initialCursorSuppressed?: boolean;
} = {}) {
  const first = createRenderer('first');
  const terminal = { renderer: first.renderer };
  const classList = createClassList();
  let redraws = 0;
  const controller = new TerminalRendererEffectController({
    terminal,
    hostEl: { classList },
    supportsCursorSuppression: options.supportsCursorSuppression ?? true,
    initialCursorSuppressed: options.initialCursorSuppressed,
    forceRender: () => { redraws += 1; },
  });
  return {
    controller,
    terminal,
    classList,
    first,
    redraws: () => redraws,
  };
}

function run() {
  assert.strictEqual(stableTerminalScrollbarOpacity(undefined), undefined);
  assert.strictEqual(stableTerminalScrollbarOpacity(0), 0);
  assert.strictEqual(stableTerminalScrollbarOpacity(0.25), 1);

  const initiallySuppressed = createController({ initialCursorSuppressed: true });
  initiallySuppressed.controller.install();
  assert.strictEqual(initiallySuppressed.first.renderer.cursorVisible, false);
  assert.strictEqual(initiallySuppressed.classList.contains('terminal-renderer-cursor-suppressed'), true);
  initiallySuppressed.controller.dispose();
  assert.strictEqual(initiallySuppressed.first.renderer.cursorVisible, true);

  const nativeXterm = createController({
    initialCursorSuppressed: true,
    supportsCursorSuppression: false,
  });
  nativeXterm.controller.install();
  assert.strictEqual(nativeXterm.first.renderer.cursorVisible, true);
  assert.strictEqual(nativeXterm.classList.contains('terminal-renderer-cursor-suppressed'), false);
  nativeXterm.controller.dispose();

  const fixture = createController();
  const { controller, terminal, classList, first } = fixture;
  assert.strictEqual(controller.install(), true);
  const firstWrapper = first.renderer.render;
  assert.notStrictEqual(firstWrapper, first.originalRender);
  assert.strictEqual(controller.install(), true, 'install is idempotent for the same renderer');
  assert.strictEqual(first.renderer.render, firstWrapper);

  first.renderer.render('screen', false, 0, terminal, 0.2);
  assert.strictEqual(first.calls.length, 1);
  assert.strictEqual(first.calls[0].receiver, first.renderer, 'original render keeps its renderer receiver');
  assert.strictEqual(first.calls[0].args[4], 1, 'scrollbar opacity is stable across renderer frames');

  const olderLease = controller.acquireRenderSuspension();
  const newerLease = controller.acquireRenderSuspension();
  first.renderer.render('hidden', false, 0, terminal, 0);
  assert.strictEqual(first.calls.length, 1, 'any active lease suppresses rendering');
  assert.strictEqual(olderLease.release(), true);
  assert.strictEqual(olderLease.release(), false, 'a lease settles exactly once');
  first.renderer.render('still-hidden', false, 0, terminal, 0);
  assert.strictEqual(first.calls.length, 1, 'stale release cannot clear a newer suspension');
  assert.strictEqual(newerLease.release(), true);
  first.renderer.render('visible', false, 0, terminal, 0);
  assert.strictEqual(first.calls.length, 2);

  controller.setAttachmentCursorSuppressed(true);
  assert.strictEqual(first.renderer.cursorVisible, false);
  assert.strictEqual(classList.contains('terminal-renderer-cursor-suppressed'), true);
  first.renderer.render('suppressed-cursor', false, 0, terminal, 0);
  assert.strictEqual(first.calls.at(-1).args[1], true, 'cursor suppression upgrades the renderer effect to a full redraw');
  assert.strictEqual(first.renderer.cursorVisible, false, 'the renderer cannot reveal its cursor after the wrapped paint');
  controller.beginImeComposition();
  controller.setAttachmentCursorSuppressed(false);
  assert.strictEqual(first.renderer.cursorVisible, false, 'IME remains an independent suppression source');
  controller.endImeComposition();
  assert.strictEqual(first.renderer.cursorVisible, true, 'the last source restores the original cursor state');
  assert.strictEqual(classList.contains('terminal-renderer-cursor-suppressed'), false);

  controller.beginImeComposition();
  controller.setAttachmentCursorSuppressed(true);
  controller.endImeComposition();
  assert.strictEqual(first.renderer.cursorVisible, false, 'attachment suppression survives IME completion');
  controller.setAttachmentCursorSuppressed(false);
  assert.strictEqual(first.renderer.cursorVisible, true);

  controller.setAttachmentCursorSuppressed(true);
  const second = createRenderer('second');
  terminal.renderer = second.renderer;
  controller.setAttachmentCursorSuppressed(true);
  assert.strictEqual(first.renderer.render, first.originalRender, 'renderer replacement restores the old exact owner');
  assert.strictEqual(first.renderer.cursorVisible, true);
  assert.notStrictEqual(second.renderer.render, second.originalRender);
  assert.strictEqual(second.renderer.cursorVisible, false, 'current suppression migrates to the replacement renderer');
  controller.setAttachmentCursorSuppressed(false);
  assert.strictEqual(second.renderer.cursorVisible, true);
  terminal.renderer = first.renderer;
  controller.setAttachmentCursorSuppressed(false);
  assert.strictEqual(first.renderer.cursorVisible, true, 'a reused renderer cannot inherit stale suppression state');
  assert.strictEqual(second.renderer.cursorVisible, true, 'replacement and previous renderer restore independently');

  const staleLease = controller.acquireRenderSuspension();
  assert.strictEqual(controller.dispose(), true);
  assert.strictEqual(controller.dispose(), false, 'dispose is terminal and idempotent');
  assert.strictEqual(second.renderer.render, second.originalRender);
  assert.strictEqual(staleLease.release(), false, 'pre-dispose leases cannot mutate the disposed owner');
  assert.strictEqual(controller.acquireRenderSuspension().release(), false);
  assert.strictEqual(controller.beginImeComposition(), false);

  const replaced = createController();
  replaced.controller.install();
  const externalRender = function externalRender() {};
  replaced.first.renderer.render = externalRender;
  replaced.controller.setAttachmentCursorSuppressed(false);
  assert.notStrictEqual(
    replaced.first.renderer.render,
    externalRender,
    'a detected same-renderer replacement becomes the new wrapped baseline',
  );
  replaced.controller.dispose();
  assert.strictEqual(
    replaced.first.renderer.render,
    externalRender,
    'dispose restores the detected external baseline',
  );

  const subsequentlyReplaced = createController();
  subsequentlyReplaced.controller.install();
  subsequentlyReplaced.first.renderer.render = externalRender;
  subsequentlyReplaced.controller.setAttachmentCursorSuppressed(false);
  const laterExternalRender = function laterExternalRender() {};
  subsequentlyReplaced.first.renderer.render = laterExternalRender;
  subsequentlyReplaced.controller.dispose();
  assert.strictEqual(
    subsequentlyReplaced.first.renderer.render,
    laterExternalRender,
    'dispose cannot overwrite a renderer wrapper replaced after the last owner checkpoint',
  );

  console.log('terminal renderer effects keep exact effect ownership across reorder and disposal');
}

run();
