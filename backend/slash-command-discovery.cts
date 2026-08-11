const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILL_BYTES = 16 * 1024;
const MAX_DISCOVERED_SKILLS = 200;
const LABEL_ACRONYMS = new Map<string, string>([
  ['ai', 'AI'],
  ['api', 'API'],
  ['bff', 'BFF'],
  ['ci', 'CI'],
  ['cli', 'CLI'],
  ['crt', 'CRT'],
  ['css', 'CSS'],
  ['csv', 'CSV'],
  ['e2e', 'E2E'],
  ['gh', 'GH'],
  ['github', 'GitHub'],
  ['html', 'HTML'],
  ['json', 'JSON'],
  ['mcp', 'MCP'],
  ['pdf', 'PDF'],
  ['pr', 'PR'],
  ['sql', 'SQL'],
  ['ui', 'UI'],
  ['url', 'URL'],
  ['ux', 'UX'],
  ['xml', 'XML'],
  ['yaml', 'YAML'],
]);

type SupportedProvider = 'codex' | 'claude';
type CommandSource = 'custom' | 'plugin' | 'skill';

interface DiscoveredCommand {
  command: string;
  description: string;
  label: string;
  scope: string;
  source: CommandSource;
}

interface SkillFrontMatter {
  description?: string;
  name?: string;
}

interface DiscoveryOptions {
  homeDir?: string;
  provider?: string;
  providerHomePath?: string;
  workspace?: string;
}

interface SkillMentionOptions {
  fallbackName?: string;
  mentionPrefix?: string;
  scope?: string;
  source?: CommandSource;
}

function normalizeProvider(provider: unknown): SupportedProvider | '' {
  const value = String(provider || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDER_EXTENSION_DISCOVERY, value)
    ? value as SupportedProvider
    : '';
}

function normalizeWorkspace(workspace: unknown, homeDir = os.homedir()): string {
  if (typeof workspace !== 'string') return '';
  const value = workspace.trim();
  if (!value) return '';
  return path.resolve(value.replace(/^~(?=$|[/\\])/, homeDir));
}

function commandLabel(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => LABEL_ACRONYMS.get(part.toLowerCase()) || part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || name;
}

async function readFilePrefix(filePath: string, limit = MAX_SKILL_BYTES): Promise<string> {
  let handle: import('fs/promises').FileHandle | null = null;
  try {
    const opened = await fs.promises.open(filePath, 'r');
    handle = opened;
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await opened.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Ignore close failures for best-effort discovery.
      }
    }
  }
}

async function parseSkillFrontMatter(skillFile: string): Promise<SkillFrontMatter> {
  const prefix = await readFilePrefix(skillFile);
  const match = prefix.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};

  const metadata: SkillFrontMatter = {};
  match[1].split(/\r?\n/).forEach(line => {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) return;
    const fieldName = field[1];
    const value = field[2]
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (fieldName === 'name' || fieldName === 'description') {
      metadata[fieldName] = value;
    }
  });
  return metadata;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string): Promise<string> {
  let current = startDir;
  while (current && current !== path.dirname(current)) {
    if (await pathExists(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return '';
}

async function workspaceSkillRoots(workspace: unknown, homeDir: string): Promise<string[]> {
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  if (!normalizedWorkspace) return [];

  const gitRoot = await findGitRoot(normalizedWorkspace) || normalizedWorkspace;
  const roots = [];
  let current = normalizedWorkspace;
  while (current && current.startsWith(gitRoot)) {
    roots.push(path.join(current, '.agents', 'skills'));
    if (current === gitRoot) break;
    current = path.dirname(current);
  }
  return roots;
}

function addCommand(commands: DiscoveredCommand[], command: DiscoveredCommand): void {
  const commandId = command.command.toLowerCase();
  if (commands.some(item => item.command.toLowerCase() === commandId)) return;
  commands.push(command);
}

async function addSkillMention(commands: DiscoveredCommand[], skillFile: string, {
  mentionPrefix = '',
  fallbackName = '',
  scope = 'Personal',
  source = 'skill',
}: SkillMentionOptions = {}): Promise<void> {
  const metadata = await parseSkillFrontMatter(skillFile);
  const rawName = String(metadata.name || fallbackName || path.basename(path.dirname(skillFile))).trim();
  if (!SAFE_COMMAND_NAME.test(rawName)) return;
  if (mentionPrefix && !SAFE_COMMAND_NAME.test(mentionPrefix)) return;

  const mentionName = mentionPrefix ? `${mentionPrefix}:${rawName}` : rawName;
  addCommand(commands, {
    command: `$${mentionName}`,
    label: commandLabel(rawName),
    description: metadata.description || `Codex skill from ${scope.toLowerCase()}`,
    source,
    scope,
  });
}

async function discoverClaudeSkillCommands(
  commands: DiscoveredCommand[],
  skillsDir: string,
  sourceLabel: string,
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_COMMAND_NAME.test(entry.name)) continue;
    if (!await pathExists(path.join(skillsDir, entry.name, 'SKILL.md'))) continue;
    addCommand(commands, {
      command: `/${entry.name}`,
      label: commandLabel(entry.name),
      description: `Claude skill from ${sourceLabel}`,
      source: 'skill',
      scope: sourceLabel === 'home' ? 'Personal' : commandLabel(sourceLabel),
    });
  }
}

async function discoverClaudeCustomCommands(
  commands: DiscoveredCommand[],
  commandsDir: string,
  sourceLabel: string,
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!SAFE_COMMAND_NAME.test(name)) continue;
    addCommand(commands, {
      command: `/${name}`,
      label: commandLabel(name),
      description: `Claude custom command from ${sourceLabel}`,
      source: 'custom',
      scope: sourceLabel === 'home' ? 'Personal' : commandLabel(sourceLabel),
    });
  }
}

