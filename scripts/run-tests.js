#!/usr/bin/env node
/**
 * Run all backend tests and report results.
 * Usage: node scripts/run-tests.js
 */
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Backend tests may dynamic-import TypeScript under src/; native node cannot load those without tsx. */
const tsxCli = path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

const projectRoot = path.join(__dirname, '..');
const testsDir = path.join(projectRoot, 'backend', 'tests');
const SOURCE_REVISION_PATHS = [
  'backend',
  'extensions',
  'frontend',
  'scripts',
  'src',
  'tests',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'tsconfig.json',
];
const SOURCE_REVISION_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.tmp',
]);
const serverBackedTests = new Set([
  'test-final.js',
  'test-session-terminal-input-e2e.js',
]);
const exclusiveTestFiles = new Set([
  // This test intentionally replaces the native PTY host for its config root.
  // Keep it continuously covered, but do not overlap it with other
  // process-level native-host tests running under the same user.
  'test-server-native-runtime-rotation.js',
]);
const DEFAULT_TEST_TIMEOUT_MS = 45_000;
const DEFAULT_TEST_CONCURRENCY = Math.min(4, Math.max(1, os.availableParallelism?.() || os.cpus().length));
const MAX_TEST_CONCURRENCY = 16;
const TEST_TIMEOUT_OVERRIDES_MS = new Map([
  ['test-native-session-engine-shell-profiles.js', 90_000],
  ['test-review-comparison-matrix.js', 180_000],
  ['test-server-native-runtime-rotation.js', 90_000],
  ['test-workspace-file-service.js', 90_000],
]);
const testFiles = fs.readdirSync(testsDir)
  .filter(f => f.startsWith('test-') && f.endsWith('.js'))
  .filter(f => process.env.FARMING_INCLUDE_SERVER_TESTS === '1' || !serverBackedTests.has(f))
  .sort();
const stateTestFiles = [
  path.join(__dirname, '..', 'tests', 'review-state.test.ts'),
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
const parallelTestRuns = testRuns.filter(testRun => !exclusiveTestFiles.has(testRun.label));
const exclusiveTestRuns = testRuns.filter(testRun => exclusiveTestFiles.has(testRun.label));
const testConcurrency = Math.min(
  parallelTestRuns.length,
  MAX_TEST_CONCURRENCY,
  Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
    ? requestedConcurrency
    : DEFAULT_TEST_CONCURRENCY
);

function captureSourceRevision() {
  const revision = new Map();

  function visit(absolutePath, relativePath) {
    const entry = fs.lstatSync(absolutePath);
    if (entry.isDirectory()) {
      if (SOURCE_REVISION_IGNORED_DIRECTORIES.has(path.basename(absolutePath))) return;
      fs.readdirSync(absolutePath)
        .sort()
        .forEach(name => visit(path.join(absolutePath, name), path.join(relativePath, name)));
      return;
    }
    if (entry.isSymbolicLink()) {
      revision.set(relativePath, `link:${fs.readlinkSync(absolutePath)}`);
      return;
    }
    if (!entry.isFile()) return;
    revision.set(
      relativePath,
      crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'),
    );
  }

  SOURCE_REVISION_PATHS.forEach(relativePath => {
    const absolutePath = path.join(projectRoot, relativePath);
    if (fs.existsSync(absolutePath)) visit(absolutePath, relativePath);
  });
  return revision;
}

function changedSourcePaths(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(relativePath => before.get(relativePath) !== after.get(relativePath))
    .sort();
}

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
  const sourceRevisionBefore = captureSourceRevision();
  let passed = 0;
  let failed = 0;
  const failures = [];

  console.log(
    `Running ${testRuns.length} tests with ${testConcurrency} workers`
      + ` and ${exclusiveTestRuns.length} exclusive process test(s)...`,
  );

  async function runBatch(runs, concurrency) {
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < runs.length) {
        const testRun = runs[nextIndex++];
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
    await Promise.all(Array.from({ length: Math.min(runs.length, concurrency) }, () => worker()));
  }

  await runBatch(parallelTestRuns, testConcurrency);
  await runBatch(exclusiveTestRuns, 1);

  const changedSources = changedSourcePaths(sourceRevisionBefore, captureSourceRevision());
  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (changedSources.length > 0) {
    console.log(`\nSource revision changed during the test run (${changedSources.length} files):`);
    changedSources.slice(0, 20).forEach(relativePath => console.log(`  ${relativePath}`));
    if (changedSources.length > 20) {
      console.log(`  ...and ${changedSources.length - 20} more`);
    }
    process.exitCode = 1;
  }

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
