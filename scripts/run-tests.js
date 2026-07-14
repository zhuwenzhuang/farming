#!/usr/bin/env node
/**
 * Run all backend tests and report results.
 * Usage: node scripts/run-tests.js
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Backend tests may dynamic-import TypeScript under src/; native node cannot load those without tsx. */
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const testsDir = path.join(__dirname, '..', 'backend', 'tests');
const serverBackedTests = new Set([
  'test-final.js',
  'test-session-terminal-input-e2e.js',
]);
const DEFAULT_TEST_TIMEOUT_MS = 45_000;
const DEFAULT_TEST_CONCURRENCY = Math.min(4, Math.max(1, os.availableParallelism?.() || os.cpus().length));
const MAX_TEST_CONCURRENCY = 16;
const TEST_TIMEOUT_OVERRIDES_MS = new Map([
  ['test-native-session-engine-shell-profiles.js', 90_000],
  ['test-review-comparison-matrix.js', 180_000],
  ['test-workspace-file-service.js', 90_000],
]);
const testFiles = fs.readdirSync(testsDir)
  .filter(f => f.startsWith('test-') && f.endsWith('.js'))
  .filter(f => process.env.FARMING_INCLUDE_SERVER_TESTS === '1' || !serverBackedTests.has(f))
  .sort();
const stateTestFiles = [
  path.join(__dirname, '..', 'tests', 'review-demo-state.test.ts'),
].filter(fs.existsSync);

const testRuns = [
  ...stateTestFiles.map(filePath => ({
    args: [tsxCli, '--test', filePath],
    label: path.basename(filePath),
  })),
  ...testFiles.map(file => ({
    args: [tsxCli, path.join(testsDir, file)],
    label: file,
    timeoutMs: TEST_TIMEOUT_OVERRIDES_MS.get(file),
  })),
];

const requestedConcurrency = Number.parseInt(process.env.FARMING_TEST_CONCURRENCY || '', 10);
const testConcurrency = Math.min(
  testRuns.length,
  MAX_TEST_CONCURRENCY,
  Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? requestedConcurrency
    : DEFAULT_TEST_CONCURRENCY
);

function runTest({ args, label, timeoutMs }) {
  return new Promise(resolve => {
    execFile(process.execPath, args, {
      timeout: Number(process.env.FARMING_TEST_TIMEOUT_MS) || timeoutMs || DEFAULT_TEST_TIMEOUT_MS,
      env: { ...process.env, NODE_ENV: 'test' }
    }, (error, stdout, stderr) => {
      resolve({
        label,
        error,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

async function main() {
  let nextIndex = 0;
  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(`Running ${testRuns.length} tests with ${testConcurrency} workers...`);

  async function worker() {
    while (nextIndex < testRuns.length) {
      const testRun = testRuns[nextIndex++];
      const result = await runTest(testRun);
      if (!result.error) {
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${result.label}`);
        continue;
      }

      failed++;
      failures.push({
        file: result.label,
        stderr: result.stderr,
        stdout: result.stdout,
        errorMessage: result.error.message ? String(result.error.message) : '',
      });
      console.log(`  \x1b[31m✗\x1b[0m ${result.label}`);
    }
  }

  await Promise.all(Array.from({ length: testConcurrency }, () => worker()));

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const { file, stderr, stdout, errorMessage } of failures) {
      console.log(`\n  ${file}:`);
      if (stderr) console.log(`    ${stderr.replace(/\n/g, '\n    ')}`);
      if (stdout) console.log(`    stdout: ${stdout.replace(/\n/g, '\n    ')}`);
      if (!stderr && !stdout && errorMessage) console.log(`    ${errorMessage.replace(/\n/g, '\n    ')}`);
    }
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
