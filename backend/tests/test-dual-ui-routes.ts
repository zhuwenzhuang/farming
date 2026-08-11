const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

  const root = path.join(__dirname, '../..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageFiles = new Set(packageJson.files);
  for (const requiredPattern of [
    'frontend/*.js',
    'frontend/skins/**/*.css',
    'frontend/skins/**/*.html',
    'frontend/skins/**/*.js',
  ]) {
    assert(packageFiles.has(requiredPattern), `npm package files are missing ${requiredPattern}`);
  }
  for (const requiredFile of [
    'frontend/runtime-paths.js',
    'frontend/skins/crt/app.js',
    'frontend/skins/crt/index.html',
    'frontend/skins/crt/styles/monochrome-green.css',
  ]) {
    assert(fs.existsSync(path.join(root, requiredFile)), `packaged UI source is missing ${requiredFile}`);
  }

  console.log('✓ Farming Code and CRT expose independent, packaged UI routes');
}

run();
