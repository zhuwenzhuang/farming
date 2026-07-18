const assert = require('assert');
const { archiveCodexSession } = require('../codex-session-archive');

async function run() {
  const calls = [];
  const result = await archiveCodexSession('019f0000-0000-7000-8000-000000000001', {
    cliVersion: '1.2.3',
    cwd: '/repo/worktree',
    providerHomePath: '/home/farming/.codex',
  }, {
    processEnv: { PATH: '/test/bin', HOME: '/home/farming' },
    resolveCompatibleCodexExecutable(version, searchPath) {
      assert.strictEqual(version, '1.2.3');
      assert.strictEqual(searchPath, '/test/bin');
      return { compatible: true, path: '/test/bin/codex' };
    },
    async execFileAsync(command, args, options) {
      calls.push({ command, args, options });
    },
  });

  assert.deepStrictEqual(result, { archived: true });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].command, '/test/bin/codex');
  assert.deepStrictEqual(calls[0].args, ['archive', '019f0000-0000-7000-8000-000000000001']);
  assert.strictEqual(calls[0].options.cwd, '/repo/worktree');
  assert.strictEqual(calls[0].options.env.CODEX_HOME, '/home/farming/.codex');

  console.log('test-codex-session-archive passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