async function discoverClaudePluginComponents(
  commands: DiscoveredCommand[],
  pluginPath: string,
  pluginName: string,
): Promise<void> {
  const skillFiles = await discoverSkillFiles(path.join(pluginPath, 'skills'));
  for (const skillFile of skillFiles) {
    const skillName = path.basename(path.dirname(skillFile));
    const metadata = await parseSkillFrontMatter(skillFile);
    addCommand(commands, {
      command: `/${pluginName}:${skillName}`,
      label: commandLabel(metadata.name || skillName),
      description: metadata.description || `Claude skill from ${pluginName}`,
      source: 'skill',
      scope: 'Plugin',
    });
  }

  let commandEntries: import('fs').Dirent[] = [];
  try {
    commandEntries = await fs.promises.readdir(path.join(pluginPath, 'commands'), { withFileTypes: true });
  } catch {
    // Plugins do not have to provide commands.
  }
  for (const entry of commandEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const commandName = entry.name.slice(0, -3);
    if (!SAFE_COMMAND_NAME.test(commandName)) continue;
    addCommand(commands, {
      command: `/${pluginName}:${commandName}`,
      label: commandLabel(commandName),
      description: `Claude command from ${pluginName}`,
      source: 'custom',
      scope: 'Plugin',
    });
  }
}

async function readBoundedJson(
  filePath: string,
  maxBytes = 1024 * 1024,
): Promise<Record<string, unknown> | null> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size > maxBytes) return null;
    const value = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function addClaudePlugin(
  commands: DiscoveredCommand[],
  pluginName: string,
  pluginPath: string,
  scope = 'Plugin',
): Promise<void> {
  if (!SAFE_COMMAND_NAME.test(pluginName)) return;
  const manifest = await readBoundedJson(path.join(pluginPath, '.claude-plugin', 'plugin.json'));
  addCommand(commands, {
    command: `plugin:${pluginName}`,
    label: String(manifest?.name || commandLabel(pluginName)).slice(0, 100),
    description: String(manifest?.description || 'Claude Code plugin').slice(0, 500),
    source: 'plugin',
    scope,
  });
  await discoverClaudePluginComponents(commands, pluginPath, pluginName);
}

