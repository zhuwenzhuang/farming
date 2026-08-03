const assert = require('assert');
const {
  MAX_CAPABILITY_CLI_CHARS,
  capabilityEnvelope,
  capabilityError,
  writeCapabilityJson,
} = require('../capability-cli-output.cjs');

const artifact = {
  kind: 'image',
  path: '.tmp/farming/browser/screenshot.png',
  mimeType: 'image/png',
  size: 42,
};
const ordinary = capabilityEnvelope('browser', 'screenshot', { artifact });
assert.deepStrictEqual(ordinary.artifacts, [artifact]);

const large = capabilityEnvelope('computer', 'get_window_state', {
  content: `${'"\n\\'.repeat(60_000)}tail`,
  artifacts: [artifact],
});
assert.strictEqual(large.result.truncated, true);
assert.strictEqual(large.artifacts[0].path, artifact.path);
assert(JSON.stringify(large).length <= MAX_CAPABILITY_CLI_CHARS);

let output = '';
writeCapabilityJson({ write(chunk) { output += chunk; } }, large);
assert(output.endsWith('\n'));
assert(output.length <= MAX_CAPABILITY_CLI_CHARS + 1);
assert.deepStrictEqual(JSON.parse(output), large);

const uncertain = capabilityError(Object.assign(new Error('action timed out with uncertain outcome'), {
  code: 'COMPUTER_ACTION_UNCERTAIN',
  uncertain: true,
}), 'computer', 'click');
assert.strictEqual(uncertain.uncertain, true);
assert.strictEqual(uncertain.retryable, false);
assert.match(uncertain.hint, /Observe/);

let largeErrorOutput = '';
writeCapabilityJson({ write(chunk) { largeErrorOutput += chunk; } }, capabilityError(
  Object.assign(new Error('x'.repeat(MAX_CAPABILITY_CLI_CHARS * 2)), { code: 'LARGE_ERROR' }),
  'browser',
  'eval',
));
assert(largeErrorOutput.length <= MAX_CAPABILITY_CLI_CHARS + 1);
const boundedError = JSON.parse(largeErrorOutput);
assert.strictEqual(boundedError.ok, false);
assert.strictEqual(boundedError.truncated, true);
assert.strictEqual(boundedError.code, 'LARGE_ERROR');

console.log('Capability CLI output tests passed');
