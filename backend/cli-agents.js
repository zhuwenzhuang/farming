const path = require('path');

const CLI_AGENTS = [
  {
    name: 'qwen',
    description: 'Qwen Code coding assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--yolo']
    }
  },
  {
    name: 'codex',
    description: 'Codex CLI - OpenAI coding assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--dangerously-bypass-approvals-and-sandbox']
    }
  },
  {
    name: 'opencode',
    description: 'OpenCode - AI coding assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'aider',
    description: 'Aider - AI pair programming',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'github-copilot-cli',
    description: 'GitHub Copilot CLI',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'claude',
    description: 'Claude CLI - Anthropic assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--dangerously-skip-permissions']
    },
    systemPromptArg: '--append-system-prompt'
  },
  {
    name: 'amazon-q',
    description: 'Amazon Q - AWS AI assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'bash',
    description: 'Bash shell',
    category: 'other',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'zsh',
    description: 'Z shell',
    category: 'other',
    interactive: true,
    supported: true,
    preferredEngine: 'native'
  },
  {
    name: 'cursor',
    description: 'Cursor AI - Code editor with AI',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'continue',
    description: 'Continue - AI code assistant',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'codeium',
    description: 'Codeium - Free AI coding assistant',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'tabnine',
    description: 'Tabnine - AI code completion',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'cody',
    description: 'Sourcegraph Cody - AI coding',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'replit',
    description: 'Replit AI - Browser IDE',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'pearai',
    description: 'PearAI - AI code editor',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'mintlify',
    description: 'Mintlify - AI documentation',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  },
  {
    name: 'Pieces-cli',
    description: 'Pieces - Code snippet manager',
    category: 'gui-launcher',
    interactive: false,
    supported: false,
    preferredEngine: 'none'
  }
];

function getAgentSpec(command) {
  const program = parseCommand(command)[0] || '';
  const executableName = path.basename(program);
  return CLI_AGENTS.find((agent) => agent.name === executableName) || null;
}

function parseCommand(command) {
  const input = String(command || '').trim();
  const parts = [];
  let current = '';
  let quote = '';
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current) parts.push(current);
  return parts;
}

function getAgentSpecForProgram(program) {
  const executableName = path.basename(program);
  return CLI_AGENTS.find((agent) => agent.name === executableName) || null;
}

function getSupportedAgents() {
  return CLI_AGENTS.filter((agent) => agent.supported);
}

function getUserLaunchAgents() {
  return getSupportedAgents().filter((agent) => agent.name !== 'qwen');
}

function getConfiguredProfile(options, agentName) {
  const profiles = options && options.agentLaunchProfiles && typeof options.agentLaunchProfiles === 'object'
    ? options.agentLaunchProfiles
    : {};
  const sharedProfile = options && options.agentLaunchProfile && typeof options.agentLaunchProfile === 'object'
    ? options.agentLaunchProfile
    : {};
  return {
    ...(profiles[agentName] || {}),
    ...sharedProfile,
  };
}

function hasArgValue(args, names) {
  return args.some((arg, index) => (
    names.includes(arg)
    || names.some(name => arg.startsWith(`${name}=`))
    || (names.includes(args[index - 1]) && Boolean(arg))
  ));
}