async function discoverClaudeInstalledPlugins(
  commands: DiscoveredCommand[],
  homePath: string,
): Promise<void> {
  const pluginsRoot = path.join(homePath, 'plugins');
  const installed = await readBoundedJson(path.join(pluginsRoot, 'installed_plugins.json'));
  const installedPlugins = installed?.plugins && typeof installed.plugins === 'object'
    && !Array.isArray(installed.plugins)
    ? installed.plugins as Record<string, unknown>
    : {};
  for (const [key, rawEntries] of Object.entries(installedPlugins).slice(0, MAX_DISCOVERED_SKILLS)) {
    const pluginName = key.split('@')[0];
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    const installedEntry = entries.find((entry): entry is Record<string, unknown> => (
      entry !== null
      && typeof entry === 'object'
      && typeof (entry as Record<string, unknown>).installPath === 'string'
    ));
    if (!installedEntry) continue;
    await addClaudePlugin(
      commands,
      pluginName,
      installedEntry.installPath as string,
      String(installedEntry.scope || 'Plugin'),
    );
  }

  let entries: import('fs').Dirent[] = [];
  try {
    entries = await fs.promises.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_COMMAND_NAME.test(entry.name)) continue;
    const pluginPath = path.join(pluginsRoot, entry.name);
    if (!await pathExists(path.join(pluginPath, '.claude-plugin', 'plugin.json'))) continue;
    await addClaudePlugin(commands, entry.name, pluginPath);
  }
}

async function discoverClaudeSlashCommands({
  homeDir = os.homedir(),
  workspace,
}: DiscoveryOptions = {}): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  const roots = [];

  if (normalizedWorkspace) {
    roots.push({ root: path.join(normalizedWorkspace, '.claude'), label: 'workspace' });
  }
  roots.push({ root: path.join(homeDir, '.claude'), label: 'home' });

  for (const { root, label } of roots) {
    await discoverClaudeSkillCommands(commands, path.join(root, 'skills'), label);
    await discoverClaudeCustomCommands(commands, path.join(root, 'commands'), label);
  }

  return commands;
}

async function discoverSkillFiles(skillsDir: string): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter(entry => entry.isDirectory() && SAFE_COMMAND_NAME.test(entry.name))
    .map(entry => path.join(skillsDir, entry.name, 'SKILL.md'));
  const skillFiles: string[] = [];
  for (const skillFile of candidates) {
    if (await pathExists(skillFile)) skillFiles.push(skillFile);
  }
  return skillFiles;
}

async function discoverDirectCodexSkills(
  commands: DiscoveredCommand[],
  skillsDir: string,
  scope: string,
): Promise<void> {
  for (const skillFile of await discoverSkillFiles(skillsDir)) {
    await addSkillMention(commands, skillFile, { scope, source: 'skill' });
  }
}

async function discoverPluginSkillFiles(
  root: string,
  depth = 0,
  skillFiles: string[] = [],
): Promise<string[]> {
  if (depth > 8 || skillFiles.length >= MAX_DISCOVERED_SKILLS) return skillFiles;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return skillFiles;
  }

  for (const entry of entries) {
    if (skillFiles.length >= MAX_DISCOVERED_SKILLS) break;
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md' && path.basename(path.dirname(entryPath)) !== 'skills') {
      skillFiles.push(entryPath);
      continue;
    }
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await discoverPluginSkillFiles(entryPath, depth + 1, skillFiles);
    }
  }

  return skillFiles;
}

function pluginNameForSkillFile(skillFile: string, pluginsCacheDir: string): string {
  const parts = path.relative(pluginsCacheDir, skillFile).split(path.sep);
  if ((parts[0] === 'openai-curated' || parts[0] === 'openai-curated-remote') && parts[1]) return parts[1];
  if ((parts[0] === 'openai-primary-runtime' || parts[0] === 'openai-bundled') && parts[1]) return parts[1];
  return parts[0] || '';
}

async function discoverCodexPluginSkills(commands: DiscoveredCommand[], homeDir: string): Promise<void> {
  const pluginsCacheDir = path.join(homeDir, '.codex', 'plugins', 'cache');
  await discoverCodexPluginSkillsAt(commands, pluginsCacheDir);
}

async function discoverCodexPluginSkillsAt(
  commands: DiscoveredCommand[],
  pluginsCacheDir: string,
): Promise<void> {
  for (const skillFile of await discoverPluginSkillFiles(pluginsCacheDir)) {
    const pluginName = pluginNameForSkillFile(skillFile, pluginsCacheDir);
    addCommand(commands, {
      command: `plugin:${pluginName}`,
      label: commandLabel(pluginName),
      description: 'Codex plugin',
      source: 'plugin',
      scope: 'Plugin',
    });
    await addSkillMention(commands, skillFile, {
      mentionPrefix: pluginName,
      fallbackName: path.basename(path.dirname(skillFile)),
      scope: 'Plugin',
      source: 'skill',
    });
  }
}

