const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const verifier = path.join(process.cwd(), 'scripts/verify-release-notes.mjs');

function runVerifier(version, notesDir, ...args) {
  return childProcess.spawnSync(
    process.execPath,
    [verifier, version, '--notes-dir', notesDir, ...args],
    { encoding: 'utf8' },
  );
}

function writeNotes(notesDir, version, codename = 'BEACON') {
  fs.writeFileSync(
    path.join(notesDir, `v${version}.md`),
    `# Farming v${version}\n\n[简体中文](./v${version}.zh_cn.md)\n\nMilestone codename: **${codename}**\n\n## Upgrade\n\nfarming-code@${version}\n`,
  );
  fs.writeFileSync(
    path.join(notesDir, `v${version}.zh_cn.md`),
    `# Farming v${version}\n\n[English](./v${version}.md)\n\n里程碑代号：**${codename}**\n\n## 升级\n\nfarming-code@${version}\n`,
  );
}

function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-notes-'));
  try {
    const version = '9.8.7';
    writeNotes(temporaryRoot, version);

    const valid = runVerifier(version, temporaryRoot);
    assert.strictEqual(valid.status, 0, valid.stderr);
    assert(valid.stdout.includes('v9.8.7 · BEACON'));

    const codename = runVerifier(version, temporaryRoot, '--codename');
    assert.strictEqual(codename.status, 0, codename.stderr);
    assert.strictEqual(codename.stdout.trim(), 'BEACON');

    fs.writeFileSync(
      path.join(temporaryRoot, `v${version}.zh_cn.md`),
      `# Farming v${version}\n\n[English](./v${version}.md)\n\n里程碑代号：**WRONG**\n\n## 升级\n\nfarming-code@${version}\n`,
    );
    const mismatch = runVerifier(version, temporaryRoot);
    assert.notStrictEqual(mismatch.status, 0);
    assert(mismatch.stderr.includes('codenames must match'));

    fs.writeFileSync(
      path.join(temporaryRoot, `v${version}.zh_cn.md`),
      `# Farming v${version}\n\n[English](./other.md)\n\n里程碑代号：**BEACON**\n\n## 升级\n\nfarming-code@${version}\n`,
    );
    const badLink = runVerifier(version, temporaryRoot);
    assert.notStrictEqual(badLink.status, 0);
    assert(badLink.stderr.includes('[English](./v9.8.7.md)'));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  console.log('✓ Release note format verifier rejects missing or inconsistent bilingual metadata');
}

run();
