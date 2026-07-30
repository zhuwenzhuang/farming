const { execFile } = require('child_process');

const DEFAULT_CODEX_MODELS_TIMEOUT_MS = 15_000;

interface RawCodexModel extends Record<string, unknown> {
  slug: string;
}

interface ReasoningLevel {
  description: string;
  effort: string;
}

interface ServiceTier {
  description: string;
  label: string;
  value: string;
}

interface ModelReasoningOption extends ReasoningLevel {
  label: string;
  value: string;
}

interface CodexModelCatalogItem {
  defaultEffort: string;
  description: string;
  displayName: string;
  label: string;
  model: string;
  reasoningLevels: ModelReasoningOption[];
  serviceTiers: ServiceTier[];
  source: string;
  value: string;
}

interface CodexModelOption {
  description: string;
  effort: string;
  label: string;
  model: string;
  source: string;
  value: string;
}

interface CodexModelListResult {
  catalog: CodexModelCatalogItem[];
  models: CodexModelOption[];
  source: 'codex';
}

interface CodexCommandError extends Error {
  code?: string;
  killed?: boolean;
}

type CodexModelsExec = (
  executable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; maxBuffer: number; timeout: number },
  callback: (
    error: CodexCommandError | null,
    stdout: string | Buffer,
    stderr: string | Buffer,
  ) => void,
) => unknown;

interface ListCodexModelOptions {
  codexBin?: string;
  env?: NodeJS.ProcessEnv;
  execFile?: CodexModelsExec;
  timeout?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class CodexModelCatalogError extends Error {
  code: string;
  override cause?: unknown;

  constructor(code: string, message: string, cause: unknown = null) {
    super(message);
    this.name = 'CodexModelCatalogError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

const EFFORT_LABELS: Record<string, string> = {
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

function compactModelLabel(model: RawCodexModel): string {
  const displayName = String(model.display_name || model.slug || '').trim();
  if (!displayName) return String(model.slug || '').trim();
  return displayName.replace(/^GPT-/i, '');
}

function normalizeReasoningLevels(model: RawCodexModel): ReasoningLevel[] {
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

function normalizeServiceTiers(model: RawCodexModel): ServiceTier[] {
  const tiers = Array.isArray(model.service_tiers) ? model.service_tiers : [];
  const normalized = tiers
    .map(tier => {
      const candidate = isObject(tier) ? tier : {};
      return {
      value: String(candidate.id || candidate.value || '').trim(),
      label: String(candidate.name || candidate.label || '').trim(),
      description: String(candidate.description || '').trim(),
      };
    })
    .filter(tier => tier.value);

  return [
    DEFAULT_SERVICE_TIER,
    ...normalized.map(tier => ({
      ...tier,
      label: tier.label || tier.value,
    })),
  ];
}

function catalogModelsFromJson(rawJson: string | Buffer): unknown[] {
  const parsed: unknown = JSON.parse(String(rawJson));
  const models = Array.isArray(parsed) ? parsed : isObject(parsed) ? parsed.models : [];
  return Array.isArray(models) ? models : [];
}

function visibleModels(models: unknown[]): RawCodexModel[] {
  return models
    .filter((model): model is RawCodexModel => (
      isObject(model) && typeof model.slug === 'string' && Boolean(model.slug.trim())
    ))
    .filter(model => !model.visibility || model.visibility === 'list')
    .sort((a, b) => {
      const priorityA = typeof a.priority === 'number' && Number.isFinite(a.priority)
        ? a.priority
        : Number.MAX_SAFE_INTEGER;
      const priorityB = typeof b.priority === 'number' && Number.isFinite(b.priority)
        ? b.priority
        : Number.MAX_SAFE_INTEGER;
      return priorityA - priorityB;
    });
}

function buildModelCatalog(models: unknown[], source = 'codex'): CodexModelCatalogItem[] {
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

function buildModelOptions(models: unknown[], source = 'codex'): CodexModelOption[] {
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

function listCodexModelOptions(
  options: ListCodexModelOptions = {},
): Promise<CodexModelListResult> {
  const codexBin = options.codexBin || process.env.FARMING_CODEX_BIN || 'codex';
  const timeout = typeof options.timeout === 'number' && Number.isFinite(options.timeout)
    ? Math.max(1, options.timeout)
    : DEFAULT_CODEX_MODELS_TIMEOUT_MS;
  const runExecFile: CodexModelsExec = options.execFile || execFile as CodexModelsExec;

  return new Promise<CodexModelListResult>((resolve, reject) => {
    try {
      runExecFile(codexBin, ['debug', 'models'], {
        ...(options.env ? { env: options.env } : {}),
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

        let models: unknown[];
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
    } catch (error: unknown) {
      reject(new CodexModelCatalogError(
        'CODEX_MODELS_COMMAND_FAILED',
        `Failed to start Codex model catalog command: ${error instanceof Error ? error.message : error}`,
        error
      ));
    }
  });
}

export {
  CodexModelCatalogError,
  DEFAULT_CODEX_MODELS_TIMEOUT_MS,
  buildModelCatalog,
  buildModelOptions,
  catalogModelsFromJson,
  listCodexModelOptions,
};
