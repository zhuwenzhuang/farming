const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

function referencedPostinstallScripts() {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.ok(typeof manifest.scripts?.postinstall === 'string', 'package.json must declare a postinstall script');
  const referenced = [...manifest.scripts.postinstall.matchAll(/scripts\/[A-Za-z0-9._-]+\.(?:cjs|mjs|js|sh)/g)]
    .map(match => match[0]);
  assert.ok(referenced.length > 0, 'postinstall should reference at least one scripts/ file');
  return [...new Set(referenced)];
}

function run() {
  const scripts = referencedPostinstallScripts();

  for (const scriptPath of scripts) {
    assert.ok(
      fs.existsSync(path.join(projectRoot, scriptPath)),
      `postinstall-referenced script is missing from the repository: ${scriptPath}`,
    );

    const archiveEntry = childProcess.spawnSync(
      'git',
      ['-C', projectRoot, 'archive', '--format=tar', 'HEAD', '--', scriptPath],
      { encoding: 'buffer' },
    );
    assert.strictEqual(
      archiveEntry.status,
      0,
      `postinstall-referenced script is not tracked by git: ${scriptPath}`,
    );

    const packagingSource = fs.readFileSync(path.join(projectRoot, 'scripts', 'package-release.sh'), 'utf8');
    const archiveLine = new RegExp(`^\\s*${scriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\\\?\\s*$`, 'm');
    assert.ok(
      archiveLine.test(packagingSource),
      `scripts/package-release.sh does not stage the postinstall-referenced script into app bundles: ${scriptPath}`,
    );
  }

  console.log(`✓ App-bundle packaging stages every postinstall-referenced script (${scripts.join(', ')})`);
}

run();
