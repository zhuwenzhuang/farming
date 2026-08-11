const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_PLUGIN_MANIFESTS = 200;
const MAX_PLUGIN_ICON_BYTES = 64 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_PLUGINS_SCHEMA_PREFIX = 'https://agent-plugins.org/schemas/';
const AGENT_PLUGINS_V1_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\/(1\.0\.0)\/plugin\.schema\.json$/;
const AGENT_PLUGINS_NAME = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const TITLE_ACRONYMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['cli', 'CLI'],
  ['mcp', 'MCP'],
  ['sql', 'SQL'],
  ['ui', 'UI'],
  ['url', 'URL'],
]);

type AgentExtensionKind = 'skill' | 'mcp' | 'hook' | 'plugin' | 'command';
type AgentExtensionStatus = 'configured' | 'enabled' | 'disabled';

interface AgentExtensionItem {
  id: string;
  name: string;
  description: string;
  kind: AgentExtensionKind;
  scope: string;
  status: AgentExtensionStatus;
  sourceFile: string;
  icon?: string;
  iconDark?: string;
}

interface DiscoveryOptions {
  provider?: string;
  providerHomePath?: string;
}

interface PluginSource {
  manifestFile: string;
  pluginRoot: string;
  nativeStatus?: AgentExtensionStatus;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, limit = 500): string {
  return typeof value === 'string'
    ? value.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit)
    : '';
}

