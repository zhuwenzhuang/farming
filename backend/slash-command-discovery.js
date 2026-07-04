const fs = require('fs');
const path = require('path');
const os = require('os');

const SAFE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILL_BYTES = 16 * 1024;
const MAX_DISCOVERED_SKILLS = 200;
const LABEL_ACRONYMS = new Map([
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

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  if (value === 'codex' || value === 'claude') return value;
  return '';
}

function normalizeWorkspace(workspace, homeDir = os.homedir()) {
  if (typeof workspace !== 'string') return '';
  const value = workspace.trim();
  if (!value) return '';
  return path.resolve(value.replace(/^~(?=$|[/\\])/, homeDir));
}

function commandLabel(name) {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map(part => LABEL_ACRONYMS.get(part.toLowerCase()) || part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ') || name;
}

function readFilePrefix(filePath, limit = MAX_SKILL_BYTES) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close failures for best-effort discovery.
      }
    }
  }
}

function parseSkillFrontMatter(skillFile) {
  const prefix = readFilePrefix(skillFile);
  const match = prefix.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return {};

  const metadata = {};
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

function findGitRoot(startDir) {
  let current = startDir;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return '';
}

function workspaceSkillRoots(workspace, homeDir) {
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  if (!normalizedWorkspace) return [];

  const gitRoot = findGitRoot(normalizedWorkspace) || normalizedWorkspace;
  const roots = [];
  let current = normalizedWorkspace;
  while (current && current.startsWith(gitRoot)) {
    roots.push(path.join(current, '.agents', 'skills'));
    if (current === gitRoot) break;
    current = path.dirname(current);
  }
  return roots;
}

function addCommand(commands, command) {
  const commandId = command.command.toLowerCase();
  if (commands.some(item => item.command.toLowerCase() === commandId)) return;
  commands.push(command);
}

function addSkillMention(commands, skillFile, {
  mentionPrefix = '',
  fallbackName = '',
  scope = 'Personal',
  source = 'skill',
} = {}) {
  const metadata = parseSkillFrontMatter(skillFile);
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

function discoverClaudeSkillCommands(commands, skillsDir, sourceLabel) {
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.forEach(entry => {
    if (!entry.isDirectory() || !SAFE_COMMAND_NAME.test(entry.name)) return;
    if (!fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md'))) return;
    addCommand(commands, {
      command: `/${entry.name}`,
      label: commandLabel(entry.name),
      description: `Claude skill from ${sourceLabel}`,
      source: 'skill',
    });
  });
}

function discoverClaudeCustomCommands(commands, commandsDir, sourceLabel) {
  let entries;
  try {
    entries = fs.readdirSync(commandsDir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.forEach(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.md')) return;
    const name = entry.name.slice(0, -3);
    if (!SAFE_COMMAND_NAME.test(name)) return;
    addCommand(commands, {
      command: `/${name}`,
      label: commandLabel(name),
      description: `Claude custom command from ${sourceLabel}`,
      source: 'custom',
    });
  });
}

function discoverClaudeSlashCommands({ homeDir = os.homedir(), workspace } = {}) {
  const commands = [];
  const normalizedWorkspace = normalizeWorkspace(workspace, homeDir);
  const roots = [];

  if (normalizedWorkspace) {
    roots.push({ root: path.join(normalizedWorkspace, '.claude'), label: 'workspace' });
  }
  roots.push({ root: path.join(homeDir, '.claude'), label: 'home' });

  roots.forEach(({ root, label }) => {
    discoverClaudeSkillCommands(commands, path.join(root, 'skills'), label);
    discoverClaudeCustomCommands(commands, path.join(root, 'commands'), label);
  });

  return commands;
}

function discoverSkillFiles(skillsDir) {
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry.isDirectory() && SAFE_COMMAND_NAME.test(entry.name))
    .map(entry => path.join(skillsDir, entry.name, 'SKILL.md'))
    .filter(skillFile => fs.existsSync(skillFile));
}

function discoverDirectCodexSkills(commands, skillsDir, scope) {
  discoverSkillFiles(skillsDir).forEach(skillFile => {
    addSkillMention(commands, skillFile, { scope, source: 'skill' });
  });
}

function discoverPluginSkillFiles(root, depth = 0, skillFiles = []) {
  if (depth > 8 || skillFiles.length >= MAX_DISCOVERED_SKILLS) return skillFiles;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return skillFiles;
  }

  entries.forEach(entry => {
    if (skillFiles.length >= MAX_DISCOVERED_SKILLS) return;
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === 'SKILL.md' && path.basename(path.dirname(entryPath)) !== 'skills') {
      skillFiles.push(entryPath);
      return;
    }
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      discoverPluginSkillFiles(entryPath, depth + 1, skillFiles);
    }
  });

  return skillFiles;
}

function pluginNameForSkillFile(skillFile, pluginsCacheDir) {
  const parts = path.relative(pluginsCacheDir, skillFile).split(path.sep);
  if (parts[0] === 'openai-curated' && parts[1]) return parts[1];
  if ((parts[0] === 'openai-primary-runtime' || parts[0] === 'openai-bundled') && parts[1]) return parts[1];
  return parts[0] || '';
}

function discoverCodexPluginSkills(commands, homeDir) {
  const pluginsCacheDir = path.join(homeDir, '.codex', 'plugins', 'cache');
  discoverPluginSkillFiles(pluginsCacheDir).forEach(skillFile => {
    const pluginName = pluginNameForSkillFile(skillFile, pluginsCacheDir);
    addSkillMention(commands, skillFile, {
      mentionPrefix: pluginName,
      fallbackName: path.basename(path.dirname(skillFile)),
      scope: 'Plugin',
      source: 'skill',
    });
  });
}

function discoverCodexSkillMentions({ homeDir = os.homedir(), workspace } = {}) {
  const commands = [];
  workspaceSkillRoots(workspace, homeDir).forEach(root => discoverDirectCodexSkills(commands, root, 'Repo'));
  discoverDirectCodexSkills(commands, path.join(homeDir, '.agents', 'skills'), 'Personal');
  discoverDirectCodexSkills(commands, path.join(homeDir, '.codex', 'skills'), 'Personal');
  discoverDirectCodexSkills(commands, path.join(homeDir, '.codex', 'skills', '.system'), 'System');
  discoverDirectCodexSkills(commands, path.join('/etc', 'codex', 'skills'), 'Admin');
  discoverCodexPluginSkills(commands, homeDir);
  return commands.slice(0, MAX_DISCOVERED_SKILLS);
}

function discoverSlashCommands({ provider, homeDir = os.homedir(), workspace } = {}) {
  const normalizedProvider = normalizeProvider(provider);
  if (normalizedProvider === 'codex') {
    return discoverCodexSkillMentions({ homeDir, workspace });
  }
  if (normalizedProvider === 'claude') {
    return discoverClaudeSlashCommands({ homeDir, workspace });
  }
  return [];
}

module.exports = {
  discoverSlashCommands,
  discoverClaudeSlashCommands,
  discoverCodexSkillMentions,
};
