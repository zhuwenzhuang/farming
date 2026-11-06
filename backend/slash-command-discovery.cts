const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_COLON_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_SKILL_BYTES = 16 * 1024;
const MAX_DISCOVERED_SKILLS = 300;
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

type SupportedProvider = 'codex' | 'claude' | 'pi' | 'opencode' | 'qoder' | 'qwen' | 'agy';
type CommandSource = 'custom' | 'plugin' | 'skill';

interface DiscoveredCommand {
  skillPath?: string;
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
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const fieldName = field[1];
    let value = field[2]
      .trim()
      .replace(/^['"]|['"]$/g, '')
      .trim();
    if (/^[>|][-+]?$/.test(value) && (fieldName === 'name' || fieldName === 'description')) {
      const block: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) {
        block.push(lines[++index].trim());
      }
      value = block.join(' ');
    }
    if (fieldName === 'name' || fieldName === 'description') {
      metadata[fieldName] = value;
    }
  }
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
  if (commands.some(item => item.command.toLowerCase() === commandId
    && (command.source !== 'skill' || (item.source === 'skill' && item.scope === command.scope && item.skillPath === command.skillPath)))) return;
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
    skillPath: skillFile,
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
      skillPath: path.join(skillsDir, entry.name, 'SKILL.md'),
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
      skillPath: skillFile,
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

async function discoverProviderSlashSkills(
  commands: DiscoveredCommand[],
  skillsDir: string,
  providerLabel: string,
  scopeLabel: string,
  namespacePrefix = '',
): Promise<void> {
  for (const skillFile of await discoverSkillFiles(skillsDir)) {
    const dirName = path.basename(path.dirname(skillFile));
    const metadata = await parseSkillFrontMatter(skillFile);
    const rawName = String(metadata.name || dirName).trim();
    const skillName = SAFE_COMMAND_NAME.test(rawName) ? rawName : dirName;
    if (!SAFE_COMMAND_NAME.test(skillName)) continue;
    if (namespacePrefix && !SAFE_COMMAND_NAME.test(namespacePrefix)) continue;
    const commandName = namespacePrefix ? `${namespacePrefix}:${skillName}` : skillName;
    addCommand(commands, {
      skillPath: skillFile,
      command: `/${commandName}`,
      label: commandLabel(skillName),
      description: metadata.description || `${providerLabel} skill from ${scopeLabel.toLowerCase()}`,
      source: 'skill',
      scope: scopeLabel,
    });
  }
}

async function discoverProviderMarkdownCommands(
  commands: DiscoveredCommand[],
  commandsDir: string,
  providerLabel: string,
  scopeLabel: string,
  {
    namespacePrefix = '',
    recursive = false,
    relativePrefix = '',
    depth = 0,
  }: {
    namespacePrefix?: string;
    recursive?: boolean;
    relativePrefix?: string;
    depth?: number;
  } = {},
): Promise<void> {
  if (depth > 4 || commands.length >= MAX_DISCOVERED_SKILLS) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (commands.length >= MAX_DISCOVERED_SKILLS) break;
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(commandsDir, entry.name);
    if (recursive && entry.isDirectory() && SAFE_COMMAND_NAME.test(entry.name)) {
      const nextPrefix = relativePrefix ? `${relativePrefix}:${entry.name}` : entry.name;
      await discoverProviderMarkdownCommands(commands, entryPath, providerLabel, scopeLabel, {
        namespacePrefix,
        recursive,
        relativePrefix: nextPrefix,
        depth: depth + 1,
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const baseName = entry.name.slice(0, -3);
    if (!SAFE_COMMAND_NAME.test(baseName)) continue;
    const metadata = await parseSkillFrontMatter(entryPath);
    const scopedName = relativePrefix ? `${relativePrefix}:${baseName}` : baseName;
    const fullName = namespacePrefix ? `${namespacePrefix}:${scopedName}` : scopedName;
    if (!SAFE_COLON_COMMAND_NAME.test(fullName)) continue;
    addCommand(commands, {
      skillPath: entryPath,
      command: `/${fullName}`,
      label: commandLabel(metadata.name || baseName),
      description: metadata.description || `${providerLabel} command from ${scopeLabel.toLowerCase()}`,
      source: 'custom',
      scope: scopeLabel,
    });
  }
}

async function parseTomlCommandDescription(filePath: string): Promise<string> {
  const prefix = await readFilePrefix(filePath);
  if (!prefix) return '';
  const match = prefix.match(/^\s*description\s*=\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\r\n]*)"|'([^'\r\n]*)')/m);
  if (!match) return '';
  return String(match[1] || match[2] || match[3] || match[4] || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function discoverProviderTomlCommands(
  commands: DiscoveredCommand[],
  commandsDir: string,
  providerLabel: string,
  scopeLabel: string,
  {
    namespacePrefix = '',
    relativePrefix = '',
    depth = 0,
  }: {
    namespacePrefix?: string;
    relativePrefix?: string;
    depth?: number;
  } = {},
): Promise<void> {
  if (depth > 4 || commands.length >= MAX_DISCOVERED_SKILLS) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (commands.length >= MAX_DISCOVERED_SKILLS) break;
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(commandsDir, entry.name);
    if (entry.isDirectory() && SAFE_COMMAND_NAME.test(entry.name)) {
      const nextPrefix = relativePrefix ? `${relativePrefix}:${entry.name}` : entry.name;
      await discoverProviderTomlCommands(commands, entryPath, providerLabel, scopeLabel, {
        namespacePrefix,
        relativePrefix: nextPrefix,
        depth: depth + 1,
      });
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.toml')) continue;
    const baseName = entry.name.slice(0, -5);
    if (!SAFE_COMMAND_NAME.test(baseName)) continue;
    const scopedName = relativePrefix ? `${relativePrefix}:${baseName}` : baseName;
    const fullName = namespacePrefix ? `${namespacePrefix}:${scopedName}` : scopedName;
    if (!SAFE_COLON_COMMAND_NAME.test(fullName)) continue;
    const description = await parseTomlCommandDescription(entryPath);
    addCommand(commands, {
      skillPath: entryPath,
      command: `/${fullName}`,
      label: commandLabel(baseName),
      description: description || `${providerLabel} command from ${scopeLabel.toLowerCase()}`,
      source: 'custom',
      scope: scopeLabel,
    });
  }
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

async function discoverPiAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverProviderSlashSkills(commands, root, 'Pi', 'Workspace');
  }
  if (normalizedWorkspace) {
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.pi', 'skills'), 'Pi', 'Workspace');
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.pi', 'commands'), 'Pi', 'Workspace', { recursive: true });
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.pi', 'prompts'), 'Pi', 'Workspace', { recursive: true });
  }
  await discoverProviderSlashSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Pi', 'Personal');
  await discoverProviderSlashSkills(commands, path.join(homePath, 'skills'), 'Pi', 'Personal');
  await discoverProviderMarkdownCommands(commands, path.join(homePath, 'commands'), 'Pi', 'Personal', { recursive: true });
  await discoverProviderMarkdownCommands(commands, path.join(homePath, 'prompts'), 'Pi', 'Personal', { recursive: true });
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverOpenCodeAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverProviderSlashSkills(commands, root, 'OpenCode', 'Workspace');
  }
  if (normalizedWorkspace) {
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.opencode', 'skills'), 'OpenCode', 'Workspace');
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.opencode', 'skill'), 'OpenCode', 'Workspace');
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.opencode', 'commands'), 'OpenCode', 'Workspace', { recursive: true });
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.opencode', 'command'), 'OpenCode', 'Workspace', { recursive: true });
  }
  const homeRoots = [homePath];
  const dotOpenCode = path.join(homeDir, '.opencode');
  if (dotOpenCode !== homePath) homeRoots.push(dotOpenCode);
  const xdgOpenCode = path.join(homeDir, '.config', 'opencode');
  if (!homeRoots.includes(xdgOpenCode)) homeRoots.push(xdgOpenCode);

  await discoverProviderSlashSkills(commands, path.join(homeDir, '.agents', 'skills'), 'OpenCode', 'Personal');
  for (const root of homeRoots) {
    await discoverProviderSlashSkills(commands, path.join(root, 'skills'), 'OpenCode', 'Personal');
    await discoverProviderSlashSkills(commands, path.join(root, 'skill'), 'OpenCode', 'Personal');
    await discoverProviderMarkdownCommands(commands, path.join(root, 'commands'), 'OpenCode', 'Personal', { recursive: true });
    await discoverProviderMarkdownCommands(commands, path.join(root, 'command'), 'OpenCode', 'Personal', { recursive: true });
  }
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverQoderInstalledPlugins(
  commands: DiscoveredCommand[],
  homePath: string,
): Promise<void> {
  const pluginsRoot = path.join(homePath, 'plugins');
  for (const registryFile of ['installed_plugins_v2.json', 'installed_plugins.json']) {
    const installed = await readBoundedJson(path.join(pluginsRoot, registryFile));
    const installedPlugins = installed?.plugins && typeof installed.plugins === 'object'
      && !Array.isArray(installed.plugins)
      ? installed.plugins as Record<string, unknown>
      : {};
    for (const [key, rawEntries] of Object.entries(installedPlugins).slice(0, MAX_DISCOVERED_SKILLS)) {
      const pluginName = key.split('@')[0];
      if (!SAFE_COMMAND_NAME.test(pluginName)) continue;
      const entries = Array.isArray(rawEntries) ? rawEntries : [];
      const installedEntry = entries.find((entry): entry is Record<string, unknown> => (
        entry !== null
        && typeof entry === 'object'
        && typeof (entry as Record<string, unknown>).installPath === 'string'
      ));
      if (!installedEntry) continue;
      const pluginPath = installedEntry.installPath as string;
      const manifest = (await readBoundedJson(path.join(pluginPath, '.qoder-plugin', 'plugin.json')))
        || (await readBoundedJson(path.join(pluginPath, '.claude-plugin', 'plugin.json')))
        || (await readBoundedJson(path.join(pluginPath, 'plugin.json')));
      addCommand(commands, {
        command: `plugin:${pluginName}`,
        label: String(manifest?.name || commandLabel(pluginName)).slice(0, 100),
        description: String(manifest?.description || 'Qoder plugin').slice(0, 500),
        source: 'plugin',
        scope: String(installedEntry.scope || 'Plugin'),
      });
      await discoverProviderSlashSkills(commands, path.join(pluginPath, 'skills'), 'Qoder', 'Plugin', pluginName);
      await discoverProviderMarkdownCommands(commands, path.join(pluginPath, 'commands'), 'Qoder', 'Plugin', {
        namespacePrefix: pluginName,
        recursive: true,
      });
    }
  }

  const externalRegistry = await readBoundedJson(path.join(homePath, 'external-commands', 'registry.json'));
  const externalCommands = Array.isArray(externalRegistry?.commands) ? externalRegistry.commands : [];
  for (const item of externalCommands) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawName = String(record.name || record.command || '').trim().replace(/^\/+/, '');
    if (!SAFE_COLON_COMMAND_NAME.test(rawName)) continue;
    addCommand(commands, {
      command: `/${rawName}`,
      label: String(record.label || commandLabel(rawName)).slice(0, 100),
      description: String(record.description || 'Qoder external command').slice(0, 500),
      source: 'custom',
      scope: 'External',
    });
  }
}

async function discoverQoderAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverProviderSlashSkills(commands, root, 'Qoder', 'Workspace');
  }
  if (normalizedWorkspace) {
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.qoder', 'skills'), 'Qoder', 'Workspace');
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.qoder', 'commands'), 'Qoder', 'Workspace', { recursive: true });
  }
  await discoverProviderSlashSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Qoder', 'Personal');
  await discoverProviderSlashSkills(commands, path.join(homePath, 'skills'), 'Qoder', 'Personal');
  await discoverProviderMarkdownCommands(commands, path.join(homePath, 'commands'), 'Qoder', 'Personal', { recursive: true });
  await discoverQoderInstalledPlugins(commands, homePath);
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverQwenExtensions(
  commands: DiscoveredCommand[],
  homePath: string,
): Promise<void> {
  const extensionsRoot = path.join(homePath, 'extensions');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_COMMAND_NAME.test(entry.name)) continue;
    const extensionPath = path.join(extensionsRoot, entry.name);
    const manifest = (await readBoundedJson(path.join(extensionPath, '.qwen-extension.json')))
      || (await readBoundedJson(path.join(extensionPath, 'qwen-extension.json')));
    addCommand(commands, {
      command: `plugin:${entry.name}`,
      label: String(manifest?.name || commandLabel(entry.name)).slice(0, 100),
      description: String(manifest?.description || 'Qwen Code extension').slice(0, 500),
      source: 'plugin',
      scope: 'Plugin',
    });
    await discoverProviderSlashSkills(commands, path.join(extensionPath, 'skills'), 'Qwen', 'Plugin', entry.name);
    await discoverProviderMarkdownCommands(commands, path.join(extensionPath, 'commands'), 'Qwen', 'Plugin', {
      namespacePrefix: entry.name,
      recursive: true,
    });
    await discoverProviderTomlCommands(commands, path.join(extensionPath, 'commands'), 'Qwen', 'Plugin', {
      namespacePrefix: entry.name,
    });
  }
}

