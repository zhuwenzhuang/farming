const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const vendorDir = path.join(__dirname, '../../frontend/vendor/ghostty-web');
  const serverPath = path.join(__dirname, '../../backend/server.cts');
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

  const requiredFiles = [
    'ghostty-web.js',
    'ghostty-vt.wasm',
    '__vite-browser-external-2447137e.js'
  ];

  requiredFiles.forEach((fileName) => {
    const filePath = path.join(vendorDir, fileName);
    assert(fs.existsSync(filePath), `${fileName} should exist in vendored Ghostty assets`);
  });

  const serverCode = fs.readFileSync(serverPath, 'utf8');
  assert(
    !serverCode.includes('node_modules/ghostty-web'),
    'server should not serve Ghostty assets directly from node_modules'
  );
  assert.strictEqual(
    packageJson.dependencies?.['ghostty-web'],
    undefined,
    'the optional Ghostty debug renderer must not be a production dependency',
  );
  assert(
    !packageJson.bundledDependencies?.includes('ghostty-web'),
    'the npm package must not bundle a duplicate Ghostty dependency beside the reviewed vendor assets',
  );
  assert(
    !String(packageJson.scripts?.prebuild || '').includes('ghostty'),
    'ordinary builds must not require the upstream Ghostty package',
  );

  console.log('✓ Ghostty remains a vendored debug asset without a production package dependency');
}

run();
