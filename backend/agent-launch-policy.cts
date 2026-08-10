import { buildInteractiveAgentBaseEnv, normalizeInteractiveTerminalEnv } from './agent-env.cjs';

const path = require('path');

/**
 * Control authority that must never be inherited by a launched Agent: the
 * current Farming instance is the only owner of these values, so an inherited
 * token or auth-disabled flag from a parent process is removed before the exact
 * current-instance values are applied.
 */
const CONTROL_AUTHORITY_ENV_KEYS: readonly string[] = Object.freeze([
  'FARMING_AGENT_TITLE_TOKEN',
  'FARMING_BROWSER_TOKEN',
  'FARMING_CAPABILITY_RUNTIME_EPOCH',
  'FARMING_COMPUTER_TOKEN',
  'FARMING_CONTROL_URL',
  'FARMING_DISABLE_AUTH',
  'FARMING_RUN_NATIVE_PTY_HOST',
  'FARMING_RUN_SERVER',
  'FARMING_TOKEN',
  'FARMING_TOKEN_FILE',
]);

/**
 * Instance-scoped configuration and Agent identity. An inherited value here
 * would make a launched Agent report or mutate another Agent's identity, so the
 * launch request must carry every value that is applied.
 */
const AGENT_IDENTITY_ENV_KEYS: readonly string[] = Object.freeze([
  'FARMING_AGENT_ID',
  'FARMING_CAPABILITIES_COMMAND',
  'FARMING_CLI_BIN_DIR',
  'FARMING_CONFIG_DIR',
  'FARMING_IS_MAIN_AGENT',
  'FARMING_MAIN_WORKSPACE',
  'FARMING_PARENT_AGENT_ID',
  'FARMING_PROJECT_WORKSPACE',
  'FARMING_SKILLS_COMMAND',
  'FARMING_SKILLS_FILE',
  'FARMING_STARTUP_PROMPT_FILE',
]);

/**
 * Farming-owned provider launch projection. `OPENCODE_CONFIG_CONTENT` is
 * deliberately absent: it is the user's or provider's own base configuration
 * (models, plugins, instructions), so Farming merges its bootstrap instruction
 * into the inherited value instead of discarding it.
 */
const PROVIDER_LAUNCH_ENV_KEYS: readonly string[] = Object.freeze([
  'OPENTUI_NOTIFICATION_PROTOCOL',
]);

const SHELL_PROMPT_ENV_KEYS: readonly string[] = Object.freeze([
  'PROMPT',
  'PROMPT_COMMAND',
  'PS1',
  'PS2',
  'PS3',
  'PS4',
  'RPROMPT',
  'RPS1',
]);

const CODING_SHELL_PRESENTATION_ENV_KEYS: readonly string[] = Object.freeze([
  'FARMING_ANONYMIZE_SHELL_PROMPT',
  'FARMING_PRESERVE_SHELL_PROMPT',
  'FARMING_SHELL_CONTROLLED_PROMPT',
]);

const DEFAULT_SHELL_ENV_KEY = '__default__';
const MAX_SHELL_ENV_CACHE_MS = 60 * 60 * 1000;
const DEFAULT_SKILLS_COMMAND = 'farming skills';
const DEFAULT_CAPABILITIES_COMMAND = 'farming capabilities';
const SKILLS_FILE_NAME = 'FARMING_MAIN_AGENT_SKILLS.md';

export type AgentLaunchRuntime = 'terminal' | 'acp';
export type AgentLaunchPhase = 'fresh' | 'resume';
export type AcpExecutablePolicy = 'managed' | 'system';
export type AcpRuntimeMode = 'managed' | 'custom';

export interface TerminalExecutableResolution {
  compatible: boolean;
  error: string;
  path: string;
}

/**
 * Canonical launch projection of one provider, owned by the provider adapter
 * registry. The launch owner applies only what a descriptor declares, so a
 * caller cannot request bootstrap or notification behavior the provider adapter
 * does not declare, and there is exactly one list to keep in sync.
 */
export interface ProviderLaunchDescriptor {
  /** Runtimes whose launch consumes the Farming bootstrap instruction file. */
  bootstrapInstructionRuntimes: readonly AgentLaunchRuntime[];
  /** Environment key carrying this provider's Farming-owned home path. */
  homeEnvKey: string;
  provider: string;
  /** Notification protocol required by this provider's Terminal TUI, else empty. */
  terminalNotificationProtocol: string;
}

