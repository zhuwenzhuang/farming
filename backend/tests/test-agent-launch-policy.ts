import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  AgentLaunchPolicy,
  type AgentLaunchExecutableRequest,
  type AgentLaunchPolicyConfig,
  type AgentLaunchPolicyPorts,
  type ProviderLaunchDescriptor,
  type TerminalExecutableResolution,
} from '../agent-launch-policy.cts';
import { listProviderLaunchDescriptors } from '../provider-adapters.cts';

interface HarnessOptions {
  config?: AgentLaunchPolicyConfig;
  executables?: string[];
  farmingOwned?: Record<string, string>;
  farmingOwnership?: Record<string, string[]>;
  processEnv?: NodeJS.ProcessEnv;
  providerDescriptors?: readonly ProviderLaunchDescriptor[];
  shellEnv?: (shell: string) => NodeJS.ProcessEnv | null;
  systemAcp?: (program: string, pathEnv: string) => string;
  systemTerminal?: (program: string, pathEnv: string) => string;
  terminalVersion?: (
    program: string,
    requiredCliVersion: string,
    pathEnv: string,
  ) => TerminalExecutableResolution;
}

/** Canonical provider launch truth: the test never restates the adapter table. */
const CANONICAL_DESCRIPTORS = listProviderLaunchDescriptors();
const PROVIDER_HOME_KEYS = CANONICAL_DESCRIPTORS.map(descriptor => descriptor.homeEnvKey);

class Harness {
  now = 1_000;
  shellCalls: string[] = [];
  systemCalls: { program: string; pathEnv: string; runtime: 'acp' | 'terminal' }[] = [];
  farmingOwnedCalls: string[] = [];
  ownershipCalls: string[] = [];
  descriptorCalls = 0;
  terminalVersionCalls: { program: string; requiredCliVersion: string; pathEnv: string }[] = [];
  readonly ports: AgentLaunchPolicyPorts;
  readonly policy: AgentLaunchPolicy;

  constructor(options: HarnessOptions = {}) {
    const executables = new Set(options.executables || []);
    this.ports = {
      appendBootstrapInstruction: (env, bootstrapFile) => {
        const base = env.OPENCODE_CONFIG_CONTENT ? JSON.parse(env.OPENCODE_CONFIG_CONTENT) : {};
        const instructions = [...(base.instructions || []), bootstrapFile];
        return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, instructions }) };
      },
      isExecutable: candidate => executables.has(candidate),
      isFarmingOwnedExecutable: (provider, candidate) => {
        this.ownershipCalls.push(`${provider}:${candidate}`);
        return (options.farmingOwnership || {})[provider]?.includes(candidate) === true;
      },
      now: () => this.now,
      processEnv: () => options.processEnv || {},
      providerLaunchDescriptors: () => {
        this.descriptorCalls += 1;
        return options.providerDescriptors || CANONICAL_DESCRIPTORS;
      },
      resolveFarmingOwnedExecutable: provider => {
        this.farmingOwnedCalls.push(provider);
        return (options.farmingOwned || {})[provider] || '';
      },
      resolveShellEnv: shell => {
        this.shellCalls.push(shell);
        return options.shellEnv ? options.shellEnv(shell) : { PATH: '/shell/bin' };
      },
      resolveSystemAcpExecutable: (program, pathEnv) => {
        this.systemCalls.push({ program, pathEnv, runtime: 'acp' });
        return options.systemAcp ? options.systemAcp(program, pathEnv) : '';
      },
      resolveSystemTerminalExecutable: (program, pathEnv) => {
        this.systemCalls.push({ program, pathEnv, runtime: 'terminal' });
        return options.systemTerminal ? options.systemTerminal(program, pathEnv) : '';
      },
      resolveTerminalExecutableVersion: (program, requiredCliVersion, pathEnv) => {
        this.terminalVersionCalls.push({ program, requiredCliVersion, pathEnv });
        return options.terminalVersion
          ? options.terminalVersion(program, requiredCliVersion, pathEnv)
          : { compatible: false, error: 'Codex executable not found', path: '', source: '' };
      },
      warn: () => {},
    };
    this.policy = new AgentLaunchPolicy(options.config || {}, this.ports);
  }
}

const SYSTEM_TERMINAL_POLICY = { kind: 'system' } as const;

test('shell environment cache honors ttl, force refresh, and exact shell isolation', () => {
  let counter = 0;
  const harness = new Harness({
    config: { shellEnvCacheMs: 100 },
    shellEnv: shell => ({ PATH: `/bin/${shell || 'default'}`, CALL: String(++counter) }),
  });

  const first = harness.policy.resolveShellEnv('');
  assert.equal(first.source, 'shell');
  assert.equal(first.env.CALL, '1');
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '1');

  harness.now += 100;
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '2');
  assert.equal(harness.policy.resolveShellEnv('', { force: true }).env.CALL, '3');
  assert.equal(harness.policy.resolveShellEnv('', { maxAgeMs: 0 }).env.CALL, '4');

  const zsh = harness.policy.resolveShellEnv('/bin/zsh');
  assert.equal(zsh.shellKey, '/bin/zsh');
  assert.equal(zsh.env.PATH, '/bin//bin/zsh');
  assert.equal(harness.policy.resolveShellEnv('').env.PATH, '/bin/default');
  assert.deepEqual(harness.shellCalls, ['', '', '', '', '/bin/zsh']);
  assert.equal(Object.isFrozen(zsh), true);
  assert.equal(Object.isFrozen(zsh.env), true);
});

