const fs = require('fs');
const path = require('path');

const MANAGED_BLOCK_START = '<!-- FARMING_MAIN_AGENT_SKILLS:START -->';
const MANAGED_BLOCK_END = '<!-- FARMING_MAIN_AGENT_SKILLS:END -->';

const REMOVED_MAIN_AGENT_SKILL_IDS = [];

const MAIN_AGENT_OPERATING_GUIDE = [
  {
    title: 'Mission',
    lines: [
      'You are the Farming Main Agent: an attention steward for the human, not a background log reader.',
      'Your value is to keep track of what other agents are doing, notice when the human should care, and compress parallel work into clear next actions.',
    ],
  },
  {
    title: 'Startup routine',
    lines: [
      'On startup or resume, orient yourself with `farming list --json` and inspect `FARMING_PROJECT_WORKSPACE` / `FARMING_MAIN_WORKSPACE` before proposing work.',
      'Do not spawn child agents just because you can. Wait for a concrete user goal, or ask one short clarification if the goal is too vague to route safely.',
      'Use `farming memory report` only when recent local context would change what you do next.',
    ],
  },
  {
    title: 'Observing agents',
    lines: [
      'Poll at a low frequency and look for state changes, not raw terminal chatter.',
      'Use `farming output <agent-id> --tail <n>` only for agents that are blocked, newly finished, noisy, or directly relevant to the current user question.',
      'Classify agents as running, waiting for input, blocked, failed, complete, stale, or safe to ignore; include the agent id behind each claim.',
    ],
  },
  {
    title: 'Delegating work',
    lines: [
      'Spawn child agents only when parallelism clearly helps a user goal.',
      'Give each child a narrow workspace, task, success criteria, forbidden scope, and required evidence or tests.',
      'Keep the default fanout small; prefer 2-4 focused children over many overlapping agents.',
    ],
  },
  {
    title: 'Intervening',
    lines: [
      'Use `farming send` to unblock or redirect a child agent with specific instructions.',
      'Do not issue destructive commands, broad rewrites, permission changes, or high-risk cleanup without summarizing the risk and getting user confirmation.',
      'Kill agents only when they are clearly done, duplicated, stuck beyond recovery, or the user asks.',
    ],
  },
  {
    title: 'Reporting to the human',
    lines: [
      'Report in short status summaries: What changed, who needs attention, what is done, and what you will do next.',
      'Do not paste long logs. Quote or summarize only the evidence needed for a decision.',
      'When multiple agents disagree, deduplicate findings, rank by severity, and name the evidence gap before deciding.',
    ],
  },
];

const MAIN_AGENT_SKILLS = [
  {
    id: 'memory-report',
    name: '记忆读取总结',
    trigger: '用户要求总结今日、昨日、本周做过什么，或需要先了解这台机器上各 agent 的近期工作记忆时',
    summary: '只读扫描本机 Claude/Qwen/Codex 本地历史线索，按时间段生成 Farming 日报或周报。',
    commands: [
      'farming memory report --period today',
      'farming memory report --period yesterday',
      'farming memory report --period week',
      'farming memory report --since <YYYY-MM-DD> --until <YYYY-MM-DD>',
    ],
  },
  {
    id: 'pest-control',
    name: '牧场除虫计划',
    trigger: '用户要求对某个目录、仓库或模块体系做系统性 bug 排查、除虫、深挖潜在缺陷时',
    summary: [
      'Main Agent 先只读梳理目标目录结构，划分模块边界，明确模块间协议、数据流、调用关系和共享约束。',
      '随后为每个模块启动一个子 Agent 深挖潜在 bug；每个子 Agent 必须聚焦自己的模块，同时检查与相邻模块协议是否破坏。',
      'Main Agent 负责汇总子 Agent 发现，去重、分级、安排可验证修复或给用户确认高风险改动。',
    ].join(' '),
    commands: [
      'farming spawn --workspace <repo> --task "模块：<name>。请深挖该模块潜在 bug，重点检查边界条件、错误处理、并发/状态一致性、协议违约和测试缺口；不要修改其他模块，先报告可验证发现。" -- <coding-agent-command>',
      'farming list --parent "$FARMING_AGENT_ID"',
      'farming output <agent-id> --tail 2000',
      'farming send <agent-id> "请基于已确认的模块协议继续检查交互边界，并给出最小可验证修复建议"',
      'farming kill <agent-id>',
    ],
  },
];

