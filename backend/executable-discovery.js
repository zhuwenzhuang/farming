const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getUserLaunchAgents } = require('./cli-agents');

const DEFAULT_CODEX_APP_BIN = '/Applications/Codex.app/Contents/Resources/codex';
const executableVersionCache = new Map();

function getPathDirectories(pathEnv = process.env.PATH || '') {
  return String(pathEnv)
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseCliVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function compareCliVersions(left, right) {
  const leftParts = parseCliVersion(left).split('.').map(part => Number(part));
  const rightParts = parseCliVersion(right).split('.').map(part => Number(part));
  if (leftParts.length !== 3 || rightParts.length !== 3) return 0;

  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index];
    if (delta !== 0) return delta;
  }
  return 0;
}

function readExecutableCliVersion(filePath, runner = execFileSync) {
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

function getExecutableVersionCacheKey(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return `${filePath}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return `${filePath}:missing`;
  }
}

function readCachedExecutableCliVersion(filePath, readVersion, options = {}) {
  if (options.cacheVersions === false) {
    return readVersion(filePath);
  }

  const cacheToken = getExecutableVersionCacheKey(filePath);
  if (executableVersionCache.has(cacheToken)) {
    return executableVersionCache.get(cacheToken);
  }

  const version = readVersion(filePath);
  const prefix = `${filePath}:`;
  Array.from(executableVersionCache.keys())
    .filter(key => key.startsWith(prefix) && key !== cacheToken)
    .forEach(key => executableVersionCache.delete(key));
  executableVersionCache.set(cacheToken, version);
  return version;
}

function clearExecutableVersionCache() {
  executableVersionCache.clear();
}

function getPreferredExecutableCandidates(agentName, pathEnv = process.env.PATH || '') {
  const pathCandidates = getPathDirectories(pathEnv).map((dir) => path.join(dir, agentName));
  if (agentName !== 'codex') return pathCandidates;

  return [
    process.env.FARMING_CODEX_BIN || '',
    DEFAULT_CODEX_APP_BIN,
    ...pathCandidates,
  ].filter(Boolean);
}

function resolveAgentExecutable(agentName, pathEnv = process.env.PATH || '') {
  return getPreferredExecutableCandidates(agentName, pathEnv).find(isExecutable) || '';
}

function resolveCompatibleCodexExecutable(requiredVersion = '', pathEnv = process.env.PATH || '', options = {}) {
  const normalizedRequired = parseCliVersion(requiredVersion);
  const readVersion = typeof options.readVersion === 'function'
    ? options.readVersion
    : readExecutableCliVersion;
  const rawCandidates = Array.isArray(options.candidates)
    ? options.candidates
    : getPreferredExecutableCandidates('codex', pathEnv);
  const seen = new Set();
  const inspected = rawCandidates
    .filter(Boolean)
    .filter(candidate => {
      if (seen.has(candidate)) return false;
      seen.add(candidate);
      return true;
    })
    .filter(isExecutable)
    .map(candidate => ({
      path: candidate,
      version: readCachedExecutableCliVersion(candidate, readVersion, options),
    }));

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
    const selected = inspected[0];
    return {
      path: selected.path,
      version: selected.version,
      requiredVersion: '',
      compatible: true,
      error: '',
    };
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

function listAvailableAgents(pathEnv = process.env.PATH || '') {
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

module.exports = {
  getPathDirectories,
  getPreferredExecutableCandidates,
  compareCliVersions,
  clearExecutableVersionCache,
  isExecutable,
  listAvailableAgents,
  parseCliVersion,
  readExecutableCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable
};
