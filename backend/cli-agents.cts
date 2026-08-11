const path = require('path') as typeof import('path');

type AgentCategory = 'coding' | 'gui-launcher' | 'other';
type PreferredEngine = 'native' | 'none';

interface AgentPermissions {
  dangerousSkipArgs: string[];
  supportsDangerousSkip: boolean;
}

interface CliAgentSpec {
  category: AgentCategory;
  command?: string;
  description: string;
  interactive: boolean;
  name: string;
  permissions?: AgentPermissions;
  preferredEngine: PreferredEngine;
  supported: boolean;
  systemPromptArg?: string;
}

interface CliAgentLaunchMetadata {
  launchOrder: number;
}

interface AgentLaunchProfile extends Record<string, unknown> {
  approvalMode?: unknown;
  effort?: unknown;
  model?: unknown;
  modelPreset?: unknown;
  permissionMode?: unknown;
  reasoningEffort?: unknown;
  serviceTier?: unknown;
}

interface ResolveLaunchOptions {
  agentLaunchProfile?: Record<string, unknown>;
  agentLaunchProfiles?: Record<string, unknown>;
  claudePermissionMode?: string;
  codexApprovalMode?: string;
  codexModel?: string;
  codexModelPreset?: string;
  codexReasoningEffort?: string;
  codexServiceTier?: string;
  dangerouslySkipPermissions?: boolean;
  farmingSystemPrompt?: string;
  mainAgentSystemPrompt?: string;
}

interface ResolvedLaunchCommand {
  args: string[];
  permissionMode: string;
  program: string;
  spec: CliAgentSpec | null;
}

interface AgentLaunchPolicyState {
  explicitPermissionMode: boolean;
  permissionMode: string;
  permissionOverride: boolean;
}

interface AgentLaunchPolicy {
  applyPermission(args: string[], permissionMode: string): void;
  applyProfile(
    args: string[],
    options: ResolveLaunchOptions,
    profile: AgentLaunchProfile,
  ): AgentLaunchPolicyState;
  applySystemPrompt?: (args: string[], systemPrompt: string) => void;
  inferPermissionMode(args: string[], permissionMode: string): string;
}

const CODEX_APPROVAL_MODES = ['ask', 'approve', 'full', 'custom'];
const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];