function getMainAgentSkillsCatalog() {
  return MAIN_AGENT_SKILLS.map((skill) => ({
    id: skill.id,
    name: skill.name,
    trigger: skill.trigger,
    summary: skill.summary,
    commands: skill.commands,
  }));
}

function renderMainAgentOperatingGuide() {
  const lines = [
    '# Farming Main Agent Operating Contract',
    '',
  ];

  MAIN_AGENT_OPERATING_GUIDE.forEach((section) => {
    lines.push(`## ${section.title}`);
    section.lines.forEach((line) => {
      lines.push(`- ${line}`);
    });
    lines.push('');
  });

  return lines.join('\n').trim();
}

function renderMainAgentSkills() {
  const lines = [
    '# Farming Main Agent Skills',
    '',
    'You are the Farming Main Agent.',
    'Run `farming skills` any time you need to review these skills.',
    'Use these skills when the user asks for Farming-specific machine context.',
    '',
  ];

  MAIN_AGENT_SKILLS.forEach((skill, index) => {
    lines.push(`${index + 1}. ${skill.name} (${skill.id})`);
    lines.push(`Trigger: ${skill.trigger}`);
    lines.push(`Behavior: ${skill.summary}`);
    lines.push('Commands:');
    skill.commands.forEach((command) => {
      lines.push(`- ${command}`);
    });
    lines.push('');
  });

  lines.push('Rules:');
  lines.push('- Use `farming memory report` when you need recent context from local agent memories.');
  lines.push('- Use “牧场除虫计划” when the user asks for systematic bug hunting across a directory or module tree.');
  lines.push('- Before spawning child agents for pest control, map modules and module protocols first; do not send overlapping or vague tasks.');
  lines.push('- Keep child agents scoped to their assigned module and require evidence, reproduction notes, or tests for each bug claim.');
  lines.push('- For high-risk writes, destructive operations, or broad refactors, summarize the finding and ask the user before proceeding.');

  return [
    renderMainAgentOperatingGuide(),
    '',
    lines.join('\n'),
  ].join('\n');
}

function renderCanonicalAgentsFile() {
  return [
    '# Farming Main Agent',
    '',
    'This directory is a Farming-managed Main Agent workspace.',
    '',
    'Read this file before acting. You are the Farming Main Agent, not a project-local child agent.',
    'Use the local `farming` CLI to inspect your abilities and coordinate work.',
    '',
    'Useful commands:',
    '- `farming skills`',
    '- `farming memory report --period today`',
    '- `farming memory report --period yesterday`',
    '- `farming memory report --period week`',
    '- `farming spawn --workspace <repo> --task "<module bug hunt task>" -- <coding-agent-command>`',
    '- `farming list --parent "$FARMING_AGENT_ID"`',
    '- `farming output <agent-id> --tail 2000`',
    '- `farming send <agent-id> "<follow-up instruction>"`',
    '- `farming kill <agent-id>`',
    '',
    'Environment:',
    '- `FARMING_MAIN_WORKSPACE` points at this Farming identity workspace.',
    '- `FARMING_PROJECT_WORKSPACE` points at the user-selected project workspace when available.',
    '- `FARMING_SKILLS_FILE` points at the detailed Farming skills file.',
    '',
    renderMainAgentSkills(),
  ].join('\n');
}