test('shell environment cache keeps no expiry at zero and clamps to the one hour maximum', () => {
  let counter = 0;
  const shellEnv = () => ({ CALL: String(++counter) });
  const noExpiry = new Harness({ config: { shellEnvCacheMs: 0 }, shellEnv });
  assert.equal(noExpiry.policy.resolveShellEnv('').env.CALL, '1');
  noExpiry.now += 10 * 60 * 60 * 1000;
  assert.equal(noExpiry.policy.resolveShellEnv('').env.CALL, '1');

  counter = 0;
  const clamped = new Harness({ config: { shellEnvCacheMs: 10 * 60 * 60 * 1000 }, shellEnv });
  assert.equal(clamped.policy.resolveShellEnv('').env.CALL, '1');
  clamped.now += 60 * 60 * 1000 - 1;
  assert.equal(clamped.policy.resolveShellEnv('').env.CALL, '1');
  clamped.now += 1;
  assert.equal(clamped.policy.resolveShellEnv('').env.CALL, '2');

  counter = 0;
  const clampedOption = new Harness({ shellEnv });
  assert.equal(clampedOption.policy.resolveShellEnv('', { maxAgeMs: Number.MAX_SAFE_INTEGER }).env.CALL, '1');
  clampedOption.now += 60 * 60 * 1000;
  assert.equal(clampedOption.policy.resolveShellEnv('', { maxAgeMs: Number.MAX_SAFE_INTEGER }).env.CALL, '2');
});

test('a backward clock makes a cached shell environment stale instead of permanent', () => {
  let counter = 0;
  const harness = new Harness({
    config: { shellEnvCacheMs: 0 },
    shellEnv: () => ({ CALL: String(++counter) }),
  });
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '1');
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '1');

  harness.now -= 5_000;
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '2');
  assert.equal(harness.policy.resolveShellEnv('').env.CALL, '2');
});

test('shell environment failure falls back to the provided process environment', () => {
  const harness = new Harness({
    processEnv: { PATH: '/process/bin', HOME: '/home/user' },
    shellEnv: () => {
      throw new Error('shell probe failed');
    },
  });

  const resolution = harness.policy.resolveShellEnv('/bin/bash');
  assert.equal(resolution.source, 'process-env');
  assert.equal(resolution.env.PATH, '/process/bin');
});

test('one cached failure snapshot is authoritative for later projections and process env mutation', () => {
  const processEnv: NodeJS.ProcessEnv = { PATH: '/process/bin', HOME: '/home/user', MARKER: 'first' };
  const harness = new Harness({
    config: { shellEnvCacheMs: 60_000 },
    processEnv,
    shellEnv: () => {
      throw new Error('shell probe failed');
    },
  });

  const resolution = harness.policy.resolveShellEnv('/bin/bash');
  assert.equal(resolution.env.MARKER, 'first');

  processEnv.MARKER = 'second';
  processEnv.PATH = '/mutated/bin';
  const projection = harness.policy.projectAgentEnv({
    agentId: 'agent-1',
    category: 'coding',
    runtime: 'terminal',
    shell: '/bin/bash',
  });
  assert.equal(projection.shellEnvSource, 'process-env');
  assert.equal(projection.env.MARKER, 'first');
  assert.equal(projection.env.PATH, '/process/bin');
  assert.equal(harness.policy.resolveShellEnv('/bin/bash').env.MARKER, 'first');
  assert.equal(harness.shellCalls.length, 1);

  harness.now += 60_000;
  assert.equal(harness.policy.resolveShellEnv('/bin/bash').env.MARKER, 'second');
});

test('Agent env projection rebuilds every launch-owned key from the request', () => {
  const poisoned: NodeJS.ProcessEnv = {
    CLAUDE_CONFIG_DIR: '/other/instance/claude',
    CODEX_HOME: '/other/instance/codex',
    FARMING_AGENT_ID: 'other-agent',
    FARMING_CAPABILITIES_COMMAND: 'evil capabilities',
    FARMING_CLI_BIN_DIR: '/other/instance/bin',
    FARMING_CONFIG_DIR: '/other/instance/config',
    FARMING_DISABLE_AUTH: '0',
    FARMING_IS_MAIN_AGENT: '1',
    FARMING_MAIN_WORKSPACE: '/other/instance/main',
    FARMING_PARENT_AGENT_ID: 'other-parent',
    FARMING_PROJECT_WORKSPACE: '/other/instance/project',
    FARMING_RUN_SERVER: '1',
    FARMING_SKILLS_COMMAND: 'evil skills',
    FARMING_SKILLS_FILE: '/other/instance/SKILLS.md',
    FARMING_STARTUP_PROMPT_FILE: '/other/instance/bootstrap.md',
    FARMING_TOKEN: 'inherited-token',
    FARMING_TOKEN_FILE: '/other/instance/token',
    OPENCODE_CONFIG_CONTENT: '{"instructions":["/other/instance/bootstrap.md"]}',
    OPENCODE_CONFIG_DIR: '/other/instance/opencode',
    OPENTUI_NOTIFICATION_PROTOCOL: 'osc0',
    QODER_CONFIG_DIR: '/other/instance/qoder',
    QWEN_HOME: '/other/instance/qwen',
  };
  const harness = new Harness({
    config: {
      authDisabled: true,
      cliBinDir: '/repo/bin',
      configDir: '/config/farming',
      controlUrl: 'http://127.0.0.1:3000/farming',
      startupPromptFile: '/config/farming/agent-bootstrap.md',
      tokenFile: '/config/farming/.session-token',
    },
    processEnv: poisoned,
    shellEnv: () => ({ ...poisoned, PATH: '/shell/bin' }),
  });

  const projection = harness.policy.projectAgentEnv({
    agentId: 'agent-main',
    category: 'coding',
    isMainAgent: true,
    mainWorkspace: '/workspaces/main',
    parentAgentId: 'agent-parent',
    projectWorkspace: '/workspaces/project',
    provider: 'codex',
    providerHomePath: '/config/farming/homes/codex',
    runtime: 'terminal',
  });
  const env = projection.env;

  assert.equal(env.FARMING_AGENT_ID, 'agent-main');
  assert.equal(env.FARMING_IS_MAIN_AGENT, '1');
  assert.equal(env.FARMING_PARENT_AGENT_ID, 'agent-parent');
  assert.equal(env.FARMING_MAIN_WORKSPACE, '/workspaces/main');
  assert.equal(env.FARMING_PROJECT_WORKSPACE, '/workspaces/project');
  assert.equal(env.FARMING_SKILLS_FILE, '/workspaces/main/FARMING_MAIN_AGENT_SKILLS.md');
  assert.equal(env.FARMING_SKILLS_COMMAND, 'farming skills');
  assert.equal(env.FARMING_CAPABILITIES_COMMAND, 'farming capabilities');
  assert.equal(env.FARMING_CLI_BIN_DIR, '/repo/bin');
  assert.equal(env.PATH, '/repo/bin:/shell/bin');
  assert.equal(env.FARMING_CONFIG_DIR, '/config/farming');
  assert.equal(env.FARMING_STARTUP_PROMPT_FILE, '/config/farming/agent-bootstrap.md');
  assert.equal(env.FARMING_CONTROL_URL, 'http://127.0.0.1:3000/farming');
  assert.equal(env.FARMING_TOKEN_FILE, '/config/farming/.session-token');
  assert.equal(env.FARMING_DISABLE_AUTH, '1');
  assert.equal(env.FARMING_TOKEN, undefined);
  assert.equal(env.FARMING_RUN_SERVER, undefined);
  assert.equal(env.CODEX_HOME, '/config/farming/homes/codex');
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.OPENCODE_CONFIG_DIR, undefined);
  assert.equal(env.QODER_CONFIG_DIR, undefined);
  assert.equal(env.QWEN_HOME, undefined);
  // Provider base configuration is the user's, not a Farming identity key.
  assert.equal(env.OPENCODE_CONFIG_CONTENT, '{"instructions":["/other/instance/bootstrap.md"]}');
  assert.equal(env.OPENTUI_NOTIFICATION_PROTOCOL, undefined);
  assert.equal(Object.isFrozen(projection), true);
  assert.equal(Object.isFrozen(env), true);

  const secondary = harness.policy.projectAgentEnv({
    agentId: 'agent-child',
    category: 'other',
    runtime: 'terminal',
    shellSession: true,
  });
  assert.equal(secondary.env.FARMING_IS_MAIN_AGENT, '0');
  assert.equal(secondary.env.FARMING_PARENT_AGENT_ID, undefined);
  assert.equal(secondary.env.FARMING_MAIN_WORKSPACE, '');
  assert.equal(secondary.env.FARMING_PROJECT_WORKSPACE, '');
  assert.equal(secondary.env.FARMING_SKILLS_FILE, undefined);
  assert.equal(secondary.env.CODEX_HOME, undefined);
});

