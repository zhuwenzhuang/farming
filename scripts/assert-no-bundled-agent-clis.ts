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

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  optionalDependencies?: Record<string, string>;
};

for (const [scope, prefix] of forbiddenPlatformPackages) {
  const scopeDirectory = path.join(packageRoot, 'node_modules', scope);
  const names = fs.existsSync(scopeDirectory) ? fs.readdirSync(scopeDirectory) : [];
  for (const platformPackage of names.filter(name => name.startsWith(prefix))) {
    const packageName = `${scope}/${platformPackage}`;
    const packageMetadata = JSON.parse(fs.readFileSync(
      path.join(scopeDirectory, platformPackage, 'package.json'),
      'utf8',
    )) as { name?: string; version?: string };
    const declared = manifest.optionalDependencies?.[packageName];
    if (
      declared !== packageMetadata.version
      && declared !== `npm:${packageMetadata.name}@${packageMetadata.version}`
    ) {
      throw new Error(`Installed Agent runtime carrier is not an exact declared optional dependency: ${packageName}`);
    }
  }
}

console.log(`Verified Agent runtime carriers are declarative and exact under ${packageRoot}`);
