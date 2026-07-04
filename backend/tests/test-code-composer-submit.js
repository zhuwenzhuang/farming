const assert = require('assert');
const {
  terminalInputPartsForComposerMessage,
} = require('../../src/components/code/composer-submit.ts');

function run() {
  assert.deepStrictEqual(
    terminalInputPartsForComposerMessage('hello Codex'),
    [{ type: 'paste', text: 'hello Codex' }, '\r'],
    'composer submit parts should paste the message before the terminal submit key'
  );

  assert.deepStrictEqual(
    terminalInputPartsForComposerMessage('first\n\nsecond'),
    [{ type: 'paste', text: 'first\n\nsecond' }, '\r'],
    'composer submit parts should keep multiline messages inside one paste part'
  );

  console.log('test-code-composer-submit passed');
}

run();