test('every canonical adapter home key is projected only for its own provider', () => {
  const harness = new Harness({ config: { configDir: '/config/farming' } });
  assert.equal(PROVIDER_HOME_KEYS.includes('QODER_CONFIG_DIR'), true);

  for (const descriptor of CANONICAL_DESCRIPTORS) {
    for (const runtime of ['terminal', 'acp'] as const) {
      const projection = harness.policy.projectAgentEnv({
        agentId: `agent-${descriptor.provider}`,
        category: 'coding',
        provider: descriptor.provider,
        providerHomePath: `/config/farming/homes/${descriptor.provider}`,
        runtime,
      });
      assert.equal(
        projection.env[descriptor.homeEnvKey],
        `/config/farming/homes/${descriptor.provider}`,
        `${descriptor.provider}:${runtime}`,
      );
      for (const otherKey of PROVIDER_HOME_KEYS) {
        if (otherKey === descriptor.homeEnvKey) continue;
        assert.equal(projection.env[otherKey], undefined, `${descriptor.provider}:${otherKey}`);
      }
    }
  }

  const unknown = harness.policy.projectAgentEnv({
    agentId: 'agent-unknown',
    category: 'coding',
    provider: 'unknown',
    providerHomePath: '/config/farming/homes/unknown',
    runtime: 'terminal',
  });
  for (const key of PROVIDER_HOME_KEYS) assert.equal(unknown.env[key], undefined, key);
});

test('canonical descriptors own bootstrap and terminal notification behavior', () => {
  const harness = new Harness({
    config: { cliBinDir: '/repo/bin', configDir: '/config/farming', startupPromptFile: '/config/farming/boot.md' },
    shellEnv: () => ({ PATH: '/shell/bin' }),
  });
  const openCodeDescriptor = CANONICAL_DESCRIPTORS.find(entry => entry.provider === 'opencode');
  assert.ok(openCodeDescriptor);
  assert.deepEqual([...openCodeDescriptor.bootstrapInstructionRuntimes].sort(), ['acp', 'terminal']);
  assert.equal(openCodeDescriptor.terminalNotificationProtocol, 'osc99');

  const openCode = harness.policy.projectAgentEnv({
    agentId: 'agent-opencode',
    category: 'coding',
    provider: 'opencode',
    providerHomePath: '/config/farming/homes/opencode',
    runtime: 'terminal',
  });
  assert.equal(openCode.env.OPENCODE_CONFIG_DIR, '/config/farming/homes/opencode');
  assert.deepEqual(
    JSON.parse(openCode.env.OPENCODE_CONFIG_CONTENT!),
    { instructions: ['/config/farming/boot.md'] },
  );
  assert.equal(openCode.env.OPENTUI_NOTIFICATION_PROTOCOL, 'osc99');

  const acpOpenCode = harness.policy.projectAgentEnv({
    agentId: 'agent-opencode-acp',
    category: 'coding',
    provider: 'opencode',
    runtime: 'acp',
  });
  assert.deepEqual(
    JSON.parse(acpOpenCode.env.OPENCODE_CONFIG_CONTENT!),
    { instructions: ['/config/farming/boot.md'] },
  );
  assert.equal(acpOpenCode.env.OPENTUI_NOTIFICATION_PROTOCOL, undefined);
  assert.equal(acpOpenCode.env.OPENCODE_CONFIG_DIR, undefined);

  for (const descriptor of CANONICAL_DESCRIPTORS) {
    if (descriptor.provider === 'opencode') continue;
    assert.deepEqual(descriptor.bootstrapInstructionRuntimes, [], descriptor.provider);
    assert.equal(descriptor.terminalNotificationProtocol, '', descriptor.provider);
    for (const runtime of ['terminal', 'acp'] as const) {
      const projection = harness.policy.projectAgentEnv({
        agentId: `agent-${descriptor.provider}`,
        category: 'coding',
        provider: descriptor.provider,
        providerHomePath: `/config/farming/homes/${descriptor.provider}`,
        runtime,
      });
      assert.equal(projection.env.OPENCODE_CONFIG_CONTENT, undefined, `${descriptor.provider}:${runtime}`);
      assert.equal(
        projection.env.OPENTUI_NOTIFICATION_PROTOCOL,
        undefined,
        `${descriptor.provider}:${runtime}`,
      );
    }
  }
  // One construction-time read owns both the scrub union and launch behavior.
  assert.equal(harness.descriptorCalls, 1);
});

