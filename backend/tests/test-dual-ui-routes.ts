const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const runtimePathsSource = read('frontend/runtime-paths.js');

  const window: {
    location: { pathname: string; protocol: string; host: string };
    FarmingRuntimePaths?: {
      basePath: string;
      apiPath(_pathname: string): string;
      webSocketUrl(): string;
    };
  } = {
    location: {
      pathname: '/farming/crt/',
      protocol: 'https:',
      host: 'example.test',
    },
  };
  vm.runInNewContext(runtimePathsSource, { window });
  assert(window.FarmingRuntimePaths, 'runtime paths must be installed on the test window');
  assert.strictEqual(window.FarmingRuntimePaths.basePath, '/farming');
  assert.strictEqual(window.FarmingRuntimePaths.apiPath('/settings'), '/farming/api/settings');
  assert.strictEqual(window.FarmingRuntimePaths.webSocketUrl(), 'wss://example.test/farming/ws');

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: path.join(__dirname, '../..'),
    encoding: 'utf8',
  }));
  const packageInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  const packageFiles = new Set(packageInfo.files.map(file => file.path));
  for (const requiredFile of [
    'frontend/runtime-paths.js',
    'frontend/skins/crt/app.js',
    'frontend/skins/crt/index.html',
    'frontend/skins/crt/styles/monochrome-green.css',
  ]) {
    assert(packageFiles.has(requiredFile), `published package is missing ${requiredFile}`);
  }

  console.log('✓ Farming Code and CRT expose independent, packaged UI routes');
}

run();
