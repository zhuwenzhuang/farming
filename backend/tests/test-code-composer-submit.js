const assert = require('assert');
const {
  codexTerminalProfileInputSteps,
  terminalInputPartsForComposerMessage,
} = require('../../src/components/code/composer-submit.ts');
const { terminalInputToPtyString } = require('../input-parts');

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

  assert.strictEqual(
    terminalInputToPtyString(terminalInputPartsForComposerMessage('hello OpenCode')),
    '\x1b[200~hello OpenCode\x1b[201~\r',
    'composer submit helper should continue to represent coding-agent messages as paste parts'
  );

  const profileSteps = codexTerminalProfileInputSteps({
    model: 'gpt-5.6-terra',
    effort: 'ultra',
    modelIndex: 2,
    reasoningIndex: 5,
    reasoningCount: 6,
    fast: true,
    fastAvailable: true,
    applyModel: true,
    applyFast: true,
  }, 'run the tests');
  assert.deepStrictEqual(
    profileSteps.map(step => ({ kind: step.kind, input: terminalInputToPtyString(step.input) })),
    [
      { kind: 'command', input: '\x1b[200~/model\x1b[201~\r' },
      { kind: 'selection', input: '3' },
      { kind: 'selection', input: '6' },
      { kind: 'command', input: '\x1b[200~/fast\x1b[201~\r' },
      { kind: 'message', input: '\x1b[200~run the tests\x1b[201~\r' },
    ],
    'Codex Terminal should apply model, reasoning, and Fast before the next composer message'
  );
  assert(profileSteps.every((step, index) => index === 0 || step.delayMs > profileSteps[index - 1].delayMs));

  const fastOnlySteps = codexTerminalProfileInputSteps({
    model: 'gpt-5.6-sol',
    effort: 'high',
    modelIndex: 1,
    reasoningIndex: 2,
    reasoningCount: 6,
    fast: false,
    fastAvailable: true,
    applyModel: false,
    applyFast: true,
  }, 'continue');
  assert.deepStrictEqual(
    fastOnlySteps.map(step => terminalInputToPtyString(step.input)),
    ['\x1b[200~/fast\x1b[201~\r', '\x1b[200~continue\x1b[201~\r'],
    'Fast-only changes should not open the model picker'
  );

  console.log('test-code-composer-submit passed');
}

run();
