const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const vendorDir = path.join(__dirname, '../../frontend/vendor/ghostty-web');
  const serverPath = path.join(__dirname, '../../backend/server.js');

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

  console.log('✓ Ghostty vendor assets are present');
}

run();
