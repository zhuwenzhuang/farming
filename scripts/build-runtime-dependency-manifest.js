#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const packages = lock.packages || {};

const CODEX_VERSION = '0.144.6';
const CLAUDE_VERSION = '0.3.207';
const AGENT_BROWSER_VERSION = '0.32.3';

const PLATFORM_TARGETS = {
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

const AGENT_BROWSER_ARTIFACTS = {
  'darwin-arm64': ['agent-browser-darwin-arm64', 11421328, 'b639605f496b629ebb2cdab30f1e070e004efd945b9cd0baf1981acfab64a151'],
  'darwin-x64': ['agent-browser-darwin-x64', 12497296, '190de038807079de7c20cb133f874658750a0887da30fe563dbe7f35f593ce29'],
  'linux-arm64': ['agent-browser-linux-arm64', 11424360, '87fd2efb67995fc433569f0383260bfee44a785d6d45ca07c77179c45b70de18'],
  'linux-arm64-musl': ['agent-browser-linux-musl-arm64', 11285568, '5f73da13c6521ea8d1f3d7a77eda7758879bcc1ba3fd3043041799673e90d8f0'],
  'linux-x64': ['agent-browser-linux-x64', 13107176, '243f6e01c4b7dea53ad07d9754df99033c614582d5c685c529a1cb81cafc3ab1'],
  'linux-x64-musl': ['agent-browser-linux-musl-x64', 12958288, 'fb11c463ef1ebc5d626355040218eb25af685774f2ee022b2df70deacbd34bf4'],
  'win32-x64': ['agent-browser-win32-x64.exe', 12758016, 'd27f77cb4ed7120a25f0b60030b306fe6788be0997f5a6baad74f74a2c0ec627'],
};

function packageRecord(packageName, version) {
  const record = packages[`node_modules/${packageName}`];
  if (!record || record.version !== version || !record.resolved || !record.integrity) {
    throw new Error(`package-lock.json does not pin ${packageName} ${version}`);
  }
  return record;
}

function npmArtifact(packageName, version, entry, archivePrefix = '') {
  const record = packageRecord(packageName, version);
  return {
    url: record.resolved,
    integrity: record.integrity,
    archive: 'tgz',
    ...(archivePrefix ? { archivePrefix } : {}),
    entry,
  };
}

function buildManifest() {
  const codexArtifacts = {};
  const claudeArtifacts = {};
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
  const agentBrowserArtifacts = {};
  for (const [platformKey, [filename, size, sha256]] of Object.entries(AGENT_BROWSER_ARTIFACTS)) {
    agentBrowserArtifacts[platformKey] = {
      url: `https://github.com/vercel-labs/agent-browser/releases/download/v${AGENT_BROWSER_VERSION}/${filename}`,
      size,
      integrity: `sha256-${Buffer.from(sha256, 'hex').toString('base64')}`,
      archive: 'file',
      entry: platformKey.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser',
    };
  }
  const manifest = {
    schemaVersion: 1,
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

function main() {
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

module.exports = { buildManifest };
