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

const DEFAULT_CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_CHATGPT_APP_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex';
const executableVersionCache = new Map<string, string>();

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
}

function dedupeExecutableCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const normalized = path.resolve(String(candidate || ''));
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function activeManagedExecutable(agentName: string, env: NodeJS.ProcessEnv): string {
  const configDir = String(env.FARMING_CONFIG_DIR || '').trim();
  if (!configDir) return '';
  try {
    const activePath = storageLayout.runtimeDependenciesActiveFile(configDir);
    const active = JSON.parse(fs.readFileSync(activePath, 'utf8')) as {
      dependencies?: Record<string, { source?: string; executablePath?: string }>;
    };
    const dependencyId = agentName === 'claude' ? 'claude' : agentName === 'codex' ? 'codex' : '';
    const dependency = dependencyId ? active.dependencies?.[dependencyId] : undefined;
    return dependency?.source === 'managed' && dependency.executablePath
      ? path.resolve(dependency.executablePath)
      : '';
  } catch {
    return '';
  }
}

function packageOwnedExecutableCandidates(agentName: string): string[] {
  const packageRoot = path.resolve(__dirname, '..');
  if (agentName === 'codex') {
    return [path.join(
      packageRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex.cmd' : 'codex',
    )];
  }
  if (agentName === 'claude') {
    return [path.join(
      packageRoot,
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'claude.exe' : 'claude',
    )];
  }
  return [];
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

function getFarmingOwnedExecutableCandidates(
  agentName: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configuredKey = agentName === 'codex'
    ? 'FARMING_CODEX_BIN'
    : agentName === 'claude'
      ? 'FARMING_CLAUDE_BIN'
      : '';
  const acpKey = agentName === 'codex'
    ? 'FARMING_ACP_CODEX_BIN'
    : agentName === 'claude'
      ? 'FARMING_ACP_CLAUDE_BIN'
      : '';
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
  const defaults = agentName === 'codex'
    ? [DEFAULT_CODEX_APP_BIN, DEFAULT_CHATGPT_APP_CODEX_BIN]
    : [];
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
    options.farmingCandidates || getFarmingOwnedExecutableCandidates(agentName),
    readVersion,
    options,
  );
  const system = inspectExecutableCandidates(
    options.systemCandidates || getSystemExecutableCandidates(agentName, pathEnv),
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
  if (agentName === 'claude') {
    return [
      process.env.FARMING_CLAUDE_BIN || '',
      process.env.CLAUDE_CODE_EXECUTABLE || '',
      ...pathCandidates,
    ].filter(Boolean);
  }
  if (agentName !== 'codex') return pathCandidates;

  return [
    process.env.FARMING_CODEX_BIN || '',
    DEFAULT_CODEX_APP_BIN,
    DEFAULT_CHATGPT_APP_CODEX_BIN,
    ...pathCandidates,
  ].filter(Boolean);
}

function resolveAgentExecutable(agentName: string, pathEnv = process.env.PATH || ''): string {
  return getPreferredExecutableCandidates(agentName, pathEnv).find(isExecutable) || '';
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
  listAvailableAgents,
  parseCliVersion,
  readExecutableCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable,
  resolveFarmingOwnedExecutable,
  resolveTerminalCodexExecutable,
  resolveTerminalExecutable,
};