test('the inherited OpenCode base configuration survives and only gains the bootstrap instruction', () => {
  const baseConfig = {
    instructions: ['/home/user/AGENTS.md'],
    model: 'anthropic/claude-sonnet-4',
    plugin: ['@user/opencode-plugin'],
    provider: { anthropic: { options: { baseURL: 'https://example.invalid/v1' } } },
  };
  const inherited: NodeJS.ProcessEnv = { OPENCODE_CONFIG_CONTENT: JSON.stringify(baseConfig), PATH: '/shell/bin' };
  const harness = new Harness({
    config: { startupPromptFile: '/config/farming/boot.md' },
    processEnv: inherited,
    shellEnv: () => ({ ...inherited }),
  });

  for (const runtime of ['terminal', 'acp'] as const) {
    const projection = harness.policy.projectAgentEnv({
      agentId: `agent-opencode-${runtime}`,
      category: 'coding',
      provider: 'opencode',
      providerHomePath: '/config/farming/homes/opencode',
      runtime,
    });
    assert.deepEqual(
      JSON.parse(projection.env.OPENCODE_CONFIG_CONTENT!),
      { ...baseConfig, instructions: ['/home/user/AGENTS.md', '/config/farming/boot.md'] },
      runtime,
    );
  }

  const noBootstrap = new Harness({
    processEnv: inherited,
    shellEnv: () => ({ ...inherited }),
  });
  const codex = noBootstrap.policy.projectAgentEnv({
    agentId: 'agent-codex',
    category: 'coding',
    provider: 'codex',
    runtime: 'terminal',
  });
  assert.equal(codex.env.OPENCODE_CONFIG_CONTENT, JSON.stringify(baseConfig));
});

