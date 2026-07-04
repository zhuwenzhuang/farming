const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensureMainAgentSkillFiles,
  getMainAgentSkillsCatalog,
  renderCanonicalAgentsFile,
  renderMainAgentBootstrap,
  renderMainAgentOperatingGuide,
  renderMainAgentSkills,
  upsertManagedBlock,
} = require('../main-agent-skills');

async function run() {
  const catalog = getMainAgentSkillsCatalog();
  assert(Array.isArray(catalog));
  assert(catalog.some(s => s.id === 'memory-report'));
  assert(catalog.some(s => s.id === 'pest-control'));
  assert(catalog.every(s => Array.isArray(s.commands) && s.commands.length > 0));

  const skills = renderMainAgentSkills();
  assert(skills.includes('Farming Main Agent Skills'));
  assert(skills.includes('记忆读取总结'));
  assert(skills.includes('farming memory report'));
  assert(skills.includes('attention steward'));
  assert(skills.includes('farming list --json'));
  assert(skills.includes('Do not spawn child agents just because you can'));
  assert(skills.includes('Poll at a low frequency'));
  assert(skills.includes('Report in short status summaries'));
  assert(skills.includes('牧场除虫计划'));
  assert(skills.includes('先只读梳理目标目录结构'));
  assert(skills.includes('明确模块间协议'));
  assert(skills.includes('farming spawn --workspace <repo>'));
  assert(skills.includes('farming list --parent "$FARMING_AGENT_ID"'));
  assert(renderCanonicalAgentsFile().includes('This directory is a Farming-managed Main Agent workspace'));
  assert(renderCanonicalAgentsFile().includes('farming memory report --period today'));
  assert(renderCanonicalAgentsFile().includes('farming spawn --workspace <repo>'));
  assert(renderMainAgentOperatingGuide().includes('Classify agents as running, waiting for input, blocked, failed, complete, stale, or safe to ignore'));

  const bootstrap = renderMainAgentBootstrap();
  assert(bootstrap.includes('Bootstrap note'));
  assert(bootstrap.includes('attention steward'));

  const updated = upsertManagedBlock('custom note\n', '<!-- FARMING_MAIN_AGENT_SKILLS:START -->\nmanaged\n<!-- FARMING_MAIN_AGENT_SKILLS:END -->\n');
  assert(updated.includes('custom note'));
  assert(updated.includes('managed'));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-main-skills-'));
  try {
    ensureMainAgentSkillFiles(tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'skills', 'pest-control.md'), 'stale skill');
    ensureMainAgentSkillFiles(tmpDir);

    const skillsFile = fs.readFileSync(path.join(tmpDir, 'FARMING_MAIN_AGENT_SKILLS.md'), 'utf8');
    const claudeFile = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf8');
    const agentsFile = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf8');
    const qwenFile = fs.readFileSync(path.join(tmpDir, 'QWEN.md'), 'utf8');
    const indexFile = fs.readFileSync(path.join(tmpDir, 'skills', 'index.json'), 'utf8');
    const memoryReportFile = fs.readFileSync(path.join(tmpDir, 'skills', 'memory-report.md'), 'utf8');
    const pestControlFile = fs.readFileSync(path.join(tmpDir, 'skills', 'pest-control.md'), 'utf8');

    assert(skillsFile.includes('farming skills'));
    assert(skillsFile.includes('牧场除虫计划'));
    assert(skillsFile.includes('farming spawn'));
    assert(claudeFile.includes('FARMING_MAIN_AGENT_SKILLS:START'));
    assert(claudeFile.includes('full Farming Main Agent identity inline'));
    assert(claudeFile.includes('You are the Farming Main Agent'));
    assert(claudeFile.includes('牧场除虫计划'));
    assert(claudeFile.includes('farming spawn --workspace <repo>'));
    assert(agentsFile.includes('This directory is a Farming-managed Main Agent workspace'));
    assert(agentsFile.includes('牧场除虫计划'));
    assert(qwenFile.includes('You are the Farming Main Agent'));
    assert(qwenFile.includes('牧场除虫计划'));
    assert(indexFile.includes('memory-report'));
    assert(indexFile.includes('pest-control'));
    assert(fs.existsSync(path.join(tmpDir, 'skills', 'pest-control.md')));
    assert(memoryReportFile.includes('记忆读取总结'));
    assert(pestControlFile.includes('牧场除虫计划'));
    assert(pestControlFile.includes('模块：<name>'));

    console.log('✓ Main Agent skills render memory-report and pest-control coding-agent memory files');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