function resolveLaunchCommand(command, options = {}) {
  const parts = parseCommand(command);
  const program = parts[0] || '';
  const args = parts.slice(1);
  const spec = getAgentSpecForProgram(program);
  const launchArgs = [...args];
  const profile = spec ? getConfiguredProfile(options, spec.name) : {};
  const codexApprovalMode = ['ask', 'approve', 'full', 'custom'].includes(options.codexApprovalMode)
    ? options.codexApprovalMode
    : (['ask', 'approve', 'full', 'custom'].includes(profile.approvalMode) ? profile.approvalMode : '');
  const codexModelPreset = typeof options.codexModelPreset === 'string'
    ? options.codexModelPreset
    : (typeof profile.modelPreset === 'string' ? profile.modelPreset : '');
  const codexModel = typeof options.codexModel === 'string'
    ? options.codexModel
    : (typeof profile.model === 'string' ? profile.model : '');
  const codexReasoningEffort = typeof options.codexReasoningEffort === 'string'
    ? options.codexReasoningEffort
    : (typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : '');
  const codexServiceTier = typeof options.codexServiceTier === 'string'
    ? options.codexServiceTier
    : (typeof profile.serviceTier === 'string' ? profile.serviceTier : '');
  const claudePermissionMode = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'].includes(profile.permissionMode)
    ? profile.permissionMode
    : 'default';
  const claudeModel = typeof profile.model === 'string' ? profile.model : '';
  const claudeEffort = typeof profile.effort === 'string' ? profile.effort : '';
  const hasCodexApprovalOverride = launchArgs.some((arg) => [
    '-a',
    '--ask-for-approval',
    '-s',
    '--sandbox',
    '--dangerously-bypass-approvals-and-sandbox',
  ].includes(arg));
  const hasCodexModelOverride = launchArgs.some((arg) => ['-m', '--model'].includes(arg))
    || launchArgs.some((arg, index) => arg === '-c' && /^model=/.test(launchArgs[index + 1] || ''))
    || launchArgs.some((arg) => arg.startsWith('-cmodel=') || arg.startsWith('--config=model='));
  const hasCodexEffortOverride = launchArgs.some((arg, index) => arg === '-c' && /^model_reasoning_effort=/.test(launchArgs[index + 1] || ''))
    || launchArgs.some((arg) => arg.startsWith('-cmodel_reasoning_effort=') || arg.startsWith('--config=model_reasoning_effort='));
  const hasCodexServiceTierOverride = launchArgs.some((arg, index) => arg === '-c' && /^service_tier=/.test(launchArgs[index + 1] || ''))
    || launchArgs.some((arg) => arg.startsWith('-cservice_tier=') || arg.startsWith('--config=service_tier='));
  const hasClaudePermissionOverride = launchArgs.some((arg) => [
    '--permission-mode',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
  ].includes(arg) || arg.startsWith('--permission-mode='));
  const hasClaudeModelOverride = hasArgValue(launchArgs, ['--model']);
  const hasClaudeEffortOverride = hasArgValue(launchArgs, ['--effort']);

  if (spec && spec.name === 'codex') {
    const [presetModel, presetEffort] = codexModelPreset.split(':');
    const model = codexModel || presetModel;
    const effort = codexReasoningEffort || presetEffort;
    const shouldApplyModelProfile = !hasCodexModelOverride;

    if (model && shouldApplyModelProfile) {
      if (model !== 'config') launchArgs.unshift('--model', model);
    }
    if (effort && effort !== 'config' && shouldApplyModelProfile && !hasCodexEffortOverride) {
      launchArgs.unshift('-c', `model_reasoning_effort="${effort}"`);
    }
    if (codexServiceTier && codexServiceTier !== 'default' && codexServiceTier !== 'config' && shouldApplyModelProfile && !hasCodexServiceTierOverride) {
      launchArgs.unshift('-c', `service_tier="${codexServiceTier}"`);
    }
  }

  if (spec && spec.name === 'claude') {
    if (claudeModel && claudeModel !== 'config' && !hasClaudeModelOverride) {
      launchArgs.unshift('--model', claudeModel);
    }
    if (claudeEffort && claudeEffort !== 'config' && !hasClaudeEffortOverride) {
      launchArgs.unshift('--effort', claudeEffort);
    }
    if (claudePermissionMode !== 'default' && !hasClaudePermissionOverride) {
      launchArgs.unshift('--permission-mode', claudePermissionMode);
    }
  }

  if (spec && spec.name === 'codex' && codexApprovalMode && codexApprovalMode !== 'custom' && !hasCodexApprovalOverride) {
    if (codexApprovalMode === 'ask') {
      launchArgs.unshift('--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write');
    } else if (codexApprovalMode === 'approve') {
      launchArgs.unshift('--ask-for-approval', 'on-request', '--sandbox', 'workspace-write');
    } else if (codexApprovalMode === 'full') {
      launchArgs.unshift('--dangerously-bypass-approvals-and-sandbox');
    }
  } else if (
    options.dangerouslySkipPermissions === true &&
    spec &&
    spec.permissions &&
    spec.permissions.supportsDangerousSkip &&
    Array.isArray(spec.permissions.dangerousSkipArgs)
    && !(spec.name === 'claude' && claudePermissionMode !== 'default')
  ) {
    launchArgs.unshift(...spec.permissions.dangerousSkipArgs);
  }

  if (
    options.mainAgentSystemPrompt &&
    spec &&
    typeof spec.systemPromptArg === 'string'
  ) {
    launchArgs.push(spec.systemPromptArg, options.mainAgentSystemPrompt);
  }

  return {
    program,
    args: launchArgs,
    spec
  };
}

module.exports = CLI_AGENTS;
module.exports.getAgentSpec = getAgentSpec;
module.exports.parseCommand = parseCommand;
module.exports.getSupportedAgents = getSupportedAgents;
module.exports.getUserLaunchAgents = getUserLaunchAgents;
module.exports.resolveLaunchCommand = resolveLaunchCommand;
