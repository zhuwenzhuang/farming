const path = require('path');
const crypto = require('crypto');
import { chatCapabilitiesForProvider } from './chat-runtime.cjs';
import { appendOpenCodeBootstrap } from './farming-agent-bootstrap.cjs';
import { createProviderSessionId, createTemporaryProviderSessionId, isSafeProviderSessionId } from './provider-session-id.cjs';
import type { ProviderCapabilitiesWire } from '../shared/agent-state-wire.js';

type ProviderId = 'codex' | 'claude' | 'pi' | 'opencode' | 'qoder' | 'qwen';
type ProviderRuntime = 'terminal' | 'acp';
type ProviderForkWorktreeMode = 'same-worktree' | 'new-worktree';
type ProviderConversationForkStrategy = 'source-session' | 'target-process';
type GoalSubmission =
  | { kind: 'prompt' }
  | { kind: 'command'; prefix: string };

interface ProviderTerminalStartupPolicy {
  readiness: {
    kind: 'output-includes';
    value: string;
  };
  serialization: 'provider-home';
}

interface ProviderSessionPolicy {
  defaultLaunchPermissionMode?: string;
  launchPermissionFallback?: 'profile-or-default';
  launchProfilePermissionKey?: 'approvalMode' | 'permissionMode';
  launchProfileOptionKeys?: Readonly<Record<string, string>>;
  permissionDisplayName?: string;
  permissionOption?: 'claudePermissionMode' | 'codexApprovalMode';
  permissionRestartModes?: readonly string[];
  preserveProfileOnResume?: boolean;
  preserveRequiredCliVersion?: boolean;
  resumeLaunchProfileOverrides?: Readonly<Record<string, string>>;
  suppressPermissionOptionWhenDangerousSkip?: boolean;
  freshPermissionRestartCommand?: string;
  identityScope?: 'provider' | 'provider-home';
  requiresStableTerminalSessionAfterInput?: boolean;
  terminalNotificationRequiresIdle?: boolean;
}

interface ProviderPermissionRestartPolicy {
  displayName: string;
  freshCommand: string;
  mode: string;
}

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
  agentId?: string;
  configDir?: string;
  executable?: string;
  cwd?: string;
  providerHomePath?: string;
  projectWorkspace?: string;
  farmingSystemPrompt?: string;
}

interface ProviderAcpLaunch {
  command: string;
  args: string[];
}

interface ProviderAcpPromptSuggestion {
  kind: 'prompt-suggestion';
  sessionId: string;
  text: string;
  promptId: string;
}

type ProviderAcpExtensionEvent = ProviderAcpPromptSuggestion;

interface ProviderAcpConfigPolicy {
  approvalModes?: Readonly<Record<string, string>>;
  coupleModelAndReasoning?: boolean;
  launchModelAndReasoning?: boolean;
  matchModelByName?: boolean;
  reasoningProfileKey?: string;
  serviceTier?: {
    enabledValues: readonly string[];
  };
}

interface ProviderAcpHistoryReplayPolicy {
  restoreMissingCheckpointMedia?: boolean;
  waitForNotifications?: boolean;
}

interface ProviderAcpSessionMetadataOptions {
  farmingSystemPrompt: string;
  sessionEnv: Record<string, string>;
}

interface ProviderAcpContract {
  acceptsMcpServers?: boolean;
  executablePolicy: 'managed' | 'system';
  packageName?: string;
  version: string;
  sharedRuntime?: boolean;
  config?: ProviderAcpConfigPolicy;
  historyReplay?: ProviderAcpHistoryReplayPolicy;
  launch?: (options: ProviderAcpLaunchOptions) => ProviderAcpLaunch;
  launchArgs?: (options: ProviderAcpLaunchOptions) => string[];
  normalizeModes?: (modes: unknown, agentInfo: Record<string, unknown>) => unknown;
  sessionMetadata?: (options: ProviderAcpSessionMetadataOptions) => Record<string, unknown>;
  normalizeExtensionNotification?: (
    method: string,
    params: Record<string, unknown>,
  ) => ProviderAcpExtensionEvent | null;
  normalizeHostMessageChunks?: boolean;
}

