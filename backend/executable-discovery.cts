const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
import { getUserLaunchAgents } from './cli-agents.cjs';
import * as storageLayout from './storage-layout.cjs';

interface LaunchAgent {
  command?: string;
  name: string;
  [key: string]: unknown;
}

type ExecutableVersionReader = (filePath: string) => string;

type ExecutableRunner = (
  filePath: string,
  args: string[],
  options: {
    encoding: 'utf8';
    stdio: ['ignore', 'pipe', 'pipe'];
    timeout: number;
  },
) => string | Buffer;

interface ExecutableResolutionOptions {
  cacheVersions?: boolean;
  candidates?: string[];
  farmingCandidates?: string[];
  preferSystem?: boolean;
  readVersion?: ExecutableVersionReader;
  systemCandidates?: string[];
  trustConfiguredExecutable?: boolean;
  allowFakeAcpRuntime?: boolean;
}

interface CodexExecutableResolution {
  compatible: boolean;
  error: string;
  path: string;
  requiredVersion: string;
  version: string;
}

interface AvailableLaunchAgent extends LaunchAgent {
  available: true;
  resolvedPath: string;
}

interface TerminalExecutableResolution {
  path: string;
  source: 'farming' | 'system' | '';
  version: string;
}

interface PersistedAcpExecutableResolution {
  error: string;
  path: string;
}

const DEFAULT_CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_CHATGPT_APP_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';
const executableVersionCache = new Map<string, string>();
const executableIdentityCache = new Map<string, boolean>();

interface ExecutableIdentityProbe {
  args: string[];
  outputIncludes: string;
}

interface ExecutableDiscoveryDefinition {
  acpMinimumVersion?: string;
  acpEnvironmentKey?: string;
  configuredEnvironmentKey?: string;
  managedDependencyId?: string;
  packageCandidates?: () => string[];
  preferredEnvironmentKeys?: string[];
  identityProbe?: ExecutableIdentityProbe;
  systemCandidates?: string[];
  terminalSessionCompatibility?: 'codex-version';
}

const EXECUTABLE_DISCOVERY_DEFINITIONS: Record<string, ExecutableDiscoveryDefinition> = {
  codex: {
    acpEnvironmentKey: 'FARMING_ACP_CODEX_BIN',
    configuredEnvironmentKey: 'FARMING_CODEX_BIN',
    managedDependencyId: 'codex',
    packageCandidates: () => [path.join(
      path.resolve(__dirname, '..'),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex.cmd' : 'codex',
    )],
    preferredEnvironmentKeys: ['FARMING_CODEX_BIN'],
    systemCandidates: [DEFAULT_CODEX_APP_BIN, DEFAULT_CHATGPT_APP_CODEX_BIN],
    terminalSessionCompatibility: 'codex-version',
  },
  claude: {
    acpEnvironmentKey: 'FARMING_ACP_CLAUDE_BIN',
    configuredEnvironmentKey: 'FARMING_CLAUDE_BIN',
    managedDependencyId: 'claude',
    packageCandidates: () => [path.join(
      path.resolve(__dirname, '..'),
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    )],
    preferredEnvironmentKeys: ['FARMING_CLAUDE_BIN', 'CLAUDE_CODE_EXECUTABLE'],
  },
  pi: {
    acpMinimumVersion: '0.80.4',
    identityProbe: {
      args: ['--help'],
      outputIncludes: 'AI coding assistant with read, bash, edit, write tools',
    },
  },
};

