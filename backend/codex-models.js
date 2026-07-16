const { execFile } = require('child_process');

const DEFAULT_CODEX_MODELS_TIMEOUT_MS = 15_000;

class CodexModelCatalogError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CodexModelCatalogError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const EFFORT_LABELS = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
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
  const timeout = Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : DEFAULT_CODEX_MODELS_TIMEOUT_MS;
  const runExecFile = options.execFile || execFile;

  return new Promise((resolve, reject) => {
    try {
      runExecFile(codexBin, ['debug', 'models'], {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.code === 'ETIMEDOUT' || error.killed === true;
          if (timedOut) {
            reject(new CodexModelCatalogError(
              'CODEX_MODELS_TIMEOUT',
              `Codex model catalog timed out after ${timeout}ms`,
              error
            ));
            return;
          }

          const detail = String(stderr || error.message || '').trim().split(/\r?\n/, 1)[0];
          reject(new CodexModelCatalogError(
            'CODEX_MODELS_COMMAND_FAILED',
            detail
              ? `Codex model catalog command failed: ${detail}`
              : 'Codex model catalog command failed',
            error
          ));
          return;
        }

        if (!String(stdout || '').trim()) {
          reject(new CodexModelCatalogError(
            'CODEX_MODELS_EMPTY_OUTPUT',
            'Codex model catalog command returned no output'
          ));
          return;
        }

        let models;
        try {
          models = catalogModelsFromJson(stdout);
        } catch (error) {
          reject(new CodexModelCatalogError(
            'CODEX_MODELS_INVALID_JSON',
            'Codex model catalog returned invalid JSON',
            error
          ));
          return;
        }

        const modelOptions = buildModelOptions(models, 'codex');
        const catalog = buildModelCatalog(models, 'codex');
        if (modelOptions.length === 0 || catalog.length === 0) {
          reject(new CodexModelCatalogError(
            'CODEX_MODELS_EMPTY_CATALOG',
            'Codex model catalog did not contain any visible models'
          ));
          return;
        }

        resolve({
          models: modelOptions,
          catalog,
          source: 'codex',
        });
      });
    } catch (error) {
      reject(new CodexModelCatalogError(
        'CODEX_MODELS_COMMAND_FAILED',
        `Failed to start Codex model catalog command: ${error.message || error}`,
        error
      ));
    }
  });
}

module.exports = {
  CodexModelCatalogError,
  DEFAULT_CODEX_MODELS_TIMEOUT_MS,
  buildModelCatalog,
  buildModelOptions,
  catalogModelsFromJson,
  listCodexModelOptions,
};
