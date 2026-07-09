const assert = require('assert');
const {
  composerDraftForSubmit,
  isComposerImeCompositionEvent,
  shouldSubmitComposerEnter,
  shouldSuppressComposerEnterAfterComposition,
} = require('../../src/components/code/composer-keyboard.ts');
const {
  addComposerHistoryEntry,
  canUseComposerHistoryNavigation,
  createDefaultComposerHistoryState,
  navigateComposerHistory,
} = require('../../src/components/code/composer-history.ts');

function keyEvent(overrides = {}) {
  return {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: {},
    ...overrides,
  };
}

function run() {
  assert.strictEqual(
    isComposerImeCompositionEvent(keyEvent(), true),
    true,
    'active IME composition should be detected'
  );

  assert.strictEqual(
    isComposerImeCompositionEvent(keyEvent({ nativeEvent: { isComposing: true } }), false),
    true,
    'native composing keyboard events should be detected'
  );

  assert.strictEqual(
    isComposerImeCompositionEvent(keyEvent({ nativeEvent: { keyCode: 229 } }), false),
    true,
    'IME keyCode 229 keyboard events should be detected'
  );

  assert.strictEqual(
    shouldSuppressComposerEnterAfterComposition(keyEvent(), 1000, 1080),
    true,
    'Enter immediately after compositionend should be suppressed'
  );

  assert.strictEqual(
    shouldSubmitComposerEnter(keyEvent(), true, 0),
    false,
    'Enter should not submit while IME composition is active'
  );

  assert.strictEqual(
    shouldSubmitComposerEnter(keyEvent(), false, 1000, 1080),
    false,
    'Enter should not submit immediately after IME compositionend'
  );

  assert.strictEqual(
    shouldSubmitComposerEnter(keyEvent(), false, 1000, 1300),
    true,
    'Enter should submit after the post-composition suppression window'
  );

  assert.strictEqual(
    shouldSubmitComposerEnter(keyEvent({ ctrlKey: true }), false, 0),
    true,
    'Ctrl+Enter should submit when IME is not composing'
  );

  assert.strictEqual(
    shouldSubmitComposerEnter(keyEvent({ shiftKey: true }), false, 0),
    false,
    'Shift+Enter should stay available for multiline input'
  );

  assert.strictEqual(
    composerDraftForSubmit('', '测试'),
    '测试',
    'iOS submit should retain the last committed Chinese draft when WebKit reports an empty textarea during Enter'
  );

  assert.strictEqual(
    composerDraftForSubmit('当前输入', '测试'),
    '当前输入',
    'the live textarea value should win when it is available at submit time'
  );

  let history = createDefaultComposerHistoryState();
  history = addComposerHistoryEntry(history, 'first command');
  history = addComposerHistoryEntry(history, 'second command');

  let result = navigateComposerHistory(history, 'previous', '');
  assert.strictEqual(result.value, 'second command', 'Up from empty should recall the latest composer message');
  assert.strictEqual(result.history.cursor, 1);

  result = navigateComposerHistory(result.history, 'previous', result.value);
  assert.strictEqual(result.value, 'first command', 'Repeated Up should walk to older composer messages');
  assert.strictEqual(result.history.cursor, 0);

  result = navigateComposerHistory(result.history, 'previous', result.value);
  assert.strictEqual(result.value, 'first command', 'Up at the oldest composer message should stay put');
  assert.strictEqual(result.history.cursor, 0);

  result = navigateComposerHistory(result.history, 'next', result.value);
  assert.strictEqual(result.value, 'second command', 'Down should walk back toward newer composer messages');
  assert.strictEqual(result.history.cursor, 1);

  result = navigateComposerHistory(result.history, 'next', result.value);
  assert.strictEqual(result.value, '', 'Down at the newest composer message should return to an empty draft');
  assert.strictEqual(result.history.cursor, null);

  result = navigateComposerHistory(history, 'previous', 'half typed');
  assert.strictEqual(result.changed, false, 'History navigation should not overwrite user-edited drafts');
  assert.strictEqual(result.history.cursor, null);

  result = navigateComposerHistory(history, 'previous', '   ');
  assert.strictEqual(result.changed, false, 'Whitespace-only drafts should still count as user-edited input');
  assert.strictEqual(result.history.cursor, null);

  assert.strictEqual(
    canUseComposerHistoryNavigation({
      direction: 'previous',
      value: 'line one\nline two',
      selectionStart: 'line one\nline'.length,
      selectionEnd: 'line one\nline'.length,
    }),
    false,
    'Up should first move through multiline composer content before recalling history'
  );

  assert.strictEqual(
    canUseComposerHistoryNavigation({
      direction: 'next',
      value: 'line one\nline two',
      selectionStart: 'line'.length,
      selectionEnd: 'line'.length,
    }),
    false,
    'Down should first move through multiline composer content before recalling history'
  );

  assert.strictEqual(
    canUseComposerHistoryNavigation({
      direction: 'previous',
      value: 'single line',
      selectionStart: 'single line'.length,
      selectionEnd: 'single line'.length,
    }),
    true,
    'Single-line composer content can use history navigation'
  );

  console.log('test-code-composer-keyboard passed');
}

run();
