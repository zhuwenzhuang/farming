#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const DEFAULT_TIMEOUT_MS = 10_000;

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
    { name: '@openai/codex', current: codexVersion, policy: 'latest' },
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
  if (!response.ok) {
    throw new Error(`Failed to query ${dependency.name}: registry returned HTTP ${response.status}`);
  }
  const metadata = await response.json();
  return requireExactVersion(metadata?.version, `${dependency.name} latest version`);
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
  const results = await Promise.all(dependencies.map(async dependency => ({
    ...dependency,
    latest: await fetchLatestVersion(dependency, {
      fetchImpl,
      registry: normalizedRegistry,
      timeoutMs,
    }),
  })));
  return {
    results,
    mismatches: results.filter(result => result.policy === 'latest' && result.current !== result.latest),
    reviews: results.filter(result => result.policy === 'adapter' && result.current !== result.latest),
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
  const { results, mismatches, reviews } = await inspectManagedReleaseDependencies(dependencies, { registry });
  for (const result of results) {
    const marker = result.current === result.latest
      ? 'ok'
      : result.policy === 'adapter'
        ? 'adapter constrained'
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
  console.log('All managed Agent dependencies match their npm latest versions.');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
