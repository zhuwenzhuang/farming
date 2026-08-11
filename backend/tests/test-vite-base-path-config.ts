const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '../..');
const tsxLoader = require.resolve('tsx');

function configuredBase(cwd, environment) {
  const script = [
    `import loadedConfig from ${JSON.stringify(path.join(projectRoot, 'vite.config.ts'))};`,
    'const config = loadedConfig.default || loadedConfig;',
    "const resolved = await config({ command: 'build', mode: 'test' });",
    'process.stdout.write(String(resolved.base));',
  ].join('\n');
  return execFileSync(process.execPath, ['--import', tsxLoader, '--input-type=module', '--eval', script], {
    cwd,
    encoding: 'utf8',
    env: environment,
  });
}

function run() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-vite-base-'));
  try {
    fs.writeFileSync(path.join(fixture, '.env.test'), 'FARMING_BASE_PATH=/from-env\n');
    assert.strictEqual(
      configuredBase(fixture, { ...process.env, FARMING_BASE_PATH: '/from-shell' }),
      '/from-shell/',
      'Vite must give the shell base path priority over an env file',
    );
    const withoutShellBase = { ...process.env };
    delete withoutShellBase.FARMING_BASE_PATH;
    assert.strictEqual(
      configuredBase(fixture, withoutShellBase),
      '/from-env/',
      'Vite must use the configured env-file base path when the shell has none',
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  console.log('✓ Vite base path honors shell and env configuration precedence');
}

run();