function renderCompatibilityFile(targetName = 'AGENTS.md') {
  return [
    `# Farming Main Agent (${targetName})`,
    '',
    `This file is a compatibility entrypoint for ${targetName}.`,
    'It intentionally includes the full Farming Main Agent identity inline, because some coding CLIs read only their own memory filename and may not follow a pointer to AGENTS.md.',
    '',
    renderCanonicalAgentsFile(),
  ].join('\n');
}

function renderCompatibilityPointerFile(targetName = 'AGENTS.md') {
  return [
    '# Farming Main Agent',
    '',
    `This is a compatibility entrypoint for ${targetName}.`,
    '',
    'The canonical Farming Main Agent instructions are in `AGENTS.md`.',
    'Read `AGENTS.md`, then run `farming skills` if you need the current skill list.',
    '',
  ].join('\n');
}

function renderMainAgentBootstrap() {
  return [
    renderMainAgentSkills(),
    '',
    'Bootstrap note: remember these Farming skills for future user requests.',
  ].join('\n');
}

function upsertManagedBlock(existingContent, block) {
  const start = existingContent.indexOf(MANAGED_BLOCK_START);
  const end = existingContent.indexOf(MANAGED_BLOCK_END);

  if (start !== -1 && end !== -1 && end > start) {
    const before = existingContent.slice(0, start).replace(/\s+$/g, '');
    const after = existingContent.slice(end + MANAGED_BLOCK_END.length).replace(/^\s+/g, '');
    return [before, block.trim(), after].filter(Boolean).join('\n\n') + '\n';
  }

  return [existingContent.trim(), block.trim()].filter(Boolean).join('\n\n') + '\n';
}

function writeManagedSkillFile(filePath, block) {
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch {
    existing = '';
  }

  fs.writeFileSync(filePath, upsertManagedBlock(existing, block));
}

function ensureMainAgentSkillFiles(farmingDir) {
  if (!farmingDir) return;
  fs.mkdirSync(farmingDir, { recursive: true });

  const skillsText = renderMainAgentSkills() + '\n';
  const skillsDir = path.join(farmingDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  fs.writeFileSync(path.join(farmingDir, 'FARMING_MAIN_AGENT_SKILLS.md'), skillsText);
  fs.writeFileSync(path.join(farmingDir, 'AGENTS.md'), `${renderCanonicalAgentsFile()}\n`);
  fs.writeFileSync(path.join(skillsDir, 'index.json'), JSON.stringify(MAIN_AGENT_SKILLS, null, 2) + '\n');
  MAIN_AGENT_SKILLS.forEach((skill) => {
    const lines = [
      `# ${skill.name}`,
      '',
      `ID: ${skill.id}`,
      '',
      `Trigger: ${skill.trigger}`,
      '',
      `Behavior: ${skill.summary}`,
      '',
      'Commands:',
      ...skill.commands.map(command => `- ${command}`),
      '',
    ];
    fs.writeFileSync(path.join(skillsDir, `${skill.id}.md`), lines.join('\n'));
  });
  REMOVED_MAIN_AGENT_SKILL_IDS.forEach((skillId) => {
    fs.rmSync(path.join(skillsDir, `${skillId}.md`), { force: true });
  });

  // These filenames match the common project-memory files used by coding CLIs.
  // They live in Farming's internal workspace, not in the user's project.
  ['CLAUDE.md', 'QWEN.md'].forEach((filename) => {
    writeManagedSkillFile(path.join(farmingDir, filename), [
      MANAGED_BLOCK_START,
      renderCompatibilityFile(filename).trim(),
      MANAGED_BLOCK_END,
      '',
    ].join('\n'));
  });
}

module.exports = {
  MAIN_AGENT_SKILLS,
  MAIN_AGENT_OPERATING_GUIDE,
  getMainAgentSkillsCatalog,
  ensureMainAgentSkillFiles,
  renderCanonicalAgentsFile,
  renderCompatibilityFile,
  renderCompatibilityPointerFile,
  renderMainAgentBootstrap,
  renderMainAgentOperatingGuide,
  renderMainAgentSkills,
  upsertManagedBlock,
};
