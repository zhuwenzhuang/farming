const fs = require('fs');
const path = require('path');

type ConfigurationSummaryKey =
  | 'approval'
  | 'model'
  | 'permission'
  | 'provider'
  | 'reasoning'
  | 'sandbox'
  | 'serviceTier';

interface ConfigurationSummaryEntry {
  key: ConfigurationSummaryKey;
  value: string;
}

interface ProviderHomeConfiguration {
  exists: boolean;
  filePath: string;
  summary: ConfigurationSummaryEntry[];
}

const PROVIDER_CONFIGURATION_FILES: Record<string, string[]> = {
  codex: ['config.toml'],
  claude: ['settings.json'],
  opencode: ['opencode.jsonc', 'opencode.json'],
  qoder: ['settings.json'],
  qwen: ['settings.json'],
};

function scalarText(value: unknown): string {
  const text = typeof value === 'string'
    ? value.trim()
    : (typeof value === 'number' && Number.isFinite(value))
      ? String(value)
      : typeof value === 'boolean'
        ? (value ? 'true' : 'false')
        : '';
  return text.length <= 200 && !/[\x00-\x1f\x7f]/.test(text) ? text : '';
}

function pushSummary(
  summary: ConfigurationSummaryEntry[],
  key: ConfigurationSummaryKey,
  value: unknown,
): void {
  const text = scalarText(value);
  if (text && !summary.some(entry => entry.key === key && entry.value === text)) {
    summary.push({ key, value: text });
  }
}

function tomlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"')) {
    const quoted = trimmed.match(/^("(?:\\.|[^"\\])*")/);
    if (!quoted) return '';
    try {
      return scalarText(JSON.parse(quoted[1] || ''));
    } catch {
      return '';
    }
  }
  const singleQuoted = trimmed.match(/^'([^']*)'/);
  if (singleQuoted) return singleQuoted[1] || '';
  return scalarText(trimmed.split(/\s+#/, 1)[0]);
}

function summarizeCodexConfiguration(contents: string): ConfigurationSummaryEntry[] {
  const values = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    values.set(match[1] || '', tomlScalar(match[2] || ''));
  }
  const summary: ConfigurationSummaryEntry[] = [];
  pushSummary(summary, 'model', values.get('model'));
  pushSummary(summary, 'provider', values.get('model_provider'));
  pushSummary(summary, 'reasoning', values.get('model_reasoning_effort'));
  pushSummary(summary, 'serviceTier', values.get('service_tier'));
  pushSummary(summary, 'approval', values.get('approval_policy'));
  pushSummary(summary, 'sandbox', values.get('sandbox_mode'));
  return summary;
}

function jsoncString(contents: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = contents.match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return '';
  try {
    return scalarText(JSON.parse(`"${match[1] || ''}"`));
  } catch {
    return '';
  }
}

function summarizeJsonConfiguration(provider: string, contents: string): ConfigurationSummaryEntry[] {
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(contents);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // OpenCode commonly uses JSONC. Known scalar keys are still safe to surface.
  }

  const summary: ConfigurationSummaryEntry[] = [];
  const modelRecord = settings.model && typeof settings.model === 'object' && !Array.isArray(settings.model)
    ? settings.model as Record<string, unknown>
    : {};
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  const model = scalarText(settings.model)
    || scalarText(modelRecord.name)
    || scalarText(env.ANTHROPIC_MODEL)
    || jsoncString(contents, 'model');
  pushSummary(summary, 'model', model);

  if (provider === 'claude') {
    pushSummary(summary, 'reasoning', settings.effortLevel);
    pushSummary(summary, 'permission', settings.permissionMode);
  }
  if (provider === 'opencode') {
    pushSummary(summary, 'provider', settings.provider || jsoncString(contents, 'provider'));
  }
  return summary;
}

function readProviderHomeConfiguration(provider: unknown, homePath: unknown): ProviderHomeConfiguration {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedHomePath = String(homePath || '').trim();
  const candidates = PROVIDER_CONFIGURATION_FILES[normalizedProvider] || [];
  const filePath = candidates.find(candidate => (
    normalizedHomePath && fs.existsSync(path.join(normalizedHomePath, candidate))
  )) || candidates[0] || '';
  if (!normalizedHomePath || !filePath) return { exists: false, filePath, summary: [] };

  const absolutePath = path.join(normalizedHomePath, filePath);
  if (!fs.existsSync(absolutePath)) return { exists: false, filePath, summary: [] };
  try {
    const contents = fs.readFileSync(absolutePath, 'utf8');
    return {
      exists: true,
      filePath,
      summary: normalizedProvider === 'codex'
        ? summarizeCodexConfiguration(contents)
        : summarizeJsonConfiguration(normalizedProvider, contents),
    };
  } catch {
    return { exists: true, filePath, summary: [] };
  }
}

export {
  PROVIDER_CONFIGURATION_FILES,
  readProviderHomeConfiguration,
  summarizeCodexConfiguration,
  summarizeJsonConfiguration,
};
