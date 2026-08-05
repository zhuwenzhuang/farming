const path = require('path');
import { chatCapabilitiesForProvider } from './chat-runtime.cjs';
import { createProviderSessionId, createTemporaryProviderSessionId, isSafeProviderSessionId } from './provider-session-id.cjs';

type ProviderId = 'codex' | 'claude' | 'opencode' | 'qoder' | 'qwen';
type ProviderRuntime = 'terminal' | 'acp';
type ProviderForkWorktreeMode = 'same-worktree' | 'new-worktree';
type ProviderConversationForkStrategy = 'source-session' | 'target-process';
type GoalSubmission =
  | { kind: 'prompt' }
  | { kind: 'command'; prefix: string };

interface ProviderConversationForkCapability {
  supported: boolean;
  strategy: ProviderConversationForkStrategy | null;
  worktreeModes: ProviderForkWorktreeMode[];
  requiresRuntimeCapability: boolean;
}

interface ProviderConversationForkContract {
  terminal?: {
    strategy: ProviderConversationForkStrategy;
    worktreeModes: readonly ProviderForkWorktreeMode[];
  };
  acp?: {
    strategy: ProviderConversationForkStrategy;
    worktreeModes: readonly ProviderForkWorktreeMode[];
    requiresRuntimeCapability: true;
  };
}

interface PositionalArgument {
  value: string;
  index: number;
  afterDelimiter: boolean;
}

interface PositionalScanOptions {
  multiValueOptions?: ReadonlySet<string>;
}

interface ProviderSessionPlan {
  id?: string;
  precreate?: boolean;
  temporary?: boolean;
  source?: string;
  forkedFromProviderSessionId?: string;
  identityWorkspace?: string;
  resumeInsertIndex?: number;
  error?: string;
  args?: string[];
}

interface ProviderEnvironmentOptions {
  [key: string]: unknown;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  farmingSystemPrompt?: string;
  approvalMode?: string;
}

interface ProviderAcpLaunchOptions {
  executable?: string;
  cwd?: string;
  projectWorkspace?: string;
  farmingSystemPrompt?: string;
}

interface ProviderAcpLaunch {
  command: string;
  args: string[];
}

interface ProviderAcpContract {
  packageName?: string;
  version: string;
  sharedRuntime?: boolean;
  launch?: (options: ProviderAcpLaunchOptions) => ProviderAcpLaunch;
}

interface ProviderCapabilitiesContract {
  runtimeSwitch: boolean;
  terminalProfile: boolean;
  goals: boolean;
  goalSubmission: {
    terminal: GoalSubmission;
    acp: GoalSubmission;
  };
  conversationFork: ProviderConversationForkContract;
}

interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  executable: string;
  homeEnvKey: string;
  interruptInput: string;
  freshAcpSessionSources: readonly string[];
  commands: readonly string[];
  supportedRuntimes: readonly ProviderRuntime[];
  planSession: (rawArgs: string[], launchArgs: string[]) => ProviderSessionPlan | null;
  terminalResumeArgs?: (
    args: string[],
    sessionId: string,
    plan?: ProviderSessionPlan,
  ) => string[];
  acp: ProviderAcpContract;
  prepareAcpEnvironment?: (options?: ProviderEnvironmentOptions) => NodeJS.ProcessEnv;
  capabilities: ProviderCapabilitiesContract;
}

interface PublicProviderCapabilities {
  supportedRuntimes: ProviderRuntime[];
  runtimeSwitch: boolean;
  terminalProfile: boolean;
  goals: boolean;
  goalSubmission: ProviderCapabilitiesContract['goalSubmission'] | null;
  conversationFork: {
    terminal: ProviderConversationForkCapability;
    acp: ProviderConversationForkCapability;
  };
  /** Compatibility fields derived from conversationFork. */
  terminalSessionFork: boolean;
  sessionFork: boolean;
  chatRuntime: string;
  supportsChat: boolean;
  supportsSteer: boolean;
}

