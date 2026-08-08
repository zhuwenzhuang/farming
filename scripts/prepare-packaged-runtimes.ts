#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';

import manifest from '../backend/data/runtime-dependency-manifest.json';

const projectRoot = path.resolve(__dirname, '..');
const agentBrowserRoot = path.dirname(require.resolve('agent-browser/package.json'));
const outputRoot = path.join(projectRoot, 'dist', 'runtime', 'agent-browser');

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

function main(): void {
  const platform = requestedPlatform();
  fs.rmSync(outputRoot, { recursive: true, force: true });
  for (const [platformKey, artifact] of Object.entries(manifest.dependencies.agentBrowser.artifacts)) {
    if (platform && platformKey !== platform) continue;
    if (!artifact.archiveEntry || !artifact.packagedEntry) {
      throw new Error(`agent-browser ${platformKey} is missing packaged runtime metadata`);
    }
    const sourceEntry = safeRelative(artifact.archiveEntry.replace(/^package\//, ''), 'archive entry');
    const packagedEntry = safeRelative(artifact.packagedEntry, 'packaged entry');
    const source = path.join(agentBrowserRoot, sourceEntry);
    const destination = path.join(projectRoot, packagedEntry);
    if (!fs.statSync(source).isFile()) {
      throw new Error(`agent-browser ${platformKey} binary is missing: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    if (!platformKey.startsWith('win32-')) fs.chmodSync(destination, 0o755);
  }
  if (platform && !(platform in manifest.dependencies.agentBrowser.artifacts)) {
    throw new Error(`Unknown agent-browser platform: ${platform}`);
  }
}

main();
