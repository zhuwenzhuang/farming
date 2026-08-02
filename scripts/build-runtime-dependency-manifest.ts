#!/usr/bin/env -S npx tsx

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface PackageLockRecord {
  version?: string;
  resolved?: string;
  integrity?: string;
}

interface PackageLock {
  packages?: Record<string, PackageLockRecord>;
}

interface PlatformTarget {
  codexPackage: string;
  codexTarget: string;
  claudePackage: string;
}

interface RuntimeArtifact {
  url: string;
  integrity: string;
  archive: 'tgz';
  archivePrefix?: string;
  archiveEntry?: string;
  entry: string;
}

interface RuntimeDependency {
  version: string;
  reportedVersion?: string;
  managedProbe?: boolean;
  probe: { args: string[] };
  artifacts: Record<string, RuntimeArtifact>;
}

export interface RuntimeDependencyManifest {
  schemaVersion: 1;
  dependencies: {
    codex: RuntimeDependency;
    claude: RuntimeDependency;
    agentBrowser: RuntimeDependency;
  };
  manifestId: string;
}

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(
  fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'),
) as PackageLock;
const packages = lock.packages || {};

const CODEX_VERSION = '0.145.0';
const CLAUDE_VERSION = '0.3.207';
const AGENT_BROWSER_VERSION = '0.32.3';

const PLATFORM_TARGETS: Record<string, PlatformTarget> = {
  'darwin-arm64': {
    codexPackage: '@openai/codex-darwin-arm64',
    codexTarget: 'aarch64-apple-darwin',
    claudePackage: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  },
  'darwin-x64': {
    codexPackage: '@openai/codex-darwin-x64',
    codexTarget: 'x86_64-apple-darwin',
    claudePackage: '@anthropic-ai/claude-agent-sdk-darwin-x64',
  },
  'linux-arm64': {
    codexPackage: '@openai/codex-linux-arm64',
    codexTarget: 'aarch64-unknown-linux-musl',
    claudePackage: '@anthropic-ai/claude-agent-sdk-linux-arm64',
  },
  'linux-arm64-musl': {
    codexPackage: '@openai/codex-linux-arm64',
    codexTarget: 'aarch64-unknown-linux-musl',
    claudePackage: '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
  },
  'linux-x64': {
    codexPackage: '@openai/codex-linux-x64',
    codexTarget: 'x86_64-unknown-linux-musl',
    claudePackage: '@anthropic-ai/claude-agent-sdk-linux-x64',
  },
  'linux-x64-musl': {
    codexPackage: '@openai/codex-linux-x64',
    codexTarget: 'x86_64-unknown-linux-musl',
    claudePackage: '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  },
  'win32-arm64': {
    codexPackage: '@openai/codex-win32-arm64',
    codexTarget: 'aarch64-pc-windows-msvc',
    claudePackage: '@anthropic-ai/claude-agent-sdk-win32-arm64',
  },
  'win32-x64': {
    codexPackage: '@openai/codex-win32-x64',
    codexTarget: 'x86_64-pc-windows-msvc',
    claudePackage: '@anthropic-ai/claude-agent-sdk-win32-x64',
  },
};

const AGENT_BROWSER_ENTRIES: Record<string, string> = {
  'darwin-arm64': 'agent-browser-darwin-arm64',
  'darwin-x64': 'agent-browser-darwin-x64',
  'linux-arm64': 'agent-browser-linux-arm64',
  'linux-arm64-musl': 'agent-browser-linux-musl-arm64',
  'linux-x64': 'agent-browser-linux-x64',
  'linux-x64-musl': 'agent-browser-linux-musl-x64',
  'win32-x64': 'agent-browser-win32-x64.exe',
};

function packageRecord(packageName: string, version: string): Required<PackageLockRecord> {
  const record = packages[`node_modules/${packageName}`];
  if (!record || record.version !== version || !record.resolved || !record.integrity) {
    throw new Error(`package-lock.json does not pin ${packageName} ${version}`);
  }
  if (!record.resolved.startsWith('https://registry.npmjs.org/')) {
    throw new Error(`${packageName} ${version} must resolve from the public npm registry`);
  }
  return record as Required<PackageLockRecord>;
}

function npmArtifact(
  packageName: string,
  version: string,
  entry: string,
  archivePrefix = '',
  archiveEntry = '',
): RuntimeArtifact {
  const record = packageRecord(packageName, version);
  return {
    url: record.resolved,
    integrity: record.integrity,
    archive: 'tgz',
    ...(archivePrefix ? { archivePrefix } : {}),
    ...(archiveEntry ? { archiveEntry } : {}),
    entry,
  };
}

export function buildManifest(): RuntimeDependencyManifest {
  const codexArtifacts: Record<string, RuntimeArtifact> = {};
  const claudeArtifacts: Record<string, RuntimeArtifact> = {};
  for (const [platformKey, target] of Object.entries(PLATFORM_TARGETS)) {
    const windows = platformKey.startsWith('win32-');
    codexArtifacts[platformKey] = npmArtifact(
      target.codexPackage,
      `${CODEX_VERSION}-${platformKey.replace('win32', 'win32').replace('-musl', '')}`,
      `bin/codex${windows ? '.exe' : ''}`,
      `package/vendor/${target.codexTarget}`,
    );
    claudeArtifacts[platformKey] = npmArtifact(
      target.claudePackage,
      CLAUDE_VERSION,
      `claude${windows ? '.exe' : ''}`,
      'package',
    );
  }
  const agentBrowserArtifacts: Record<string, RuntimeArtifact> = {};
  for (const [platformKey, archiveFilename] of Object.entries(AGENT_BROWSER_ENTRIES)) {
    agentBrowserArtifacts[platformKey] = npmArtifact(
      'agent-browser',
      AGENT_BROWSER_VERSION,
      platformKey.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser',
      '',
      `package/bin/${archiveFilename}`,
    );
  }
  const manifest = {
    schemaVersion: 1 as const,
    dependencies: {
      codex: {
        version: CODEX_VERSION,
        probe: { args: ['--version'] },
        artifacts: codexArtifacts,
      },
      claude: {
        version: CLAUDE_VERSION,
        reportedVersion: '2.1.0',
        managedProbe: false,
        probe: { args: ['--version'] },
        artifacts: claudeArtifacts,
      },
      agentBrowser: {
        version: AGENT_BROWSER_VERSION,
        probe: { args: ['--version'] },
        artifacts: agentBrowserArtifacts,
      },
    },
  };
  const content = JSON.stringify(manifest);
  return {
    ...manifest,
    manifestId: crypto.createHash('sha256').update(content).digest('hex'),
  };
}

function main(): void {
  const output = `${JSON.stringify(buildManifest(), null, 2)}\n`;
  const target = path.join(root, 'backend', 'data', 'runtime-dependency-manifest.json');
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== output) {
      throw new Error('runtime dependency manifest is stale; run npm run prepare:runtime-manifest');
    }
    return;
  }
  fs.writeFileSync(target, output);
}

if (require.main === module) main();
