#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import manifest from '../backend/data/runtime-dependency-manifest.json';
import { verifyPackagedRuntimeIdentity } from '../backend/packaged-runtime-identity.cjs';

// Source preparation owns a source/platform-keyed cache outside Vite's output.
// A private staging directory becomes reusable only after identity verification.
// Failed builds remove their own staging; concurrent publishers verify the winner.
// Release packaging retains its separate exact-Farming-SHA contract.
export async function prepareSourceBrowserRuntime(options: {
  projectRoot?: string;
  artifactRoot?: string;
  platformKey?: string;
  build?: (output: string, platformKey: string) => Promise<void>;
} = {}): Promise<string> {
  const root = options.projectRoot || path.resolve(__dirname, '..');
  const platformKey = options.platformKey || `${process.platform}-${process.arch}`;
  const dependency = manifest.dependencies.agentBrowser;
  const artifact = dependency.artifacts[platformKey as keyof typeof dependency.artifacts];
  if (!artifact) throw new Error(`No patched agent-browser runtime for ${platformKey}`);
  const expected = { version: dependency.version, platformKey, sourceId: artifact.packagedIdentity };
  const cacheRoot = path.join(root, 'node_modules', '.cache', 'farming', 'agent-browser', artifact.packagedIdentity);
  const cached = path.join(cacheRoot, platformKey);
  const verify = (directory: string): void => {
    verifyPackagedRuntimeIdentity(path.join(directory, artifact.entry), expected);
    if (!fs.statSync(path.join(directory, 'LICENSE')).isFile()) throw new Error('Patched runtime omitted LICENSE');
  };
  fs.mkdirSync(cacheRoot, { recursive: true });
  if (!fs.existsSync(cached)) {
    const staging = fs.mkdtempSync(path.join(cacheRoot, '.preparing-'));
    try {
      const output = path.join(staging, platformKey);
      const artifactRoot = options.artifactRoot || process.env.FARMING_AGENT_BROWSER_ARTIFACTS;
      if (artifactRoot) {
        const source = path.resolve(artifactRoot, platformKey);
        verify(source);
        fs.cpSync(source, output, { recursive: true });
      } else {
        console.log(`Building patched agent-browser ${dependency.version} for ${platformKey} (first preparation)`);
        const build = options.build || ((destination: string, platform: string) => new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [path.join(root, 'scripts', 'build-agent-browser-runtime.mjs'),
            '--platform', platform, '--output', destination], { cwd: root, stdio: 'inherit' });
          child.once('error', reject);
          child.once('exit', (code, signal) => code === 0 ? resolve()
            : reject(new Error(`Patched agent-browser build failed (${signal || code}); see build output above`)));
        }));
        await build(staging, platformKey);
      }
      verify(output);
      try {
        fs.renameSync(output, cached);
      } catch (error) {
        if (!fs.existsSync(cached)) throw error;
        verify(cached);
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  verify(cached);
  const destination = path.join(root, artifact.packagedEntry);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const name of [artifact.entry, 'identity.json', 'LICENSE', 'NOTICE']) {
    const source = path.join(cached, name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(path.dirname(destination), name));
  }
  verify(path.dirname(destination));
  console.log(`Patched agent-browser ${dependency.version} ready`);
  return destination;
}

if (require.main === module) {
  void prepareSourceBrowserRuntime().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
