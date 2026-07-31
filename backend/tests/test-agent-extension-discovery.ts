import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { discoverAgentExtensions } = require('../agent-extension-discovery.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-extensions-'));
const codexHome = path.join(temporaryRoot, 'codex');
const pluginRoot = path.join(codexHome, 'plugins', 'example');
const standardPluginRoot = path.join(codexHome, 'plugins', 'standard');

try {
  fs.mkdirSync(path.join(codexHome, 'skills', 'personal-skill'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'skills', 'personal-skill', 'SKILL.md'), [
    '---',
    'name: Personal Skill',
    'description: A Home-owned skill.',
    '---',
    '',
    '# Personal Skill',
  ].join('\n'));
  fs.writeFileSync(path.join(codexHome, 'hooks.json'), JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: './stop.sh' }] }],
    },
  }));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), [
    '[mcp_servers.home-server]',
    'command = "home-server"',
    'enabled = false',
    '',
    '[mcp_servers.home-server.env]',
    'TOKEN = "must-not-be-returned"',
  ].join('\n'));

  fs.mkdirSync(path.join(pluginRoot, 'skills', 'plugin-skill'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'example-plugin',
    version: '1.2.3',
    description: 'Example Agent plugin.',
    skills: './skills',
    mcpServers: './mcp.json',
    hooks: './hooks/hooks.json',
  }));
  fs.writeFileSync(path.join(pluginRoot, 'skills', 'plugin-skill', 'SKILL.md'), [
    '---',
    'name: Plugin Skill',
    'description: A plugin-owned skill.',
    '---',
  ].join('\n'));
  fs.writeFileSync(path.join(pluginRoot, 'commands', 'review.md'), [
    '---',
    'description: Review a change.',
    '---',
  ].join('\n'));
  fs.writeFileSync(path.join(pluginRoot, 'mcp.json'), JSON.stringify({
    mcpServers: {
      example: { title: 'Example MCP', command: 'node', args: ['server.js'] },
    },
  }));
  fs.writeFileSync(path.join(pluginRoot, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: './check.sh' }] }],
    },
  }));
  fs.mkdirSync(standardPluginRoot, { recursive: true });
  fs.writeFileSync(path.join(standardPluginRoot, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'standard-plugin',
    description: 'Agent Plugins v1 root manifest.',
  }));
  fs.writeFileSync(path.join(standardPluginRoot, 'mcp.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { standard: { title: 'Standard MCP', url: 'https://example.test/mcp' } },
  }));

  const items = discoverAgentExtensions({ provider: 'codex', providerHomePath: codexHome });
  assert(items.some((item: any) => item.kind === 'skill' && item.name === 'Personal Skill'));
  assert(items.some((item: any) => item.kind === 'skill' && item.name === 'example-plugin: Plugin Skill'));
  assert(items.some((item: any) => item.kind === 'plugin' && item.name === 'Example Plugin'));
  assert(items.some((item: any) => item.kind === 'mcp' && item.name === 'Example MCP'));
  assert(items.some((item: any) => item.kind === 'mcp' && item.name === 'Standard MCP'));
  assert(items.some((item: any) => item.kind === 'hook' && item.name === 'example-plugin: PreToolUse'));
  assert(items.some((item: any) => item.kind === 'command' && item.name === 'example-plugin: Review'));

  const disabledMcp = items.find((item: any) => item.id === 'mcp:home:home-server');
  assert.strictEqual(disabledMcp?.status, 'disabled');
  assert.strictEqual(disabledMcp?.sourceFile, 'config.toml');
  assert.strictEqual(items.filter((item: any) => item.id.startsWith('mcp:home:')).length, 1);
  assert(!JSON.stringify(items).includes('must-not-be-returned'));
  assert(items.every((item: any) => item.sourceFile && !path.isAbsolute(item.sourceFile)));

  if (process.platform !== 'win32') {
    const escapedSkills = path.join(temporaryRoot, 'escaped-skills');
    const escapedPlugin = path.join(codexHome, 'plugins', 'escaped-plugin');
    fs.mkdirSync(path.join(escapedSkills, 'must-not-load'), { recursive: true });
    fs.mkdirSync(escapedPlugin, { recursive: true });
    fs.writeFileSync(path.join(escapedSkills, 'must-not-load', 'SKILL.md'), '---\nname: Escaped Skill\n---\n');
    fs.writeFileSync(path.join(escapedPlugin, 'plugin.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'escaped-plugin',
    }));
    fs.symlinkSync(escapedSkills, path.join(escapedPlugin, 'skills'), 'dir');
    const pathSafeItems = discoverAgentExtensions({ provider: 'codex', providerHomePath: codexHome });
    assert(!pathSafeItems.some((item: any) => item.name.includes('Escaped Skill')));
  }

  const unsupportedPlugin = path.join(codexHome, 'plugins', 'unsupported-standard');
  fs.mkdirSync(path.join(unsupportedPlugin, 'skills', 'must-not-load'), { recursive: true });
  fs.writeFileSync(path.join(unsupportedPlugin, 'plugin.json'), JSON.stringify({
    $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
    name: 'unsupported-standard',
  }));
  fs.writeFileSync(path.join(unsupportedPlugin, 'skills', 'must-not-load', 'SKILL.md'), '---\nname: Unsupported Skill\n---\n');
  assert(!discoverAgentExtensions({ provider: 'codex', providerHomePath: codexHome })
    .some((item: any) => item.name.includes('Unsupported')));

  const otherHome = path.join(temporaryRoot, 'other');
  fs.mkdirSync(path.join(otherHome, 'skills', 'other-only'), { recursive: true });
  fs.writeFileSync(path.join(otherHome, 'skills', 'other-only', 'SKILL.md'), '---\nname: Other Only\n---\n');
  assert(!JSON.stringify(items).includes('Other Only'));
  assert(discoverAgentExtensions({ provider: 'codex', providerHomePath: otherHome })
    .some((item: any) => item.name === 'Other Only'));

  const claudeHome = path.join(temporaryRoot, 'claude');
  const claudePluginRoot = path.join(claudeHome, 'plugins', 'cache', 'market', 'disabled-plugin', '1.0.0');
  fs.mkdirSync(path.join(claudePluginRoot, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(claudePluginRoot, 'skills', 'disabled-skill'), { recursive: true });
  fs.writeFileSync(path.join(claudePluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'disabled-plugin',
  }));
  fs.writeFileSync(path.join(claudePluginRoot, 'skills', 'disabled-skill', 'SKILL.md'), '---\nname: Disabled Skill\n---\n');
  fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'disabled-plugin@market': false },
  }));
  fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'disabled-plugin@market': [{ installPath: claudePluginRoot }],
    },
  }));
  const claudeItems = discoverAgentExtensions({ provider: 'claude', providerHomePath: claudeHome });
  assert(claudeItems.some((item: any) => item.kind === 'plugin' && item.status === 'disabled'));
  assert(claudeItems.some((item: any) => item.kind === 'skill' && item.status === 'disabled'));

  const qoderHome = path.join(temporaryRoot, 'qoder');
  const qoderPluginRoot = path.join(qoderHome, 'plugins', 'cache', 'market', 'qoder-computer-use');
  fs.mkdirSync(path.join(qoderPluginRoot, '.qoder-plugin'), { recursive: true });
  fs.writeFileSync(path.join(qoderPluginRoot, '.qoder-plugin', 'plugin.json'), JSON.stringify({
    name: 'computer-use',
    displayName: 'Qoder Computer Use',
    mcp: './.mcp.json',
  }));
  fs.writeFileSync(path.join(qoderPluginRoot, '.mcp.json'), JSON.stringify({
    mcpServers: { computer: { command: 'computer-use' } },
  }));
  fs.writeFileSync(path.join(qoderHome, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'qoder-computer-use@market': false },
  }));
  const qoderItems = discoverAgentExtensions({ provider: 'qoder', providerHomePath: qoderHome });
  assert(qoderItems.some((item: any) => item.kind === 'plugin' && item.name === 'Qoder Computer Use' && item.status === 'disabled'));
  assert(qoderItems.some((item: any) => item.kind === 'mcp' && item.status === 'disabled'));

  console.log('agent extension discovery tests passed');
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
