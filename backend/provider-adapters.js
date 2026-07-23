const path = require('path');
const { chatCapabilitiesForProvider } = require('./chat-runtime');
const {
  createProviderSessionId,
  createTemporaryProviderSessionId,
  isSafeProviderSessionId,
} = require('./provider-session-id');

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

function optionTakesValue(option, valueOptions) {
  return Boolean(option && !option.includes('=') && valueOptions.has(option));
}

function scanPositionals(args, valueOptions, options = {}) {
  const positionals = [];
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

function codexSessionIdAfterSubcommand(args, subcommandIndex) {
  const sessionId = scanPositionals(
    args.slice(subcommandIndex + 1),
    CODEX_VALUE_OPTIONS,
    { multiValueOptions: new Set(['-i', '--image']) },
  )[0]?.value || '';
  return CODEX_SESSION_ID_RE.test(sessionId) ? sessionId.toLowerCase() : '';
}

function argValue(args, names) {
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

function hasArg(args, names) {
  for (const arg of args) {
    if (arg === '--') break;
    if (names.includes(arg) || names.some(name => arg.startsWith(`${name}=`))) return true;
  }
  return false;
}

function codexSessionPlan(rawArgs, _launchArgs) {
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
      error: 'A fresh Codex --remote Terminal cannot pre-create a stable session id; resume an explicit remote session id instead',
    };
  }
  return {
    id: '',
    precreate: true,
    temporary: false,
    source: 'codex-precreate',
    identityWorkspace: argValue(rawArgs, ['-C', '--cd']),
  };
}

function explicitSessionPlan(provider, rawArgs, launchArgs) {
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

function openCodeSessionPlan(rawArgs, launchArgs) {
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

function codexAcpEnvironment(options = {}) {
  const env = { ...(options.env || process.env) };
  if (options.executable && !env.CODEX_PATH) env.CODEX_PATH = options.executable;
  if (options.identityOnly === true) env.FARMING_CODEX_ACP_IDENTITY_ONLY = '1';
  else delete env.FARMING_CODEX_ACP_IDENTITY_ONLY;
  let config = {};
  if (env.CODEX_CONFIG) {
    try {
      const parsed = JSON.parse(env.CODEX_CONFIG);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed;
    } catch {
      // A selected Farming profile below replaces an invalid adapter config.
    }
  }
  if (options.model && options.model !== 'config') config.model = options.model;
  if (options.reasoningEffort && options.reasoningEffort !== 'config') config.model_reasoning_effort = options.reasoningEffort;
  if (options.serviceTier && !['config', 'default'].includes(options.serviceTier)) config.service_tier = options.serviceTier;
  if (Object.keys(config).length > 0) env.CODEX_CONFIG = JSON.stringify(config);
  const initialMode = { ask: 'read-only', approve: 'agent', full: 'agent-full-access' }[options.approvalMode];
  if (initialMode) env.INITIAL_AGENT_MODE = initialMode;
  return env;
}

const PROVIDER_ADAPTERS = Object.freeze([
  {
    id: 'codex',
    displayName: 'codex',
    executable: 'codex',
    homeEnvKey: 'CODEX_HOME',
    interruptInput: '\x1b',
    freshAcpSessionSources: ['codex-temporary'],
    commands: ['codex'],
    supportedRuntimes: ['terminal', 'acp', 'json'],
    planSession: codexSessionPlan,
    terminalResumeArgs: (args, sessionId) => ['resume', sessionId, ...args],
    acp: { packageName: '@agentclientprotocol/codex-acp', version: '1.1.4' },
    prepareAcpEnvironment: codexAcpEnvironment,
    capabilities: { runtimeSwitch: true, terminalProfile: true, goals: false },
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
    acp: { packageName: '@agentclientprotocol/claude-agent-acp', version: '0.59.0' },
    capabilities: { runtimeSwitch: true, terminalProfile: false, goals: false },
  },
  {
    id: 'opencode',
    displayName: 'opencode',
    executable: 'opencode',
    homeEnvKey: 'OPENCODE_CONFIG_DIR',
    interruptInput: '\x03',
    freshAcpSessionSources: [],
    commands: ['opencode'],
    supportedRuntimes: ['terminal', 'acp', 'json'],
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
      launch: options => ({
        command: options.executable || 'opencode',
        args: ['acp', '--cwd', path.resolve(options.cwd || process.cwd())],
      }),
    },
    capabilities: { runtimeSwitch: true, terminalProfile: false, goals: false },
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
      launch: options => ({ command: options.executable || 'qodercli', args: ['--acp'] }),
    },
    capabilities: { runtimeSwitch: true, terminalProfile: false, goals: false },
  },
]);

const ADAPTER_BY_ID = new Map(PROVIDER_ADAPTERS.map(adapter => [adapter.id, Object.freeze(adapter)]));
const ADAPTER_BY_COMMAND = new Map(PROVIDER_ADAPTERS.flatMap(adapter => (
  adapter.commands.map(command => [command, adapter])
)));

function getProviderAdapter(provider) {
  return ADAPTER_BY_ID.get(String(provider || '').trim().toLowerCase()) || null;
}

function providerForProgram(program) {
  return ADAPTER_BY_COMMAND.get(path.basename(String(program || '').trim()))?.id || '';
}

function listProviderAdapters() {
  return [...PROVIDER_ADAPTERS];
}

function providerCapabilities(provider) {
  const adapter = getProviderAdapter(provider);
  return {
    supportedRuntimes: adapter ? [...adapter.supportedRuntimes] : ['terminal'],
    runtimeSwitch: adapter?.capabilities?.runtimeSwitch === true,
    terminalProfile: adapter?.capabilities?.terminalProfile === true,
    goals: adapter?.capabilities?.goals === true,
    ...(adapter
      ? chatCapabilitiesForProvider(provider)
      : { chatRuntime: '', supportsChat: false, supportsSteer: false }),
  };
}

function providerSupportsRuntime(provider, runtime) {
  return getProviderAdapter(provider)?.supportedRuntimes.includes(runtime) === true;
}

function applyProviderHomeEnvironment(env, provider, homePath) {
  const key = getProviderAdapter(provider)?.homeEnvKey;
  if (key && homePath) env[key] = homePath;
  return env;
}

function isFreshAcpSessionSource(provider, source) {
  return getProviderAdapter(provider)?.freshAcpSessionSources.includes(source) === true;
}

module.exports = {
  getProviderAdapter,
  applyProviderHomeEnvironment,
  isFreshAcpSessionSource,
  listProviderAdapters,
  providerCapabilities,
  providerForProgram,
  providerSupportsRuntime,
};
