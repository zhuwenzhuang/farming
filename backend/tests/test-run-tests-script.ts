const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'run-tests.ts'), 'utf8');

assert(source.includes("process.env.FARMING_TEST_CONCURRENCY"));
assert(source.includes('DEFAULT_TEST_CONCURRENCY'));
assert(source.includes("['test-workspace-file-service.ts', 90_000]"));
assert(source.includes('Promise.all'));
assert(!source.includes('execFileSync'));
assert(source.includes("args: ['--import', 'tsx', '--test', filePath]"));
assert(source.includes('function captureSourceRevision()'));
assert(source.includes('function changedSourcePaths(before: Map<string, string>, after: Map<string, string>)'));
assert(source.includes('Source revision changed during the test run'));

console.log('✓ full test runner uses configurable bounded concurrency and fences its source revision');
