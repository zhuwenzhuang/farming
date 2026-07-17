const assert = require('assert');
const {
  applyCodexTerminalProfile,
  codexServiceTierConfirmations,
  codexTerminalProfileFromOutput,
  codexTerminalProfileFromPreview,
  modelSelectionInput,
  reasoningSelectionInput,
  newCodexServiceTierConfirmation,
} = require('../codex-terminal-profile');

const IDLE_55 = [
  '› Improve documentation in @filename',
  '',
  '  gpt-5.5 xhigh · /workspace',
].join('\n');

const MODEL_MENU = [
  'Select Model and Effort',
  'Choose the model and reasoning effort to use',
  '',
  '  1. gpt-5.5            Stable coding model',
  '  7. gpt-5.6-luna       Fastest variant',
  '› 8. gpt-5.6-sol        Strong coding variant',
].join('\n');

const REASONING_MENU = [
  'Select Reasoning Level for gpt-5.6-sol',
  '',
  '  1. Low                Fast responses',
  '  2. Medium             Balanced',
  '  3. High               Deeper reasoning',
  '› 4. Extra high         Deep reasoning',
  '  5. More reasoning…    Max and Ultra consume usage limits faster',
].join('\n');

const ADVANCED_REASONING_MENU = [
  'Advanced Reasoning',
  '⚠ Consumes usage limits faster',
  '› 1. Max                For difficult problems',
  '  2. Ultra              For demanding multi-agent work',
].join('\n');

async function run() {
  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('gpt-5.6-sol xhigh fast · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true }
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromOutput([
      '• Model changed to gpt-5.6-sol xhigh',
      '• Service tier set to priority',
      'gpt-5.5 xhigh · stale simplified preview',
    ].join('\n')),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true },
    'explicit PTY confirmations should outrank a stale simplified footer'
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('• Service tier set to priority\n\ngpt-5.6-sol xhigh · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: true },
    'newer Codex versions confirm Fast separately instead of adding it to the footer'
  );
  assert.deepStrictEqual(
    codexTerminalProfileFromPreview('gpt-5.6-sol xhigh · ~/git/farming'),
    { model: 'gpt-5.6-sol', effort: 'xhigh', fast: null },
    'a footer without a Fast marker must not overwrite a previously confirmed tier'
  );
  assert.deepStrictEqual(codexServiceTierConfirmations(
    '• Service tier set to priority\n• Service tier set to default'
  ), [
    { serviceTier: 'priority', fast: true },
    { serviceTier: 'default', fast: false },
  ]);
  assert.deepStrictEqual(
    newCodexServiceTierConfirmation(
      '• Service tier set to default',
      '• Service tier set to default\n• Service tier set to priority'
    ),
    { serviceTier: 'priority', fast: true }
  );
  assert.strictEqual(modelSelectionInput(MODEL_MENU, 'gpt-5.6-sol'), '8');
  assert.strictEqual(reasoningSelectionInput(REASONING_MENU, 'xhigh'), '4');
  assert.strictEqual(reasoningSelectionInput(
    'Select Reasoning Level for gpt-5.6-sol\n  1. Low\n  5. Max',
    'max'
  ), '5', 'older Codex versions with a direct Max option should remain supported');
  assert.strictEqual(reasoningSelectionInput(ADVANCED_REASONING_MENU, 'max'), '1');
  assert.strictEqual(reasoningSelectionInput(ADVANCED_REASONING_MENU, 'ultra'), '2');

  let preview = IDLE_55;
  let stage = 'idle';
  let readsInStage = 0;
  const inputs = [];
  const readPreview = async () => {
    readsInStage += 1;
    if (stage === 'opening-model' && readsInStage >= 4) {
      preview = MODEL_MENU;
      stage = 'model-menu';
    } else if (stage === 'opening-reasoning' && readsInStage >= 3) {
      preview = REASONING_MENU;
      stage = 'reasoning-menu';
    } else if (stage === 'opening-advanced-reasoning' && readsInStage >= 4) {
      preview = ADVANCED_REASONING_MENU;
      stage = 'advanced-reasoning-menu';
    } else if (stage === 'applying-model' && readsInStage >= 5) {
      preview = 'Model changed to gpt-5.6-sol ultra\n\ngpt-5.6-sol ultra · /workspace';
      stage = 'model-applied';
    } else if (stage === 'applying-fast' && readsInStage >= 3) {
      preview = 'gpt-5.6-sol ultra fast · /workspace';
      stage = 'fast-applied';
    }
    return preview;
  };
  const sendInput = async input => {
    inputs.push(input);
    readsInStage = 0;
    if (Array.isArray(input) && input[0]?.text === '/model') stage = 'opening-model';
    else if (input === '8') stage = 'opening-reasoning';
    else if (input === '5') stage = 'opening-advanced-reasoning';
    else if (input === '2') stage = 'applying-model';
    else if (Array.isArray(input) && input[0]?.text === '/fast on') stage = 'applying-fast';
  };

  const applied = await applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'ultra', serviceTier: 'priority' },
    readPreview,
    sendInput,
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });

  assert.deepStrictEqual(inputs, [
    [{ type: 'paste', text: '/model' }, '\r'],
    '8',
    '5',
    '2',
    [{ type: 'paste', text: '/fast on' }, '\r'],
  ], 'profile changes should wait for each rendered Codex picker instead of relying on fixed delays');
  assert.deepStrictEqual(applied, {
    model: 'gpt-5.6-sol',
    effort: 'ultra',
    serviceTier: 'priority',
  });

  let modernOutput = 'booted';
  const modernInputs = [];
  const modernApplied = await applyCodexTerminalProfile({
    profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
    readPreview: async () => 'gpt-5.6-sol xhigh · /workspace',
    readOutput: async () => modernOutput,
    sendInput: async input => {
      modernInputs.push(input);
      modernOutput += '\n• Service tier set to default';
    },
    sleep: async () => {},
    pollIntervalMs: 0,
    timeoutMs: 1000,
  });
  assert.deepStrictEqual(modernInputs, [
    [{ type: 'paste', text: '/fast off' }, '\r'],
  ], 'an unknown modern CLI tier should receive one idempotent target command');
  assert.deepStrictEqual(modernApplied, {
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    serviceTier: 'default',
  });

  await assert.rejects(
    applyCodexTerminalProfile({
      profile: { model: 'gpt-5.6-sol', effort: 'xhigh', serviceTier: 'default' },
      readPreview: async () => 'Codex is working…',
      sendInput: async () => assert.fail('busy terminals must not receive /model'),
    }),
    /not idle/
  );

  console.log('test-codex-terminal-profile passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
