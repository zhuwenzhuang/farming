#!/usr/bin/env -S node --import tsx
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface BehaviorManifest {
  contracts: Array<{
    evidence?: { node?: string[] };
  }>;
}

const projectRoot = path.join(__dirname, '..');
const manifest = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'tests', 'behavior-contracts.json'), 'utf8'),
) as BehaviorManifest;
const nodeTests = [...new Set(manifest.contracts.flatMap(contract => contract.evidence?.node || []))].sort();
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
const testTimeoutMs = Number(process.env.FARMING_BEHAVIOR_TEST_TIMEOUT_MS) || 90_000;

for (const relativePath of nodeTests) {
  console.log(`Behavior evidence: ${relativePath}`);
  const absolutePath = path.join(projectRoot, relativePath);
  const args = relativePath.startsWith('tests/') && relativePath.endsWith('.test.ts')
    ? ['--import', 'tsx', '--test', absolutePath]
    : [tsxCli, absolutePath];
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--enable-source-maps'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
    timeout: testTimeoutMs,
  });
  if (result.error) console.error(`Behavior evidence failed to run: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Behavior Node evidence passed: ${nodeTests.length} tests`);