const CODEX_LAUNCH_POLICY: AgentLaunchPolicy = {
  applyProfile(launchArgs, options, profile) {
    const explicitPermissionMode = typeof options.codexApprovalMode === 'string'
      && CODEX_APPROVAL_MODES.includes(options.codexApprovalMode);
    const permissionMode = explicitPermissionMode
      ? (options.codexApprovalMode || '')
      : (typeof profile.approvalMode === 'string' && CODEX_APPROVAL_MODES.includes(profile.approvalMode)
        ? profile.approvalMode
        : '');
    const modelPreset = typeof options.codexModelPreset === 'string'
      ? options.codexModelPreset
      : (typeof profile.modelPreset === 'string' ? profile.modelPreset : '');
    const configuredModel = typeof options.codexModel === 'string'
      ? options.codexModel
      : (typeof profile.model === 'string' ? profile.model : '');
    const configuredEffort = typeof options.codexReasoningEffort === 'string'
      ? options.codexReasoningEffort
      : (typeof profile.reasoningEffort === 'string' ? profile.reasoningEffort : '');
    const serviceTier = typeof options.codexServiceTier === 'string'
      ? options.codexServiceTier
      : (typeof profile.serviceTier === 'string' ? profile.serviceTier : '');
    const permissionOverride = launchArgs.some((arg) => [
      '-a',
      '--ask-for-approval',
      '-s',
      '--sandbox',
      '--dangerously-bypass-approvals-and-sandbox',
    ].includes(arg));
    const modelOverride = launchArgs.some((arg) => ['-m', '--model'].includes(arg))
      || launchArgs.some((arg, index) => arg === '-c' && /^model=/.test(launchArgs[index + 1] || ''))
      || launchArgs.some((arg) => arg.startsWith('-cmodel=') || arg.startsWith('--config=model='));
    const effortOverride = launchArgs.some((arg, index) => arg === '-c' && /^model_reasoning_effort=/.test(launchArgs[index + 1] || ''))
      || launchArgs.some((arg) => arg.startsWith('-cmodel_reasoning_effort=') || arg.startsWith('--config=model_reasoning_effort='));
    const serviceTierOverride = launchArgs.some((arg, index) => arg === '-c' && /^service_tier=/.test(launchArgs[index + 1] || ''))
      || launchArgs.some((arg) => arg.startsWith('-cservice_tier=') || arg.startsWith('--config=service_tier='));
    const [presetModel, presetEffort] = modelPreset.split(':');
    const model = configuredModel || presetModel;
    const effort = configuredEffort || presetEffort;

    if (model && !modelOverride && model !== 'config') launchArgs.unshift('--model', model);
    if (effort && effort !== 'config' && !modelOverride && !effortOverride) {
      launchArgs.unshift('-c', `model_reasoning_effort="${effort}"`);
    }
    if (serviceTier && serviceTier !== 'config' && !modelOverride && !serviceTierOverride) {
      launchArgs.unshift('-c', `service_tier="${serviceTier}"`);
    }
    return { explicitPermissionMode, permissionMode, permissionOverride };
  },
  applyPermission(launchArgs, permissionMode) {
    if (permissionMode === 'ask') {
      launchArgs.unshift('--ask-for-approval', 'untrusted', '--sandbox', 'workspace-write');
    } else if (permissionMode === 'approve') {
      launchArgs.unshift('--ask-for-approval', 'on-request', '--sandbox', 'workspace-write');
    } else if (permissionMode === 'full') {
      launchArgs.unshift('--dangerously-bypass-approvals-and-sandbox');
    }
  },
  applySystemPrompt(launchArgs, systemPrompt) {
    launchArgs.unshift('-c', `developer_instructions=${JSON.stringify(systemPrompt)}`);
  },
  inferPermissionMode(launchArgs, permissionMode) {
    if (launchArgs.includes('--dangerously-bypass-approvals-and-sandbox')) return 'full';
    const approvalMode = argValue(launchArgs, ['-a', '--ask-for-approval']);
    if (approvalMode === 'untrusted') return 'ask';
    if (approvalMode === 'on-request') return 'approve';
    if (approvalMode) return 'custom';
    return permissionMode === 'custom' ? 'custom' : '';
  },
};

const CLAUDE_LAUNCH_POLICY: AgentLaunchPolicy = {
  applyProfile(launchArgs, options, profile) {
    const explicitPermissionMode = typeof options.claudePermissionMode === 'string'
      && CLAUDE_PERMISSION_MODES.includes(options.claudePermissionMode);
    const permissionMode = explicitPermissionMode
      ? (options.claudePermissionMode || 'default')
      : (typeof profile.permissionMode === 'string' && CLAUDE_PERMISSION_MODES.includes(profile.permissionMode)
        ? profile.permissionMode
        : 'default');
    const model = typeof profile.model === 'string' ? profile.model : '';
    const effort = typeof profile.effort === 'string' ? profile.effort : '';
    const permissionOverride = launchArgs.some((arg) => [
      '--permission-mode',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
    ].includes(arg) || arg.startsWith('--permission-mode='));
    if (model && model !== 'config' && !hasArgValue(launchArgs, ['--model'])) {
      launchArgs.unshift('--model', model);
    }
    if (effort && effort !== 'config' && !hasArgValue(launchArgs, ['--effort'])) {
      launchArgs.unshift('--effort', effort);
    }
    return { explicitPermissionMode, permissionMode, permissionOverride };
  },
  applyPermission(launchArgs, permissionMode) {
    if (permissionMode !== 'default') launchArgs.unshift('--permission-mode', permissionMode);
  },
  inferPermissionMode(launchArgs) {
    if (launchArgs.includes('--dangerously-skip-permissions')) return 'bypassPermissions';
    return argValue(launchArgs, ['--permission-mode']);
  },
};

const AGENT_LAUNCH_POLICIES: Readonly<Record<string, AgentLaunchPolicy>> = {
  codex: CODEX_LAUNCH_POLICY,
  claude: CLAUDE_LAUNCH_POLICY,
};