const CODEX_VALUE_OPTIONS = new Set([
  '-a', '-c', '-C', '-m', '-p', '-s', '--ask-for-approval', '--cd', '--config',
  '--config-profile', '--model', '--profile', '--sandbox', '--add-dir',
  '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '--local-provider', '-i', '--image',
]);
const OPENCODE_VALUE_OPTIONS = new Set([
  '-m', '-s', '--agent', '--hostname', '--log-level', '--mdns-domain',
  '--model', '--port', '--prompt', '--replay-limit', '--session',
]);
const CODEX_SUBCOMMANDS = new Set([
  'exec', 'e', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server',
  'app-server', 'remote-control', 'app', 'completion', 'update', 'doctor',
  'sandbox', 'debug', 'apply', 'a', 'resume', 'archive', 'delete', 'unarchive',
  'fork', 'cloud', 'exec-server', 'features', 'help',
]);
const OPENCODE_SUBCOMMANDS = new Set([
  'completion', 'acp', 'mcp', 'attach', 'run', 'debug', 'providers', 'auth',
  'agent', 'upgrade', 'uninstall', 'serve', 'web', 'models', 'stats', 'export',
  'import', 'github', 'pr', 'session', 'plugin', 'plug', 'db',
]);
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_CONVERSATION_FORK: ProviderConversationForkCapability = Object.freeze({
  supported: false,
  strategy: null,
  worktreeModes: [],
  requiresRuntimeCapability: false,
});

function conversationForkCapability(
  adapter: Readonly<ProviderAdapter> | null,
  runtime: ProviderRuntime,
): ProviderConversationForkCapability {
  const declared = adapter?.capabilities?.conversationFork?.[runtime];
  if (!declared) return { ...NO_CONVERSATION_FORK, worktreeModes: [] };
  return {
    supported: true,
    strategy: declared.strategy,
    worktreeModes: [...declared.worktreeModes],
    requiresRuntimeCapability: runtime === 'acp'
      && 'requiresRuntimeCapability' in declared
      && declared.requiresRuntimeCapability === true,
  };
}

function optionTakesValue(option: string, valueOptions: ReadonlySet<string>): boolean {
  return Boolean(option && !option.includes('=') && valueOptions.has(option));
}

function scanPositionals(
  args: string[],
  valueOptions: ReadonlySet<string>,
  options: PositionalScanOptions = {},
): PositionalArgument[] {
  const positionals: PositionalArgument[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (!arg) continue;
    if (arg === '--') {
      for (let positionalIndex = index + 1; positionalIndex < args.length; positionalIndex += 1) {
        const value = String(args[positionalIndex] || '');
        if (value) positionals.push({ value, index: positionalIndex, afterDelimiter: true });
      }
      break;
    }
    if (arg.startsWith('-')) {
      if (
        options.multiValueOptions?.has(arg)
        && !arg.includes('=')
      ) {
        while (index + 1 < args.length && !String(args[index + 1] || '').startsWith('-')) index += 1;
        continue;
      }
      if (optionTakesValue(arg, valueOptions)) index += 1;
      continue;
    }
    positionals.push({ value: arg, index, afterDelimiter: false });
  }
  return positionals;
}

function codexSessionIdAfterSubcommand(args: string[], subcommandIndex: number): string {
  const sessionId = scanPositionals(
    args.slice(subcommandIndex + 1),
    CODEX_VALUE_OPTIONS,
    { multiValueOptions: new Set(['-i', '--image']) },
  )[0]?.value || '';
  return CODEX_SESSION_ID_RE.test(sessionId) ? sessionId.toLowerCase() : '';
}

function argValue(args: string[], names: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    for (const name of names) {
      if (arg === name) return args[index + 1] || '';
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return '';
}

function hasArg(args: string[], names: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '--') break;
    if (names.includes(arg) || names.some(name => arg.startsWith(`${name}=`))) return true;
  }
  return false;
}

function codexSessionPlan(rawArgs: string[], _launchArgs: string[]): ProviderSessionPlan | null {
  const positional = scanPositionals(rawArgs, CODEX_VALUE_OPTIONS, {
    multiValueOptions: new Set(['-i', '--image']),
  });
  const subcommand = positional[0]
    && positional[0].afterDelimiter !== true
    && CODEX_SUBCOMMANDS.has(positional[0].value)
    ? positional[0]
    : null;
  if (subcommand?.value === 'resume') {
    const id = hasArg(rawArgs.slice(subcommand.index + 1), ['--last'])
      ? ''
      : codexSessionIdAfterSubcommand(rawArgs, subcommand.index);
    if (id) return { id, temporary: false, source: 'resume' };
  }
  if (subcommand?.value === 'fork') {
    return {
      id: createTemporaryProviderSessionId(),
      temporary: true,
      source: 'codex-fork-temporary',
      forkedFromProviderSessionId: hasArg(rawArgs.slice(subcommand.index + 1), ['--last'])
        ? ''
        : codexSessionIdAfterSubcommand(rawArgs, subcommand.index),
    };
  }
  if (subcommand) return null;
  if (hasArg(rawArgs, ['--remote'])) {
    return {
      error: 'A fresh Codex --remote Terminal cannot be correlated with a local resumable session id; resume an explicit remote session id instead',
    };
  }
  return {
    id: createTemporaryProviderSessionId(),
    temporary: true,
    source: 'codex-temporary',
  };
}

