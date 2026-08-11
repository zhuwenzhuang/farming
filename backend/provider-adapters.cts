const path = require('path');
import { chatCapabilitiesForProvider } from './chat-runtime.cjs';
import { appendOpenCodeBootstrap } from './farming-agent-bootstrap.cjs';
import { createProviderSessionId, createTemporaryProviderSessionId, isSafeProviderSessionId } from './provider-session-id.cjs';
import type { ProviderCapabilitiesWire } from '../shared/agent-state-wire.js';

type ProviderId = 'codex' | 'claude' | 'opencode' | 'qoder' | 'qwen';
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
  permissionDisplayName?: string;
  permissionOption?: 'claudePermissionMode' | 'codexApprovalMode';
  permissionRestartModes?: readonly string[];
  preserveProfileOnResume?: boolean;
  preserveRequiredCliVersion?: boolean;
  freshPermissionRestartCommand?: string;
  requiresStableTerminalSessionAfterInput?: boolean;
  terminalNotificationIdleFence?: boolean;
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
  executable?: string;
  cwd?: string;
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
  executablePolicy: 'managed' | 'system';
  packageName?: string;
  version: string;
  sharedRuntime?: boolean;
  config?: ProviderAcpConfigPolicy;
  historyReplay?: ProviderAcpHistoryReplayPolicy;
  launch?: (options: ProviderAcpLaunchOptions) => ProviderAcpLaunch;
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
  runtimeObservationKind?: 'codex' | 'claude' | 'process';
  freshAcpSessionSources: readonly string[];
  commands: readonly string[];
  supportedRuntimes: readonly ProviderRuntime[];
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
    displayName: 'Codex',
    executable: 'codex',
    homeEnvKey: 'CODEX_HOME',
    interruptInput: '\x1b',
    runtimeObservationKind: 'codex',
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
      permissionDisplayName: 'Codex',
      permissionOption: 'codexApprovalMode',
      permissionRestartModes: ['ask', 'approve', 'full', 'custom'],
      preserveProfileOnResume: true,
      preserveRequiredCliVersion: true,
      freshPermissionRestartCommand: 'codex',
      requiresStableTerminalSessionAfterInput: true,
    },
    acp: {
      executablePolicy: 'managed',
      packageName: '@agentclientprotocol/codex-acp',
      version: '1.1.14',
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
      permissionDisplayName: 'Claude',
      permissionOption: 'claudePermissionMode',
      permissionRestartModes: ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'],
    },
    acp: {
      executablePolicy: 'managed',
      packageName: '@agentclientprotocol/claude-agent-acp',
      version: '0.66.0',
      sharedRuntime: true,
      config: {
        launchModelAndReasoning: true,
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
    displayName: 'OpenCode',
    executable: 'opencode',
    homeEnvKey: 'OPENCODE_CONFIG_DIR',
    interruptInput: '\x03',
    freshAcpSessionSources: [],
    commands: ['opencode'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: openCodeSessionPlan,
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
      historyReplay: {
        restoreMissingCheckpointMedia: true,
        waitForNotifications: true,
      },
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
    displayName: 'Qwen Code',
    executable: 'qwen',
    homeEnvKey: 'QWEN_HOME',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['qwen-session-id'],
    commands: ['qwen'],
    supportedRuntimes: ['terminal', 'acp'],
    planSession: (rawArgs, launchArgs) => explicitSessionPlan('qwen', rawArgs, launchArgs),
    sessionPolicy: {
      terminalNotificationIdleFence: true,
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

function providerCapabilities(provider: unknown): ProviderCapabilitiesWire {
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

function providerTerminalNotificationUsesIdleFence(provider: unknown): boolean {
  return getProviderAdapter(provider)?.sessionPolicy?.terminalNotificationIdleFence === true;
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
  options: {
    homePath?: string;
    runtime: ProviderRuntime;
    startupPromptFile?: string;
  },
): NodeJS.ProcessEnv {
  const adapter = getProviderAdapter(provider);
  if (!adapter) return env;
  if (options.homePath) env[adapter.homeEnvKey] = options.homePath;
  if (adapter.id === 'opencode' && options.startupPromptFile) {
    Object.assign(env, appendOpenCodeBootstrap(env, options.startupPromptFile));
  }
  if (adapter.id === 'opencode' && options.runtime === 'terminal') {
    env.OPENTUI_NOTIFICATION_PROTOCOL = 'osc99';
  }
  return env;
}

function isFreshAcpSessionSource(provider: unknown, source: string): boolean {
  return getProviderAdapter(provider)?.freshAcpSessionSources.includes(source) === true;
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
  claudeAcpEnvironment,
  getProviderAdapter,
  applyProviderHomeEnvironment,
  applyProviderLaunchEnvironment,
  clearProviderHomeEnvironment,
  isFreshAcpSessionSource,
  listProviderAdapters,
  normalizeProviderAcpExtensionNotification,
  providerArgsContinueSession,
  providerConversationForkCapability,
  providerCapabilities,
  providerForProgram,
  providerPermissionRestartPolicy,
  providerRuntimeObservationKind,
  providerRequiresStableTerminalSessionAfterInput,
  providerSessionResumeOptions,
  providerSessionIdentityRollbackArgs,
  providerSupportsSharedAcpRuntime,
  providerSupportsRuntime,
  providerTerminalStartupPolicy,
  providerTerminalNotificationUsesIdleFence,
  type ProviderTerminalStartupPolicy,
  type ProviderPermissionRestartPolicy,
};