function getPathDirectories(pathEnv = process.env.PATH || ''): string[] {
  return String(pathEnv)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseCliVersion(value: unknown): string {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function compareCliVersions(left: unknown, right: unknown): number {
  const leftParts = parseCliVersion(left).split('.').map(part => Number(part));
  const rightParts = parseCliVersion(right).split('.').map(part => Number(part));
  if (leftParts.length !== 3 || rightParts.length !== 3) return 0;

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function readExecutableCliVersion(
  filePath: string,
  runner: ExecutableRunner = execFileSync as unknown as ExecutableRunner,
): string {
  try {
    return parseCliVersion(runner(filePath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    }));
  } catch {
    return '';
  }
}

function getExecutableVersionCacheKey(filePath: string): string {
  try {
    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function readCachedExecutableCliVersion(
  filePath: string,
  readVersion: ExecutableVersionReader,
  options: ExecutableResolutionOptions = {},
): string {
  if (options.cacheVersions === false) {
    return readVersion(filePath);
  }

  const cacheToken = getExecutableVersionCacheKey(filePath);
  const cachedVersion = executableVersionCache.get(cacheToken);
  if (cachedVersion !== undefined) return cachedVersion;

  const version = readVersion(filePath);
  const prefix = `${filePath}:`;
  Array.from(executableVersionCache.keys())
    .filter(key => key.startsWith(prefix) && key !== cacheToken)
    .forEach(key => executableVersionCache.delete(key));
  executableVersionCache.set(cacheToken, version);
  return version;
}

function clearExecutableVersionCache(): void {
  executableVersionCache.clear();
  executableIdentityCache.clear();
}

function matchesExecutableIdentity(
  agentName: string,
  filePath: string,
  runner: ExecutableRunner = execFileSync as unknown as ExecutableRunner,
): boolean {
  const probe = EXECUTABLE_DISCOVERY_DEFINITIONS[agentName]?.identityProbe;
  if (!probe) return true;
  const cacheToken = `${getExecutableVersionCacheKey(filePath)}:${agentName}:identity`;
  const cached = executableIdentityCache.get(cacheToken);
  if (cached !== undefined) return cached;
  let matches = false;
  try {
    matches = String(runner(filePath, probe.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2000,
    })).includes(probe.outputIncludes);
  } catch {
    matches = false;
  }
  const prefix = `${filePath}:`;
  Array.from(executableIdentityCache.keys())
    .filter(key => key.startsWith(prefix) && key !== cacheToken)
    .forEach(key => executableIdentityCache.delete(key));
  executableIdentityCache.set(cacheToken, matches);
  return matches;
}

function dedupeExecutableCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    const configured = String(candidate || '').trim();
    if (!configured) return [];
    const absolute = path.resolve(configured);
    if (seen.has(absolute)) return [];
    seen.add(absolute);
    return [absolute];
  });
}

function activeManagedExecutable(agentName: string, env: NodeJS.ProcessEnv): string {
  const dependencyId = EXECUTABLE_DISCOVERY_DEFINITIONS[agentName]?.managedDependencyId;
  if (!dependencyId) return '';
  const configDir = String(env.FARMING_CONFIG_DIR || '').trim();
  if (!configDir) return '';
  try {
    const activePath = storageLayout.runtimeDependenciesActiveFile(configDir);
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8')) as {
      dependencies?: Record<string, { source?: string; executablePath?: string }>;
    };
    const dependency = active.dependencies?.[dependencyId];
    return dependency?.source === 'managed' && dependency.executablePath
      ? path.resolve(dependency.executablePath)
      : '';
  } catch {
    return '';
  }
}

function packageOwnedExecutableCandidates(agentName: string): string[] {
  return EXECUTABLE_DISCOVERY_DEFINITIONS[agentName]?.packageCandidates?.() || [];
}

function isFarmingOwnedPath(candidate: string, env: NodeJS.ProcessEnv): boolean {
  const resolved = path.resolve(candidate);
  const packageNodeModules = path.resolve(__dirname, '..', 'node_modules');
  if (resolved === packageNodeModules || resolved.startsWith(`${packageNodeModules}${path.sep}`)) {
    return true;
  }
  const configDir = String(env.FARMING_CONFIG_DIR || '').trim();
  if (configDir) {
    const runtimeRoot = path.resolve(configDir, 'runtimes');
    if (resolved === runtimeRoot || resolved.startsWith(`${runtimeRoot}${path.sep}`)) return true;
  }
  const seedDir = String(env.FARMING_RUNTIME_SEED_DIR || '').trim();
  if (seedDir) {
    const seedRoot = path.resolve(seedDir);
    if (resolved === seedRoot || resolved.startsWith(`${seedRoot}${path.sep}`)) return true;
  }
  return false;
}