export interface AgentLaunchPolicyPorts {
  /** Provider-owned projection of the bootstrap instruction file. */
  appendBootstrapInstruction(env: NodeJS.ProcessEnv, bootstrapFile: string): NodeJS.ProcessEnv;
  isExecutable(candidate: string): boolean;
  /** Narrow ownership proof for a managed executable of one provider. */
  isFarmingOwnedExecutable(provider: string, candidate: string): boolean;
  now(): number;
  processEnv(): NodeJS.ProcessEnv;
  /** Every provider this instance may launch, with its full launch projection. */
  providerLaunchDescriptors(): readonly ProviderLaunchDescriptor[];
  resolveFarmingOwnedExecutable(provider: string): string;
  resolveShellEnv(shell: string): NodeJS.ProcessEnv | null;
  resolveSystemAcpExecutable(program: string, pathEnv: string): string;
  resolveSystemTerminalExecutable(program: string, pathEnv: string): string;
  /** Version-aware Terminal resolution; owns system versus newer-Farming policy. */
  resolveTerminalExecutableVersion(
    program: string,
    requiredCliVersion: string,
    pathEnv: string,
  ): TerminalExecutableResolution;
  warn?(message: string, error: unknown): void;
}

export interface AgentLaunchPolicyConfig {
  authDisabled?: boolean;
  capabilitiesCommand?: string;
  cliBinDir?: string;
  configDir?: string;
  controlUrl?: string;
  /** Terminal program version reported to every launched Agent. */
  programVersion?: string;
  shellEnvCacheMs?: number;
  skillsCommand?: string;
  startupPromptFile?: string;
  tokenFile?: string;
}

export interface ShellEnvResolveOptions {
  force?: boolean;
  maxAgeMs?: number;
}

export interface ShellEnvResolution {
  env: Readonly<NodeJS.ProcessEnv>;
  source: 'shell' | 'process-env';
}

export interface AgentEnvProjectionRequest {
  agentId: string;
  /** `coding` launches a CLI directly; `other` launches the user's shell. */
  category: string;
  isMainAgent?: boolean;
  mainWorkspace?: string;
  parentAgentId?: string;
  projectWorkspace?: string;
  provider?: string;
  providerHomePath?: string;
  runtime: AgentLaunchRuntime;
  /** Shell whose captured environment this Agent may use. */
  shell?: string;
  /** True when the launched program is the user's interactive shell. */
  shellSession?: boolean;
  stripNodeOptions?: boolean;
  stripRuntimeShims?: boolean;
}

export interface AgentEnvProjection {
  env: Readonly<NodeJS.ProcessEnv>;
}

export interface AcpExecutableRequest {
  configuredMode: AcpRuntimeMode;
  /** ACP executable policy of the provider adapter. */
  executablePolicy: AcpExecutablePolicy;
  /** PATH captured from the user shell environment. */
  pathEnv: string;
  /** Executable already selected and persisted for this session. */
  persistedExecutable?: string;
  phase: AgentLaunchPhase;
  /** Program name requested by the launch profile. */
  program: string;
  provider: string;
  runtime: 'acp';
}

export type TerminalExecutablePolicy =
  | { kind: 'codex-versioned'; requiredCliVersion: string }
  | { kind: 'system' };

export interface TerminalExecutableRequest {
  pathEnv: string;
  program: string;
  provider: string;
  runtime: 'terminal';
  /** Explicit Terminal resolution policy; there is no implicit default. */
  terminalPolicy: TerminalExecutablePolicy;
}

export type AgentLaunchExecutableRequest = AcpExecutableRequest | TerminalExecutableRequest;

export type AgentLaunchExecutableRejection =
  | 'custom-not-absolute'
  | 'custom-not-configured'
  | 'custom-not-executable'
  | 'managed-not-absolute'
  | 'managed-not-executable'
  | 'managed-unavailable'
  | 'managed-unowned'
  | 'persisted-managed-missing'
  | 'persisted-managed-not-absolute'
  | 'persisted-managed-unowned'
  | 'persisted-managed-unusable'
  | 'persisted-system-missing'
  | 'persisted-system-not-absolute'
  | 'persisted-system-unusable'
  | 'policy-missing'
  | 'system-not-absolute'
  | 'system-not-executable'
  | 'system-not-found'
  | 'terminal-version-incompatible';