async function discoverCodexSkillMentions({
  homeDir = os.homedir(),
  workspace,
}: DiscoveryOptions = {}): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverDirectCodexSkills(commands, root, 'Repo');
  }
  await discoverDirectCodexSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Personal');
  await discoverDirectCodexSkills(commands, path.join(homeDir, '.codex', 'skills'), 'Personal');
  await discoverDirectCodexSkills(commands, path.join(homeDir, '.codex', 'skills', '.system'), 'System');
  await discoverDirectCodexSkills(commands, path.join('/etc', 'codex', 'skills'), 'Admin');
  await discoverCodexPluginSkills(commands, homeDir);
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverClaudeAgentExtensions(
  homePath: string,
  workspace: string | undefined,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace);
  if (normalizedWorkspace) {
    await discoverClaudeSkillCommands(commands, path.join(normalizedWorkspace, '.claude', 'skills'), 'workspace');
    await discoverClaudeCustomCommands(commands, path.join(normalizedWorkspace, '.claude', 'commands'), 'workspace');
  }
  await discoverClaudeSkillCommands(commands, path.join(homePath, 'skills'), 'home');
  await discoverClaudeCustomCommands(commands, path.join(homePath, 'commands'), 'home');
  await discoverClaudeInstalledPlugins(commands, homePath);
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverCodexAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverDirectCodexSkills(commands, root, 'Repo');
  }
  await discoverDirectCodexSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Personal');
  await discoverDirectCodexSkills(commands, path.join(homePath, 'skills'), 'Personal');
  await discoverDirectCodexSkills(commands, path.join(homePath, 'skills', '.system'), 'System');
  await discoverDirectCodexSkills(commands, path.join('/etc', 'codex', 'skills'), 'Admin');
  await discoverCodexPluginSkillsAt(commands, path.join(homePath, 'plugins', 'cache'));
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

interface ProviderExtensionDiscoveryDefinition {
  discoverAtHome(homePath: string, workspace: string | undefined, homeDir: string): Promise<DiscoveredCommand[]>;
  discoverLegacy(options: DiscoveryOptions): Promise<DiscoveredCommand[]>;
}

const PROVIDER_EXTENSION_DISCOVERY = {
  codex: {
    discoverAtHome: discoverCodexAgentExtensions,
    discoverLegacy: discoverCodexSkillMentions,
  },
  claude: {
    discoverAtHome: discoverClaudeAgentExtensions,
    discoverLegacy: discoverClaudeSlashCommands,
  },
} satisfies Record<SupportedProvider, ProviderExtensionDiscoveryDefinition>;

async function discoverAgentExtensions({
  provider,
  providerHomePath,
  workspace,
  homeDir = os.homedir(),
}: DiscoveryOptions = {}): Promise<DiscoveredCommand[]> {
  const normalizedProvider = normalizeProvider(provider);
  const homePath = normalizeWorkspace(providerHomePath);
  const normalizedHomeDir = normalizeWorkspace(homeDir) || os.homedir();
  if (!normalizedProvider || !homePath) return [];

  return PROVIDER_EXTENSION_DISCOVERY[normalizedProvider].discoverAtHome(
    homePath,
    workspace,
    normalizedHomeDir,
  );
}

async function discoverSlashCommands({
  provider,
  homeDir = os.homedir(),
  providerHomePath,
  workspace,
}: DiscoveryOptions = {}): Promise<DiscoveredCommand[]> {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider && normalizeWorkspace(providerHomePath)) {
    return await discoverAgentExtensions({
      provider: normalizedProvider,
      providerHomePath,
      workspace,
      homeDir,
    });
  }
  return normalizedProvider
    ? PROVIDER_EXTENSION_DISCOVERY[normalizedProvider].discoverLegacy({ homeDir, workspace })
    : [];
}

export {
  discoverAgentExtensions,
  discoverSlashCommands,
  discoverClaudeSlashCommands,
  discoverCodexSkillMentions,
};