test('mutating the descriptor list after construction cannot alter policy', () => {
  const descriptors: ProviderLaunchDescriptor[] = [
    {
      bootstrapInstructionRuntimes: [],
      homeEnvKey: 'CODEX_HOME',
      provider: 'codex',
      terminalNotificationProtocol: '',
    },
  ];
  const harness = new Harness({
    config: { startupPromptFile: '/config/farming/boot.md' },
    providerDescriptors: descriptors,
  });
  const request = {
    agentId: 'agent-codex',
    category: 'coding',
    provider: 'codex',
    providerHomePath: '/config/farming/homes/codex',
    runtime: 'terminal',
  } as const;

  const first = harness.policy.projectAgentEnv(request);
  assert.equal(first.env.CODEX_HOME, '/config/farming/homes/codex');
  assert.equal(first.env.OPENTUI_NOTIFICATION_PROTOCOL, undefined);

  descriptors[0].terminalNotificationProtocol = 'osc99';
  descriptors[0].bootstrapInstructionRuntimes = ['terminal'];
  descriptors[0].homeEnvKey = 'EVIL_HOME';
  descriptors.push({
    bootstrapInstructionRuntimes: ['terminal'],
    homeEnvKey: 'EVIL_HOME',
    provider: 'evil',
    terminalNotificationProtocol: 'osc99',
  });

  const later = harness.policy.projectAgentEnv(request);
  assert.equal(later.env.CODEX_HOME, '/config/farming/homes/codex');
  assert.equal(later.env.EVIL_HOME, undefined);
  assert.equal(later.env.OPENTUI_NOTIFICATION_PROTOCOL, undefined);
  assert.equal(later.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(first.env.OPENTUI_NOTIFICATION_PROTOCOL, undefined);
  assert.equal(harness.policy.launchOwnedEnvKeys().includes('EVIL_HOME'), false);
  assert.equal(
    harness.policy.projectAgentEnv({ ...request, provider: 'evil', providerHomePath: '/evil/home' }).env.EVIL_HOME,
    undefined,
  );
});

test('an ambiguous or incomplete descriptor list is rejected at construction', () => {
  const duplicate: ProviderLaunchDescriptor[] = [
    { bootstrapInstructionRuntimes: [], homeEnvKey: 'CODEX_HOME', provider: 'codex', terminalNotificationProtocol: '' },
    { bootstrapInstructionRuntimes: [], homeEnvKey: 'OTHER_HOME', provider: 'codex', terminalNotificationProtocol: '' },
  ];
  assert.throws(() => new Harness({ providerDescriptors: duplicate }), /duplicate provider launch descriptor: codex/);

  const missingHome: ProviderLaunchDescriptor[] = [
    { bootstrapInstructionRuntimes: [], homeEnvKey: '  ', provider: 'codex', terminalNotificationProtocol: '' },
  ];
  assert.throws(() => new Harness({ providerDescriptors: missingHome }), /home environment key for provider codex/);

  const missingProvider: ProviderLaunchDescriptor[] = [
    { bootstrapInstructionRuntimes: [], homeEnvKey: 'CODEX_HOME', provider: '', terminalNotificationProtocol: '' },
  ];
  assert.throws(() => new Harness({ providerDescriptors: missingProvider }), /requires a provider id/);

  const unknownRuntime = [
    {
      bootstrapInstructionRuntimes: ['terminal', 'shell'],
      homeEnvKey: 'CODEX_HOME',
      provider: 'codex',
      terminalNotificationProtocol: '',
    },
  ] as unknown as ProviderLaunchDescriptor[];
  assert.throws(
    () => new Harness({ providerDescriptors: unknownRuntime }),
    /unknown bootstrap instruction runtime for provider codex: shell/,
  );
});

test('filesystem identities keep exact trailing whitespace and reject blank-only values', () => {
  const harness = new Harness({
    config: {
      cliBinDir: '/repo/bin ',
      configDir: '/config/farming ',
      startupPromptFile: '/config/farming/boot.md ',
      tokenFile: '  ',
    },
    shellEnv: () => ({ PATH: '/shell/bin' }),
  });

  const projection = harness.policy.projectAgentEnv({
    agentId: '  agent-main  ',
    category: 'coding',
    mainWorkspace: '/workspaces/main ',
    projectWorkspace: '/workspaces/project ',
    provider: ' codex ',
    providerHomePath: '/config/farming/homes/codex ',
    runtime: 'terminal',
  });

  assert.equal(projection.env.FARMING_CLI_BIN_DIR, '/repo/bin ');
  assert.equal(projection.env.PATH, '/repo/bin :/shell/bin');
  assert.equal(projection.env.FARMING_CONFIG_DIR, '/config/farming ');
  assert.equal(projection.env.FARMING_STARTUP_PROMPT_FILE, '/config/farming/boot.md ');
  assert.equal(projection.env.FARMING_TOKEN_FILE, undefined);
  assert.equal(projection.env.FARMING_MAIN_WORKSPACE, '/workspaces/main ');
  assert.equal(projection.env.FARMING_PROJECT_WORKSPACE, '/workspaces/project ');
  assert.equal(projection.env.FARMING_SKILLS_FILE, '/workspaces/main /FARMING_MAIN_AGENT_SKILLS.md');
  assert.equal(projection.env.FARMING_AGENT_ID, 'agent-main');
  assert.equal(projection.env.CODEX_HOME, '/config/farming/homes/codex ');
});

test('a persisted executable path keeps exact trailing whitespace', () => {
  const persisted = '/farming/versions/a/claude-acp ';
  const harness = new Harness({
    executables: [persisted],
    farmingOwnership: { claude: [persisted] },
  });

  assert.deepEqual(
    harness.policy.selectExecutable({
      configuredMode: 'managed',
      executablePolicy: 'managed',
      pathEnv: '/shell/bin',
      persistedExecutable: persisted,
      phase: 'resume',
      program: 'claude',
      provider: 'claude',
      runtime: 'acp',
    }),
    { selected: true, executable: persisted, source: 'persisted-managed' },
  );
});

test('launch owned keys cover control authority, identity, and every adapter home key', () => {
  const keys = new Harness().policy.launchOwnedEnvKeys();
  assert.equal(Object.isFrozen(keys), true);
  for (const key of [
    ...PROVIDER_HOME_KEYS,
    'FARMING_AGENT_ID',
    'FARMING_CLI_BIN_DIR',
    'FARMING_CONFIG_DIR',
    'FARMING_IS_MAIN_AGENT',
    'FARMING_MAIN_WORKSPACE',
    'FARMING_PARENT_AGENT_ID',
    'FARMING_PROJECT_WORKSPACE',
    'FARMING_SKILLS_FILE',
    'FARMING_STARTUP_PROMPT_FILE',
    'FARMING_TOKEN',
    'OPENTUI_NOTIFICATION_PROTOCOL',
  ]) assert.equal(keys.includes(key), true, key);
  assert.equal(keys.includes('QODER_CONFIG_DIR'), true);
  assert.equal(keys.includes('OPENCODE_CONFIG_CONTENT'), false);
  assert.equal(new Set(keys).size, keys.length);
});

test('projection scrubs prompt keys and runtime shims per category', () => {
  const harness = new Harness({
    config: { cliBinDir: '/repo/bin' },
    shellEnv: () => ({
      FARMING_SHELL_CONTROLLED_PROMPT: '1',
      LD_LIBRARY_PATH: '/server/lib',
      NODE_OPTIONS: '--max-old-space-size=99999',
      PATH: '/shell/bin',
      PS1: 'shell-prompt',
    }),
  });

  const shellAgent = harness.policy.projectAgentEnv({
    agentId: 'agent-shell',
    category: 'other',
    runtime: 'terminal',
    shellSession: true,
  });
  assert.equal(shellAgent.env.PS1, undefined);
  assert.equal(shellAgent.env.LD_LIBRARY_PATH, undefined);
  assert.equal(shellAgent.env.NODE_OPTIONS, undefined);
  assert.equal(shellAgent.env.TERM_PROGRAM, 'farming');

  const codingAgent = harness.policy.projectAgentEnv({
    agentId: 'agent-coding',
    category: 'coding',
    runtime: 'terminal',
    stripNodeOptions: false,
  });
  assert.equal(codingAgent.env.FARMING_SHELL_CONTROLLED_PROMPT, undefined);
  assert.equal(codingAgent.env.PS1, 'shell-prompt');
  assert.equal(codingAgent.env.NODE_OPTIONS, '--max-old-space-size=99999');
});

test('the reported program version comes from config, not mutable global process state', () => {
  const previousVersion = process.env.npm_package_version;
  process.env.npm_package_version = 'ambient-1.0.0';
  try {
    const configured = new Harness({ config: { programVersion: '2.5.0' } });
    const request = { agentId: 'agent-1', category: 'coding', runtime: 'terminal' } as const;
    assert.equal(configured.policy.projectAgentEnv(request).env.TERM_PROGRAM_VERSION, '2.5.0');

    process.env.npm_package_version = 'ambient-9.9.9';
    assert.equal(configured.policy.projectAgentEnv(request).env.TERM_PROGRAM_VERSION, '2.5.0');

    const unset = new Harness();
    assert.equal(unset.policy.projectAgentEnv(request).env.TERM_PROGRAM_VERSION, '');
  } finally {
    if (previousVersion === undefined) delete process.env.npm_package_version;
    else process.env.npm_package_version = previousVersion;
  }
});

test('mutating the input config or ports after construction cannot change outputs', () => {
  const config: AgentLaunchPolicyConfig = { cliBinDir: '/repo/bin', tokenFile: '/config/farming/.session-token' };
  const harness = new Harness({
    config,
    executables: ['/shell/bin/claude'],
    shellEnv: () => ({ PATH: '/shell/bin' }),
    systemTerminal: program => `/shell/bin/${program}`,
  });

  config.cliBinDir = '/evil/bin';
  config.tokenFile = '/evil/token';
  harness.ports.isExecutable = () => false;
  harness.ports.resolveSystemTerminalExecutable = () => '/evil/bin/claude';

  const projection = harness.policy.projectAgentEnv({
    agentId: 'agent-1',
    category: 'coding',
    runtime: 'terminal',
  });
  assert.equal(projection.env.FARMING_CLI_BIN_DIR, '/repo/bin');
  assert.equal(projection.env.PATH, '/repo/bin:/shell/bin');
  assert.equal(projection.env.FARMING_TOKEN_FILE, '/config/farming/.session-token');

  assert.deepEqual(
    harness.policy.selectExecutable({
      pathEnv: '/shell/bin',
      program: 'claude',
      provider: 'claude',
      runtime: 'terminal',
      terminalPolicy: SYSTEM_TERMINAL_POLICY,
    }),
    { selected: true, executable: '/shell/bin/claude', source: 'system' },
  );
});

test('a request without its runtime executable policy is rejected without any effect', () => {
  const harness = new Harness({
    executables: ['/shell/bin/codex', '/farming/bin/claude-acp'],
    farmingOwned: { claude: '/farming/bin/claude-acp' },
    farmingOwnership: { claude: ['/farming/bin/claude-acp'] },
    systemAcp: program => `/shell/bin/${program}`,
    systemTerminal: program => `/shell/bin/${program}`,
    terminalVersion: () => ({ compatible: true, error: '', path: '/shell/bin/codex', source: 'system' }),
  });

  const malformed: unknown[] = [
    null,
    { pathEnv: '/shell/bin', program: 'codex', provider: 'codex', runtime: 'terminal' },
    { pathEnv: '/shell/bin', program: 'codex', provider: 'codex', runtime: 'terminal', terminalPolicy: { kind: 'codex-versioned' } },
    { pathEnv: '/shell/bin', program: 'codex', provider: 'codex', runtime: 'terminal', terminalPolicy: { kind: 'managed' } },
    { pathEnv: '/shell/bin', program: 'claude', provider: 'claude', runtime: 'acp', phase: 'fresh', executablePolicy: 'managed' },
    { pathEnv: '/shell/bin', program: 'claude', provider: 'claude', runtime: 'acp', phase: 'fresh', configuredMode: 'managed' },
    { pathEnv: '/shell/bin', program: 'claude', provider: 'claude', runtime: 'acp', configuredMode: 'managed', executablePolicy: 'managed' },
    { program: 'claude', provider: 'claude', runtime: 'acp', phase: 'fresh', configuredMode: 'managed', executablePolicy: 'managed' },
    { pathEnv: '/shell/bin', program: 'codex', provider: 'codex', runtime: 'shell' },
  ];

  for (const request of malformed) {
    const decision = harness.policy.selectExecutable(request as AgentLaunchExecutableRequest);
    assert.equal(decision.selected, false, JSON.stringify(request));
    assert.equal(decision.selected === false && decision.reason, 'policy-missing', JSON.stringify(request));
  }
  assert.deepEqual(harness.systemCalls, []);
  assert.deepEqual(harness.farmingOwnedCalls, []);
  assert.deepEqual(harness.ownershipCalls, []);
  assert.deepEqual(harness.terminalVersionCalls, []);
});

test('managed ACP resume keeps the persisted Farming-owned executable instead of rediscovering', () => {
  const harness = new Harness({
    executables: ['/farming/versions/a/claude-acp'],
    farmingOwned: { claude: '/farming/versions/b/claude-acp' },
    farmingOwnership: { claude: ['/farming/versions/a/claude-acp', '/farming/versions/b/claude-acp'] },
  });

  assert.deepEqual(
    harness.policy.selectExecutable({
      configuredMode: 'managed',
      executablePolicy: 'managed',
      pathEnv: '/shell/bin',
      persistedExecutable: '/farming/versions/a/claude-acp',
      phase: 'resume',
      program: 'claude',
      provider: 'claude',
      runtime: 'acp',
    }),
    { selected: true, executable: '/farming/versions/a/claude-acp', source: 'persisted-managed' },
  );
  assert.deepEqual(harness.farmingOwnedCalls, []);
  assert.deepEqual(harness.ownershipCalls, ['claude:/farming/versions/a/claude-acp']);

  const fresh = new Harness({
    executables: ['/farming/versions/b/claude-acp'],
    farmingOwned: { claude: '/farming/versions/b/claude-acp' },
    farmingOwnership: { claude: ['/farming/versions/b/claude-acp'] },
  });
  assert.deepEqual(
    fresh.policy.selectExecutable({
      configuredMode: 'managed',
      executablePolicy: 'managed',
      pathEnv: '/shell/bin',
      phase: 'fresh',
      program: 'claude',
      provider: 'claude',
      runtime: 'acp',
    }),
    { selected: true, executable: '/farming/versions/b/claude-acp', source: 'discovered-managed' },
  );
  assert.deepEqual(fresh.ownershipCalls, ['claude:/farming/versions/b/claude-acp']);
});

test('managed ACP rejects missing, unusable, relative, or unowned persisted executables', () => {
  const harness = new Harness({
    executables: ['/farming/versions/a/claude-acp', '/usr/local/bin/claude-acp'],
    farmingOwned: { claude: '/farming/versions/b/claude-acp' },
    farmingOwnership: { claude: ['/farming/versions/a/claude-acp'] },
  });
  const base = {
    configuredMode: 'managed' as const,
    executablePolicy: 'managed' as const,
    pathEnv: '/shell/bin',
    phase: 'resume' as const,
    program: 'claude',
    provider: 'claude',
    runtime: 'acp' as const,
  };

  const cases: [string | undefined, string][] = [
    [undefined, 'persisted-managed-missing'],
    ['relative/claude-acp', 'persisted-managed-not-absolute'],
    ['/farming/versions/gone/claude-acp', 'persisted-managed-unusable'],
    ['/usr/local/bin/claude-acp', 'persisted-managed-unowned'],
  ];
  for (const [persistedExecutable, reason] of cases) {
    const decision = harness.policy.selectExecutable({ ...base, persistedExecutable });
    assert.equal(decision.selected === false && decision.reason, reason);
  }
  assert.deepEqual(harness.farmingOwnedCalls, []);
});

test('fresh managed ACP discovery must be absolute, executable, available, and Farming-owned', () => {
  const base = {
    configuredMode: 'managed' as const,
    executablePolicy: 'managed' as const,
    pathEnv: '/shell/bin',
    phase: 'fresh' as const,
    program: 'claude',
    provider: 'claude',
    runtime: 'acp' as const,
  };

  const unavailable = new Harness({}).policy.selectExecutable(base);
  assert.equal(unavailable.selected === false && unavailable.reason, 'managed-unavailable');

  const relative = new Harness({ farmingOwned: { claude: 'claude-acp' } }).policy.selectExecutable(base);
  assert.equal(relative.selected === false && relative.reason, 'managed-not-absolute');

  const notExecutable = new Harness({
    farmingOwned: { claude: '/farming/versions/b/claude-acp' },
  }).policy.selectExecutable(base);
  assert.equal(notExecutable.selected === false && notExecutable.reason, 'managed-not-executable');

  const unowned = new Harness({
    executables: ['/usr/local/bin/claude-acp'],
    farmingOwned: { claude: '/usr/local/bin/claude-acp' },
  });
  const unownedDecision = unowned.policy.selectExecutable(base);
  assert.equal(unownedDecision.selected === false && unownedDecision.reason, 'managed-unowned');
  assert.deepEqual(unowned.ownershipCalls, ['claude:/usr/local/bin/claude-acp']);
});

test('system ACP resume reuses the persisted executable exactly without rediscovery', () => {
  const harness = new Harness({
    executables: ['/usr/local/bin/opencode'],
    systemAcp: () => '/opt/homebrew/bin/opencode',
  });
  const base = {
    configuredMode: 'managed' as const,
    executablePolicy: 'system' as const,
    pathEnv: '/shell/bin',
    phase: 'resume' as const,
    program: 'opencode',
    provider: 'opencode',
    runtime: 'acp' as const,
  };

  assert.deepEqual(
    harness.policy.selectExecutable({ ...base, persistedExecutable: '/usr/local/bin/opencode' }),
    { selected: true, executable: '/usr/local/bin/opencode', source: 'persisted-system' },
  );
  assert.deepEqual(harness.systemCalls, []);

  const cases: [string | undefined, string][] = [
    [undefined, 'persisted-system-missing'],
    ['opencode', 'persisted-system-not-absolute'],
    ['/usr/local/bin/gone', 'persisted-system-unusable'],
  ];
  for (const [persistedExecutable, reason] of cases) {
    const decision = harness.policy.selectExecutable({ ...base, persistedExecutable });
    assert.equal(decision.selected === false && decision.reason, reason);
  }
  assert.deepEqual(harness.systemCalls, []);
});

test('custom ACP executable selection is exact and validated for fresh and resume', () => {
  const harness = new Harness({ executables: ['/custom/claude-acp'] });
  const request = {
    configuredMode: 'custom' as const,
    executablePolicy: 'managed' as const,
    pathEnv: '/shell/bin',
    program: 'claude',
    provider: 'claude',
    runtime: 'acp' as const,
  };

  for (const phase of ['fresh', 'resume'] as const) {
    assert.deepEqual(
      harness.policy.selectExecutable({ ...request, persistedExecutable: '/custom/claude-acp', phase }),
      { selected: true, executable: '/custom/claude-acp', source: 'persisted-custom' },
    );
  }

  const relative = harness.policy.selectExecutable({ ...request, persistedExecutable: 'claude-acp', phase: 'fresh' });
  assert.equal(relative.selected === false && relative.reason, 'custom-not-absolute');

  const notExecutable = harness.policy.selectExecutable({
    ...request,
    persistedExecutable: '/custom/missing-acp',
    phase: 'resume',
  });
  assert.equal(notExecutable.selected === false && notExecutable.reason, 'custom-not-executable');

  const unconfigured = harness.policy.selectExecutable({ ...request, persistedExecutable: '  ', phase: 'fresh' });
  assert.equal(unconfigured.selected === false && unconfigured.reason, 'custom-not-configured');
  assert.deepEqual(harness.farmingOwnedCalls, []);
});

test('system executables must be absolute and executable, never the bare program', () => {
  const harness = new Harness({
    executables: ['/shell/bin/codex', '/shell/bin/opencode'],
    systemAcp: (program, pathEnv) => (pathEnv === '/shell/bin' ? `/shell/bin/${program}` : ''),
    systemTerminal: (program, pathEnv) => (pathEnv === '/shell/bin' ? `/shell/bin/${program}` : ''),
  });

  assert.deepEqual(
    harness.policy.selectExecutable({
      pathEnv: '/shell/bin',
      program: 'opencode',
      provider: 'opencode',
      runtime: 'terminal',
      terminalPolicy: SYSTEM_TERMINAL_POLICY,
    }),
    { selected: true, executable: '/shell/bin/opencode', source: 'system' },
  );
  for (const phase of ['fresh', 'resume'] as const) {
    const decision = harness.policy.selectExecutable({
      configuredMode: 'managed',
      executablePolicy: 'system',
      pathEnv: '/shell/bin',
      phase,
      program: 'opencode',
      provider: 'opencode',
      runtime: 'acp',
      ...(phase === 'resume' ? { persistedExecutable: '/shell/bin/opencode' } : {}),
    });
    assert.deepEqual(decision, {
      selected: true,
      executable: '/shell/bin/opencode',
      source: phase === 'fresh' ? 'system' : 'persisted-system',
    });
  }
  assert.deepEqual(
    harness.systemCalls.map(call => `${call.runtime}:${call.program}:${call.pathEnv}`),
    ['terminal:opencode:/shell/bin', 'acp:opencode:/shell/bin'],
  );

  const missing = harness.policy.selectExecutable({
    pathEnv: '/empty/bin',
    program: 'claude',
    provider: 'claude',
    runtime: 'terminal',
    terminalPolicy: SYSTEM_TERMINAL_POLICY,
  });
  assert.equal(missing.selected === false && missing.reason, 'system-not-found');

  const bare = new Harness({ systemTerminal: program => program }).policy.selectExecutable({
    pathEnv: '/shell/bin',
    program: 'claude',
    provider: 'claude',
    runtime: 'terminal',
    terminalPolicy: SYSTEM_TERMINAL_POLICY,
  });
  assert.equal(bare.selected === false && bare.reason, 'system-not-absolute');

  const notExecutable = new Harness({
    systemTerminal: program => `/shell/bin/${program}`,
  }).policy.selectExecutable({
    pathEnv: '/shell/bin',
    program: 'claude',
    provider: 'claude',
    runtime: 'terminal',
    terminalPolicy: SYSTEM_TERMINAL_POLICY,
  });
  assert.equal(notExecutable.selected === false && notExecutable.reason, 'system-not-executable');
});

test('an explicit absolute non-Codex Terminal program is selected exactly without PATH discovery', () => {
  const executable = '/custom/bin/qodercli ';
  const harness = new Harness({ executables: [executable] });

  assert.deepEqual(
    harness.policy.selectExecutable({
      pathEnv: '/shell/bin',
      program: executable,
      provider: 'qoder',
      runtime: 'terminal',
      terminalPolicy: SYSTEM_TERMINAL_POLICY,
    }),
    { selected: true, executable, source: 'system' },
  );
  assert.deepEqual(harness.systemCalls, []);

  const unusable = '/custom/bin/missing-qodercli';
  const rejected = harness.policy.selectExecutable({
    pathEnv: '/shell/bin',
    program: unusable,
    provider: 'qoder',
    runtime: 'terminal',
    terminalPolicy: SYSTEM_TERMINAL_POLICY,
  });
  assert.equal(rejected.selected === false && rejected.reason, 'system-not-executable');
  assert.deepEqual(harness.systemCalls, []);
});

test('Terminal version policy stays in the resolver port and rejects incompatible results', () => {
  const harness = new Harness({
    executables: ['/shell/bin/codex', '/farming/bin/codex'],
    terminalVersion: (program, requiredCliVersion, pathEnv) => {
      if (requiredCliVersion === '0.50.0') {
        return { compatible: true, error: '', path: `${pathEnv}/${program}`, source: 'system' };
      }
      if (requiredCliVersion === '0.60.0') {
        return { compatible: true, error: '', path: '/farming/bin/codex', source: 'farming' };
      }
      return { compatible: false, error: 'Codex 0.99.0 or newer is required', path: '/shell/bin/codex', source: 'system' };
    },
  });
  const base = {
    pathEnv: '/shell/bin',
    program: 'codex',
    provider: 'codex',
    runtime: 'terminal' as const,
  };

  assert.deepEqual(
    harness.policy.selectExecutable({
      ...base,
      terminalPolicy: { kind: 'codex-versioned', requiredCliVersion: '0.50.0' },
    }),
    { selected: true, executable: '/shell/bin/codex', source: 'system' },
  );
  assert.deepEqual(
    harness.policy.selectExecutable({
      ...base,
      terminalPolicy: { kind: 'codex-versioned', requiredCliVersion: '0.60.0' },
    }),
    { selected: true, executable: '/farming/bin/codex', source: 'discovered-managed' },
  );

  const incompatible = harness.policy.selectExecutable({
    ...base,
    terminalPolicy: { kind: 'codex-versioned', requiredCliVersion: '0.99.0' },
  });
  assert.equal(incompatible.selected === false && incompatible.reason, 'terminal-version-incompatible');
  assert.equal(
    incompatible.selected === false && incompatible.message,
    'Codex 0.99.0 or newer is required',
  );
  assert.deepEqual(harness.systemCalls, []);
  assert.deepEqual(
    harness.terminalVersionCalls.map(call => `${call.program}:${call.requiredCliVersion}:${call.pathEnv}`),
    ['codex:0.50.0:/shell/bin', 'codex:0.60.0:/shell/bin', 'codex:0.99.0:/shell/bin'],
  );

  const empty = new Harness({
    terminalVersion: () => ({ compatible: true, error: '', path: 'codex', source: 'system' }),
  });
  const relative = empty.policy.selectExecutable({
    ...base,
    terminalPolicy: { kind: 'codex-versioned', requiredCliVersion: '' },
  });
  assert.equal(relative.selected === false && relative.reason, 'system-not-absolute');
  assert.deepEqual(
    empty.terminalVersionCalls.map(call => call.requiredCliVersion),
    [''],
  );
});

test('Terminal policy is bound to program identity for both legal and illegal combinations', () => {
  const harness = new Harness({
    executables: ['/shell/bin/codex', '/usr/local/bin/codex'],
    systemTerminal: program => `/shell/bin/${program}`,
    terminalVersion: program => ({
      compatible: true,
      error: '',
      path: path.isAbsolute(program) ? program : `/shell/bin/${program}`,
      source: 'system',
    }),
  });
  const versioned = { kind: 'codex-versioned', requiredCliVersion: '0.50.0' } as const;

  for (const program of ['codex', '/usr/local/bin/codex']) {
    assert.deepEqual(
      harness.policy.selectExecutable({
        pathEnv: '/shell/bin',
        program,
        provider: 'codex',
        runtime: 'terminal',
        terminalPolicy: versioned,
      }),
      {
        selected: true,
        executable: program === 'codex' ? '/shell/bin/codex' : '/usr/local/bin/codex',
        source: 'system',
      },
      program,
    );
  }
  assert.deepEqual(
    harness.terminalVersionCalls.map(call => call.program),
    ['codex', '/usr/local/bin/codex'],
  );
  assert.deepEqual(harness.systemCalls, []);

  const illegal = new Harness({
    executables: ['/shell/bin/codex', '/shell/bin/opencode'],
    systemTerminal: program => `/shell/bin/${program}`,
    terminalVersion: program => ({ compatible: true, error: '', path: `/shell/bin/${program}`, source: 'system' }),
  });
  const illegalRequests: AgentLaunchExecutableRequest[] = [
    {
      pathEnv: '/shell/bin',
      program: '/usr/local/bin/codex',
      provider: 'codex',
      runtime: 'terminal',
      terminalPolicy: SYSTEM_TERMINAL_POLICY,
    },
    {
      pathEnv: '/shell/bin',
      program: 'opencode',
      provider: 'opencode',
      runtime: 'terminal',
      terminalPolicy: versioned,
    },
  ];
  for (const request of illegalRequests) {
    const decision = illegal.policy.selectExecutable(request);
    assert.equal(decision.selected === false && decision.reason, 'policy-missing', request.program);
  }
  assert.deepEqual(illegal.systemCalls, []);
  assert.deepEqual(illegal.terminalVersionCalls, []);
});