async function discoverQwenAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverProviderSlashSkills(commands, root, 'Qwen', 'Workspace');
  }
  if (normalizedWorkspace) {
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.qwen', 'skills'), 'Qwen', 'Workspace');
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.qwen', 'commands'), 'Qwen', 'Workspace', { recursive: true });
    await discoverProviderTomlCommands(commands, path.join(normalizedWorkspace, '.qwen', 'commands'), 'Qwen', 'Workspace');
  }
  await discoverProviderSlashSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Qwen', 'Personal');
  await discoverProviderSlashSkills(commands, path.join(homePath, 'skills'), 'Qwen', 'Personal');
  await discoverProviderMarkdownCommands(commands, path.join(homePath, 'commands'), 'Qwen', 'Personal', { recursive: true });
  await discoverProviderTomlCommands(commands, path.join(homePath, 'commands'), 'Qwen', 'Personal');
  await discoverQwenExtensions(commands, homePath);
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

async function discoverAgyInstalledPlugins(
  commands: DiscoveredCommand[],
  pluginsRoot: string,
): Promise<void> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.promises.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_COMMAND_NAME.test(entry.name)) continue;
    const pluginPath = path.join(pluginsRoot, entry.name);
    const manifest = (await readBoundedJson(path.join(pluginPath, 'plugin.json')))
      || (await readBoundedJson(path.join(pluginPath, '.gemini-plugin', 'plugin.json')));
    addCommand(commands, {
      command: `plugin:${entry.name}`,
      label: String(manifest?.name || commandLabel(entry.name)).slice(0, 100),
      description: String(manifest?.description || 'Antigravity plugin').slice(0, 500),
      source: 'plugin',
      scope: 'Plugin',
    });
    await discoverProviderSlashSkills(commands, path.join(pluginPath, 'skills'), 'Antigravity', 'Plugin', entry.name);
    await discoverProviderMarkdownCommands(commands, path.join(pluginPath, 'commands'), 'Antigravity', 'Plugin', {
      namespacePrefix: entry.name,
      recursive: true,
    });
  }
}

