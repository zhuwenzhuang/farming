const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

(async () => {
  const {
    buildWorkspaceHistory,
    buildWorkspaceOptions,
    formatWorkspaceForDisplay,
    getMainWorkspaceDefault,
    normalizeWorkspaceValue,
    resolveWorkspaceToStart,
    shouldRememberWorkspace,
  } = importTsModule('src/lib/workspace-options.ts');

  assert.strictEqual(normalizeWorkspaceValue('/home/farming-user/example-project/'), '/home/farming-user/example-project');
  assert.strictEqual(normalizeWorkspaceValue('/'), '/');
  assert.strictEqual(shouldRememberWorkspace('/home/farming-user/example-project'), true);
  assert.strictEqual(shouldRememberWorkspace('/var/folders/farming-e2e'), false);
  assert.strictEqual(shouldRememberWorkspace('/tmp'), false);
  assert.strictEqual(shouldRememberWorkspace('/tmp/farming-e2e'), false);
  assert.strictEqual(shouldRememberWorkspace('/private/tmp/farming-e2e'), false);
  assert.strictEqual(shouldRememberWorkspace('/home/farming-user/.farming'), false);
  assert.strictEqual(shouldRememberWorkspace('~/.farming'), false);

  assert.deepStrictEqual(
    buildWorkspaceHistory('/home/farming-user/example-project/', [
      '/home/farming-user/.farming',
      '/home/farming-user/farming',
      '/home/farming-user/example-project',
      '/tmp',
      '/var/tmp/farming-e2e',
    ]),
    ['/home/farming-user/example-project', '/home/farming-user/farming']
  );

  assert.deepStrictEqual(
    buildWorkspaceOptions(
      ['/home/farming-user/farming/', '/home/farming-user/.farming', '/home/farming-user/old-project'],
      ['/home/farming-user/old-project/', '/home/farming-user/example-project', '/home/farming-user/.farming', '/home/farming-user/another']
    ),
    ['/home/farming-user/farming', '/home/farming-user/old-project', '/home/farming-user/example-project', '/home/farming-user/another']
  );

  assert.deepStrictEqual(
    buildWorkspaceOptions(
      ['/a', '/b', '/c', '/d', '/e'],
      ['/f']
    ),
    ['/a', '/b', '/c', '/d', '/e']
  );

  assert.strictEqual(
    getMainWorkspaceDefault({ workspace: '/home/farming-user/.farming', workspaceHistory: ['/home/farming-user/example-project'] }),
    '~/.farming'
  );
  assert.strictEqual(
    getMainWorkspaceDefault({ workspace: '/home/farming-user/.farming', lastMainWorkspace: '/home/farming-user/last-main' }),
    '/home/farming-user/last-main'
  );
  assert.strictEqual(formatWorkspaceForDisplay('/home/farming-user/.farming'), '~/.farming');
  assert.strictEqual(resolveWorkspaceToStart('', true, '/home/farming-user/last-main'), '/home/farming-user/last-main');
  assert.strictEqual(resolveWorkspaceToStart('', true, ''), '~/.farming');
  assert.strictEqual(resolveWorkspaceToStart('', false, '/home/farming-user/last-main'), null);
  assert.strictEqual(resolveWorkspaceToStart('/home/farming-user/example-project', false, '/home/farming-user/last-main'), '/home/farming-user/example-project');

  console.log('test-workspace-options passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
