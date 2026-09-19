#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import manifest from '../backend/data/runtime-dependency-manifest.json';
import { canonicalManagedRipgrepPlatform } from '../backend/ripgrep-runtime.cjs';
import { prepareRipgrepRuntimes } from './prepare-ripgrep-runtime';
import { verifyPackagedRuntimeIdentity } from '../backend/packaged-runtime-identity.cjs';

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'dist', 'runtime', 'agent-browser');
const ripgrepOutputRoot = path.join(projectRoot, 'dist', 'runtime', 'ripgrep');

function requestedPlatform(): string {
  const index = process.argv.indexOf('--platform');
  if (index < 0) return '';
  const value = String(process.argv[index + 1] || '').trim();
  if (!value || value.startsWith('-')) throw new Error('--platform requires a platform key');
  return value;
}

function safeRelative(value: string, label: string): string {
  const normalized = path.normalize(value);
  if (!value || path.isAbsolute(value) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`${label} must stay inside its package root: ${value}`);
  }
  return normalized;
}

async function main(): Promise<void> {
  const platform = requestedPlatform();
  const artifactRoot = process.env.FARMING_AGENT_BROWSER_ARTIFACTS;
  if (!artifactRoot) throw new Error('FARMING_AGENT_BROWSER_ARTIFACTS must point to the patched native build outputs; upstream npm binaries are not accepted');
  const farmingSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  if (platform && !(platform in manifest.dependencies.agentBrowser.artifacts)) {
    throw new Error(`Unknown agent-browser platform: ${platform}`);
  }
  // Validate the complete selection before replacing the previous package image.
  for (const [platformKey, artifact] of Object.entries(manifest.dependencies.agentBrowser.artifacts)) {
    if (platform && platformKey !== platform) continue;
    const identity = verifyPackagedRuntimeIdentity(path.resolve(artifactRoot, platformKey, artifact.entry), {
      version: manifest.dependencies.agentBrowser.version, platformKey, sourceId: artifact.packagedIdentity,
    });
    if (identity.farmingSha !== farmingSha) throw new Error(`agent-browser ${platformKey} was built for another Farming SHA`);
    if (!fs.statSync(path.resolve(artifactRoot, platformKey, 'LICENSE')).isFile()) {
      throw new Error(`agent-browser ${platformKey} omitted its license`);
    }
  }
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.rmSync(ripgrepOutputRoot, { recursive: true, force: true });
  for (const [platformKey, artifact] of Object.entries(manifest.dependencies.agentBrowser.artifacts)) {
    if (platform && platformKey !== platform) continue;
    if (!artifact.packagedIdentity || !artifact.packagedEntry) {
      throw new Error(`agent-browser ${platformKey} is missing packaged runtime metadata`);
    }
    const packagedEntry = safeRelative(artifact.packagedEntry, 'packaged entry');
    const source = path.resolve(artifactRoot, platformKey, artifact.entry);
    const destination = path.join(projectRoot, packagedEntry);
    if (!fs.statSync(source).isFile()) {
      throw new Error(`agent-browser ${platformKey} binary is missing: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    for (const name of ['identity.json', 'LICENSE', 'NOTICE']) {
      const companion = path.join(path.dirname(source), name);
      if (fs.existsSync(companion)) fs.copyFileSync(companion, path.join(path.dirname(destination), name));
    }
    if (!platformKey.startsWith('win32-')) fs.chmodSync(destination, 0o755);
    verifyPackagedRuntimeIdentity(destination, {
      version: manifest.dependencies.agentBrowser.version, platformKey, sourceId: artifact.packagedIdentity,
    });
  }
  await prepareRipgrepRuntimes(platform
    ? [canonicalManagedRipgrepPlatform(platform)]
    : ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