async function discoverAgyAgentExtensions(
  homePath: string,
  workspace: string | undefined,
  homeDir: string,
): Promise<DiscoveredCommand[]> {
  const commands: DiscoveredCommand[] = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  for (const root of await workspaceSkillRoots(workspace, homeDir)) {
    await discoverProviderSlashSkills(commands, root, 'Antigravity', 'Workspace');
  }
  if (normalizedWorkspace) {
    await discoverProviderSlashSkills(commands, path.join(normalizedWorkspace, '.gemini', 'skills'), 'Antigravity', 'Workspace');
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.gemini', 'commands'), 'Antigravity', 'Workspace', { recursive: true });
    await discoverProviderMarkdownCommands(commands, path.join(normalizedWorkspace, '.agents', 'commands'), 'Antigravity', 'Workspace', { recursive: true });
  }
  await discoverProviderSlashSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Antigravity', 'Personal');
  await discoverProviderSlashSkills(commands, path.join(homeDir, '.gemini', 'config', 'skills'), 'Antigravity', 'Personal');
  await discoverProviderMarkdownCommands(commands, path.join(homeDir, '.gemini', 'config', 'commands'), 'Antigravity', 'Personal', { recursive: true });
  await discoverProviderSlashSkills(commands, path.join(homePath, 'skills'), 'Antigravity', 'Personal');
  await discoverProviderMarkdownCommands(commands, path.join(homePath, 'commands'), 'Antigravity', 'Personal', { recursive: true });
  await discoverProviderSlashSkills(commands, path.join(homePath, 'builtin', 'skills'), 'Antigravity', 'System');
  await discoverAgyInstalledPlugins(commands, path.join(homePath, 'plugins'));
  await discoverAgyInstalledPlugins(commands, path.join(homeDir, '.gemini', 'config', 'plugins'));
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

interface ProviderSlashCommandSpec {
  command: string;
  description: string;
  label?: string;
  scope?: string;
}

const PROVIDER_SLASH_COMMANDS: Record<SupportedProvider, ProviderSlashCommandSpec[]> = {
  codex: [
    { command: '/goal', label: 'Goal', description: 'Run a bounded goal loop until the objective is met or Max Turns is reached' },
    { command: '/review', label: 'Review', description: 'Review current changes and find issues' },
    { command: '/fast', label: 'Fast', description: 'Toggle Fast mode for Codex' },
    { command: '/model', label: 'Model', description: 'Choose model and reasoning effort' },
    { command: '/permissions', label: 'Permissions', description: 'Configure approval mode and tool permissions' },
    { command: '/plan', label: 'Plan', description: 'Switch to Plan mode' },
    { command: '/compact', label: 'Compact', description: 'Summarize conversation to free context window' },
    { command: '/diff', label: 'Diff', description: 'Show git diff including untracked files' },
    { command: '/mention', label: 'Mention', description: 'Attach a file to the conversation' },
    { command: '/skills', label: 'Skills', description: 'Browse and invoke skills' },
    { command: '/status', label: 'Status', description: 'Show current session configuration and token usage' },
    { command: '/fork', label: 'Fork', description: 'Fork the current conversation into a new thread' },
    { command: '/resume', label: 'Resume', description: 'Resume a saved conversation' },
    { command: '/new', label: 'New', description: 'Start a new conversation' },
    { command: '/clear', label: 'Clear', description: 'Clear the terminal and start fresh' },
    { command: '/copy', label: 'Copy', description: 'Copy the latest Codex output to clipboard' },
    { command: '/init', label: 'Init', description: 'Generate an AGENTS.md scaffold' },
    { command: '/mcp', label: 'MCP', description: 'List configured MCP tools' },
    { command: '/Apps', label: 'Apps', description: 'Manage Codex apps and connectors' },
    { command: '/experimental', label: 'Experimental', description: 'Toggle experimental features' },
    { command: '/personality', label: 'Personality', description: 'Choose communication style' },
    { command: '/ps', label: 'PS', description: 'List background terminals' },
    { command: '/clean', label: 'Clean', description: 'Stop all background terminals' },
    { command: '/agent', label: 'Agent', description: 'Switch the active agent thread' },
    { command: '/statusline', label: 'Status Line', description: 'Configure status line items' },
    { command: '/theme', label: 'Theme', description: 'Choose syntax highlighting theme' },
    { command: '/feedback', label: 'Feedback', description: 'Send logs to maintainers' },
    { command: '/logout', label: 'Logout', description: 'Log out of Codex' },
    { command: '/quit', label: 'Quit', description: 'Exit Codex' },
    { command: '/exit', label: 'Exit', description: 'Exit Codex' },
  ],
  claude: [
    { command: '/goal', label: 'Goal', description: 'Run a bounded goal loop until the objective is met or Max Turns is reached' },
    { command: '/review', label: 'Review', description: 'Review a pull request or current changes' },
    { command: '/security-review', label: 'Security Review', description: 'Audit pending changes for security vulnerabilities' },
    { command: '/pr-comments', label: 'PR Comments', description: 'Get comments from the current pull request' },
    { command: '/plan', label: 'Plan', description: 'Enter plan mode or view the current session plan' },
    { command: '/model', label: 'Model', description: 'Set the AI model for Claude Code' },
    { command: '/effort', label: 'Effort', description: 'Set the model effort level' },
    { command: '/fast', label: 'Fast', description: 'Toggle fast mode' },
    { command: '/permissions', label: 'Permissions', description: 'Manage allow & deny tool permission rules' },
    { command: '/compact', label: 'Compact', description: 'Clear history but keep a summary in context' },
    { command: '/context', label: 'Context', description: 'Visualize current context usage' },
    { command: '/cost', label: 'Cost', description: 'Show the total cost and duration of the current session' },
    { command: '/usage', label: 'Usage', description: 'Show plan usage limits' },
    { command: '/stats', label: 'Stats', description: 'Visualize usage, session history, and model preferences' },
    { command: '/diff', label: 'Diff', description: 'Open interactive diff viewer for uncommitted changes' },
    { command: '/memory', label: 'Memory', description: 'Edit Claude memory files' },
    { command: '/init', label: 'Init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
    { command: '/add-dir', label: 'Add Dir', description: 'Add a new working directory' },
    { command: '/agents', label: 'Agents', description: 'Manage agent configurations' },
    { command: '/skills', label: 'Skills', description: 'List available skills' },
    { command: '/mcp', label: 'MCP', description: 'Manage MCP servers' },
    { command: '/plugin', label: 'Plugin', description: 'Manage Claude Code plugins' },
    { command: '/reload-plugins', label: 'Reload Plugins', description: 'Activate pending plugin changes in the current session' },
    { command: '/hooks', label: 'Hooks', description: 'View hook configurations for tool events' },
    { command: '/tasks', label: 'Tasks', description: 'List and manage background tasks' },
    { command: '/loop', label: 'Loop', description: 'Run a prompt or slash command on a recurring interval' },
    { command: '/btw', label: 'BTW', description: 'Ask a quick side question without adding to main conversation' },
    { command: '/advisor', label: 'Advisor', description: 'Configure advisor model for architectural decisions' },
    { command: '/rewind', label: 'Rewind', description: 'Restore code and/or conversation to a previous point' },
    { command: '/branch', label: 'Branch', description: 'Create a branch of the current conversation' },
    { command: '/resume', label: 'Resume', description: 'Resume a conversation' },
    { command: '/export', label: 'Export', description: 'Export the current conversation to a file or clipboard' },
    { command: '/copy', label: 'Copy', description: 'Copy Claude’s last response to clipboard' },
    { command: '/clear', label: 'Clear', description: 'Clear conversation history and free up context' },
    { command: '/config', label: 'Config', description: 'Open config panel' },
    { command: '/status', label: 'Status', description: 'Show Claude Code status including version, model, and account' },
    { command: '/doctor', label: 'Doctor', description: 'Diagnose and verify your Claude Code installation and settings' },
    { command: '/help', label: 'Help', description: 'Show help and available commands' },
    { command: '/exit', label: 'Exit', description: 'Exit the CLI' },
  ],
  pi: [
    { command: '/settings', label: 'Settings', description: 'Open settings menu' },
    { command: '/model', label: 'Model', description: 'Select model (opens selector UI)' },
    { command: '/scoped-models', label: 'Scoped Models', description: 'Enable or disable models for Ctrl+P cycling' },
    { command: '/export', label: 'Export', description: 'Export session to HTML or Markdown' },
    { command: '/share', label: 'Share', description: 'Share session as a secret GitHub gist' },
    { command: '/copy', label: 'Copy', description: 'Copy last agent message to clipboard' },
    { command: '/name', label: 'Name', description: 'Set session display name' },
    { command: '/session', label: 'Session', description: 'Show session info and stats' },
    { command: '/changelog', label: 'Changelog', description: 'Display version history' },
    { command: '/hotkeys', label: 'Hotkeys', description: 'Show all keyboard shortcuts' },
    { command: '/fork', label: 'Fork', description: 'Create a new fork from a previous message' },
    { command: '/tree', label: 'Tree', description: 'Navigate session tree (switch branches)' },
    { command: '/login', label: 'Login', description: 'Login with OAuth provider' },
    { command: '/logout', label: 'Logout', description: 'Logout from OAuth provider' },
    { command: '/new', label: 'New', description: 'Start a new session' },
    { command: '/compact', label: 'Compact', description: 'Manually compact the session context' },
    { command: '/resume', label: 'Resume', description: 'Resume a different session' },
    { command: '/reload', label: 'Reload', description: 'Reload extensions, skills, prompts, and themes' },
    { command: '/quit', label: 'Quit', description: 'Exit pi' },
  ],
  opencode: [
    { command: '/init', label: 'Init', description: 'Create or update AGENTS.md' },
    { command: '/review', label: 'Review', description: 'Review changes (commit, branch, or PR)' },
    { command: '/compact', label: 'Compact', description: 'Compact the current session context' },
    { command: '/undo', label: 'Undo', description: 'Undo the last message and file changes' },
    { command: '/redo', label: 'Redo', description: 'Redo a previously undone message' },
    { command: '/share', label: 'Share', description: 'Share the current session' },
    { command: '/unshare', label: 'Unshare', description: 'Unshare the current session' },
    { command: '/models', label: 'Models', description: 'Select or switch model' },
    { command: '/agents', label: 'Agents', description: 'Select or switch agent' },
    { command: '/mcps', label: 'MCPs', description: 'Manage MCP servers' },
    { command: '/skills', label: 'Skills', description: 'Browse and invoke skills' },
    { command: '/sessions', label: 'Sessions', description: 'Switch or manage sessions' },
    { command: '/new', label: 'New', description: 'Start a new session' },
    { command: '/status', label: 'Status', description: 'Show session and provider status' },
    { command: '/themes', label: 'Themes', description: 'Switch UI theme' },
    { command: '/help', label: 'Help', description: 'Show available commands and shortcuts' },
    { command: '/exit', label: 'Exit', description: 'Exit OpenCode' },
  ],
  qoder: [
    { command: '/init', label: 'Init', description: 'Analyze codebase and create AGENTS.md' },
    { command: '/compact', label: 'Compact', description: 'Compact and summarize conversation history' },
    { command: '/review', label: 'Review', description: 'Review current changes' },
    { command: '/security-review', label: 'Security Review', description: 'Run a security review on current changes' },
    { command: '/Simplified-Code', label: 'Simplified Code', description: 'Simplify and clean up recent code changes' },
    { command: '/skills', label: 'Skills', description: 'Browse and invoke available skills' },
    { command: '/agents', label: 'Agents', description: 'Manage subagents' },
    { command: '/model', label: 'Model', description: 'Select or configure the active model' },
    { command: '/status', label: 'Status', description: 'Show current session and account status' },
    { command: '/clear', label: 'Clear', description: 'Clear conversation history' },
    { command: '/help', label: 'Help', description: 'Show available slash commands' },
    { command: '/exit', label: 'Exit', description: 'Exit Qoder CLI' },
  ],
  qwen: [
    { command: '/init', label: 'Init', description: 'Analyze the project and create a tailored QWEN.md file' },
    { command: '/summary', label: 'Summary', description: 'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md' },
    { command: '/compress', label: 'Compress', description: 'Replace conversation context with a summary to save tokens' },
    { command: '/compact', label: 'Compact', description: 'Compact the conversation context' },
    { command: '/review', label: 'Review', description: 'Review uncommitted or branch changes' },
    { command: '/model', label: 'Model', description: 'Switch the model for the current session' },
    { command: '/approval-mode', label: 'Approval Mode', description: 'View or change the approval mode for tool usage' },
    { command: '/agents', label: 'Agents', description: 'Manage subagents for specialized task delegation' },
    { command: '/skills', label: 'Skills', description: 'List and invoke available skills' },
    { command: '/mcp', label: 'MCP', description: 'Manage configured MCP servers and tools' },
    { command: '/extensions', label: 'Extensions', description: 'Manage Qwen Code extensions' },
    { command: '/memory', label: 'Memory', description: 'Show or refresh hierarchical instructional memory' },
    { command: '/directory', label: 'Directory', description: 'Manage workspace directories' },
    { command: '/restore', label: 'Restore', description: 'Restore project files to a previous checkpoint' },
    { command: '/chat', label: 'Chat', description: 'Save, list, or resume conversation checkpoints' },
    { command: '/stats', label: 'Stats', description: 'Check session statistics and token usage' },
    { command: '/insight', label: 'Insight', description: 'Generate personalized insights from your chat history' },
    { command: '/bug', label: 'Bug', description: 'Submit a bug report about Qwen Code' },
    { command: '/clear', label: 'Clear', description: 'Clear the screen and conversation history' },
    { command: '/copy', label: 'Copy', description: 'Copy the last result or code snippet to clipboard' },
    { command: '/settings', label: 'Settings', description: 'View and edit Qwen Code settings' },
    { command: '/theme', label: 'Theme', description: 'Change the visual theme' },
    { command: '/language', label: 'Language', description: 'View or change the UI/output language' },
    { command: '/auth', label: 'Auth', description: 'Change your authentication method' },
    { command: '/about', label: 'About', description: 'Show version information' },
    { command: '/help', label: 'Help', description: 'Display help information about available commands' },
    { command: '/quit', label: 'Quit', description: 'Exit Qwen Code' },
  ],
  agy: [
    { command: '/boost', label: 'Boost', description: 'Deep thinking, strategic planning, multiple perspectives, and rigorous verification' },
    { command: '/teamwork', label: 'Teamwork', description: 'Coordinate a team of autonomous subagents to tackle a large project' },
    { command: '/goal', label: 'Goal', description: 'Run a thorough long-running task and do not stop until the goal is achieved' },
    { command: '/plan', label: 'Plan', description: 'Create a step-by-step plan before execution' },
    { command: '/grill-me', label: 'Grill Me', description: 'Align on a plan through an interactive design interview' },
    { command: '/schedule', label: 'Schedule', description: 'Run an instruction on a recurring schedule or set a one-time timer' },
    { command: '/browser', label: 'Browser', description: 'Browse the web or interact with web applications' },
    { command: '/learn', label: 'Learn', description: 'Persist a learned behavior or setup across future tasks' },
    { command: '/compact', label: 'Compact', description: 'Summarize the conversation to free up context window space' },
    { command: '/model', label: 'Model', description: 'Show or switch the active model' },
    { command: '/effort', label: 'Effort', description: 'Show or change the model thinking effort level' },
    { command: '/skills', label: 'Skills', description: 'List available skills in the current workspace and home' },
    { command: '/agents', label: 'Agents', description: 'List available subagents' },
    { command: '/plugin', label: 'Plugin', description: 'Manage and create Antigravity plugins' },
    { command: '/quota', label: 'Quota', description: 'Show model quota and credit status' },
    { command: '/credits', label: 'Credits', description: 'Show credit balance and usage settings' },
    { command: '/clear', label: 'Clear', description: 'Start a fresh Antigravity conversation' },
    { command: '/status', label: 'Status', description: 'Show current session and runtime status' },
    { command: '/help', label: 'Help', description: 'List available slash commands' },
    { command: '/exit', label: 'Exit', description: 'Exit the Antigravity CLI' },
  ],
};

function appendProviderSlashCommands(
  commands: DiscoveredCommand[],
  provider: SupportedProvider,
): void {
  const specs = PROVIDER_SLASH_COMMANDS[provider] || [];
  for (const spec of specs) {
    const command = spec.command.trim();
    if (!command.startsWith('/')) continue;
    addCommand(commands, {
      command,
      label: spec.label || commandLabel(command.slice(1)),
      description: spec.description,
      source: 'custom',
      scope: spec.scope || 'Built-in',
    });
  }
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
  pi: {
    discoverAtHome: discoverPiAgentExtensions,
    discoverLegacy: ({ homeDir = os.homedir(), workspace }: DiscoveryOptions = {}) => (
      discoverPiAgentExtensions(path.join(homeDir, '.pi', 'agent'), workspace, homeDir)
    ),
  },
  opencode: {
    discoverAtHome: discoverOpenCodeAgentExtensions,
    discoverLegacy: ({ homeDir = os.homedir(), workspace }: DiscoveryOptions = {}) => (
      discoverOpenCodeAgentExtensions(path.join(homeDir, '.opencode'), workspace, homeDir)
    ),
  },
  qoder: {
    discoverAtHome: discoverQoderAgentExtensions,
    discoverLegacy: ({ homeDir = os.homedir(), workspace }: DiscoveryOptions = {}) => (
      discoverQoderAgentExtensions(path.join(homeDir, '.qoder'), workspace, homeDir)
    ),
  },
  qwen: {
    discoverAtHome: discoverQwenAgentExtensions,
    discoverLegacy: ({ homeDir = os.homedir(), workspace }: DiscoveryOptions = {}) => (
      discoverQwenAgentExtensions(path.join(homeDir, '.qwen'), workspace, homeDir)
    ),
  },
  agy: {
    discoverAtHome: discoverAgyAgentExtensions,
    discoverLegacy: ({ homeDir = os.homedir(), workspace }: DiscoveryOptions = {}) => (
      discoverAgyAgentExtensions(path.join(homeDir, '.gemini', 'antigravity'), workspace, homeDir)
    ),
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
  if (!normalizedProvider) return [];
  const commands = normalizeWorkspace(providerHomePath)
    ? await discoverAgentExtensions({
      provider: normalizedProvider,
      providerHomePath,
      workspace,
      homeDir,
    })
    : await PROVIDER_EXTENSION_DISCOVERY[normalizedProvider].discoverLegacy({ homeDir, workspace });
  const merged = [...commands];
  appendProviderSlashCommands(merged, normalizedProvider);
  return merged.slice(0, MAX_DISCOVERED_SKILLS);
}

export {
  discoverAgentExtensions,
  discoverSlashCommands,
  discoverClaudeSlashCommands,
  discoverCodexSkillMentions,
};