function explicitSessionPlan(
  provider: ProviderId,
  rawArgs: string[],
  launchArgs: string[],
): ProviderSessionPlan | null {
  const explicitSessionId = argValue(rawArgs, ['--session-id']);
  const resumeSessionId = argValue(rawArgs, ['--resume']);
  const isFork = hasArg(rawArgs, ['--fork-session']);
  const isContinue = hasArg(rawArgs, provider === 'claude' ? ['--continue', '-c'] : ['--continue']);
  if (explicitSessionId && isSafeProviderSessionId(explicitSessionId)) {
    return {
      id: explicitSessionId,
      temporary: false,
      source: 'launch-session-id',
      forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    };
  }
  if (resumeSessionId && isSafeProviderSessionId(resumeSessionId) && !isFork) {
    return { id: resumeSessionId, temporary: false, source: 'resume' };
  }
  if (isContinue) return null;
  const id = createProviderSessionId();
  return {
    id,
    temporary: false,
    source: isFork ? `${provider}-fork-session-id` : `${provider}-session-id`,
    forkedFromProviderSessionId: isFork && isSafeProviderSessionId(resumeSessionId) ? resumeSessionId : '',
    args: ['--session-id', id, ...launchArgs],
  };
}

function openCodeSessionPlan(rawArgs: string[], launchArgs: string[]): ProviderSessionPlan | null {
  const id = argValue(rawArgs, ['--session', '-s']);
  if (id && isSafeProviderSessionId(id)) {
    return hasArg(rawArgs, ['--fork'])
      ? {
        id: createTemporaryProviderSessionId(),
        temporary: true,
        source: 'opencode-fork-temporary',
        forkedFromProviderSessionId: id,
      }
      : { id, temporary: false, source: 'resume' };
  }
  if (hasArg(rawArgs, ['--session', '-s', '--continue', '-c', '--fork'])) return null;
  const positional = scanPositionals(rawArgs, OPENCODE_VALUE_OPTIONS, {
    multiValueOptions: new Set(['--cors']),
  });
  if (
    positional[0]
    && positional[0].afterDelimiter !== true
    && OPENCODE_SUBCOMMANDS.has(positional[0].value)
  ) return null;
  return {
    id: '',
    precreate: true,
    temporary: false,
    source: 'opencode-precreate',
    identityWorkspace: positional[0]?.value || '',
    resumeInsertIndex: launchArgs.length,
  };
}

function codexAcpEnvironment(
  options: ProviderEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env = { ...(options.env || process.env) };
  if (options.executable) env.CODEX_PATH = options.executable;
  let config: Record<string, unknown> = {};
  if (env.CODEX_CONFIG) {
    try {
      const parsed: unknown = JSON.parse(env.CODEX_CONFIG);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // A selected Farming profile below replaces an invalid adapter config.
    }
  }
  if (options.model && options.model !== 'config') config.model = options.model;
  if (options.reasoningEffort && options.reasoningEffort !== 'config') config.model_reasoning_effort = options.reasoningEffort;
  if (options.serviceTier && !['config', 'default'].includes(options.serviceTier)) config.service_tier = options.serviceTier;
  if (typeof options.farmingSystemPrompt === 'string' && options.farmingSystemPrompt.trim()) {
    config.developer_instructions = [
      typeof config.developer_instructions === 'string' ? config.developer_instructions.trim() : '',
      options.farmingSystemPrompt.trim(),
    ].filter(Boolean).join('\n\n');
  }
  if (Object.keys(config).length > 0) env.CODEX_CONFIG = JSON.stringify(config);
  const initialMode = options.approvalMode
    ? { ask: 'read-only', approve: 'agent', full: 'agent-full-access' }[options.approvalMode]
    : undefined;
  if (initialMode) env.INITIAL_AGENT_MODE = initialMode;
  return env;
}