interface ProviderCapabilitiesContract {
  runtimeSwitch: boolean;
  contextWindow: boolean;
  terminalProfile: boolean;
  terminalComposerInput: 'plain-text' | 'bracketed-paste';
  slashCommandDiscovery: boolean;
  goals: boolean;
  goalSubmission: {
    terminal: GoalSubmission;
    acp: { kind: 'prompt' };
  };
  conversationFork: ProviderConversationForkContract;
}

type ProviderUsageCollection =
  | {
      kind: 'local-history';
      rootDirectories: readonly string[];
    }
  | {
      collector: 'opencode-session-export';
      kind: 'session-export';
    }
  | {
      kind: 'unavailable';
    };

type ProviderUsageLiveCollector = 'codex-cli' | 'claude-cli';

interface ProviderUsageContract {
  collection: ProviderUsageCollection;
  coverageName?: string;
  defaultHomeDirectory: string;
  liveCollector?: ProviderUsageLiveCollector;
  source: string;
  coverageSource?: string;
  authStatus?: string;
  quotaUnavailableReason?: string;
  tokenUnavailableReason?: string;
}

interface ProviderLaunchEnvironmentOptions {
  homePath?: string;
  runtime: ProviderRuntime;
  startupPromptFile?: string;
}

interface ProviderAdapter {
  id: ProviderId;
  displayName: string;
  executable: string;
  homeEnvKey: string;
  interruptInput: string;
  runtimeObservationKind?: 'codex' | 'claude' | 'process';
  legacyAcpRequestIsChat?: boolean;
  acpSessionSourceErrors?: Readonly<Record<string, string>>;
  freshAcpSessionSources: readonly string[];
  commands: readonly string[];
  supportedRuntimes: readonly ProviderRuntime[];
  applyLaunchEnvironment?: (
    env: NodeJS.ProcessEnv,
    options: ProviderLaunchEnvironmentOptions,
  ) => NodeJS.ProcessEnv;
  continuesSession?: (rawArgs: string[]) => boolean;
  planSession: (rawArgs: string[], launchArgs: string[]) => ProviderSessionPlan | null;
  sessionIdentityRollbackArgs?: (sessionId: string) => string[];
  terminalResumeArgs?: (
    args: string[],
    sessionId: string,
    plan?: ProviderSessionPlan,
  ) => string[];
  terminalStartup?: ProviderTerminalStartupPolicy;
  sessionPolicy?: ProviderSessionPolicy;
  acp: ProviderAcpContract;
  prepareAcpEnvironment?: (options?: ProviderEnvironmentOptions) => NodeJS.ProcessEnv;
  capabilities: ProviderCapabilitiesContract;
  usage: ProviderUsageContract;
}

interface ProviderDescriptor {
  commands: readonly string[];
  defaultHomeDirectory: string;
  displayName: string;
  executable: string;
  id: ProviderId;
  supportedRuntimes: readonly ProviderRuntime[];
}