function validatePersistedAcpExecutable(
  provider: string,
  candidate: unknown,
  options: {
    cacheVersions?: boolean;
    environment?: NodeJS.ProcessEnv;
    readVersion?: ExecutableVersionReader;
    requireFarmingOwned?: boolean;
  } = {},
): PersistedAcpExecutableResolution {
  const executable = typeof candidate === 'string' ? candidate : '';
  if (!executable) {
    return {
      error: `${provider} ACP resume requires its persisted executable, but none was recorded`,
      path: '',
    };
  }
  if (!path.isAbsolute(executable)) {
    return {
      error: `${provider} ACP persisted executable must be an absolute path: ${executable}`,
      path: '',
    };
  }
  if (!isExecutable(executable)) {
    return {
      error: `${provider} ACP persisted executable is no longer usable: ${executable}`,
      path: '',
    };
  }
  if (!matchesExecutableIdentity(provider, executable)) {
    return {
      error: `${provider} ACP persisted executable no longer identifies as ${provider}: ${executable}`,
      path: '',
    };
  }
  const minimumVersion = EXECUTABLE_DISCOVERY_DEFINITIONS[provider]?.acpMinimumVersion || '';
  if (minimumVersion) {
    const readVersion = options.readVersion || readExecutableCliVersion;
    const version = readCachedExecutableCliVersion(executable, readVersion, options);
    if (!version || compareCliVersions(version, minimumVersion) < 0) {
      return {
        error: version
          ? `${provider} ACP requires ${provider} CLI ${minimumVersion} or newer, but the persisted executable is ${version}: ${executable}`
          : `${provider} ACP requires ${provider} CLI ${minimumVersion} or newer, but the persisted executable version could not be verified: ${executable}`,
        path: '',
      };
    }
  }
  if (
    options.requireFarmingOwned === true
    && !isFarmingOwnedPath(executable, options.environment || process.env)
  ) {
    return {
      error: `${provider} ACP persisted executable is not Farming-owned: ${executable}`,
      path: '',
    };
  }
  return { error: '', path: executable };
}

function getFarmingOwnedExecutableCandidates(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const definition = EXECUTABLE_DISCOVERY_DEFINITIONS[agentName];
  const configuredKey = definition?.configuredEnvironmentKey || '';
  const acpKey = definition?.acpEnvironmentKey || '';
  const explicitAcp = acpKey ? String(env[acpKey] || '').trim() : '';
  const configured = configuredKey ? String(env[configuredKey] || '').trim() : '';
  return dedupeExecutableCandidates([
    ...(explicitAcp ? [explicitAcp] : []),
    activeManagedExecutable(agentName, env),
    ...packageOwnedExecutableCandidates(agentName),
    ...(configured && isFarmingOwnedPath(configured, env) ? [configured] : []),
  ]);
}

function getSystemExecutableCandidates(
  agentName: string,
  pathEnv = process.env.PATH || '',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const owned = new Set(getFarmingOwnedExecutableCandidates(agentName, env).map(candidate => path.resolve(candidate)));
  const defaults = EXECUTABLE_DISCOVERY_DEFINITIONS[agentName]?.systemCandidates || [];
  return dedupeExecutableCandidates([
    ...defaults,
    ...getPathDirectories(pathEnv).map(dir => path.join(dir, agentName)),
  ]).filter(candidate => !owned.has(path.resolve(candidate)));
}

function inspectExecutableCandidates(
  candidates: string[],
  readVersion: ExecutableVersionReader,
  options: ExecutableResolutionOptions = {},
): Array<{ path: string; version: string }> {
  return dedupeExecutableCandidates(candidates)
    .filter(isExecutable)
    .map(candidate => ({
      path: candidate,
      version: readCachedExecutableCliVersion(candidate, readVersion, options),
    }));
}

function newestKnownExecutable(
  candidates: Array<{ path: string; version: string }>,
): { path: string; version: string } | null {
  return candidates
    .filter(candidate => Boolean(candidate.version))
    .sort((left, right) => compareCliVersions(right.version, left.version))[0] || null;
}

function resolveFarmingOwnedExecutable(
  agentName: string,
  options: ExecutableResolutionOptions = {},
): string {
  const candidates = options.farmingCandidates || getFarmingOwnedExecutableCandidates(agentName);
  return dedupeExecutableCandidates(candidates).find(isExecutable) || '';
}