function claudeAcpEnvironment(
  options: ProviderEnvironmentOptions = {},
): NodeJS.ProcessEnv {
  const env = { ...(options.env || process.env) };
  if (options.executable) {
    env.CLAUDE_CODE_EXECUTABLE = options.executable;
  }
  return env;
}

const PROVIDER_ADAPTERS: readonly ProviderAdapter[] = Object.freeze([
  {
    id: 'codex',
    displayName: 'codex',
    executable: 'codex',
    homeEnvKey: 'CODEX_HOME',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['codex-temporary'],
    commands: ['codex'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: codexSessionPlan,
    terminalResumeArgs: (args, sessionId) => ['resume', sessionId, ...args],
    acp: {
      packageName: '@agentclientprotocol/codex-acp',
      version: '1.1.4',
      sharedRuntime: true,
    },
    prepareAcpEnvironment: codexAcpEnvironment,
    capabilities: {
      runtimeSwitch: true,
      terminalProfile: true,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: { strategy: 'target-process', worktreeModes: ['same-worktree', 'new-worktree'] },
        acp: {
          strategy: 'source-session',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
    },
  },
  {
    id: 'claude',
    displayName: 'claude code',
    executable: 'claude',
    homeEnvKey: 'CLAUDE_CONFIG_DIR',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['claude-session-id'],
    commands: ['claude'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('claude', rawArgs, launchArgs),
    acp: {
      packageName: '@agentclientprotocol/claude-agent-acp',
      version: '0.59.0',
      sharedRuntime: true,
    },
    prepareAcpEnvironment: claudeAcpEnvironment,
    capabilities: {
      runtimeSwitch: true,
      terminalProfile: false,
      goals: false,
      goalSubmission: { terminal: { kind: 'command', prefix: '/goal' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: { strategy: 'target-process', worktreeModes: ['same-worktree', 'new-worktree'] },
        acp: {
          strategy: 'target-process',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
    },
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    executable: 'opencode',
    homeEnvKey: 'OPENCODE_CONFIG_DIR',
    interruptInput: '\x03',
    freshAcpSessionSources: [],
    commands: ['opencode'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: openCodeSessionPlan,
    terminalResumeArgs: (args, sessionId) => {
      const delimiterIndex = args.indexOf('--');
      const insertIndex = delimiterIndex >= 0 ? delimiterIndex : args.length;
      return [
        ...args.slice(0, insertIndex),
        '--session',
        sessionId,
        ...args.slice(insertIndex),
      ];
    },
    acp: {
      version: 'native',
      sharedRuntime: true,
      launch: options => ({
        command: options.executable || 'opencode',
        args: ['acp', '--cwd', path.resolve(options.projectWorkspace || options.cwd || process.cwd())],
      }),
    },
    capabilities: {
      runtimeSwitch: true,
      terminalProfile: false,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: { strategy: 'target-process', worktreeModes: ['same-worktree', 'new-worktree'] },
        acp: {
          strategy: 'source-session',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
    },
  },
  {
    id: 'qoder',
    displayName: 'qoder',
    executable: 'qodercli',
    homeEnvKey: 'QODER_CONFIG_DIR',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['qoder-session-id'],
    commands: ['qoder', 'qodercli'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('qoder', rawArgs, launchArgs),
    acp: {
      version: 'native',
      sharedRuntime: true,
      launch: options => ({
        command: options.executable || 'qodercli',
        args: [
          ...(typeof options.farmingSystemPrompt === 'string' && options.farmingSystemPrompt.trim()
            ? ['--append-system-prompt', options.farmingSystemPrompt.trim()]
            : []),
          '--acp',
        ],
      }),
    },
    capabilities: {
      runtimeSwitch: true,
      terminalProfile: false,
      goals: false,
      goalSubmission: { terminal: { kind: 'command', prefix: '/goal set' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: { strategy: 'target-process', worktreeModes: ['same-worktree', 'new-worktree'] },
        acp: {
          strategy: 'source-session',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
    },
  },
  {
    id: 'qwen',
    displayName: 'qwen code',
    executable: 'qwen',
    homeEnvKey: 'QWEN_HOME',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['qwen-session-id'],
    commands: ['qwen'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('qwen', rawArgs, launchArgs),
    terminalResumeArgs: (args, sessionId) => {
      const delimiterIndex = args.indexOf('--');
      const insertIndex = delimiterIndex >= 0 ? delimiterIndex : args.length;
      return [
        ...args.slice(0, insertIndex),
        '--resume',
        sessionId,
        ...args.slice(insertIndex),
      ];
    },
    acp: {
      version: 'native',
      sharedRuntime: true,
      launch: options => ({
        command: options.executable || 'qwen',
        args: [
          ...(typeof options.farmingSystemPrompt === 'string' && options.farmingSystemPrompt.trim()
            ? ['--append-system-prompt', options.farmingSystemPrompt.trim()]
            : []),
          '--acp',
        ],
      }),
    },
    capabilities: {
      runtimeSwitch: true,
      terminalProfile: false,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
      conversationFork: {
        acp: {
          strategy: 'source-session',
          worktreeModes: ['same-worktree'],
          requiresRuntimeCapability: true,
        },
      },
    },
  },
]);

const ADAPTER_BY_ID = new Map<ProviderId, Readonly<ProviderAdapter>>(
  PROVIDER_ADAPTERS.map(adapter => [adapter.id, Object.freeze(adapter)]),
);
const ADAPTER_BY_COMMAND = new Map<string, ProviderAdapter>(PROVIDER_ADAPTERS.flatMap(adapter => (
  adapter.commands.map(command => [command, adapter] as [string, ProviderAdapter])
)));

function getProviderAdapter(provider: unknown): Readonly<ProviderAdapter> | null {
  const providerId = String(provider || '').trim().toLowerCase() as ProviderId;
  return ADAPTER_BY_ID.get(providerId) || null;
}

function providerForProgram(program: unknown): ProviderId | '' {
  return ADAPTER_BY_COMMAND.get(path.basename(String(program || '').trim()))?.id || '';
}

function listProviderAdapters(): readonly ProviderAdapter[] {
  return [...PROVIDER_ADAPTERS];
}

function providerCapabilities(provider: unknown): PublicProviderCapabilities {
  const adapter = getProviderAdapter(provider);
  const terminalFork = conversationForkCapability(adapter, 'terminal');
  const acpFork = conversationForkCapability(adapter, 'acp');
  return {
    supportedRuntimes: adapter ? [...adapter.supportedRuntimes] : ['terminal'],
    runtimeSwitch: adapter?.capabilities?.runtimeSwitch === true,
    terminalProfile: adapter?.capabilities?.terminalProfile === true,
    goals: adapter?.capabilities?.goals === true,
    goalSubmission: adapter?.capabilities?.goalSubmission || null,
    conversationFork: {
      terminal: terminalFork,
      acp: acpFork,
    },
    terminalSessionFork: terminalFork.supported,
    sessionFork: acpFork.supported,
    ...(adapter
      ? chatCapabilitiesForProvider(provider)
      : { chatRuntime: '', supportsChat: false, supportsSteer: false }),
  };
}

function providerSupportsRuntime(provider: unknown, runtime: ProviderRuntime): boolean {
  return getProviderAdapter(provider)?.supportedRuntimes.includes(runtime) === true;
}

function providerSupportsSharedAcpRuntime(provider: unknown): boolean {
  return getProviderAdapter(provider)?.acp.sharedRuntime === true;
}

function providerConversationForkCapability(
  provider: unknown,
  runtime: ProviderRuntime,
): ProviderConversationForkCapability {
  return conversationForkCapability(getProviderAdapter(provider), runtime);
}

function applyProviderHomeEnvironment(
  env: NodeJS.ProcessEnv,
  provider: unknown,
  homePath: string,
): NodeJS.ProcessEnv {
  const key = getProviderAdapter(provider)?.homeEnvKey;
  if (key && homePath) env[key] = homePath;
  return env;
}

function isFreshAcpSessionSource(provider: unknown, source: string): boolean {
  return getProviderAdapter(provider)?.freshAcpSessionSources.includes(source) === true;
}

export {
  claudeAcpEnvironment,
  getProviderAdapter,
  applyProviderHomeEnvironment,
  isFreshAcpSessionSource,
  listProviderAdapters,
  providerConversationForkCapability,
  providerCapabilities,
  providerForProgram,
  providerSupportsSharedAcpRuntime,
  providerSupportsRuntime,
};
