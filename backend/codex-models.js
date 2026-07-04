const { execFile } = require('child_process');

const FALLBACK_MODELS = [
  {
    slug: 'gpt-5.5',
    display_name: 'GPT-5.5',
    description: 'Frontier model for complex coding, research, and real-world work.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
    service_tiers: [
      { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
    ],
    visibility: 'list',
  },
  {
    slug: 'gpt-5.4',
    display_name: 'GPT-5.4',
    description: 'Strong model for everyday coding.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
    service_tiers: [
      { id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' },
    ],
    visibility: 'list',
  },
  {
    slug: 'gpt-5.4-mini',
    display_name: 'GPT-5.4 Mini',
    description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
    ],
    visibility: 'list',
  },
  {
    slug: 'gpt-5.3-codex-spark',
    display_name: 'GPT-5.3 Codex Spark',
    description: 'Ultra-fast coding model.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
    ],
    visibility: 'list',
  },
];

const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

const DEFAULT_SERVICE_TIER = {
  value: 'default',
  label: 'Standard',
  description: 'Default speed',
};

function compactModelLabel(model) {
  const displayName = String(model.display_name || model.slug || '').trim();
  if (!displayName) return String(model.slug || '').trim();
  return displayName.replace(/^GPT-/i, '');
}

function normalizeReasoningLevels(model) {
  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];

  if (levels.length > 0) {
    return levels
      .map(level => ({
        effort: String(level && level.effort || '').trim(),
        description: String(level && level.description || '').trim(),
      }))
      .filter(level => level.effort);
  }

  const fallbackEffort = String(model.default_reasoning_level || '').trim();
  return fallbackEffort ? [{ effort: fallbackEffort, description: '' }] : [];
}

function normalizeServiceTiers(model) {
  const tiers = Array.isArray(model.service_tiers) ? model.service_tiers : [];
  const normalized = tiers
    .map(tier => ({
      value: String(tier && (tier.id || tier.value) || '').trim(),
      label: String(tier && (tier.name || tier.label) || '').trim(),
      description: String(tier && tier.description || '').trim(),
    }))
    .filter(tier => tier.value);

  return [
    DEFAULT_SERVICE_TIER,
    ...normalized.map(tier => ({
      ...tier,
      label: tier.label || tier.value,
    })),
  ];
}

function catalogModelsFromJson(rawJson) {
  const parsed = JSON.parse(rawJson);
  const models = Array.isArray(parsed) ? parsed : parsed.models;
  return Array.isArray(models) ? models : [];
}

function visibleModels(models) {
  return models
    .filter(model => model && typeof model.slug === 'string' && model.slug.trim())
    .filter(model => !model.visibility || model.visibility === 'list')
    .sort((a, b) => {
      const priorityA = Number.isFinite(a.priority) ? a.priority : Number.MAX_SAFE_INTEGER;
      const priorityB = Number.isFinite(b.priority) ? b.priority : Number.MAX_SAFE_INTEGER;
      return priorityA - priorityB;
    });
}

function buildModelCatalog(models, source = 'codex') {
  return visibleModels(models).map(model => {
    const modelId = model.slug.trim();
    const levels = normalizeReasoningLevels(model);

    return {
      value: modelId,
      model: modelId,
      label: compactModelLabel(model),
      displayName: String(model.display_name || model.slug || '').trim(),
      description: String(model.description || '').trim(),
      defaultEffort: String(model.default_reasoning_level || levels[0]?.effort || '').trim(),
      reasoningLevels: levels.map(level => ({
        value: level.effort,
        effort: level.effort,
        label: EFFORT_LABELS[level.effort] || level.effort,
        description: level.description,
      })),
      serviceTiers: normalizeServiceTiers(model),
      source,
    };
  });
}

function buildModelOptions(models, source = 'codex') {
  return buildModelCatalog(models, source).flatMap(model => {
    if (model.reasoningLevels.length === 0) {
      return [{
        value: model.value,
        model: model.value,
        effort: '',
        label: model.label,
        description: model.description,
        source,
      }];
    }

    return model.reasoningLevels.map(level => ({
      value: `${model.value}:${level.value}`,
      model: model.value,
      effort: level.value,
      label: `${model.label} ${level.label}`,
      description: level.description || model.description,
      source,
    }));
  });
}

function listCodexModelOptions(options = {}) {
  const codexBin = options.codexBin || process.env.FARMING_CODEX_BIN || 'codex';
  const timeout = options.timeout || 3000;

  return new Promise((resolve) => {
    const fallback = () => resolve({
      models: buildModelOptions(FALLBACK_MODELS, 'fallback'),
      catalog: buildModelCatalog(FALLBACK_MODELS, 'fallback'),
      source: 'fallback',
    });

    try {
      execFile(codexBin, ['debug', 'models'], {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      }, (error, stdout) => {
        if (!error && stdout) {
          try {
            const models = catalogModelsFromJson(stdout);
            const modelOptions = buildModelOptions(models, 'codex');
            if (modelOptions.length > 0) {
              resolve({
                models: modelOptions,
                catalog: buildModelCatalog(models, 'codex'),
                source: 'codex',
              });
              return;
            }
          } catch {
            // fall through to fallback catalog
          }
        }

        fallback();
      });
    } catch {
      fallback();
    }
  });
}

module.exports = {
  buildModelCatalog,
  buildModelOptions,
  catalogModelsFromJson,
  listCodexModelOptions,
};