function assertProviderCatalogIntegrity(
  adapters: ReadonlyArray<Pick<ProviderAdapter, 'commands' | 'executable' | 'id'>>,
): void {
  const providerIds = new Set<ProviderId>();
  const commandOwners = new Map<string, ProviderId>();

  for (const adapter of adapters) {
    if (providerIds.has(adapter.id)) {
      throw new Error(`Duplicate Provider id "${adapter.id}"`);
    }
    providerIds.add(adapter.id);

    if (!adapter.commands.includes(adapter.executable)) {
      throw new Error(
        `Provider "${adapter.id}" commands do not include executable "${adapter.executable}"`,
      );
    }

    for (const command of adapter.commands) {
      const existingOwner = commandOwners.get(command);
      if (existingOwner !== undefined) {
        throw new Error(
          `Provider command alias "${command}" is declared by both "${existingOwner}" and "${adapter.id}"`,
        );
      }
      commandOwners.set(command, adapter.id);
    }
  }
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
const PI_VALUE_OPTIONS = new Set([
  '--mode', '--provider', '--model', '--api-key', '--system-prompt',
  '--append-system-prompt', '--name', '-n', '--session', '--session-id',
  '--fork', '--session-dir', '--models', '--tools', '-t', '--exclude-tools',
  '-xt', '--thinking', '--export', '--extension', '-e', '--skill',
  '--prompt-template', '--theme', '--use-theme', '--tui-mode',
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
const PI_SUBCOMMANDS = new Set([
  'install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth',
]);
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
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

function piSessionPlan(rawArgs: string[], launchArgs: string[]): ProviderSessionPlan | null {
  const explicitSessionId = argValue(rawArgs, ['--session-id']);
  const resumeSessionId = argValue(rawArgs, ['--session']);
  const forkSourceId = argValue(rawArgs, ['--fork']);
  if (explicitSessionId && PI_SESSION_ID_RE.test(explicitSessionId)) {
    return {
      id: explicitSessionId,
      temporary: false,
      source: 'pi-explicit-session-id',
      forkedFromProviderSessionId: PI_SESSION_ID_RE.test(forkSourceId) ? forkSourceId : '',
    };
  }
  if (resumeSessionId && PI_SESSION_ID_RE.test(resumeSessionId) && !forkSourceId) {
    return { id: resumeSessionId, temporary: false, source: 'resume' };
  }
  if (forkSourceId && PI_SESSION_ID_RE.test(forkSourceId)) {
    const id = createProviderSessionId();
    return {
      id,
      temporary: false,
      source: 'pi-fork-session-id',
      forkedFromProviderSessionId: forkSourceId,
      args: ['--session-id', id, ...launchArgs],
    };
  }
  if (
    hasArg(rawArgs, [
      '--session', '--session-id', '--fork', '--continue', '-c', '--resume', '-r',
      '--no-session', '--print', '-p', '--export', '--list-models', '--help', '-h',
      '--version', '-v',
    ])
    || ['json', 'rpc'].includes(argValue(rawArgs, ['--mode']))
  ) return null;
  const positional = scanPositionals(rawArgs, PI_VALUE_OPTIONS);
  if (
    positional[0]
    && positional[0].afterDelimiter !== true
    && PI_SUBCOMMANDS.has(positional[0].value)
  ) return null;
  const id = createProviderSessionId();
  return {
    id,
    temporary: false,
    source: 'pi-session-id',
    args: ['--session-id', id, ...launchArgs],
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

function piAcpLaunchArgs(options: ProviderAcpLaunchOptions = {}): string[] {
  const executable = String(options.executable || '').trim();
  const agentHome = String(options.providerHomePath || '').trim();
  const agentIdentity = String(options.agentId || '').trim();
  const configIdentity = String(options.configDir || '').trim();
  if (!executable || !agentHome || !agentIdentity || !configIdentity) {
    throw new Error('Pi ACP launch requires exact executable, Agent Home, Agent, and Config identities.');
  }
  const stateKey = crypto.createHash('sha256')
    .update(`${path.resolve(configIdentity)}\0${agentIdentity}`)
    .digest('hex')
    .slice(0, 24);
  const args = [
    '--farming-pi-command',
    executable,
    '--farming-pi-acp-state-dir',
    path.join(path.resolve(agentHome), '.farming', 'pi-acp', stateKey),
  ];
  const farmingSystemPrompt = String(options.farmingSystemPrompt || '').trim();
  if (farmingSystemPrompt) {
    args.push('--farming-append-system-prompt', farmingSystemPrompt);
  }
  return args;
}

const PROVIDER_ADAPTERS = Object.freeze<ProviderAdapter[]>([
  {
    id: 'codex',
    displayName: 'Codex',
    executable: 'codex',
    homeEnvKey: 'CODEX_HOME',
    interruptInput: '\x1b',
    runtimeObservationKind: 'codex',
    legacyAcpRequestIsChat: true,
    freshAcpSessionSources: ['codex-temporary'],
    commands: ['codex'],
    supportedRuntimes: ['terminal', 'acp'],
    continuesSession: args => args.some(arg => arg === 'resume' || arg === 'fork'),
    planSession: codexSessionPlan,
    sessionIdentityRollbackArgs: sessionId => ['delete', '--force', sessionId],
    terminalResumeArgs: (args, sessionId) => ['resume', sessionId, ...args],
    terminalStartup: {
      serialization: 'provider-home',
      readiness: { kind: 'output-includes', value: '\u001b' },
    },
    sessionPolicy: {
      defaultLaunchPermissionMode: 'approve',
      launchPermissionFallback: 'profile-or-default',
      launchProfilePermissionKey: 'approvalMode',
      launchProfileOptionKeys: {
        model: 'codexModel',
        modelPreset: 'codexModelPreset',
        reasoningEffort: 'codexReasoningEffort',
        serviceTier: 'codexServiceTier',
      },
      permissionDisplayName: 'Codex',
      permissionOption: 'codexApprovalMode',
      permissionRestartModes: ['ask', 'approve', 'full', 'custom'],
      preserveProfileOnResume: true,
      preserveRequiredCliVersion: true,
      resumeLaunchProfileOverrides: {
        model: 'config',
        modelPreset: 'config',
        reasoningEffort: 'config',
        serviceTier: 'config',
      },
      suppressPermissionOptionWhenDangerousSkip: true,
      freshPermissionRestartCommand: 'codex',
      requiresStableTerminalSessionAfterInput: true,
    },
    acp: {
      executablePolicy: 'managed',
      packageName: '@agentclientprotocol/codex-acp',
      version: '1.2.0',
      sharedRuntime: true,
      normalizeHostMessageChunks: true,
      config: {
        approvalModes: {
          ask: 'read-only',
          approve: 'agent',
          full: 'agent-full-access',
        },
        coupleModelAndReasoning: true,
        launchModelAndReasoning: true,
        matchModelByName: true,
        serviceTier: { enabledValues: ['fast', 'priority'] },
      },
    },
    prepareAcpEnvironment: codexAcpEnvironment,
    usage: {
      collection: {
        kind: 'local-history',
        rootDirectories: ['sessions', 'archived_sessions'],
      },
      defaultHomeDirectory: '.codex',
      liveCollector: 'codex-cli',
      source: 'Farming local history',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: true,
      terminalProfile: true,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: true,
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
    displayName: 'Claude Code',
    executable: 'claude',
    homeEnvKey: 'CLAUDE_CONFIG_DIR',
    interruptInput: '\x1b',
    runtimeObservationKind: 'claude',
    freshAcpSessionSources: ['claude-session-id'],
    commands: ['claude'],
    supportedRuntimes: ['terminal', 'acp'],
    continuesSession: args => args.some(arg => (
      arg === '--resume'
      || arg.startsWith('--resume=')
      || arg === '--continue'
      || arg === '-c'
      || arg === '--fork-session'
    )),
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('claude', rawArgs, launchArgs),
    sessionPolicy: {
      launchProfilePermissionKey: 'permissionMode',
      permissionDisplayName: 'Claude',
      permissionOption: 'claudePermissionMode',
      permissionRestartModes: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
      resumeLaunchProfileOverrides: { model: 'config', effort: 'config' },
    },
    acp: {
      executablePolicy: 'managed',
      packageName: '@agentclientprotocol/claude-agent-acp',
      version: '0.66.0',
      sharedRuntime: true,
      config: {
        launchModelAndReasoning: true,
        reasoningProfileKey: 'effort',
      },
      sessionMetadata: ({ farmingSystemPrompt, sessionEnv }) => ({
        ...(farmingSystemPrompt
          ? {
              systemPrompt: {
                type: 'preset',
                preset: 'claude_code',
                append: farmingSystemPrompt,
              },
            }
          : {}),
        ...(Object.keys(sessionEnv).length > 0
          ? { claudeCode: { options: { env: sessionEnv } } }
          : {}),
      }),
    },
    prepareAcpEnvironment: claudeAcpEnvironment,
    usage: {
      collection: {
        kind: 'local-history',
        rootDirectories: ['projects'],
      },
      coverageName: 'Claude',
      defaultHomeDirectory: '.claude',
      liveCollector: 'claude-cli',
      source: 'Farming local history',
      quotaUnavailableReason: 'Claude Code auth/status output does not expose usage remaining.',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: true,
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
    id: 'pi',
    displayName: 'Pi',
    executable: 'pi',
    homeEnvKey: 'PI_CODING_AGENT_DIR',
    interruptInput: '\x1b',
    runtimeObservationKind: 'process',
    freshAcpSessionSources: ['pi-session-id'],
    acpSessionSourceErrors: {
      'pi-explicit-session-id': 'Pi Chat cannot determine whether --session-id names a new or existing session. Omit --session-id for a new Chat, or use --session <id> to resume an existing session.',
      'pi-fork-session-id': 'Pi Chat does not support the Pi CLI --fork flow with pi-acp 0.0.33. Fork the Terminal session, or start a new Chat.',
      'untracked-command': 'Pi Chat cannot preserve --continue, --resume picker, session-file, fork-file, print, JSON/RPC, export, or package-management CLI semantics. Start a new Chat without those flags, or use --session <id> to resume an exact Pi session.',
    },
    commands: ['pi'],
    supportedRuntimes: ['terminal', 'acp'],
    continuesSession: args => args.some(arg => (
      arg === '--session'
      || arg.startsWith('--session=')
      || arg === '--fork'
      || arg.startsWith('--fork=')
      || arg === '--continue'
      || arg === '-c'
      || arg === '--resume'
      || arg === '-r'
    )),
    planSession: piSessionPlan,
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
      acceptsMcpServers: false,
      executablePolicy: 'system',
      launchArgs: piAcpLaunchArgs,
      packageName: 'pi-acp',
      version: '0.0.33',
      sharedRuntime: false,
    },
    usage: {
      collection: { kind: 'unavailable' },
      defaultHomeDirectory: '.pi/agent',
      source: 'local Pi sessions',
      coverageSource: 'local Pi sessions',
      authStatus: 'Local sessions',
      quotaUnavailableReason: 'Pi provider quota telemetry is unavailable.',
      tokenUnavailableReason: 'Pi token usage is not yet aggregated by Farming.',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'bracketed-paste',
      slashCommandDiscovery: false,
      goals: false,
      goalSubmission: { terminal: { kind: 'prompt' }, acp: { kind: 'prompt' } },
      conversationFork: {
        terminal: { strategy: 'target-process', worktreeModes: ['same-worktree', 'new-worktree'] },
      },
    },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    executable: 'opencode',
    homeEnvKey: 'OPENCODE_CONFIG_DIR',
    interruptInput: '\x03',
    freshAcpSessionSources: [],
    commands: ['opencode'],
    supportedRuntimes: ['terminal', 'acp'],
    applyLaunchEnvironment: (env, options) => {
      if (options.startupPromptFile) {
        Object.assign(env, appendOpenCodeBootstrap(env, options.startupPromptFile));
      }
      if (options.runtime === 'terminal') env.OPENTUI_NOTIFICATION_PROTOCOL = 'osc99';
      return env;
    },
    planSession: openCodeSessionPlan,
    sessionPolicy: {
      identityScope: 'provider',
    },
    sessionIdentityRollbackArgs: sessionId => ['session', 'delete', sessionId],
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
      executablePolicy: 'system',
      version: 'native',
      sharedRuntime: true,
      normalizeModes: (modes, agentInfo) => {
        if (String(agentInfo.version || '') !== '1.0.43' || !modes || typeof modes !== 'object') return modes;
        const record = modes as Record<string, unknown>;
        const availableModes = Array.isArray(record.availableModes)
          ? record.availableModes.filter(mode => (
              !mode || typeof mode !== 'object' || String((mode as Record<string, unknown>).id || '') !== 'plan'
            ))
          : record.availableModes;
        return { ...record, availableModes };
      },
      launch: options => ({
        command: options.executable || 'opencode',
        args: ['acp', '--cwd', path.resolve(options.projectWorkspace || options.cwd || process.cwd())],
      }),
    },
    usage: {
      collection: {
        collector: 'opencode-session-export',
        kind: 'session-export',
      },
      defaultHomeDirectory: '.opencode',
      source: 'opencode session export',
      authStatus: 'Local session export',
      quotaUnavailableReason: 'OpenCode session exports do not expose quota remaining.',
      tokenUnavailableReason: 'OpenCode token usage is unavailable.',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'plain-text',
      slashCommandDiscovery: false,
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
    displayName: 'Qoder',
    executable: 'qodercli',
    homeEnvKey: 'QODER_CONFIG_DIR',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['qoder-session-id'],
    commands: ['qoder', 'qodercli'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('qoder', rawArgs, launchArgs),
    acp: {
      executablePolicy: 'system',
      version: 'native',
      sharedRuntime: true,
      historyReplay: {
        restoreMissingCheckpointMedia: true,
        waitForNotifications: true,
      },
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
    usage: {
      collection: { kind: 'unavailable' },
      defaultHomeDirectory: '.qoder',
      source: 'Qoder session files',
      coverageSource: 'local Qoder sessions',
      authStatus: 'Local sessions',
      quotaUnavailableReason: 'Qoder quota telemetry is unavailable.',
      tokenUnavailableReason: 'Qoder session files do not expose model token usage.',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'plain-text',
      slashCommandDiscovery: false,
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
    displayName: 'Qwen Code',
    executable: 'qwen',
    homeEnvKey: 'QWEN_HOME',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['qwen-session-id'],
    commands: ['qwen'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('qwen', rawArgs, launchArgs),
    sessionPolicy: {
      terminalNotificationRequiresIdle: true,
    },
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
      executablePolicy: 'system',
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
      normalizeExtensionNotification: (method, params) => {
        if (method !== 'qwen/notify/session/prompt-suggestion' || params.v !== 1) return null;
        const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : '';
        const text = typeof params.suggestion === 'string' ? params.suggestion.trim() : '';
        const promptId = typeof params.promptId === 'string' ? params.promptId.trim() : '';
        if (!sessionId || !text || text.length > 500 || !promptId) return null;
        return { kind: 'prompt-suggestion', sessionId, text, promptId };
      },
    },
    usage: {
      collection: { kind: 'unavailable' },
      defaultHomeDirectory: '.qwen',
      source: 'local Qwen Code sessions',
      coverageSource: 'local Qwen sessions',
      authStatus: 'Local sessions',
      quotaUnavailableReason: 'Qwen quota telemetry is unavailable.',
      tokenUnavailableReason: 'Qwen session files do not expose model token usage.',
    },
    capabilities: {
      runtimeSwitch: true,
      contextWindow: false,
      terminalProfile: false,
      terminalComposerInput: 'plain-text',
      slashCommandDiscovery: false,
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

assertProviderCatalogIntegrity(PROVIDER_ADAPTERS);

function projectProviderDescriptor(adapter: ProviderAdapter): Readonly<ProviderDescriptor> {
  return Object.freeze({
    commands: Object.freeze([...adapter.commands]),
    defaultHomeDirectory: adapter.usage.defaultHomeDirectory,
    displayName: adapter.displayName,
    executable: adapter.executable,
    id: adapter.id,
    supportedRuntimes: Object.freeze([...adapter.supportedRuntimes]),
  });
}

const PROVIDER_DESCRIPTORS: readonly Readonly<ProviderDescriptor>[] = Object.freeze(
  PROVIDER_ADAPTERS.map(projectProviderDescriptor),
);

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

function listProviderDescriptors(): readonly Readonly<ProviderDescriptor>[] {
  return PROVIDER_DESCRIPTORS;
}

function providerCapabilities(provider: unknown): ProviderCapabilitiesWire {
  const adapter = getProviderAdapter(provider);
  const terminalFork = conversationForkCapability(adapter, 'terminal');
  const acpFork = conversationForkCapability(adapter, 'acp');
  return {
    supportedRuntimes: adapter ? [...adapter.supportedRuntimes] : ['terminal'],
    runtimeSwitch: adapter?.capabilities?.runtimeSwitch === true,
    contextWindow: adapter?.capabilities?.contextWindow === true,
    terminalProfile: adapter?.capabilities?.terminalProfile === true,
    terminalComposerInput: adapter?.capabilities?.terminalComposerInput || 'bracketed-paste',
    slashCommandDiscovery: adapter?.capabilities?.slashCommandDiscovery === true,
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

function providerRuntimeObservationKind(provider: unknown): 'codex' | 'claude' | 'process' | 'unknown' {
  const adapter = getProviderAdapter(provider);
  return adapter?.runtimeObservationKind || (adapter ? 'process' : 'unknown');
}

function providerArgsContinueSession(provider: unknown, rawArgs: string[]): boolean {
  return getProviderAdapter(provider)?.continuesSession?.(rawArgs) === true;
}

function providerTerminalStartupPolicy(
  provider: unknown,
): Readonly<ProviderTerminalStartupPolicy> | null {
  return getProviderAdapter(provider)?.terminalStartup || null;
}

function providerSessionResumeOptions(
  provider: unknown,
  options: {
    permissionMode?: string;
    preserveProfile?: boolean;
    requiredCliVersion?: string;
  } = {},
): Record<string, string | boolean> {
  const policy = getProviderAdapter(provider)?.sessionPolicy;
  if (!policy) return {};
  const result: Record<string, string | boolean> = {};
  const permissionMode = String(options.permissionMode || '').trim();
  if (permissionMode && policy.permissionOption) result[policy.permissionOption] = permissionMode;
  if (options.preserveProfile === true && policy.preserveProfileOnResume === true) {
    result.preserveProviderSessionProfile = true;
  }
  const requiredCliVersion = String(options.requiredCliVersion || '').trim();
  if (requiredCliVersion && policy.preserveRequiredCliVersion === true) {
    result.requiredCliVersion = requiredCliVersion;
  }
  return result;
}

function providerSessionLaunchProfile(
  provider: unknown,
  profile: Record<string, unknown>,
  preserveProviderSessionProfile: boolean,
): Record<string, unknown> {
  const overrides = preserveProviderSessionProfile
    ? getProviderAdapter(provider)?.sessionPolicy?.resumeLaunchProfileOverrides
    : null;
  return overrides ? { ...profile, ...overrides } : { ...profile };
}

function providerSessionIdentityScope(
  provider: unknown,
): 'provider' | 'provider-home' {
  return getProviderAdapter(provider)?.sessionPolicy?.identityScope || 'provider-home';
}

function providerRequestedLaunchProfile(
  provider: unknown,
  profile: Record<string, unknown>,
  requestedOptions: Record<string, unknown>,
): Record<string, unknown> {
  const optionKeys = getProviderAdapter(provider)?.sessionPolicy?.launchProfileOptionKeys || {};
  const requestedProfile = { ...profile };
  for (const [profileKey, optionKey] of Object.entries(optionKeys)) {
    if (typeof requestedOptions[optionKey] === 'string') {
      requestedProfile[profileKey] = requestedOptions[optionKey];
    }
  }
  return requestedProfile;
}

function providerLaunchCommandOptions(
  provider: unknown,
  requestedOptions: Record<string, unknown>,
  profile: Record<string, unknown>,
  dangerouslySkipPermissions: boolean,
): Record<string, unknown> {
  const policy = getProviderAdapter(provider)?.sessionPolicy;
  const optionKey = policy?.permissionOption;
  if (!policy || !optionKey) return {};
  const requestedMode = typeof requestedOptions[optionKey] === 'string'
    ? String(requestedOptions[optionKey])
    : '';
  if (requestedMode) return { [optionKey]: requestedMode };
  if (
    dangerouslySkipPermissions
    && policy.suppressPermissionOptionWhenDangerousSkip === true
  ) return {};
  if (policy.launchPermissionFallback !== 'profile-or-default') return {};
  const profileMode = providerLaunchPermissionMode(provider, profile);
  const fallbackMode = profileMode || policy.defaultLaunchPermissionMode || '';
  return fallbackMode ? { [optionKey]: fallbackMode } : {};
}

function providerLaunchPermissionMode(
  provider: unknown,
  profile: Record<string, unknown>,
): string {
  const key = getProviderAdapter(provider)?.sessionPolicy?.launchProfilePermissionKey;
  return key && typeof profile[key] === 'string' ? profile[key].trim() : '';
}

function providerAcpRuntimeProfile(
  provider: unknown,
  profile: Record<string, unknown>,
): { model: string; reasoningEffort: string; serviceTier: string } {
  const reasoningKey = getProviderAdapter(provider)?.acp.config?.reasoningProfileKey || 'reasoningEffort';
  return {
    model: typeof profile.model === 'string' ? profile.model : '',
    reasoningEffort: typeof profile[reasoningKey] === 'string' ? String(profile[reasoningKey]) : '',
    serviceTier: typeof profile.serviceTier === 'string' ? profile.serviceTier : '',
  };
}

function providerTreatsLegacyAcpRequestAsChat(provider: unknown): boolean {
  return getProviderAdapter(provider)?.legacyAcpRequestIsChat === true;
}

function providerPermissionRestartPolicy(
  provider: unknown,
  requestedMode: unknown,
): ProviderPermissionRestartPolicy | null {
  const adapter = getProviderAdapter(provider);
  const policy = adapter?.sessionPolicy;
  if (!adapter || !policy?.permissionRestartModes) return null;
  const requested = String(requestedMode || '');
  return {
    displayName: policy.permissionDisplayName || adapter.displayName,
    freshCommand: policy.freshPermissionRestartCommand || '',
    mode: policy.permissionRestartModes.includes(requested) ? requested : '',
  };
}

function providerRequiresStableTerminalSessionAfterInput(provider: unknown): boolean {
  return getProviderAdapter(provider)?.sessionPolicy?.requiresStableTerminalSessionAfterInput === true;
}

function providerTerminalNotificationRequiresIdle(provider: unknown): boolean {
  return getProviderAdapter(provider)?.sessionPolicy?.terminalNotificationRequiresIdle === true;
}

function providerSupportsSharedAcpRuntime(provider: unknown): boolean {
  return getProviderAdapter(provider)?.acp.sharedRuntime === true;
}

function providerSessionIdentityRollbackArgs(
  provider: unknown,
  sessionId: string,
): string[] | null {
  const rollbackArgs = getProviderAdapter(provider)?.sessionIdentityRollbackArgs;
  return rollbackArgs ? rollbackArgs(sessionId) : null;
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

function clearProviderHomeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const adapter of PROVIDER_ADAPTERS) delete env[adapter.homeEnvKey];
  return env;
}

function applyProviderLaunchEnvironment(
  env: NodeJS.ProcessEnv,
  provider: unknown,
  options: ProviderLaunchEnvironmentOptions,
): NodeJS.ProcessEnv {
  const adapter = getProviderAdapter(provider);
  if (!adapter) return env;
  if (options.homePath) env[adapter.homeEnvKey] = options.homePath;
  return adapter.applyLaunchEnvironment?.(env, options) || env;
}

function isFreshAcpSessionSource(provider: unknown, source: string): boolean {
  return getProviderAdapter(provider)?.freshAcpSessionSources.includes(source) === true;
}

function providerAcpSessionSourceError(provider: unknown, source: unknown): string {
  const normalizedSource = String(source || '').trim();
  return getProviderAdapter(provider)?.acpSessionSourceErrors?.[normalizedSource] || '';
}

function providerAcpMcpServersError(provider: unknown, servers: unknown): string {
  if (!Array.isArray(servers) || servers.length === 0) return '';
  const adapter = getProviderAdapter(provider);
  if (!adapter || adapter.acp.acceptsMcpServers !== false) return '';
  return `${adapter.displayName} Chat does not support ACP MCP servers with ${adapter.acp.packageName || 'its current adapter'} ${adapter.acp.version}. Configure integrations through ${adapter.displayName} itself, or remove mcpServers.`;
}

function normalizeProviderAcpExtensionNotification(
  provider: unknown,
  method: unknown,
  params: unknown,
): ProviderAcpExtensionEvent | null {
  const adapter = getProviderAdapter(provider);
  if (!adapter?.acp.normalizeExtensionNotification || !params || typeof params !== 'object') return null;
  return adapter.acp.normalizeExtensionNotification(
    String(method || ''),
    params as Record<string, unknown>,
  );
}

export {
  assertProviderCatalogIntegrity,
  claudeAcpEnvironment,
  getProviderAdapter,
  applyProviderHomeEnvironment,
  applyProviderLaunchEnvironment,
  clearProviderHomeEnvironment,
  isFreshAcpSessionSource,
  providerAcpMcpServersError,
  providerAcpSessionSourceError,
  listProviderAdapters,
  listProviderDescriptors,
  normalizeProviderAcpExtensionNotification,
  providerArgsContinueSession,
  providerConversationForkCapability,
  providerCapabilities,
  providerForProgram,
  providerPermissionRestartPolicy,
  providerAcpRuntimeProfile,
  providerLaunchPermissionMode,
  providerLaunchCommandOptions,
  providerRuntimeObservationKind,
  providerRequiresStableTerminalSessionAfterInput,
  providerSessionResumeOptions,
  providerSessionIdentityScope,
  providerSessionLaunchProfile,
  providerRequestedLaunchProfile,
  providerSessionIdentityRollbackArgs,
  providerSupportsSharedAcpRuntime,
  providerSupportsRuntime,
  providerTerminalStartupPolicy,
  providerTerminalNotificationRequiresIdle,
  providerTreatsLegacyAcpRequestAsChat,
  type ProviderTerminalStartupPolicy,
  type ProviderPermissionRestartPolicy,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderUsageCollection,
  type ProviderUsageLiveCollector,
};
