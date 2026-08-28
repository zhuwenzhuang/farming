const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acpRuntimeHostIdentity,
} = require('../acp-runtime-host-identity.cts');

function fixture(root, transcriptSource) {
  const backendDir = path.join(root, 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  fs.writeFileSync(path.join(backendDir, 'acp-transcript.cjs'), transcriptSource);
  fs.writeFileSync(path.join(backendDir, 'codex-transcript-sanitizer.cjs'), 'sanitizer-v1');
  return backendDir;
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-acp-runtime-host-identity-'));
  try {
    const first = fixture(path.join(root, 'first'), 'projection-v1');
    const changedProjection = fixture(path.join(root, 'changed-projection'), 'projection-v2');
    const changedSanitizer = fixture(path.join(root, 'changed-sanitizer'), 'projection-v1');
    fs.writeFileSync(path.join(changedSanitizer, 'codex-transcript-sanitizer.cjs'), 'sanitizer-v2');

    assert.notStrictEqual(
      acpRuntimeHostIdentity(first).buildId,
      acpRuntimeHostIdentity(changedProjection).buildId,
      'changing transcript projection code must rotate the Runtime Host build identity',
    );
    assert.notStrictEqual(
      acpRuntimeHostIdentity(first).buildId,
      acpRuntimeHostIdentity(changedSanitizer).buildId,
      'changing the transcript sanitizer must rotate the Runtime Host build identity',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
console.log('ACP runtime host identity tests passed');