export type AgentLaunchExecutableDecision =
  | { selected: true; executable: string }
  | { selected: false; reason: AgentLaunchExecutableRejection; message: string };

interface ShellEnvCacheEntry {
  env: Readonly<NodeJS.ProcessEnv>;
  processEnv: Readonly<NodeJS.ProcessEnv>;
  resolvedAt: number;
  source: ShellEnvResolution['source'];
}

function frozenEnv(env: NodeJS.ProcessEnv): Readonly<NodeJS.ProcessEnv> {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') next[key] = value;
  }
  return Object.freeze(next);
}

function normalizeCacheMs(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_SHELL_ENV_CACHE_MS);
}

/** Identity-style value: documented trimming applies to ids, names, commands. */
function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Filesystem identity: a path may legally end with a space, so only a
 * whitespace-only value counts as absent and a legal value is never mutated.
 */
function exactPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value;
}

function normalizeConfig(config: AgentLaunchPolicyConfig): Readonly<AgentLaunchPolicyConfig> {
  return Object.freeze({
    authDisabled: config.authDisabled === true,
    capabilitiesCommand: normalizeText(config.capabilitiesCommand) || DEFAULT_CAPABILITIES_COMMAND,
    cliBinDir: exactPath(config.cliBinDir),
    configDir: exactPath(config.configDir),
    controlUrl: normalizeText(config.controlUrl),
    programVersion: normalizeText(config.programVersion),
    shellEnvCacheMs: normalizeCacheMs(config.shellEnvCacheMs),
    skillsCommand: normalizeText(config.skillsCommand) || DEFAULT_SKILLS_COMMAND,
    startupPromptFile: exactPath(config.startupPromptFile),
    tokenFile: exactPath(config.tokenFile),
  });
}

function boundPorts(ports: AgentLaunchPolicyPorts): Readonly<AgentLaunchPolicyPorts> {
  const warn = ports.warn;
  return Object.freeze({
    appendBootstrapInstruction: ports.appendBootstrapInstruction.bind(ports),
    isExecutable: ports.isExecutable.bind(ports),
    isFarmingOwnedExecutable: ports.isFarmingOwnedExecutable.bind(ports),
    now: ports.now.bind(ports),
    processEnv: ports.processEnv.bind(ports),
    providerLaunchDescriptors: ports.providerLaunchDescriptors.bind(ports),
    resolveFarmingOwnedExecutable: ports.resolveFarmingOwnedExecutable.bind(ports),
    resolveShellEnv: ports.resolveShellEnv.bind(ports),
    resolveSystemAcpExecutable: ports.resolveSystemAcpExecutable.bind(ports),
    resolveSystemTerminalExecutable: ports.resolveSystemTerminalExecutable.bind(ports),
    resolveTerminalExecutableVersion: ports.resolveTerminalExecutableVersion.bind(ports),
    warn: typeof warn === 'function' ? warn.bind(ports) : undefined,
  });
}

const LAUNCH_RUNTIMES: readonly AgentLaunchRuntime[] = Object.freeze(['acp', 'terminal']);

/**
 * One validated, frozen snapshot of the canonical provider launch list. Taking
 * it once at construction makes both the scrub union and the per-launch
 * behavior lookup read the same list, and a later mutation of the source array
 * or of any descriptor cannot change an already constructed policy.
 */
