const assert = require('assert');
const {
  isBrowserShortcut,
  isCopyShortcut,
  isCrtNativeTerminalPasteTarget,
  isPasteShortcut,
} = require('../../frontend/skins/crt/app.js');

function makeEvent(overrides = {}) {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function run() {
  const originalNavigator = global.navigator;
  try {
    Object.defineProperty(global, 'navigator', {
      value: { platform: 'MacIntel' },
      configurable: true,
    });
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'c', metaKey: true })), true);
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 't', metaKey: true })), true);
    assert.strictEqual(isCopyShortcut(makeEvent({ key: 'c', metaKey: true })), true);
    assert.strictEqual(isPasteShortcut(makeEvent({ key: 'v', metaKey: true })), true);
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'ArrowUp' })), false);

    Object.defineProperty(global, 'navigator', {
      value: { platform: 'Linux x86_64' },
      configurable: true,
    });
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'c', ctrlKey: true })), true);
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'w', ctrlKey: true })), true);
    assert.strictEqual(isCopyShortcut(makeEvent({ key: 'c', ctrlKey: true })), true);
    assert.strictEqual(isPasteShortcut(makeEvent({ key: 'v', ctrlKey: true })), true);
    assert.strictEqual(isBrowserShortcut(makeEvent({ key: 'a' })), false);
    assert.strictEqual(isCrtNativeTerminalPasteTarget({
      closest: selector => selector === '#terminal-output .xterm' ? {} : null,
    }), true);
    assert.strictEqual(isCrtNativeTerminalPasteTarget({ closest: () => null }), false);
    assert.strictEqual(isCrtNativeTerminalPasteTarget(null), false);
  } finally {
    Object.defineProperty(global, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  }

  console.log('test-session-input-helpers passed');
}

run();
