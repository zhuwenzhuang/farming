const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function run() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  for (const lifecycle of ['preinstall', 'install', 'postinstall']) {
    assert.strictEqual(
      manifest.scripts?.[lifecycle],
      undefined,
      `npm package must not declare ${lifecycle}`,
    );
  }
  assert(!manifest.files.includes('scripts/prepare-installed-runtime.cjs'));
  assert(!fs.existsSync(path.join(projectRoot, 'scripts', 'prepare-installed-runtime.cjs')));
  console.log('✓ npm installation has no lifecycle-script dependency');
}

run();
