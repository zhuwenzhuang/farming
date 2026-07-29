const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
];

const CLAUDE_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'];

type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ClaudeEffortOption {
  effort: ClaudeEffort;
  label: string;
  value: ClaudeEffort;
}

interface ClaudeModelOption {
  defaultEffort: ClaudeEffort;
  displayName: string;
  label: string;
  reasoningLevels: readonly ClaudeEffortOption[];
  source: 'settings';
  value: string;
}

interface ClaudeSettingsSummary {
  available: boolean;
  effectiveEffort: ClaudeEffort | '';
  effectiveModel: string;
  effortOptions: readonly ClaudeEffortOption[];
  modelOptions: ClaudeModelOption[];
}

interface ClaudeSettingsOptions {
  home?: string;
  settingsFile?: string;
}

const CLAUDE_EFFORT_OPTIONS: readonly ClaudeEffortOption[] = [
  { value: 'low', effort: 'low', label: 'Low' },
  { value: 'medium', effort: 'medium', label: 'Medium' },
  { value: 'high', effort: 'high', label: 'High' },
  { value: 'xhigh', effort: 'xhigh', label: 'Extra High' },
  { value: 'max', effort: 'max', label: 'Max' },
];

function normalizeClaudeModelValue(model: unknown): string {
  if (typeof model !== 'string') return '';
  const value = model.trim();
  if (!value || value.length > 200) return '';
  if (/[\s\x00-\x1f\x7f]/.test(value)) return '';
  if (value.startsWith('-')) return '';
  return value;
}

function normalizeClaudeEffortValue(effort: unknown): ClaudeEffort | '' {
  return typeof effort === 'string' && CLAUDE_EFFORT_VALUES.includes(effort)
    ? effort as ClaudeEffort
    : '';
}

function getClaudeSettingsFile(options: ClaudeSettingsOptions = {}): string {
  if (options.settingsFile) return options.settingsFile;
  if (process.env.FARMING_CLAUDE_SETTINGS_FILE) return process.env.FARMING_CLAUDE_SETTINGS_FILE;

  const home = options.home || os.homedir();
  return path.join(home, '.claude', 'settings.json');
}

function pushUnique(values: string[], value: string): void {
  if (value && !values.includes(value)) values.push(value);
}

function emptyClaudeSettingsSummary(available = false): ClaudeSettingsSummary {
  return {
    available,
    effectiveModel: '',
    effectiveEffort: '',
    modelOptions: [],
    effortOptions: CLAUDE_EFFORT_OPTIONS,
  };
}

function summarizeClaudeSettings(rawSettings: unknown): ClaudeSettingsSummary {
  if (!rawSettings || typeof rawSettings !== 'object') {
    return emptyClaudeSettingsSummary(false);
  }

  const settings = rawSettings as Record<string, unknown>;
  const env = settings.env && typeof settings.env === 'object'
    ? settings.env as Record<string, unknown>
    : {};
  const modelValues: string[] = [];
  CLAUDE_MODEL_ENV_KEYS.forEach((key) => {
    pushUnique(modelValues, normalizeClaudeModelValue(env[key]));
  });

  const effectiveModel = normalizeClaudeModelValue(env.ANTHROPIC_MODEL) || modelValues[0] || '';
  const effectiveEffort = normalizeClaudeEffortValue(settings.effortLevel);
  const modelOptions: ClaudeModelOption[] = modelValues.map((model) => ({
    value: model,
    label: model,
    displayName: model,
    defaultEffort: effectiveEffort || 'medium',
    reasoningLevels: CLAUDE_EFFORT_OPTIONS,
    source: 'settings',
  }));

  if (effectiveModel && !modelOptions.some((option) => option.value === effectiveModel)) {
    modelOptions.unshift({
      value: effectiveModel,
      label: effectiveModel,
      displayName: effectiveModel,
      defaultEffort: effectiveEffort || 'medium',
      reasoningLevels: CLAUDE_EFFORT_OPTIONS,
      source: 'settings',
    });
  }

  return {
    available: true,
    effectiveModel,
    effectiveEffort,
    modelOptions,
    effortOptions: CLAUDE_EFFORT_OPTIONS,
  };
}

function readClaudeSettingsSummary(
  options: ClaudeSettingsOptions = {},
): ClaudeSettingsSummary {
  const settingsFile = getClaudeSettingsFile(options);
  if (!settingsFile || !fs.existsSync(settingsFile)) {
    return emptyClaudeSettingsSummary(false);
  }

  try {
    const rawSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return summarizeClaudeSettings(rawSettings);
  } catch {
    return emptyClaudeSettingsSummary(false);
  }
}

export {
  CLAUDE_EFFORT_OPTIONS,
  normalizeClaudeEffortValue,
  normalizeClaudeModelValue,
  readClaudeSettingsSummary,
  summarizeClaudeSettings,
};
