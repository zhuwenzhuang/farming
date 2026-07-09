const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compareCliVersions,
  getPathDirectories,
  getPreferredExecutableCandidates,
  clearExecutableVersionCache,
  isExecutable,
  listAvailableAgents,
  parseCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable
} = require('../executable-discovery');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'farming-exec-'));
}

function writeExecutable(dir, name) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '#!/usr/bin/env bash\n');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function run() {
  assert.deepStrictEqual(
    getPathDirectories('/usr/bin::/bin:/custom/bin'),
    ['/usr/bin', '/bin', '/custom/bin'],
    'path parsing should ignore empty segments'
  );

  const tempDir = makeTempDir();

  try {
    const executablePath = writeExecutable(tempDir, 'claude');
    writeExecutable(tempDir, 'bash');
    writeExecutable(tempDir, 'qodercli');
    writeExecutable(tempDir, 'qwen');
    const preferredCodex = writeExecutable(tempDir, 'preferred-codex');
    const textPath = path.join(tempDir, 'notes.txt');
    fs.writeFileSync(textPath, 'plain text');

    assert.strictEqual(isExecutable(executablePath), true, 'marked executable file should be detected');
    assert.strictEqual(isExecutable(textPath), false, 'non-executable file should be ignored');
    process.env.FARMING_CODEX_BIN = preferredCodex;

    const agents = listAvailableAgents(`${tempDir}${path.delimiter}/usr/bin`);
    const names = agents.map((agent) => agent.name);
    const codex = agents.find((agent) => agent.name === 'codex');

    assert.deepStrictEqual(
      names.slice(0, 4),
      ['codex', 'claude', 'qoder', 'bash'],
      'available launch agents should keep the stable product order while omitting missing agents'
    );
    assert(names.includes('claude'), 'claude should be discovered from PATH');
    assert(names.includes('qoder'), 'qoder should be discovered from qodercli on PATH');
    assert(names.includes('codex'), 'codex should be discovered from the preferred Codex.app-style binary');
    assert.strictEqual(codex.resolvedPath, preferredCodex, 'preferred codex binary should win over PATH');
    assert.strictEqual(agents.find((agent) => agent.name === 'qoder').command, 'qodercli');
    assert.strictEqual(resolveAgentExecutable('codex', `${tempDir}${path.delimiter}/usr/bin`), preferredCodex);
    assert.strictEqual(getPreferredExecutableCandidates('codex', tempDir)[0], preferredCodex);
    assert.strictEqual(parseCliVersion('codex-cli 0.142.3'), '0.142.3');
    assert(compareCliVersions('0.142.3', '0.133.0') > 0, 'newer codex should compare higher');
    const oldCodex = writeExecutable(tempDir, 'old-codex');
    const newCodex = writeExecutable(tempDir, 'new-codex');
    const compatibleCodex = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [oldCodex, newCodex],
      readVersion(filePath) {
        return filePath === oldCodex ? '0.133.0' : '0.142.3';
      },
    });
    assert.strictEqual(compatibleCodex.path, newCodex, 'resume should skip an older codex when a compatible candidate exists');
    assert.strictEqual(compatibleCodex.compatible, true);

    clearExecutableVersionCache();
    let versionReads = 0;
    resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [newCodex],
      readVersion() {
        versionReads += 1;
        return '0.142.3';
      },
    });
    resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [newCodex],
      readVersion() {
        versionReads += 1;
        return '0.142.3';
      },
    });
    assert.strictEqual(versionReads, 1, 'compatible Codex version reads should be cached per executable');
    clearExecutableVersionCache();

    const incompatibleCodex = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [oldCodex],
      readVersion() {
        return '0.133.0';
      },
    });
    assert.strictEqual(incompatibleCodex.compatible, false);
    assert(incompatibleCodex.error.includes('older than this session'), 'old-only codex should produce an actionable error');
    assert(names.includes('bash'), 'bash should remain available as a launch option');
    assert(!names.includes('qwen'), 'qwen should not be exposed as a launch option');

    console.log('✓ Executable discovery uses process PATH reliably');
  } finally {
    delete process.env.FARMING_CODEX_BIN;
    cleanup(tempDir);
  }
}

run();
