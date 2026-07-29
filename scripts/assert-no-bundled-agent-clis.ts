#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(packageRoot, 'package.json'))) {
  throw new Error('Usage: assert-no-bundled-agent-clis.ts <package-root>');
}

const forbidden = [
  'node_modules/@agentclientprotocol/codex-acp',
  'node_modules/@agentclientprotocol/claude-agent-acp',
  'node_modules/@openai/codex',
  'node_modules/@anthropic-ai/claude-agent-sdk',
  'node_modules/agent-browser',
];

for (const relativePath of forbidden) {
  if (fs.existsSync(path.join(packageRoot, relativePath))) {
    throw new Error(`Release unexpectedly bundled Agent runtime dependency: ${relativePath}`);
  }
}

const forbiddenPlatformPackages: ReadonlyArray<readonly [scope: string, prefix: string]> = [
  ['@openai', 'codex-'],
  ['@anthropic-ai', 'claude-agent-sdk-'],
];

for (const [scope, prefix] of forbiddenPlatformPackages) {
  const scopeDirectory = path.join(packageRoot, 'node_modules', scope);
  const names = fs.existsSync(scopeDirectory) ? fs.readdirSync(scopeDirectory) : [];
  const platformPackage = names.find(name => name.startsWith(prefix));
  if (platformPackage) {
    throw new Error(
      `Release unexpectedly bundled platform Agent CLI: node_modules/${scope}/${platformPackage}`,
    );
  }
}

console.log(`Verified no duplicate Codex, Claude, or agent-browser CLI under ${packageRoot}`);