function resolveTerminalExecutable(
  agentName: string,
  pathEnv = process.env.PATH || '',
  options: ExecutableResolutionOptions = {},
): TerminalExecutableResolution {
  const readVersion = typeof options.readVersion === 'function'
    ? options.readVersion
    : readExecutableCliVersion;
  const farming = inspectExecutableCandidates(
    (options.farmingCandidates || getFarmingOwnedExecutableCandidates(agentName))
      .filter(candidate => matchesExecutableIdentity(agentName, candidate)),
    readVersion,
    options,
  );
  const system = inspectExecutableCandidates(
    (options.systemCandidates || getSystemExecutableCandidates(agentName, pathEnv))
      .filter(candidate => matchesExecutableIdentity(agentName, candidate)),
    readVersion,
    options,
  );
  if (system.length > 0) {
    const newestSystem = newestKnownExecutable(system);
    const newestFarming = newestKnownExecutable(farming);
    if (
      newestFarming
      && newestSystem
      && compareCliVersions(newestFarming.version, newestSystem.version) > 0
    ) {
      return { ...newestFarming, source: 'farming' };
    }
    return { ...(newestSystem || system[0]), source: 'system' };
  }
  if (farming.length > 0) {
    return { ...(newestKnownExecutable(farming) || farming[0]), source: 'farming' };
  }
  return { path: '', source: '', version: '' };
}

function getPreferredExecutableCandidates(
  agentName: string,
  pathEnv = process.env.PATH || '',
): string[] {
  const pathCandidates = getPathDirectories(pathEnv).map((dir) => path.join(dir, agentName));
  const definition = EXECUTABLE_DISCOVERY_DEFINITIONS[agentName];
  return [
    ...(definition?.preferredEnvironmentKeys || []).map(key => process.env[key] || ''),
    ...(definition?.systemCandidates || []),
    ...pathCandidates,
  ].filter(Boolean);
}

function resolveAgentExecutable(agentName: string, pathEnv = process.env.PATH || ''): string {
  return dedupeExecutableCandidates(getPreferredExecutableCandidates(agentName, pathEnv))
    .find(candidate => isExecutable(candidate) && matchesExecutableIdentity(agentName, candidate)) || '';
}

function resolveProviderAcpExecutable(
  agentName: string,
  pathEnv = process.env.PATH || '',
  options: ExecutableResolutionOptions = {},
): CodexExecutableResolution {
  const configuredAgentName = String(agentName || '').trim();
  const normalizedAgentName = path.basename(configuredAgentName);
  const definition = EXECUTABLE_DISCOVERY_DEFINITIONS[normalizedAgentName];
  // Deterministic fake-ACP E2E spawn path: the fake ACP runtime is a fixture,
  // so its executable resolution must not require a real provider binary.
  // This option is set only by the fake-ACP spawn call site, never by custom
  // absolute-executable or production paths.
  if (options.allowFakeAcpRuntime === true) {
    return {
      compatible: true,
      error: '',
      path: configuredAgentName || normalizedAgentName,
      requiredVersion: definition?.acpMinimumVersion || '',
      version: '',
    };
  }
  const candidates = options.candidates
    || (path.isAbsolute(configuredAgentName)
      ? [configuredAgentName]
      : getPreferredExecutableCandidates(normalizedAgentName, pathEnv));
  const explicitAbsoluteCandidate = candidates.length === 1
    ? path.resolve(candidates[0])
    : '';
  const executable = dedupeExecutableCandidates(candidates)
    .find(candidate => (
      isExecutable(candidate)
      && matchesExecutableIdentity(normalizedAgentName, candidate)
    )) || '';
  const minimumVersion = definition?.acpMinimumVersion || '';
  if (!minimumVersion) {
    return {
      compatible: true,
      error: '',
      path: executable,
      requiredVersion: minimumVersion,
      version: '',
    };
  }
  if (!executable) {
    const displayName = normalizedAgentName === 'pi' ? 'Pi' : normalizedAgentName;
    const explicitIsExecutable = explicitAbsoluteCandidate
      ? isExecutable(explicitAbsoluteCandidate)
      : false;
    return {
      compatible: false,
      error: explicitAbsoluteCandidate
        ? (explicitIsExecutable
          ? `${displayName} Chat executable is not a recognized ${displayName} CLI: ${explicitAbsoluteCandidate}. Select the real ${displayName} executable.`
          : `${displayName} Chat executable is missing or not executable: ${explicitAbsoluteCandidate}. Install ${displayName} or select an executable file.`)
        : `${displayName} Chat requires a verified ${displayName} CLI ${minimumVersion} or newer in the user shell PATH. Install or update ${displayName}, then refresh the Agent list.`,
      path: '',
      requiredVersion: minimumVersion,
      version: '',
    };
  }
  const readVersion = options.readVersion || readExecutableCliVersion;
  const version = readCachedExecutableCliVersion(executable, readVersion, options);
  if (!version || compareCliVersions(version, minimumVersion) < 0) {
    const displayName = normalizedAgentName === 'pi' ? 'Pi' : normalizedAgentName;
    return {
      compatible: false,
      error: version
        ? `${displayName} Chat requires ${displayName} CLI ${minimumVersion} or newer, but found ${version}. Update ${displayName}, then refresh the Agent list.`
        : `${displayName} Chat requires ${displayName} CLI ${minimumVersion} or newer, but its version could not be verified. Update ${displayName}, then refresh the Agent list.`,
      path: executable,
      requiredVersion: minimumVersion,
      version,
    };
  }
  return {
    compatible: true,
    error: '',
    path: executable,
    requiredVersion: minimumVersion,
    version,
  };
}