const CLI_AGENTS: CliAgentSpec[] = [
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
    name: 'opencode',
    description: 'OpenCode - AI coding assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--auto']
    }
  },
  {
    name: 'qoder',
    command: 'qodercli',
    description: 'Qoder - AI coding assistant',
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
    name: 'qwen',
    description: 'Qwen Code coding assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--yolo']
    },
    systemPromptArg: '--append-system-prompt'
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
    name: 'aider',
    description: 'Aider - AI pair programming',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--yes-always']
    }
  },
  {
    name: 'github-copilot-cli',
    description: 'GitHub Copilot CLI',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--allow-all-tools']
    }
  },
  {
    name: 'amazon-q',
    description: 'Amazon Q - AWS AI assistant',
    category: 'coding',
    interactive: true,
    supported: true,
    preferredEngine: 'native',
    permissions: {
      supportsDangerousSkip: true,
      dangerousSkipArgs: ['--trust-all-tools']
    }
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

function getAgentSpec(command: unknown): CliAgentSpec | null {
  const program = parseCommand(command)[0] || '';
  const executableName = path.basename(program);
  return CLI_AGENTS.find((agent) => agent.name === executableName || agent.command === executableName) || null;
}

function parseCommand(command: unknown): string[] {
  const input = String(command || '').trim();
  const parts = [];
  let current = '';
  let quote = '';
  let escaping = false;
  let hasToken = false;

  for (const char of input) {
    if (quote === "'") {
      // Single quotes: everything is literal except the closing quote.
      if (char === "'") quote = '';
      else current += char;
      continue;
    }

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
      hasToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current || hasToken) {
        parts.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escaping) current += '\\';
  if (current || hasToken) parts.push(current);
  return parts;
}

function getAgentSpecForProgram(program: string): CliAgentSpec | null {
  const executableName = path.basename(program);
  return CLI_AGENTS.find((agent) => agent.name === executableName || agent.command === executableName) || null;
}

function getHistoryAgentSpec(command: unknown): CliAgentSpec | null {
  const program = parseCommand(command).find(token => (
    token !== 'env' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
  ));
  return program ? getAgentSpecForProgram(program) : null;
}

function isSupportedHistoryAgent(command: unknown): boolean {
  const spec = getHistoryAgentSpec(command);
  return Boolean(spec && spec.supported === true && spec.category === 'coding');
}

function getSupportedAgents(): CliAgentSpec[] {
  return CLI_AGENTS.filter((agent) => agent.supported);
}

function getUserLaunchAgents(): CliAgentSpec[] {
  return getSupportedAgents();
}

function getAgentLaunchMetadata(agentName: unknown): CliAgentLaunchMetadata {
  const launchOrder = CLI_AGENTS.findIndex(agent => agent.name === String(agentName || ''));
  return {
    launchOrder: launchOrder === -1 ? CLI_AGENTS.length : launchOrder,
  };
}

function getConfiguredProfile(
  options: ResolveLaunchOptions,
  agentName: string,
): AgentLaunchProfile {
  const profiles = options.agentLaunchProfiles && typeof options.agentLaunchProfiles === 'object'
    ? options.agentLaunchProfiles
    : {};
  const sharedProfile = options.agentLaunchProfile && typeof options.agentLaunchProfile === 'object'
    ? options.agentLaunchProfile
    : {};
  const agentProfile = profiles[agentName];
  return {
    ...(agentProfile && typeof agentProfile === 'object' ? agentProfile : {}),
    ...sharedProfile,
  };
}

function hasArgValue(args: string[], names: string[]): boolean {
  return args.some((arg, index) => (
    names.includes(arg)
    || names.some(name => arg.startsWith(`${name}=`))
    || (names.includes(args[index - 1]) && Boolean(arg))
  ));
}

function argValue(args: string[], names: string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of names) {
      if (arg === name) {
        const value = args[index + 1];
        return value && !String(value).startsWith('-') ? String(value) : '';
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return '';
}

function inferLaunchPermissionMode(
  spec: CliAgentSpec | null,
  launchArgs: string[],
  policyPermissionMode = '',
): string {
  if (!spec) return '';
  const launchPolicy = AGENT_LAUNCH_POLICIES[spec.name];
  if (launchPolicy) return launchPolicy.inferPermissionMode(launchArgs, policyPermissionMode);

  if (
    spec.permissions &&
    spec.permissions.supportsDangerousSkip &&
    Array.isArray(spec.permissions.dangerousSkipArgs) &&
    spec.permissions.dangerousSkipArgs.some(arg => launchArgs.includes(arg))
  ) {
    return 'full';
  }

  return '';
}

function resolveLaunchCommand(
  command: unknown,
  options: ResolveLaunchOptions = {},
): ResolvedLaunchCommand {
  const parts = parseCommand(command);
  const rawProgram = parts[0] || '';
  if (!rawProgram.trim()) {
    throw new Error('spawn requires a non-empty executable');
  }
  const args = parts.slice(1);
  const spec = getAgentSpecForProgram(rawProgram);
  const rawProgramBasename = path.basename(rawProgram);
  const program = spec && spec.command && rawProgramBasename === spec.name && rawProgramBasename === rawProgram
    ? spec.command
    : rawProgram;
  const launchArgs = [...args];
  // Match VS Code's built-in macOS profiles: bash and zsh launch as login
  // shells, so their normal user profile is the source of prompt and PATH.
  if (
    process.platform === 'darwin' &&
    launchArgs.length === 0 &&
    spec &&
    (spec.name === 'bash' || spec.name === 'zsh')
  ) {
    launchArgs.push('-l');
  }
  const profile = spec ? getConfiguredProfile(options, spec.name) : {};
  const launchPolicy = spec ? AGENT_LAUNCH_POLICIES[spec.name] : undefined;
  const launchPolicyState = launchPolicy?.applyProfile(launchArgs, options, profile) || {
    explicitPermissionMode: false,
    permissionMode: '',
    permissionOverride: false,
  };

  const dangerousSkipArgs = spec?.permissions?.supportsDangerousSkip === true
    && Array.isArray(spec.permissions.dangerousSkipArgs)
    ? spec.permissions.dangerousSkipArgs
    : null;
  const hasDangerousSkipArgs = dangerousSkipArgs !== null;
  const hasDangerousSkipOverride = dangerousSkipArgs?.some(arg => launchArgs.includes(arg)) ?? false;
  const hasPermissionOverride = launchPolicy
    ? launchPolicyState.permissionOverride
    : hasDangerousSkipOverride;

  if (
    options.dangerouslySkipPermissions === true
    && hasDangerousSkipArgs
    && !hasPermissionOverride
    && !launchPolicyState.explicitPermissionMode
  ) {
    launchArgs.unshift(...dangerousSkipArgs);
  } else if (launchPolicy && !hasPermissionOverride) {
    launchPolicy.applyPermission(launchArgs, launchPolicyState.permissionMode);
  }

  const systemPrompt = [options.farmingSystemPrompt, options.mainAgentSystemPrompt]
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n\n');
  if (systemPrompt && spec && typeof spec.systemPromptArg === 'string') {
    launchArgs.push(spec.systemPromptArg, systemPrompt);
  } else if (systemPrompt && launchPolicy?.applySystemPrompt) {
    launchPolicy.applySystemPrompt(launchArgs, systemPrompt);
  }

  return {
    program,
    args: launchArgs,
    spec,
    permissionMode: inferLaunchPermissionMode(spec, launchArgs, launchPolicyState.permissionMode)
  };
}

export {
  CLI_AGENTS,
  getAgentLaunchMetadata,
  getAgentSpec,
  getSupportedAgents,
  getUserLaunchAgents,
  isSupportedHistoryAgent,
  parseCommand,
  resolveLaunchCommand,
};
export type {
  AgentCategory,
  CliAgentLaunchMetadata,
  AgentLaunchProfile,
  AgentPermissions,
  CliAgentSpec,
  PreferredEngine,
  ResolvedLaunchCommand,
  ResolveLaunchOptions,
};
