const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function run() {
  const serverSource = read('backend/server.js');
  const mainSource = read('src/main.tsx');
  const appSource = read('frontend/skins/crt/app.js');
  const runtimePathsSource = read('frontend/runtime-paths.js');
  const packageJson = JSON.parse(read('package.json'));
  const pkgConfig = read('pkg.config.cjs');
  const packageRelease = read('scripts/package-release.sh');

  assert(serverSource.includes("routePath(BASE_PATH, '/code')"));
  assert(serverSource.includes("routePath(BASE_PATH, '/code/')"));
  assert(serverSource.includes("const crtEntryPath = routePath(BASE_PATH, '/crt')"));
  assert(serverSource.includes("express.static(crtFrontendDir, { index: false })"));
  assert(mainSource.includes("src={appPath('/crt/')}"));
  assert(mainSource.includes('data-testid="app-error-crt-background"'));
  assert(mainSource.includes("window.location.replace(appPath('/code/'))"));
  assert(!mainSource.includes("import('./styles/effects.css')"));
  assert(appSource.includes('fetch(farmingApiPath('));
  assert(appSource.includes('new WebSocket(farmingWebSocketUrl())'));
  assert(appSource.includes('crtSkinEffectsEnabled'));

  const window = {
    location: {
      pathname: '/farming/crt/',
      protocol: 'https:',
      host: 'example.test',
    },
  };
  vm.runInNewContext(runtimePathsSource, { window });
  assert.strictEqual(window.FarmingRuntimePaths.basePath, '/farming');
  assert.strictEqual(window.FarmingRuntimePaths.apiPath('/settings'), '/farming/api/settings');
  assert.strictEqual(window.FarmingRuntimePaths.webSocketUrl(), 'wss://example.test/farming/ws');

  assert(packageJson.files.includes('frontend/*.js'));
  assert(packageJson.files.includes('frontend/skins/'));
  assert(pkgConfig.includes("'frontend/skins/**/*'"));
  assert(packageRelease.includes('  frontend \\\n'));
  assert(packageRelease.includes('  shared \\\n'));

  console.log('✓ Farming Code and CRT expose independent, packaged UI routes');
}

run();
