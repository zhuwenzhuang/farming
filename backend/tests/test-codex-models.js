const assert = require('assert');
const {
  DEFAULT_CODEX_MODELS_TIMEOUT_MS,
  buildModelCatalog,
  buildModelOptions,
  catalogModelsFromJson,
  listCodexModelOptions,
} = require('../codex-models');

async function run() {
  const raw = JSON.stringify({
    models: [
      {
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        description: 'Frontier model',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [
          { effort: 'high', description: 'Greater reasoning depth' },
          { effort: 'xhigh', description: 'Extra high reasoning depth' },
          { effort: 'ultra', description: 'Highest reasoning depth' },
        ],
        service_tiers: [
          { id: 'priority', name: 'Fast', description: '1.5x speed' },
        ],
        visibility: 'list',
        priority: 7,
        base_instructions: 'do not expose this',
      },
      {
        slug: 'gpt-5.4',
        display_name: 'GPT-5.4',
        supported_reasoning_levels: [
          { effort: 'medium', description: 'Everyday tasks' },
        ],
        visibility: 'list',
        priority: 16,
      },
      {
        slug: 'hidden-model',
        display_name: 'Hidden',
        visibility: 'hidden',
      },
    ],
  });

  const models = catalogModelsFromJson(raw);
  const catalog = buildModelCatalog(models);
  const options = buildModelOptions(models);

  assert.deepStrictEqual(catalog.map(option => option.value), ['gpt-5.5', 'gpt-5.4']);
  assert.deepStrictEqual(catalog[0].serviceTiers.map(tier => tier.value), ['default', 'priority']);
  assert.strictEqual(catalog[0].serviceTiers[0].label, 'Standard');
  assert.strictEqual(catalog[0].serviceTiers[0].description, 'Default speed');
  assert.strictEqual(catalog[0].serviceTiers[1].label, 'Fast');
  assert.deepStrictEqual(options.map(option => option.value), ['gpt-5.5:high', 'gpt-5.5:xhigh', 'gpt-5.5:ultra', 'gpt-5.4:medium']);
  assert.strictEqual(options[0].label, '5.5 High');
  assert.strictEqual(options[1].label, '5.5 Extra High');
  assert.strictEqual(options[2].label, '5.5 Ultra');
  assert.strictEqual(options.some(option => JSON.stringify(option).includes('do not expose this')), false);

  let observedExecOptions = null;
  const liveCatalog = await listCodexModelOptions({
    execFile(_bin, _args, execOptions, callback) {
      observedExecOptions = execOptions;
      callback(null, raw, '');
    },
  });
  assert.strictEqual(observedExecOptions.timeout, DEFAULT_CODEX_MODELS_TIMEOUT_MS);
  assert.strictEqual(DEFAULT_CODEX_MODELS_TIMEOUT_MS, 15_000);
  assert.strictEqual(liveCatalog.source, 'codex');
  assert.deepStrictEqual(liveCatalog.catalog.map(option => option.value), ['gpt-5.5', 'gpt-5.4']);

  const timeoutError = Object.assign(new Error('Command timed out'), {
    killed: true,
    signal: 'SIGTERM',
  });
  await assert.rejects(
    listCodexModelOptions({
      timeout: 25,
      execFile(_bin, _args, _execOptions, callback) {
        callback(timeoutError, '', '');
      },
    }),
    error => (
      error.code === 'CODEX_MODELS_TIMEOUT'
      && error.message === 'Codex model catalog timed out after 25ms'
    ),
    'a model catalog timeout must reject instead of returning a static fallback'
  );

  await assert.rejects(
    listCodexModelOptions({
      execFile(_bin, _args, _execOptions, callback) {
        callback(null, '{not-json', '');
      },
    }),
    error => error.code === 'CODEX_MODELS_INVALID_JSON',
    'invalid catalog JSON must remain an observable failure'
  );

  await assert.rejects(
    listCodexModelOptions({
      execFile(_bin, _args, _execOptions, callback) {
        callback(null, JSON.stringify({ models: [] }), '');
      },
    }),
    error => error.code === 'CODEX_MODELS_EMPTY_CATALOG',
    'an empty catalog must remain an observable failure'
  );

  console.log('✓ Codex model catalog is dynamic, bounded, and fails without static fallback');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
