#!/usr/bin/env node
/**
 * Run all backend tests and report results.
 * Usage: node scripts/run-tests.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Backend tests may dynamic-import TypeScript under src/; native node cannot load those without tsx. */
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const testsDir = path.join(__dirname, '..', 'backend', 'tests');
const serverBackedTests = new Set([
  'test-final.js',
  'test-session-terminal-input-e2e.js',
]);
const testFiles = fs.readdirSync(testsDir)
  .filter(f => f.startsWith('test-') && f.endsWith('.js'))
  .filter(f => process.env.FARMING_INCLUDE_SERVER_TESTS === '1' || !serverBackedTests.has(f))
  .sort();

let passed = 0;
let failed = 0;
const failures = [];

for (const file of testFiles) {
  const filePath = path.join(testsDir, file);
  try {
    execFileSync(process.execPath, [tsxCli, filePath], {
      timeout: 30000,
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'test' }
    });
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${file}`);
  } catch (err) {
    failed++;
    const stderr = err.stderr ? err.stderr.toString().split('\n').slice(0, 5).join('\n') : '';
    failures.push({ file, stderr });
    console.log(`  \x1b[31m✗\x1b[0m ${file}`);
  }
}

console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const { file, stderr } of failures) {
    console.log(`\n  ${file}:`);
    if (stderr) console.log(`    ${stderr.replace(/\n/g, '\n    ')}`);
  }
  process.exit(1);
}