function resolveCompatibleCodexExecutable(
  requiredVersion = '',
  pathEnv = process.env.PATH || '',
  options: ExecutableResolutionOptions = {},
): CodexExecutableResolution {
  const normalizedRequired = parseCliVersion(requiredVersion);
  const readVersion = typeof options.readVersion === 'function'
    ? options.readVersion
    : readExecutableCliVersion;
  const groups = options.preferSystem
    ? [
        {
          source: 'system' as const,
          candidates: options.systemCandidates || getSystemExecutableCandidates('codex', pathEnv),
        },
        {
          source: 'farming' as const,
          candidates: options.farmingCandidates || getFarmingOwnedExecutableCandidates('codex'),
        },
      ]
    : [{
        source: 'legacy' as const,
        candidates: Array.isArray(options.candidates)
          ? options.candidates
          : getPreferredExecutableCandidates('codex', pathEnv),
      }];
  const inspectedBySource = groups.map(group => ({
    source: group.source,
    candidates: inspectExecutableCandidates(group.candidates, readVersion, options),
  }));
  const inspected = inspectedBySource.flatMap(group => group.candidates);

  if (inspected.length === 0) {
    return {
      path: '',
      version: '',
      requiredVersion: normalizedRequired,
      compatible: false,
      error: 'Codex executable not found',
    };
  }

  if (!normalizedRequired) {
    if (options.preferSystem) {
      const system = inspectedBySource.find(group => group.source === 'system')?.candidates || [];
      const farming = inspectedBySource.find(group => group.source === 'farming')?.candidates || [];
      const newestSystem = newestKnownExecutable(system);
      const newestFarming = newestKnownExecutable(farming);
      if (
        newestFarming
        && newestSystem
        && compareCliVersions(newestFarming.version, newestSystem.version) > 0
      ) {
        return {
          path: newestFarming.path,
          version: newestFarming.version,
          requiredVersion: '',
          compatible: true,
          error: '',
        };
      }
      const selected = newestSystem || system[0] || newestFarming || farming[0];
      if (selected) {
        return {
          path: selected.path,
          version: selected.version,
          requiredVersion: '',
          compatible: true,
          error: '',
        };
      }
    }
    const selected = inspected[0];
    return {
      path: selected.path,
      version: selected.version,
      requiredVersion: '',
      compatible: true,
      error: '',
    };
  }

  if (options.preferSystem) {
    const system = inspectedBySource.find(group => group.source === 'system')?.candidates || [];
    const farming = inspectedBySource.find(group => group.source === 'farming')?.candidates || [];
    const compatibleSystem = newestKnownExecutable(system.filter(candidate => (
      candidate.version && compareCliVersions(candidate.version, normalizedRequired) >= 0
    )));
    const compatibleFarming = newestKnownExecutable(farming.filter(candidate => (
      candidate.version && compareCliVersions(candidate.version, normalizedRequired) >= 0
    )));
    if (
      compatibleFarming
      && compatibleSystem
      && compareCliVersions(compatibleFarming.version, compatibleSystem.version) > 0
    ) {
      return {
        path: compatibleFarming.path,
        version: compatibleFarming.version,
        requiredVersion: normalizedRequired,
        compatible: true,
        error: '',
      };
    }
    if (compatibleSystem || compatibleFarming) {
      const selected = compatibleSystem || compatibleFarming;
      return {
        path: selected!.path,
        version: selected!.version,
        requiredVersion: normalizedRequired,
        compatible: true,
        error: '',
      };
    }
    const unknownSystem = system.find(candidate => !candidate.version);
    const unknownFarming = farming.find(candidate => !candidate.version);
    const unknown = unknownSystem || unknownFarming;
    if (unknown) {
      return {
        path: unknown.path,
        version: '',
        requiredVersion: normalizedRequired,
        compatible: true,
        error: '',
      };
    }
  }

  const compatibleKnown = inspected.find(candidate => (
    candidate.version && compareCliVersions(candidate.version, normalizedRequired) >= 0
  ));
  if (compatibleKnown) {
    return {
      path: compatibleKnown.path,
      version: compatibleKnown.version,
      requiredVersion: normalizedRequired,
      compatible: true,
      error: '',
    };
  }

  const unknownVersion = inspected.find(candidate => !candidate.version);
  if (unknownVersion) {
    return {
      path: unknownVersion.path,
      version: '',
      requiredVersion: normalizedRequired,
      compatible: true,
      error: '',
    };
  }

  const newestKnown = inspected
    .filter(candidate => candidate.version)
    .sort((left, right) => compareCliVersions(right.version, left.version))[0];
  const newestVersion = newestKnown ? newestKnown.version : '';
  return {
    path: newestKnown ? newestKnown.path : inspected[0].path,
    version: newestVersion,
    requiredVersion: normalizedRequired,
    compatible: false,
    error: newestVersion
      ? `Codex CLI ${newestVersion} is older than this session (${normalizedRequired}). Update Codex or set FARMING_CODEX_BIN to a newer Codex executable.`
      : `Codex CLI version could not be verified for session ${normalizedRequired}. Update Codex or set FARMING_CODEX_BIN to a newer Codex executable.`,
  };
}