function readText(filePath: string): string {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  const contents = readText(filePath);
  if (!contents) return null;
  try {
    const value = JSON.parse(contents);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function titleFromName(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => TITLE_ACRONYMS.get(part.toLowerCase()) || part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || name;
}

function sourceFileWithin(homePath: string, absoluteFile: string): string {
  const relative = path.relative(homePath, absoluteFile);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  try {
    const realHome = fs.realpathSync(homePath);
    const realFile = fs.realpathSync(absoluteFile);
    const realRelative = path.relative(realHome, realFile);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return '';
  } catch {
    return '';
  }
  return relative.split(path.sep).join('/');
}

function safePluginPath(pluginRoot: string, configured: unknown, fallback: string): string {
  const raw = stringValue(configured) || fallback;
  if (!raw) return '';
  const resolved = path.resolve(pluginRoot, raw);
  const relative = path.relative(pluginRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return '';
  if (fs.existsSync(resolved)) {
    try {
      const realPluginRoot = fs.realpathSync(pluginRoot);
      const realResolved = fs.realpathSync(resolved);
      const realRelative = path.relative(realPluginRoot, realResolved);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return '';
    } catch {
      return '';
    }
  }
  return resolved;
}

function pluginIconDataUrl(pluginRoot: string, configured: unknown): string {
  const iconFile = safePluginPath(pluginRoot, configured, '');
  if (!iconFile) return '';
  try {
    const stats = fs.statSync(iconFile);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_PLUGIN_ICON_BYTES) return '';
    const extension = path.extname(iconFile).toLowerCase();
    const mime = new Map([
      ['.svg', 'image/svg+xml'],
      ['.png', 'image/png'],
      ['.webp', 'image/webp'],
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
    ]).get(extension);
    if (!mime) return '';
    const contents = fs.readFileSync(iconFile);
    if (extension === '.svg') {
      const svg = contents.toString('utf8');
      if (!/<svg(?:\s|>)/i.test(svg)) return '';
      if (/<(?:script|foreignObject|iframe|object|embed)(?:\s|>)/i.test(svg)) return '';
      if (/\son[a-z]+\s*=/i.test(svg)) return '';
      if (/(?:href|src)\s*=\s*["']\s*(?:https?:|\/\/|data:)/i.test(svg)) return '';
      if (/url\(\s*["']?\s*(?:https?:|\/\/|data:)/i.test(svg)) return '';
    }
    return `data:${mime};base64,${contents.toString('base64')}`;
  } catch {
    return '';
  }
}

function addItem(items: AgentExtensionItem[], item: AgentExtensionItem): void {
  if (items.length >= MAX_ITEMS || !item.name || !item.sourceFile) return;
  const key = `${item.kind}\0${item.sourceFile}\0${item.name}`.toLowerCase();
  if (items.some(existing => `${existing.kind}\0${existing.sourceFile}\0${existing.name}`.toLowerCase() === key)) return;
  items.push(item);
}

function parseMarkdownFrontMatter(filePath: string): { name: string; description: string } {
  const contents = readText(filePath).slice(0, 32 * 1024);
  const frontMatter = contents.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)?.[1] || '';
  const fields = new Map<string, string>();
  frontMatter.split(/\r?\n/).forEach(line => {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) return;
    fields.set(match[1].toLowerCase(), match[2].trim().replace(/^['"]|['"]$/g, ''));
  });
  return {
    name: stringValue(fields.get('name'), 128),
    description: stringValue(fields.get('description')),
  };
}

function discoverSkillDirectory(
  items: AgentExtensionItem[],
  homePath: string,
  skillsDir: string,
  scope: string,
  pluginName = '',
): void {
  let entries: import('fs').Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach(entry => {
    if (!entry.isDirectory() || !SAFE_NAME.test(entry.name)) return;
    const sourceFile = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(sourceFile)) return;
    const metadata = parseMarkdownFrontMatter(sourceFile);
    const name = metadata.name || titleFromName(entry.name);
    addItem(items, {
      id: `skill:${pluginName || scope}:${entry.name}`,
      name: pluginName ? `${pluginName}: ${name}` : name,
      description: metadata.description || `Skill from ${scope.toLowerCase()}`,
      kind: 'skill',
      scope,
      status: 'configured',
      sourceFile: sourceFileWithin(homePath, sourceFile),
    });
  });
}

function discoverCommandDirectory(
  items: AgentExtensionItem[],
  homePath: string,
  commandsDir: string,
  scope: string,
  pluginName = '',
): void {
  let entries: import('fs').Dirent[] = [];
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.md')) return;
    const commandName = entry.name.slice(0, -3);
    if (!SAFE_NAME.test(commandName)) return;
    const sourceFile = path.join(commandsDir, entry.name);
    const metadata = parseMarkdownFrontMatter(sourceFile);
    addItem(items, {
      id: `command:${pluginName || scope}:${commandName}`,
      name: pluginName ? `${pluginName}: ${metadata.name || titleFromName(commandName)}` : metadata.name || titleFromName(commandName),
      description: metadata.description || `Command from ${scope.toLowerCase()}`,
      kind: 'command',
      scope,
      status: 'configured',
      sourceFile: sourceFileWithin(homePath, sourceFile),
    });
  });
}

function mcpStatus(configuration: Record<string, unknown>): AgentExtensionStatus {
  return configuration.enabled === false || configuration.disabled === true ? 'disabled' : 'configured';
}

function mcpDescription(configuration: Record<string, unknown>): string {
  const explicit = stringValue(configuration.description);
  if (explicit) return explicit;
  const command = stringValue(configuration.command, 160);
  if (command) return `stdio · ${path.basename(command)}`;
  const url = stringValue(configuration.url, 300) || stringValue(configuration.serverUrl, 300);
  if (url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol.replace(':', '').toUpperCase()} · ${parsed.host}`;
    } catch {
      return 'Remote MCP server';
    }
  }
  return 'MCP server configuration';
}

function discoverMcpMap(
  items: AgentExtensionItem[],
  homePath: string,
  sourceFile: string,
  rawMap: unknown,
  scope: string,
  pluginName = '',
): void {
  Object.entries(recordValue(rawMap)).slice(0, MAX_ITEMS).forEach(([name, rawConfiguration]) => {
    if (!SAFE_NAME.test(name)) return;
    const configuration = recordValue(rawConfiguration);
    addItem(items, {
      id: `mcp:${pluginName || scope}:${name}`,
      name: stringValue(configuration.title, 128) || (pluginName ? `${pluginName}: ${titleFromName(name)}` : titleFromName(name)),
      description: mcpDescription(configuration),
      kind: 'mcp',
      scope,
      status: mcpStatus(configuration),
      sourceFile: sourceFileWithin(homePath, sourceFile),
    });
  });
}

function discoverMcpFile(
  items: AgentExtensionItem[],
  homePath: string,
  sourceFile: string,
  scope: string,
  pluginName = '',
): void {
  const document = readJson(sourceFile);
  if (!document) return;
  discoverMcpMap(items, homePath, sourceFile, document.mcpServers || document.servers || document, scope, pluginName);
}

function discoverAgentPluginsV1McpFile(
  items: AgentExtensionItem[],
  homePath: string,
  sourceFile: string,
  pluginName: string,
  schemaVersion: string,
): void {
  const document = readJson(sourceFile);
  if (!document) return;
  if (document.$schema !== `https://agent-plugins.org/schemas/${schemaVersion}/mcp.schema.json`) return;
  if (!document.mcpServers || typeof document.mcpServers !== 'object' || Array.isArray(document.mcpServers)) return;
  discoverMcpMap(items, homePath, sourceFile, document.mcpServers, 'Plugin', pluginName);
}

function discoverHookMap(
  items: AgentExtensionItem[],
  homePath: string,
  sourceFile: string,
  rawHooks: unknown,
  scope: string,
  pluginName = '',
): void {
  Object.entries(recordValue(rawHooks)).slice(0, MAX_ITEMS).forEach(([eventName, rawGroups]) => {
    if (!SAFE_NAME.test(eventName)) return;
    const groups = Array.isArray(rawGroups) ? rawGroups : [rawGroups];
    let handlerCount = 0;
    groups.forEach(group => {
      const hooks = recordValue(group).hooks;
      handlerCount += Array.isArray(hooks) ? hooks.length : (hooks ? 1 : 0);
    });
    addItem(items, {
      id: `hook:${pluginName || scope}:${eventName}`,
      name: pluginName ? `${pluginName}: ${titleFromName(eventName)}` : titleFromName(eventName),
      description: `${handlerCount || groups.length} configured handler${handlerCount === 1 ? '' : 's'}`,
      kind: 'hook',
      scope,
      status: 'configured',
      sourceFile: sourceFileWithin(homePath, sourceFile),
    });
  });
}

function discoverHookFile(
  items: AgentExtensionItem[],
  homePath: string,
  sourceFile: string,
  scope: string,
  pluginName = '',
): void {
  const document = readJson(sourceFile);
  if (!document) return;
  discoverHookMap(items, homePath, sourceFile, document.hooks || document, scope, pluginName);
}

function manifestPluginRoot(manifestFile: string): string {
  const manifestDir = path.dirname(manifestFile);
  return ['.codex-plugin', '.claude-plugin', '.qoder-plugin', '.plugin'].includes(path.basename(manifestDir))
    ? path.dirname(manifestDir)
    : manifestDir;
}

function findPluginManifests(root: string): string[] {
  const manifests: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (depth > 8 || manifests.length >= MAX_PLUGIN_MANIFESTS) return;
    let entries: import('fs').Dirent[] = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (manifests.length >= MAX_PLUGIN_MANIFESTS) break;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        visit(path.join(directory, entry.name), depth + 1);
        continue;
      }
      if (entry.name !== 'plugin.json') continue;
      const manifestFile = path.join(directory, entry.name);
      const parentName = path.basename(directory);
      if (
        parentName === '.codex-plugin'
        || parentName === '.claude-plugin'
        || parentName === '.qoder-plugin'
        || parentName === '.plugin'
        || depth <= 3
      ) {
        manifests.push(manifestFile);
      }
    }
  };
  visit(root, 0);
  return manifests;
}

function claudePluginSources(homePath: string, settings: Record<string, unknown>): PluginSource[] {
  const enabledPlugins = recordValue(settings.enabledPlugins);
  const installedFile = path.join(homePath, 'plugins', 'installed_plugins.json');
  const installed = recordValue(readJson(installedFile)?.plugins);
  const sources: PluginSource[] = [];
  Object.entries(installed).slice(0, MAX_PLUGIN_MANIFESTS).forEach(([pluginId, rawEntries]) => {
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    entries.forEach(rawEntry => {
      const installPath = stringValue(recordValue(rawEntry).installPath, 2000);
      if (!installPath) return;
      const candidates = [
        path.join(installPath, '.claude-plugin', 'plugin.json'),
        path.join(installPath, 'plugin.json'),
      ];
      const manifestFile = candidates.find(candidate => fs.existsSync(candidate));
      if (!manifestFile) return;
      sources.push({
        manifestFile,
        pluginRoot: manifestPluginRoot(manifestFile),
        nativeStatus: enabledPlugins[pluginId] === true
          ? 'enabled'
          : enabledPlugins[pluginId] === false
            ? 'disabled'
            : 'configured',
      });
    });
  });
  let directEntries: import('fs').Dirent[] = [];
  try {
    directEntries = fs.readdirSync(path.join(homePath, 'plugins'), { withFileTypes: true });
  } catch {
    // A Home does not have to contain plugins.
  }
  directEntries.forEach(entry => {
    if (!entry.isDirectory() || entry.name === 'cache' || entry.name === 'marketplaces') return;
    const manifestFile = path.join(homePath, 'plugins', entry.name, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) return;
    sources.push({
      manifestFile,
      pluginRoot: manifestPluginRoot(manifestFile),
      nativeStatus: 'configured',
    });
  });
  return sources;
}

function providerPluginSources(homePath: string, settings: Record<string, unknown>): PluginSource[] {
  const enabledPlugins = recordValue(settings.enabledPlugins);
  return findPluginManifests(path.join(homePath, 'plugins')).map(manifestFile => {
    const pluginRoot = manifestPluginRoot(manifestFile);
    const manifest = readJson(manifestFile) || {};
    const candidateNames = new Set([
      stringValue(manifest.name, 128),
      path.basename(pluginRoot),
    ].filter(Boolean));
    const nativeEntry = Object.entries(enabledPlugins).find(([pluginId]) => (
      candidateNames.has(pluginId.split('@')[0] || '')
    ));
    return {
      manifestFile,
      pluginRoot,
      nativeStatus: nativeEntry?.[1] === true
        ? 'enabled'
        : nativeEntry?.[1] === false
          ? 'disabled'
          : 'configured',
    };
  });
}

function discoverPlugin(
  items: AgentExtensionItem[],
  homePath: string,
  source: PluginSource,
): void {
  const firstPluginItemIndex = items.length;
  const manifest = readJson(source.manifestFile);
  if (!manifest) return;
  const pluginRoot = source.pluginRoot;
  const declaredSchema = stringValue(manifest.$schema);
  const agentPluginsSchema = declaredSchema.match(AGENT_PLUGINS_V1_SCHEMA);
  if (declaredSchema.startsWith(AGENT_PLUGINS_SCHEMA_PREFIX) && !agentPluginsSchema) return;
  const agentPluginsSchemaVersion = agentPluginsSchema?.[1] || '';
  const interfaceMetadata = recordValue(manifest.interface);
  const rawName = agentPluginsSchemaVersion
    ? stringValue(manifest.name, 128)
    : stringValue(manifest.name, 128) || path.basename(pluginRoot);
  if (
    agentPluginsSchemaVersion
    && (
      !AGENT_PLUGINS_NAME.test(rawName)
      || rawName.includes('--')
      || rawName.includes('..')
    )
  ) return;
  const pluginName = stringValue(interfaceMetadata.displayName, 128)
    || stringValue(manifest.displayName, 128)
    || titleFromName(rawName);
  const description = stringValue(interfaceMetadata.shortDescription)
    || stringValue(manifest.description)
    || 'Agent plugin';
  const icon = pluginIconDataUrl(
    pluginRoot,
    interfaceMetadata.logo || interfaceMetadata.composerIcon || manifest.logo || manifest.icon,
  );
  const iconDark = pluginIconDataUrl(pluginRoot, interfaceMetadata.logoDark || manifest.logoDark);
  addItem(items, {
    id: `plugin:${rawName}`,
    name: pluginName,
    description,
    kind: 'plugin',
    scope: stringValue(manifest.version, 64) ? `Plugin · ${stringValue(manifest.version, 64)}` : 'Plugin',
    status: source.nativeStatus || 'configured',
    sourceFile: sourceFileWithin(homePath, source.manifestFile),
    ...(icon ? { icon } : {}),
    ...(iconDark ? { iconDark } : {}),
  });

  if (agentPluginsSchemaVersion) {
    const skillsDir = safePluginPath(pluginRoot, './skills', '');
    if (skillsDir) discoverSkillDirectory(items, homePath, skillsDir, 'Plugin', rawName);
    const mcpFile = safePluginPath(pluginRoot, './mcp.json', '');
    if (mcpFile && fs.existsSync(mcpFile)) {
      discoverAgentPluginsV1McpFile(items, homePath, mcpFile, rawName, agentPluginsSchemaVersion);
    }
    return;
  }

  const skillsDir = safePluginPath(pluginRoot, manifest.skills, 'skills');
  if (skillsDir) discoverSkillDirectory(items, homePath, skillsDir, 'Plugin', rawName);
  const commandsDir = safePluginPath(pluginRoot, manifest.commands, 'commands');
  if (commandsDir) discoverCommandDirectory(items, homePath, commandsDir, 'Plugin', rawName);

  if (manifest.mcpServers && typeof manifest.mcpServers === 'object' && !Array.isArray(manifest.mcpServers)) {
    discoverMcpMap(items, homePath, source.manifestFile, manifest.mcpServers, 'Plugin', rawName);
  } else {
    const configuredMcp = safePluginPath(pluginRoot, manifest.mcpServers || manifest.mcp, '');
    const mcpFile = configuredMcp || [path.join(pluginRoot, 'mcp.json'), path.join(pluginRoot, '.mcp.json')]
      .find(candidate => fs.existsSync(candidate)) || '';
    if (mcpFile) discoverMcpFile(items, homePath, mcpFile, 'Plugin', rawName);
  }

  if (manifest.hooks && typeof manifest.hooks === 'object' && !Array.isArray(manifest.hooks)) {
    discoverHookMap(items, homePath, source.manifestFile, manifest.hooks, 'Plugin', rawName);
  } else {
    const configuredHooks = safePluginPath(pluginRoot, manifest.hooks, '');
    const hooksFile = configuredHooks || [path.join(pluginRoot, 'hooks', 'hooks.json'), path.join(pluginRoot, 'hooks.json')]
      .find(candidate => fs.existsSync(candidate)) || '';
    if (hooksFile) discoverHookFile(items, homePath, hooksFile, 'Plugin', rawName);
  }
  if (source.nativeStatus === 'enabled' || source.nativeStatus === 'disabled') {
    items.slice(firstPluginItemIndex).forEach(item => {
      item.status = source.nativeStatus as AgentExtensionStatus;
    });
  }
}

function discoverCodexTomlMcp(items: AgentExtensionItem[], homePath: string): void {
  const sourceFile = path.join(homePath, 'config.toml');
  const contents = readText(sourceFile);
  if (!contents) return;
  const sections = contents.split(/^\s*\[mcp_servers\.((?:"(?:\\.|[^"])*")|[^\]]+)\]\s*$/m);
  for (let index = 1; index < sections.length; index += 2) {
    const rawName = (sections[index] || '').trim();
    if (!rawName.startsWith('"') && rawName.includes('.')) continue;
    const name = rawName.startsWith('"')
      ? (() => { try { return JSON.parse(rawName); } catch { return ''; } })()
      : rawName;
    if (!SAFE_NAME.test(name)) continue;
    const body = sections[index + 1] || '';
    const disabled = /^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(body);
    const command = body.match(/^\s*command\s*=\s*["']([^"']+)["']/m)?.[1] || '';
    addItem(items, {
      id: `mcp:home:${name}`,
      name: titleFromName(name),
      description: command ? `stdio · ${path.basename(command)}` : 'MCP server configuration',
      kind: 'mcp',
      scope: 'Home',
      status: disabled ? 'disabled' : 'configured',
      sourceFile: sourceFileWithin(homePath, sourceFile),
    });
  }
}

function discoverAgentExtensions({ provider, providerHomePath }: DiscoveryOptions = {}): AgentExtensionItem[] {
  const normalizedProvider = stringValue(provider, 64).toLowerCase();
  const rawHomePath = stringValue(providerHomePath, 2000);
  if (!normalizedProvider || !rawHomePath) return [];
  const homePath = path.resolve(rawHomePath);
  if (!fs.existsSync(homePath)) return [];

  const items: AgentExtensionItem[] = [];
  discoverSkillDirectory(items, homePath, path.join(homePath, 'skills'), 'Home');
  discoverCommandDirectory(items, homePath, path.join(homePath, 'commands'), 'Home');

  const settingsFile = path.join(homePath, 'settings.json');
  const settings = readJson(settingsFile) || {};
  if (settings.hooks) discoverHookMap(items, homePath, settingsFile, settings.hooks, 'Home');
  if (settings.mcpServers) discoverMcpMap(items, homePath, settingsFile, settings.mcpServers, 'Home');

  const hooksFile = path.join(homePath, 'hooks.json');
  if (fs.existsSync(hooksFile)) discoverHookFile(items, homePath, hooksFile, 'Home');
  const mcpFile = path.join(homePath, 'mcp.json');
  if (fs.existsSync(mcpFile)) discoverMcpFile(items, homePath, mcpFile, 'Home');

  if (normalizedProvider === 'codex') discoverCodexTomlMcp(items, homePath);

  const pluginSources = normalizedProvider === 'claude'
    ? claudePluginSources(homePath, settings)
    : providerPluginSources(homePath, settings);
  const seenPluginRoots = new Set<string>();
  pluginSources.forEach(source => {
    let canonicalRoot = source.pluginRoot;
    try { canonicalRoot = fs.realpathSync(source.pluginRoot); } catch { /* Keep normalized path. */ }
    if (seenPluginRoots.has(canonicalRoot)) return;
    seenPluginRoots.add(canonicalRoot);
    discoverPlugin(items, homePath, source);
  });

  return items.sort((left, right) => (
    left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || left.sourceFile.localeCompare(right.sourceFile)
  ));
}

export {
  discoverAgentExtensions,
};
export type {
  AgentExtensionItem,
};
