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

function stripJsoncComments(contents: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index] || '';
    const next = contents[index + 1] || '';
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === '/' && next === '/') {
      lineComment = true;
      result += '  ';
      index += 1;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      result += '  ';
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

function stripJsoncTrailingCommas(contents: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents[index] || '';
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }
    if (character === ',') {
      let lookahead = index + 1;
      while (/\s/.test(contents[lookahead] || '')) lookahead += 1;
      if (contents[lookahead] === '}' || contents[lookahead] === ']') {
        result += ' ';
        continue;
      }
    }
    result += character;
  }
  return result;
}

function parseJsoncObject(contents: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripJsoncTrailingCommas(stripJsoncComments(contents)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function summarizeJsonConfiguration(provider: string, contents: string): ConfigurationSummaryEntry[] {
  const settings = parseJsoncObject(contents);

  const summary: ConfigurationSummaryEntry[] = [];
  const modelRecord = settings.model && typeof settings.model === 'object' && !Array.isArray(settings.model)
    ? settings.model as Record<string, unknown>
    : {};
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env)
    ? settings.env as Record<string, unknown>
    : {};
  const model = scalarText(settings.model)
    || scalarText(modelRecord.name)
    || scalarText(env.ANTHROPIC_MODEL);
  pushSummary(summary, 'model', model);

  if (provider === 'claude') {
    pushSummary(summary, 'reasoning', settings.effortLevel);
    pushSummary(summary, 'permission', settings.permissionMode);
  }
  if (provider === 'opencode') {
    pushSummary(summary, 'provider', settings.provider);
  }
  return summary;
}

interface ProviderConfigurationDefinition {
  files: string[];
  summarize(contents: string): ConfigurationSummaryEntry[];
}

const PROVIDER_CONFIGURATION_DEFINITIONS: Record<string, ProviderConfigurationDefinition> = {
  codex: {
    files: ['config.toml'],
    summarize: summarizeCodexConfiguration,
  },
  claude: {
    files: ['settings.json'],
    summarize: contents => summarizeJsonConfiguration('claude', contents),
  },
  opencode: {
    files: ['opencode.jsonc', 'opencode.json'],
    summarize: contents => summarizeJsonConfiguration('opencode', contents),
  },
  qoder: {
    files: ['settings.json'],
    summarize: contents => summarizeJsonConfiguration('qoder', contents),
  },
  qwen: {
    files: ['settings.json'],
    summarize: contents => summarizeJsonConfiguration('qwen', contents),
  },
};

const PROVIDER_CONFIGURATION_FILES: Record<string, string[]> = Object.fromEntries(
  Object.entries(PROVIDER_CONFIGURATION_DEFINITIONS).map(([provider, definition]) => [
    provider,
    [...definition.files],
  ]),
);

function readProviderHomeConfiguration(provider: unknown, homePath: unknown): ProviderHomeConfiguration {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const normalizedHomePath = String(homePath || '').trim();
  const definition = PROVIDER_CONFIGURATION_DEFINITIONS[normalizedProvider];
  const candidates = definition?.files || [];
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
      summary: definition?.summarize(contents) || [],
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