function resolveTerminalCodexExecutable(
  requiredVersion = '',
  pathEnv = process.env.PATH || '',
  options: ExecutableResolutionOptions = {},
): CodexExecutableResolution {
  return resolveCompatibleCodexExecutable(requiredVersion, pathEnv, {
    ...options,
    preferSystem: true,
  });
}

function resolveProviderTerminalExecutable(
  agentName: string,
  requiredVersion = '',
  pathEnv = process.env.PATH || '',
  options: ExecutableResolutionOptions = {},
): CodexExecutableResolution {
  const normalizedAgentName = path.basename(String(agentName || '').trim());
  const definition = EXECUTABLE_DISCOVERY_DEFINITIONS[normalizedAgentName];
  const configuredExecutable = definition?.configuredEnvironmentKey
    ? process.env[definition.configuredEnvironmentKey] || ''
    : '';
  if (options.trustConfiguredExecutable === true && configuredExecutable) {
    return {
      compatible: true,
      error: '',
      path: configuredExecutable,
      requiredVersion: String(requiredVersion || '').trim(),
      version: '',
    };
  }
  if (definition?.terminalSessionCompatibility === 'codex-version') {
    return resolveTerminalCodexExecutable(requiredVersion, pathEnv, options);
  }
  const resolved = resolveTerminalExecutable(normalizedAgentName, pathEnv, options);
  return {
    ...resolved,
    compatible: true,
    error: '',
    requiredVersion: '',
  };
}

function listAvailableAgents(pathEnv = process.env.PATH || ''): AvailableLaunchAgent[] {
  return getUserLaunchAgents()
    .map((agent) => ({
      ...agent,
      resolvedPath: resolveAgentExecutable(agent.command || agent.name, pathEnv),
    }))
    .filter((agent) => Boolean(agent.resolvedPath))
    .map((agent) => ({
      ...agent,
      available: true
    }));
}

export {
  getPathDirectories,
  getFarmingOwnedExecutableCandidates,
  getSystemExecutableCandidates,
  getPreferredExecutableCandidates,
  compareCliVersions,
  clearExecutableVersionCache,
  isExecutable,
  matchesExecutableIdentity,
  listAvailableAgents,
  parseCliVersion,
  readExecutableCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable,
  resolveFarmingOwnedExecutable,
  resolveProviderAcpExecutable,
  resolveTerminalCodexExecutable,
  resolveProviderTerminalExecutable,
  resolveTerminalExecutable,
  validatePersistedAcpExecutable,
};