function snapshotDescriptors(
  descriptors: readonly ProviderLaunchDescriptor[] | null | undefined,
): ReadonlyMap<string, Readonly<ProviderLaunchDescriptor>> {
  const byProvider = new Map<string, Readonly<ProviderLaunchDescriptor>>();
  for (const descriptor of Array.from(descriptors || [])) {
    if (!descriptor || typeof descriptor !== 'object') {
      throw new Error('Agent launch policy requires an object for every provider launch descriptor');
    }
    const provider = normalizeText(descriptor.provider);
    if (!provider) {
      throw new Error('Agent launch policy requires a provider id on every provider launch descriptor');
    }
    if (byProvider.has(provider)) {
      throw new Error(`Agent launch policy received a duplicate provider launch descriptor: ${provider}`);
    }
    const homeEnvKey = normalizeText(descriptor.homeEnvKey);
    if (!homeEnvKey) {
      throw new Error(`Agent launch policy requires a home environment key for provider ${provider}`);
    }
    const runtimes = Array.from(descriptor.bootstrapInstructionRuntimes || []);
    for (const runtime of runtimes) {
      // Silently dropping an unknown runtime would make a declared bootstrap
      // behavior disappear at launch time instead of failing here.
      if (!LAUNCH_RUNTIMES.includes(runtime)) {
        throw new Error(
          `Agent launch policy received an unknown bootstrap instruction runtime for provider ${provider}: ${String(runtime)}`,
        );
      }
    }
    byProvider.set(provider, Object.freeze({
      bootstrapInstructionRuntimes: Object.freeze([...new Set(runtimes)]),
      homeEnvKey,
      provider,
      terminalNotificationProtocol: normalizeText(descriptor.terminalNotificationProtocol),
    }));
  }
  return byProvider;
}

const CODEX_PROGRAM_NAME = 'codex';

/**
 * Terminal version policy is bound to program identity, not to a caller's
 * claim: only the Codex program may use `codex-versioned`, and Codex must never
 * be launched through the unversioned system path.
 */
function terminalPolicyMatchesProgram(program: string, kind: string): boolean {
  const isCodex = path.basename(normalizeText(program)) === CODEX_PROGRAM_NAME;
  return isCodex ? kind === 'codex-versioned' : kind === 'system';
}

/**
 * Runtime guard for the executable request union. A JavaScript caller can omit a
 * policy field that TypeScript requires, and a missing policy must reject
 * instead of silently falling through to a weaker selection path.
 */
function validExecutableRequest(request: AgentLaunchExecutableRequest | null | undefined): boolean {
  if (!request || typeof request !== 'object') return false;
  if (typeof request.pathEnv !== 'string') return false;
  if (typeof request.program !== 'string' || typeof request.provider !== 'string') return false;
  if (request.runtime === 'acp') {
    if (request.phase !== 'fresh' && request.phase !== 'resume') return false;
    if (request.configuredMode !== 'managed' && request.configuredMode !== 'custom') return false;
    return request.executablePolicy === 'managed' || request.executablePolicy === 'system';
  }
  if (request.runtime !== 'terminal') return false;
  const policy = request.terminalPolicy;
  if (!policy || typeof policy !== 'object') return false;
  if (!terminalPolicyMatchesProgram(request.program, policy.kind)) return false;
  if (policy.kind === 'system') return true;
  return policy.kind === 'codex-versioned' && typeof policy.requiredCliVersion === 'string';
}

class AgentLaunchPolicy {
  readonly #ports: Readonly<AgentLaunchPolicyPorts>;
  readonly #config: Readonly<AgentLaunchPolicyConfig>;
  readonly #providerDescriptors: ReadonlyMap<string, Readonly<ProviderLaunchDescriptor>>;
  readonly #launchOwnedEnvKeys: readonly string[];
  readonly #shellEnvCache = new Map<string, ShellEnvCacheEntry>();

