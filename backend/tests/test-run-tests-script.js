const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'run-tests.js'), 'utf8');

assert(source.includes("process.env.FARMING_TEST_CONCURRENCY"));
assert(source.includes('DEFAULT_TEST_CONCURRENCY'));
assert(source.includes('Promise.all'));
assert(!source.includes('execFileSync'));

console.log('✓ full test runner uses configurable bounded concurrency');
