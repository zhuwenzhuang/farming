const assert = require('assert');
const {
  buildWorkspaceHistory,
  normalizeWorkspaceValue,
  shouldRememberWorkspace,
  getDefaultWorkspaceForDialog,
  resolveWorkspaceToStart,
} = require('../../frontend/skins/crt/app.js');

function run() {
  assert.strictEqual(normalizeWorkspaceValue('  /tmp/foo  '), '/tmp/foo');
  assert.strictEqual(normalizeWorkspaceValue('   '), '');
  assert.strictEqual(normalizeWorkspaceValue(null), '');
  assert.strictEqual(shouldRememberWorkspace('/home/farming-user/git/farming'), true);
  assert.strictEqual(shouldRememberWorkspace('/tmp/farming-e2e'), false);
  assert.strictEqual(shouldRememberWorkspace('/private/tmp/farming-e2e'), false);
  assert.strictEqual(shouldRememberWorkspace('/var/folders/abc/workspace'), false);

  const history = buildWorkspaceHistory('/home/farming-user/project-c', [
    '/home/farming-user/project-b',
    '/home/farming-user/project-a',
    '/home/farming-user/project-b',
    '   ',
    '/home/farming-user/project-c',
  ]);
  assert.deepStrictEqual(history, [
    '/home/farming-user/project-c',
    '/home/farming-user/project-b',
    '/home/farming-user/project-a',
  ]);

  const ignoresVar = buildWorkspaceHistory('/var/folders/abc/workspace', [
    '/home/farming-user/project-b',
    '/var/folders/older/workspace',
    '/home/farming-user/project-a',
  ]);
  assert.deepStrictEqual(ignoresVar, ['/home/farming-user/project-b', '/home/farming-user/project-a']);

  const capped = buildWorkspaceHistory('/home/farming-user/project-08', [
    '/home/farming-user/project-07',
    '/home/farming-user/project-06',
    '/home/farming-user/project-05',
    '/home/farming-user/project-04',
    '/home/farming-user/project-03',
    '/home/farming-user/project-02',
    '/home/farming-user/project-01',
    '/home/farming-user/project-00',
    '/home/farming-user/project-overflow',
  ]);
  assert.deepStrictEqual(capped, [
    '/home/farming-user/project-08',
    '/home/farming-user/project-07',
    '/home/farming-user/project-06',
    '/home/farming-user/project-05',
    '/home/farming-user/project-04',
  ]);

  assert.strictEqual(getDefaultWorkspaceForDialog(true), '');
  assert.strictEqual(getDefaultWorkspaceForDialog(false), '');
  assert.strictEqual(resolveWorkspaceToStart('/tmp/work', true), '/tmp/work');
  assert.strictEqual(resolveWorkspaceToStart('/tmp/work', false), '/tmp/work');
  assert.strictEqual(resolveWorkspaceToStart('', false), null);

  console.log('test-workspace-history-helpers passed');
}

run();
