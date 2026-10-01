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

export async function createManagedReleaseUpgradePlan(report, {
  fetchImpl = globalThis.fetch, registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS, projectRoot,
} = {}) {
  const current = new Map(report.results.map(result => [result.name, result.current]));
  const targets = new Map(report.mismatches.map(result => [result.name, result.latest]));
  const edits = [];
  const set = (section, name, version) => edits.push({ section, name, version });
  for (const [name, version] of targets) {
    if (name === '@openai/codex') {
      set('overrides', name, version);
      for (const platform of CODEX_RUNTIME_PLATFORMS) {
        set('optionalDependencies', `${name}-${platform}`, `npm:${name}@${version}-${platform}`);
      }
    } else {
      set(name === '@agentclientprotocol/sdk' ? 'dependencies' : 'devDependencies', name, version);
    }
  }
  if (targets.has('@agentclientprotocol/claude-agent-acp')) {
    const adapter = '@agentclientprotocol/claude-agent-acp';
    const base = registry.endsWith('/') ? registry : `${registry}/`;
    const response = await fetchImpl(new URL(`${encodeURIComponent(adapter)}/${encodeURIComponent(targets.get(adapter))}`, base), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) throw new Error(`Failed to read the selected Claude adapter: HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.name !== adapter || metadata.version !== targets.get(adapter)) throw new Error('Claude upgrade metadata identity mismatch');
    const sdk = requireExactVersion(metadata.dependencies?.['@anthropic-ai/claude-agent-sdk'], 'selected Claude adapter SDK');
    if (sdk !== current.get('@anthropic-ai/claude-agent-sdk')) {
      for (const platform of [...CODEX_RUNTIME_PLATFORMS, 'linux-arm64-musl', 'linux-x64-musl']) {
        set('optionalDependencies', `@anthropic-ai/claude-agent-sdk-${platform}`, sdk);
      }
    }
  }
  return {
    schemaVersion: 1, observedAt: new Date().toISOString(),
    status: edits.length ? 'upgrade-required' : 'current',
    targets: report.mismatches.map(({ name, current: from, latest: to }) => ({ name, from, to })),
    edits,
    deferred: report.deferred.map(({ name, current: version, latest, missingPlatforms }) => ({ name, version, latest, missingPlatforms })),
    reviewedVendors: report.mismatches.filter(result => result.name.endsWith('-acp')).map(result => ({
      package: result.name,
      source: result.name === 'pi-acp' ? 'scripts/prepare-pi-acp-vendor.ts'
        : result.name.includes('codex') ? 'scripts/prepare-codex-acp-vendor.ts' : 'scripts/prepare-claude-acp-vendor.ts',
      acceptance: 'Review upstream changes and retained patches before updating version or integrity pins; do not accept regenerated bytes by hash alone.',
    })),
    references: projectRoot ? findManagedUpgradeReferences(projectRoot, report.mismatches) : [],
    adapterConstraints: report.reviews.map(({ name, current: version, latest }) => ({ name, version, latest })),
    commands: edits.length ? [
      'npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/ --no-audit --no-fund',
      'npm ci --registry=https://registry.npmjs.org/ --no-audit --no-fund',
      'npm run prepare:acp-vendor',
      'npm run prepare:runtime-manifest',
      'npm run release:fast-screen',
      'npm run test:pre-release:codex-ui',
    ] : [],
    next: edits.length ? 'Apply all manifest edits together, resolve the lock once, review changed vendors, then run focused compatibility checks before the final candidate push.'
      : 'No upgrade required by release policy; standalone Claude SDK latest does not override its adapter constraint.',
  };
}

export function findManagedUpgradeReferences(projectRoot, mismatches) {
  if (!mismatches.length) return [];
  const references = [];
  const folders = ['backend', 'scripts', 'tests'].map(folder => path.join(projectRoot, folder));
  while (folders.length) {
    const folder = folders.pop();
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '.tmp', 'vendor'].includes(entry.name)) folders.push(file);
      } else if (entry.isFile() && /\.(?:cts|ts|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')
        && fs.statSync(file).size <= 1024 * 1024) {
        const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
        for (const mismatch of mismatches) {
          const version = mismatch.current.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`(?<![\\w.])${version}(?![\\w]|\\.\\d)`);
          lines.forEach((line, index) => {
            if (pattern.test(line)) references.push({ name: mismatch.name, version: mismatch.current,
              file: path.relative(projectRoot, file).split(path.sep).join('/'), line: index + 1 });
          });
        }
      }
    }
  }
  return references.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.name.localeCompare(right.name));
}

function parseArguments(argumentsList) {
  let registry = DEFAULT_REGISTRY;
  let planPath;
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (!['--registry', '--plan'].includes(argumentsList[index]) || !argumentsList[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${argumentsList[index] ?? ''}`);
    }
    if (argumentsList[index] === '--registry') registry = argumentsList[index + 1];
    else planPath = argumentsList[index + 1];
    index += 1;
  }
  return { registry, planPath };
}

async function main() {
  const { registry, planPath } = parseArguments(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dependencies = readManagedReleaseDependencies(projectRoot);
  const report = await inspectManagedReleaseDependencies(dependencies, { registry });
  if (planPath) {
    const plan = await createManagedReleaseUpgradePlan(report, { registry, projectRoot });
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    console.log('Exact managed upgrade plan written.');
  }
  const {
    results,
    mismatches,
    reviews,
    deferred,
    incomplete,
  } = report;
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