  constructor(config: AgentLaunchPolicyConfig, ports: AgentLaunchPolicyPorts) {
    this.#config = normalizeConfig(config);
    this.#ports = boundPorts(ports);
    this.#providerDescriptors = snapshotDescriptors(this.#ports.providerLaunchDescriptors());
    this.#launchOwnedEnvKeys = Object.freeze([...new Set([
      ...CONTROL_AUTHORITY_ENV_KEYS,
      ...AGENT_IDENTITY_ENV_KEYS,
      ...PROVIDER_LAUNCH_ENV_KEYS,
      ...[...this.#providerDescriptors.values()].map(descriptor => descriptor.homeEnvKey),
    ])].sort());
  }

  resolveShellEnv(shell = '', options: ShellEnvResolveOptions = {}): ShellEnvResolution {
    const shellKey = String(shell || '').trim() || DEFAULT_SHELL_ENV_KEY;
    const entry = this.#shellEnvEntry(shellKey, options);
    return Object.freeze({ env: entry.env, source: entry.source });
  }

  projectAgentEnv(request: AgentEnvProjectionRequest): AgentEnvProjection {
    const shellKey = String(request.shell || '').trim() || DEFAULT_SHELL_ENV_KEY;
    const cached = this.#shellEnvEntry(shellKey, {});
    const env = buildInteractiveAgentBaseEnv({
      processEnv: { ...cached.processEnv },
      shellEnv: cached.source === 'shell' ? { ...cached.env } : null,
    });

    for (const key of this.#launchOwnedEnvKeys) delete env[key];
    if (request.category === 'coding') {
      // Prompt policy is meaningful only for shell sessions. Never pass a
      // shell presentation toggle into a directly launched coding CLI.
      for (const key of CODING_SHELL_PRESENTATION_ENV_KEYS) delete env[key];
    }
    if (request.category === 'other' && request.shellSession === true) {
      // Like VS Code, the launched shell's own startup files own its prompt.
      for (const key of SHELL_PROMPT_ENV_KEYS) delete env[key];
    }

    env.PATH = [this.#config.cliBinDir || '', env.PATH || ''].filter(Boolean).join(path.delimiter);
    normalizeInteractiveTerminalEnv(env, {
      stripNodeOptions: request.stripNodeOptions !== false,
      stripRuntimeShims: request.stripRuntimeShims !== false,
    });
    // The reported program version is instance configuration, not whatever the
    // ambient process environment or package metadata happens to say now.
    env.TERM_PROGRAM_VERSION = this.#config.programVersion!;

    const mainWorkspace = exactPath(request.mainWorkspace);
    if (this.#config.cliBinDir) env.FARMING_CLI_BIN_DIR = this.#config.cliBinDir;
    env.FARMING_AGENT_ID = normalizeText(request.agentId);
    env.FARMING_IS_MAIN_AGENT = request.isMainAgent === true ? '1' : '0';
    env.FARMING_SKILLS_COMMAND = this.#config.skillsCommand!;
    env.FARMING_CAPABILITIES_COMMAND = this.#config.capabilitiesCommand!;
    env.FARMING_MAIN_WORKSPACE = mainWorkspace;
    env.FARMING_PROJECT_WORKSPACE = exactPath(request.projectWorkspace);
    const parentAgentId = normalizeText(request.parentAgentId);
    if (parentAgentId) env.FARMING_PARENT_AGENT_ID = parentAgentId;
    if (mainWorkspace) env.FARMING_SKILLS_FILE = path.join(mainWorkspace, SKILLS_FILE_NAME);
    Object.assign(env, this.#controlAuthority());

    this.#applyProviderLaunch(env, request);

    return Object.freeze({ env: frozenEnv(env) });
  }

  selectExecutable(request: AgentLaunchExecutableRequest): AgentLaunchExecutableDecision {
    if (!validExecutableRequest(request)) {
      return this.#reject(
        'policy-missing',
        'Agent launch executable request is missing its runtime executable policy',
      );
    }
    const provider = normalizeText(request.provider);
    const requestedProgram = exactPath(request.program);
    const program = path.isAbsolute(requestedProgram)
      ? requestedProgram
      : normalizeText(request.program);
    const pathEnv = String(request.pathEnv);

    if (request.runtime === 'terminal') {
      // An explicit non-Codex Terminal path is already the complete executable
      // identity. Validate that exact path instead of treating it as a PATH
      // lookup name; failure must not retry discovery or fall back to a bare
      // program. Codex remains version-gated by its dedicated resolver.
      if (request.terminalPolicy.kind === 'system' && path.isAbsolute(program)) {
        return this.#validateSystem(program, program);
      }
      return request.terminalPolicy.kind === 'codex-versioned'
        ? this.#selectVersionedTerminal(program, request.terminalPolicy.requiredCliVersion, pathEnv)
        : this.#validateSystem(
          program,
          exactPath(this.#ports.resolveSystemTerminalExecutable(program, pathEnv)),
        );
    }

    const persisted = exactPath(request.persistedExecutable);
    if (request.configuredMode === 'custom') {
      return this.#selectCustom(provider, persisted);
    }
    if (request.phase === 'resume') {
      return request.executablePolicy === 'managed'
        ? this.#resumeManaged(provider, persisted)
        : this.#resumeSystem(provider, persisted);
    }
    if (request.executablePolicy === 'managed') {
      return this.#freshManaged(provider);
    }
    return this.#validateSystem(
      program,
      exactPath(this.#ports.resolveSystemAcpExecutable(program, pathEnv)),
    );
  }

  #applyProviderLaunch(env: NodeJS.ProcessEnv, request: AgentEnvProjectionRequest): void {
    const provider = normalizeText(request.provider);
    if (!provider) return;
    const descriptor = this.#providerDescriptors.get(provider);
    if (!descriptor) return;

    const providerHomePath = exactPath(request.providerHomePath);
    if (providerHomePath) env[descriptor.homeEnvKey] = providerHomePath;
    if (
      descriptor.bootstrapInstructionRuntimes.includes(request.runtime)
      && env.FARMING_STARTUP_PROMPT_FILE
    ) {
      Object.assign(
        env,
        this.#ports.appendBootstrapInstruction(env, env.FARMING_STARTUP_PROMPT_FILE),
      );
    }
    if (request.runtime === 'terminal' && descriptor.terminalNotificationProtocol) {
      env.OPENTUI_NOTIFICATION_PROTOCOL = descriptor.terminalNotificationProtocol;
    }
  }

  #selectCustom(provider: string, persisted: string): AgentLaunchExecutableDecision {
    if (!persisted) {
      return this.#reject('custom-not-configured', `${provider} custom ACP executable is not configured`);
    }
    if (!path.isAbsolute(persisted)) {
      return this.#reject('custom-not-absolute', `${provider} custom ACP executable must be an absolute path`);
    }
    if (!this.#ports.isExecutable(persisted)) {
      return this.#reject('custom-not-executable', `${provider} custom ACP executable is not executable: ${persisted}`);
    }
    return this.#select(persisted);
  }

  #freshManaged(provider: string): AgentLaunchExecutableDecision {
    const discovered = exactPath(this.#ports.resolveFarmingOwnedExecutable(provider));
    if (!discovered) {
      return this.#reject(
        'managed-unavailable',
        `${provider} ACP requires a Farming-owned executable, but none is available`,
      );
    }
    if (!path.isAbsolute(discovered)) {
      return this.#reject(
        'managed-not-absolute',
        `${provider} ACP Farming-owned executable must be an absolute path: ${discovered}`,
      );
    }
    if (!this.#ports.isExecutable(discovered)) {
      return this.#reject(
        'managed-not-executable',
        `${provider} ACP Farming-owned executable is not executable: ${discovered}`,
      );
    }
    // Ownership is proven for a fresh discovery too: the resolver reports a
    // candidate, it does not certify that the candidate is Farming-owned.
    if (!this.#ports.isFarmingOwnedExecutable(provider, discovered)) {
      return this.#reject(
        'managed-unowned',
        `${provider} ACP discovered executable is not Farming-owned: ${discovered}`,
      );
    }
    return this.#select(discovered);
  }

  #resumeManaged(provider: string, persisted: string): AgentLaunchExecutableDecision {
    if (!persisted) {
      return this.#reject(
        'persisted-managed-missing',
        `${provider} ACP resume requires the persisted Farming-owned executable, but none was recorded`,
      );
    }
    if (!path.isAbsolute(persisted)) {
      return this.#reject(
        'persisted-managed-not-absolute',
        `${provider} ACP persisted Farming-owned executable must be an absolute path: ${persisted}`,
      );
    }
    if (!this.#ports.isExecutable(persisted)) {
      return this.#reject(
        'persisted-managed-unusable',
        `${provider} ACP persisted Farming-owned executable is no longer usable: ${persisted}`,
      );
    }
    if (!this.#ports.isFarmingOwnedExecutable(provider, persisted)) {
      return this.#reject(
        'persisted-managed-unowned',
        `${provider} ACP persisted executable is not Farming-owned: ${persisted}`,
      );
    }
    return this.#select(persisted);
  }

  #resumeSystem(provider: string, persisted: string): AgentLaunchExecutableDecision {
    if (!persisted) {
      return this.#reject(
        'persisted-system-missing',
        `${provider} ACP resume requires the persisted system executable, but none was recorded`,
      );
    }
    if (!path.isAbsolute(persisted)) {
      return this.#reject(
        'persisted-system-not-absolute',
        `${provider} ACP persisted system executable must be an absolute path: ${persisted}`,
      );
    }
    if (!this.#ports.isExecutable(persisted)) {
      return this.#reject(
        'persisted-system-unusable',
        `${provider} ACP persisted system executable is no longer usable: ${persisted}`,
      );
    }
    return this.#select(persisted);
  }

  #selectVersionedTerminal(
    program: string,
    requiredCliVersion: string,
    pathEnv: string,
  ): AgentLaunchExecutableDecision {
    const resolution = this.#ports.resolveTerminalExecutableVersion(program, requiredCliVersion, pathEnv);
    if (!resolution || resolution.compatible !== true) {
      return this.#reject(
        'terminal-version-incompatible',
        normalizeText(resolution?.error)
          || `Executable "${program}" does not satisfy the required version ${requiredCliVersion}`,
      );
    }
    return this.#validateSystem(program, exactPath(resolution.path));
  }

  #validateSystem(program: string, executable: string): AgentLaunchExecutableDecision {
    if (!executable) {
      return this.#reject(
        'system-not-found',
        `Executable "${program}" was not found in the user shell PATH`,
      );
    }
    if (!path.isAbsolute(executable)) {
      return this.#reject(
        'system-not-absolute',
        `Executable "${program}" must resolve to an absolute path, but got: ${executable}`,
      );
    }
    if (!this.#ports.isExecutable(executable)) {
      return this.#reject(
        'system-not-executable',
        `Executable "${program}" resolved to a file that is not executable: ${executable}`,
      );
    }
    return this.#select(executable);
  }

  #shellEnvEntry(shellKey: string, options: ShellEnvResolveOptions): ShellEnvCacheEntry {
    const now = this.#ports.now();
    const hasMaxAge = typeof options.maxAgeMs === 'number' && Number.isFinite(options.maxAgeMs);
    const maxAgeMs = hasMaxAge
      ? Math.min(Math.max(0, options.maxAgeMs!), MAX_SHELL_ENV_CACHE_MS)
      : this.#config.shellEnvCacheMs!;
    const cached = this.#shellEnvCache.get(shellKey);
    // A clock that moved backward makes the recorded age unknown, so the entry
    // is stale rather than trusted for an unbounded time.
    const age = cached ? now - cached.resolvedAt : 0;
    if (
      options.force !== true
      && cached
      && age >= 0
      && ((!hasMaxAge && maxAgeMs === 0) || age < maxAgeMs)
    ) {
      return cached;
    }

    let shellEnv: NodeJS.ProcessEnv | null = null;
    try {
      shellEnv = this.#ports.resolveShellEnv(shellKey === DEFAULT_SHELL_ENV_KEY ? '' : shellKey) || null;
    } catch (error: unknown) {
      this.#ports.warn?.('Failed to resolve user shell environment for agent', error);
      shellEnv = null;
    }

    let entry: ShellEnvCacheEntry;
    if (shellEnv) {
      entry = {
        env: frozenEnv(shellEnv),
        processEnv: frozenEnv(this.#ports.processEnv()),
        resolvedAt: now,
        source: 'shell',
      };
    } else {
      // One frozen fallback snapshot is authoritative for every consumer while
      // this cache entry lives, so a later process-env mutation cannot make two
      // launches of the same shell disagree.
      const fallback = frozenEnv(this.#ports.processEnv());
      entry = { env: fallback, processEnv: fallback, resolvedAt: now, source: 'process-env' };
    }
    const frozenEntry = Object.freeze(entry);
    this.#shellEnvCache.set(shellKey, frozenEntry);
    return frozenEntry;
  }

  #controlAuthority(): NodeJS.ProcessEnv {
    const authority: NodeJS.ProcessEnv = {};
    if (this.#config.controlUrl) authority.FARMING_CONTROL_URL = this.#config.controlUrl;
    if (this.#config.tokenFile) authority.FARMING_TOKEN_FILE = this.#config.tokenFile;
    if (this.#config.authDisabled) authority.FARMING_DISABLE_AUTH = '1';
    if (this.#config.configDir) authority.FARMING_CONFIG_DIR = this.#config.configDir;
    if (this.#config.startupPromptFile) {
      authority.FARMING_STARTUP_PROMPT_FILE = this.#config.startupPromptFile;
    }
    return authority;
  }

  #select(executable: string): AgentLaunchExecutableDecision {
    return Object.freeze({ selected: true as const, executable });
  }

  #reject(reason: AgentLaunchExecutableRejection, message: string): AgentLaunchExecutableDecision {
    return Object.freeze({ selected: false as const, reason, message });
  }
}

export {
  AgentLaunchPolicy,
};
