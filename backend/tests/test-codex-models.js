const assert = require('assert');
const { buildModelCatalog, buildModelOptions, catalogModelsFromJson } = require('../codex-models');

function run() {
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
  assert.deepStrictEqual(options.map(option => option.value), ['gpt-5.5:high', 'gpt-5.5:xhigh', 'gpt-5.4:medium']);
  assert.strictEqual(options[0].label, '5.5 High');
  assert.strictEqual(options[1].label, '5.5 Extra High');
  assert.strictEqual(options.some(option => JSON.stringify(option).includes('do not expose this')), false);

  console.log('✓ Codex model catalog is reduced to safe dynamic model and tier options');
}

run();
