#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_TIMEOUT_MS = 10_000;
const CODEX_RUNTIME_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
];

function requireExactVersion(value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must be an exact version, found ${JSON.stringify(value)}`);
  }
  return value;
}

export function readManagedReleaseDependencies(projectRoot) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const runtimeManifest = JSON.parse(fs.readFileSync(
    path.join(projectRoot, 'backend/data/runtime-dependency-manifest.json'),
    'utf8',
  ));
  const codexVersion = requireExactVersion(
    runtimeManifest.dependencies?.codex?.version,
    'managed Codex version',
  );
  const claudeVersion = requireExactVersion(
    runtimeManifest.dependencies?.claude?.version,
    'managed Claude Agent SDK version',
  );
  const claudeAdapterSdkVersion = requireExactVersion(
    packageLock.packages?.['node_modules/@agentclientprotocol/claude-agent-acp']
      ?.dependencies?.['@anthropic-ai/claude-agent-sdk'],
    'Claude ACP adapter SDK dependency',
  );

  if (packageJson.overrides?.['@openai/codex'] !== codexVersion) {
    throw new Error('package.json Codex override must match the managed runtime manifest');
  }
  if (claudeVersion !== claudeAdapterSdkVersion) {
    throw new Error('managed Claude Agent SDK version must match the exact Claude ACP adapter dependency');
  }

  return [
    {
      name: '@agentclientprotocol/codex-acp',
      current: requireExactVersion(
        packageJson.devDependencies?.['@agentclientprotocol/codex-acp'],
        'Codex ACP version',
      ),
      policy: 'latest',
    },
    {
      name: '@agentclientprotocol/claude-agent-acp',
      current: requireExactVersion(
        packageJson.devDependencies?.['@agentclientprotocol/claude-agent-acp'],
        'Claude ACP version',
      ),
      policy: 'codex-coupled',
    },
    {
      name: 'pi-acp',
      current: requireExactVersion(
        packageJson.devDependencies?.['pi-acp'],
        'Pi ACP version',
      ),
      policy: 'latest',
    },
    {
      name: '@agentclientprotocol/sdk',
      current: requireExactVersion(
        packageJson.dependencies?.['@agentclientprotocol/sdk'],
        'ACP SDK version',
      ),
      policy: 'latest',
    },
    {
      name: '@openai/codex',
      current: codexVersion,
      policy: 'latest',
      requiredPlatforms: CODEX_RUNTIME_PLATFORMS,
    },
    {
      name: '@anthropic-ai/claude-agent-sdk',
      current: claudeVersion,
      policy: 'adapter',
    },
  ];
}

async function fetchLatestVersion(dependency, { fetchImpl, registry, timeoutMs }) {
  const packagePath = encodeURIComponent(dependency.name);
  const url = new URL(`${packagePath}/latest`, registry);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`Failed to query ${dependency.name}: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status !== 200) {
    throw new Error(`Failed to query ${dependency.name}: registry returned HTTP ${response.status}`);
  }
  const metadata = await response.json();
  return requireExactVersion(metadata?.version, `${dependency.name} latest version`);
}

async function findMissingPlatformVersions(
  dependency,
  version,
  { fetchImpl, registry, timeoutMs },
) {
  if (!dependency.requiredPlatforms || dependency.current === version) return [];
  const packagePath = encodeURIComponent(dependency.name);
  const checks = await Promise.all(dependency.requiredPlatforms.map(async platform => {
    const platformVersion = `${version}-${platform}`;
    const url = new URL(`${packagePath}/${encodeURIComponent(platformVersion)}`, registry);
    let response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new Error(
        `Failed to query ${dependency.name}@${platformVersion}: `
        + `${error instanceof Error ? error.message : error}`,
      );
    }
    if (response.status === 404) return platform;
    if (response.status !== 200) {
      throw new Error(
        `Failed to query ${dependency.name}@${platformVersion}: `
        + `registry returned HTTP ${response.status}`,
      );
    }
    return null;
  }));
  return checks.filter(Boolean);
}

export async function inspectManagedReleaseDependencies(
  dependencies,
  {
    fetchImpl = globalThis.fetch,
    registry = DEFAULT_REGISTRY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('A Fetch implementation is required');
  const normalizedRegistry = registry.endsWith('/') ? registry : `${registry}/`;
  const results = await Promise.all(dependencies.map(async dependency => {
    const latest = await fetchLatestVersion(dependency, {
      fetchImpl,
      registry: normalizedRegistry,
      timeoutMs,
    });
    const missingPlatforms = await findMissingPlatformVersions(dependency, latest, {
      fetchImpl,
      registry: normalizedRegistry,
      timeoutMs,
    });
    return { ...dependency, latest, missingPlatforms };
  }));
  const incomplete = results.filter(result => result.missingPlatforms.length > 0);
  const codexUpdateRequired = results.some(result => (
    result.name === '@agentclientprotocol/codex-acp' || result.name === '@openai/codex'
  ) && result.current !== result.latest && result.missingPlatforms.length === 0);
  return {
    results,
    mismatches: results.filter(result => (
      result.policy === 'latest'
      || (result.policy === 'codex-coupled' && codexUpdateRequired)
    ) && result.current !== result.latest && result.missingPlatforms.length === 0),
    reviews: results.filter(result => result.policy === 'adapter' && result.current !== result.latest),
    deferred: results.filter(result => (
      result.missingPlatforms.length > 0
      || (
        result.policy === 'codex-coupled'
        && !codexUpdateRequired
        && result.current !== result.latest
      )
    )),
    incomplete,
  };
}

function parseArguments(argumentsList) {
  let registry = DEFAULT_REGISTRY;
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] !== '--registry' || !argumentsList[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argumentsList[index] ?? ''}`);
    }
    registry = argumentsList[index + 1];
    index += 1;
  }
  return { registry };
}

async function main() {
  const { registry } = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dependencies = readManagedReleaseDependencies(projectRoot);
  const {
    results,
    mismatches,
    reviews,
    deferred,
    incomplete,
  } = await inspectManagedReleaseDependencies(dependencies, { registry });
  for (const result of results) {
    const marker = result.current === result.latest
      ? 'ok'
      : result.missingPlatforms.length > 0
        ? `deferred: incomplete platform publication missing=${result.missingPlatforms.join(',')}`
      : result.policy === 'adapter'
        ? 'adapter constrained'
        : deferred.includes(result)
          ? 'deferred until Codex update'
        : 'update available';
    console.log(`${marker}: ${result.name} current=${result.current} latest=${result.latest}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Release blocked: ${mismatches.length} managed Agent dependencies do not match npm latest. `
      + 'Review and update each pin, patch, hash, and affected acceptance evidence before releasing.',
    );
  }
  if (reviews.length > 0) {
    console.log(
      'Claude Agent SDK is intentionally constrained by the latest Claude ACP adapter; '
      + 'its standalone npm latest is informational until the adapter adopts it.',
    );
  }
  if (incomplete.length > 0) {
    console.log(
      'Codex runtime updates require every managed platform package; '
      + 'incomplete npm publications remain on the last complete version.',
    );
  }
  if (deferred.length > 0) {
    console.log(
      'Claude ACP updates are intentionally deferred until a managed Codex dependency also needs an update.',
    );
  }
  console.log('All managed Agent dependencies satisfy the release update policy.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
