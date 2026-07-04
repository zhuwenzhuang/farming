const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { discoverSlashCommands } = require('../slash-command-discovery');

function mkdirp(filePath) {
  fs.mkdirSync(filePath, { recursive: true });
}

function run() {
  const tmpBase = path.resolve(__dirname, '..', '..', '.tmp');
  mkdirp(tmpBase);
  const tmpRoot = fs.mkdtempSync(path.join(tmpBase, 'slash-commands-'));
  const homeDir = path.join(tmpRoot, 'home');
  const workspace = path.join(tmpRoot, 'workspace');

  try {
    mkdirp(path.join(homeDir, '.claude', 'skills', 'home-skill'));
    fs.writeFileSync(path.join(homeDir, '.claude', 'skills', 'home-skill', 'SKILL.md'), 'secret home body\n');
    mkdirp(path.join(workspace, '.claude', 'skills', 'workspace-skill'));
    fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'workspace-skill', 'SKILL.md'), 'secret workspace body\n');
    mkdirp(path.join(workspace, '.claude', 'skills', 'not-a-skill'));
    mkdirp(path.join(workspace, '.claude', 'skills', '../bad'));
    mkdirp(path.join(workspace, '.claude', 'commands'));
    fs.writeFileSync(path.join(workspace, '.claude', 'commands', 'review.md'), 'secret review body\n');
    fs.writeFileSync(path.join(workspace, '.claude', 'commands', '.hidden.md'), 'hidden\n');
    fs.writeFileSync(path.join(workspace, '.claude', 'commands', 'bad name.md'), 'bad\n');
    mkdirp(path.join(workspace, '.agents', 'skills', 'repo-skill'));
    fs.writeFileSync(path.join(workspace, '.agents', 'skills', 'repo-skill', 'SKILL.md'), [
      '---',
      'name: repo-skill',
      'description: Repo skill summary',
      '---',
      'secret repo body',
      '',
    ].join('\n'));
    mkdirp(path.join(homeDir, '.agents', 'skills', 'home-codex'));
    fs.writeFileSync(path.join(homeDir, '.agents', 'skills', 'home-codex', 'SKILL.md'), [
      '---',
      'name: home-codex',
      'description: Home Codex skill summary',
      '---',
      'secret home codex body',
      '',
    ].join('\n'));
    mkdirp(path.join(homeDir, '.codex', 'skills', '.system', 'skill-creator'));
    fs.writeFileSync(path.join(homeDir, '.codex', 'skills', '.system', 'skill-creator', 'SKILL.md'), [
      '---',
      'name: skill-creator',
      'description: System skill summary',
      '---',
      'secret system body',
      '',
    ].join('\n'));
    const pluginSkillDir = path.join(homeDir, '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'pdf', '1.0.0', 'skills', 'pdf');
    mkdirp(pluginSkillDir);
    fs.writeFileSync(path.join(pluginSkillDir, 'SKILL.md'), [
      '---',
      'name: "pdf"',
      'description: "Read, create, render, and verify PDF files"',
      '---',
      'secret plugin body',
      '',
    ].join('\n'));

    const claudeCommands = discoverSlashCommands({ provider: 'claude', homeDir, workspace });
    const names = claudeCommands.map(command => command.command);
    assert(names.includes('/workspace-skill'), 'workspace Claude skills should become slash commands');
    assert(names.includes('/home-skill'), 'home Claude skills should become slash commands');
    assert(names.includes('/review'), 'workspace Claude command files should become slash commands');
    assert(!names.includes('/not-a-skill'), 'directories without SKILL.md should be ignored');
    assert(!names.includes('/.hidden'), 'hidden command files should be ignored');
    assert(!names.includes('/bad name'), 'unsafe command names should be ignored');
    assert(!JSON.stringify(claudeCommands).includes('secret'), 'slash command discovery should not expose file contents');

    const codexCommands = discoverSlashCommands({ provider: 'codex', homeDir, workspace });
    const codexNames = codexCommands.map(command => command.command);
    assert(codexNames.includes('$repo-skill'), 'repo Codex skills should become $skill mentions');
    assert(codexNames.includes('$home-codex'), 'home Codex skills should become $skill mentions');
    assert(codexNames.includes('$skill-creator'), 'system Codex skills should become $skill mentions');
    assert(codexNames.includes('$pdf:pdf'), 'plugin Codex skills should include the plugin namespace');
    assert(codexCommands.some(command => (
      command.command === '$pdf:pdf' && command.label === 'PDF' && command.scope === 'Plugin'
    )));
    assert(!JSON.stringify(codexCommands).includes('secret'), 'Codex skill discovery should not expose skill body text');

    assert.deepStrictEqual(discoverSlashCommands({ provider: 'unknown', homeDir, workspace }), []);

    console.log('test-slash-command-discovery passed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

run();
