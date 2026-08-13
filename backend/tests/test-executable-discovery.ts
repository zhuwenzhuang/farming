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
  matchesExecutableIdentity,
  listAvailableAgents,
  parseCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable,
  resolveFarmingOwnedExecutable,
  resolveProviderAcpExecutable,
  resolveProviderTerminalExecutable,
  resolveTerminalCodexExecutable,
  resolveTerminalExecutable,
  validatePersistedAcpExecutable,
} = require('../executable-discovery.cjs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'farming-exec-'));
}

function writeExecutable(dir, name, contents = '#!/usr/bin/env bash\n') {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
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
    const pi = writeExecutable(
      tempDir,
      'pi',
      [
        '#!/usr/bin/env bash',
        'if [ "$1" = "--version" ]; then',
        '  printf "%s\\n" "pi 0.84.1"',
        'else',
        '  printf "%s\\n" "pi - AI coding assistant with read, bash, edit, write tools"',
        'fi',
        '',
      ].join('\n'),
    );
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
      names.slice(0, 6),
      ['codex', 'claude', 'pi', 'qoder', 'qwen', 'bash'],
      'available launch agents should keep the stable product order while omitting missing agents'
    );
    assert(names.includes('claude'), 'claude should be discovered from PATH');
    assert(names.includes('qoder'), 'qoder should be discovered from qodercli on PATH');
    assert(names.includes('qwen'), 'Qwen Code should be discovered from qwen on PATH');
    assert(names.includes('pi'), 'Pi should be discovered only after its product help probe passes');
    assert.strictEqual(matchesExecutableIdentity('pi', pi), true);
    assert.strictEqual(
      resolveAgentExecutable('pi', tempDir),
      path.resolve(pi),
      'Pi must resolve from the supplied shell PATH to an absolute persisted path',
    );
    assert.strictEqual(
      resolveProviderAcpExecutable('pi', tempDir).path,
      path.resolve(pi),
      'Pi Chat must resolve the verified Pi executable from the supplied shell PATH',
    );
    assert(names.includes('codex'), 'codex should be discovered from the preferred Codex.app-style binary');
    assert.strictEqual(codex.resolvedPath, preferredCodex, 'preferred codex binary should win over PATH');
    assert.strictEqual(agents.find((agent) => agent.name === 'qoder').command, 'qodercli');
    assert.strictEqual(resolveAgentExecutable('codex', `${tempDir}${path.delimiter}/usr/bin`), preferredCodex);
    assert.deepStrictEqual(
      getPreferredExecutableCandidates('codex', tempDir).slice(0, 3),
      [
        preferredCodex,
        '/Applications/Codex.app/Contents/Resources/codex',
        '/Applications/ChatGPT.app/Contents/Resources/codex',
      ],
      'Codex discovery should prefer an explicit override, then cover both macOS app bundle names'
    );
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
    const providerIncompatibleCodex = resolveProviderTerminalExecutable('codex', '0.142.0', '', {
      candidates: [oldCodex],
      readVersion() {
        return '0.133.0';
      },
    });
    assert.strictEqual(
      providerIncompatibleCodex.compatible,
      false,
      'the Provider executable policy should enforce Codex session compatibility',
    );
    assert.strictEqual(
      resolveProviderTerminalExecutable('codex', '999.0.0', '', {
        trustConfiguredExecutable: true,
      }).path,
      preferredCodex,
      'an explicit trusted test executable should be selected through discovery policy',
    );

    const systemCodex = writeExecutable(tempDir, 'system-codex');
    const farmingCodex = writeExecutable(tempDir, 'farming-codex');
    const sameVersion = resolveTerminalCodexExecutable('', '', {
      systemCandidates: [systemCodex],
      farmingCandidates: [farmingCodex],
      readVersion(filePath) {
        return filePath === systemCodex ? '0.146.0' : '0.146.0';
      },
    });
    assert.strictEqual(sameVersion.path, systemCodex, 'equal versions should prefer the system Codex');

    clearExecutableVersionCache();
    const newerFarming = resolveTerminalCodexExecutable('', '', {
      systemCandidates: [systemCodex],
      farmingCandidates: [farmingCodex],
      readVersion(filePath) {
        return filePath === systemCodex ? '0.146.0' : '0.147.0';
      },
    });
    assert.strictEqual(newerFarming.path, farmingCodex, 'a newer Farming Codex may replace the system Codex');

    clearExecutableVersionCache();
    const newerSystem = resolveTerminalExecutable('claude', '', {
      systemCandidates: [systemCodex],
      farmingCandidates: [farmingCodex],
      readVersion(filePath) {
        return filePath === systemCodex ? '2.2.0' : '2.1.0';
      },
    });
    assert.strictEqual(newerSystem.path, systemCodex, 'a newer system executable should win for Terminal');
    assert.strictEqual(newerSystem.source, 'system');
    const providerClaude = resolveProviderTerminalExecutable('claude', '999.0.0', '', {
      systemCandidates: [systemCodex],
      farmingCandidates: [farmingCodex],
      readVersion(filePath) {
        return filePath === systemCodex ? '2.2.0' : '2.1.0';
      },
    });
    assert.strictEqual(providerClaude.path, systemCodex);
    assert.strictEqual(providerClaude.compatible, true, 'providers without a resume version policy remain compatible');
    const compatiblePiAcp = resolveProviderAcpExecutable('pi', '', { candidates: [pi] });
    assert.strictEqual(compatiblePiAcp.path, path.resolve(pi));
    assert.strictEqual(compatiblePiAcp.version, '0.84.1');
    assert.strictEqual(compatiblePiAcp.compatible, true);
    const oldPi = writeExecutable(
      tempDir,
      'old-pi',
      '#!/usr/bin/env bash\nprintf "%s\\n" "pi - AI coding assistant with read, bash, edit, write tools"\n',
    );
    const incompatiblePiAcp = resolveProviderAcpExecutable('pi', '', {
      candidates: [oldPi],
      readVersion: () => '0.79.9',
    });
    assert.strictEqual(incompatiblePiAcp.compatible, false);
    assert.match(incompatiblePiAcp.error, /0\.80\.4 or newer/);
    const unknownPiAcp = resolveProviderAcpExecutable('pi', '', {
      candidates: [oldPi],
      readVersion: () => '',
      cacheVersions: false,
    });
    assert.strictEqual(unknownPiAcp.compatible, false);
    assert.match(unknownPiAcp.error, /version could not be verified/);
    const explicitOldPiAcp = resolveProviderAcpExecutable('pi', tempDir, {
      candidates: [oldPi],
      cacheVersions: false,
      readVersion: () => '0.79.9',
    });
    assert.strictEqual(explicitOldPiAcp.path, path.resolve(oldPi));
    assert.strictEqual(explicitOldPiAcp.compatible, false);
    assert.match(explicitOldPiAcp.error, /0\.80\.4 or newer/);
    const wrongExplicitPi = writeExecutable(
      tempDir,
      'not-really-pi',
      '#!/usr/bin/env bash\nprintf "%s\\n" "unrelated executable"\n',
    );
    const wrongExplicitPiAcp = resolveProviderAcpExecutable('pi', tempDir, {
      candidates: [wrongExplicitPi],
    });
    assert.strictEqual(wrongExplicitPiAcp.path, '');
    assert.strictEqual(wrongExplicitPiAcp.compatible, false);
    assert.match(wrongExplicitPiAcp.error, /not a recognized Pi CLI/);
    const missingExplicitPiAcp = resolveProviderAcpExecutable('pi', tempDir, {
      candidates: [path.join(tempDir, 'missing-pi')],
    });
    assert.strictEqual(missingExplicitPiAcp.path, '');
    assert.strictEqual(missingExplicitPiAcp.compatible, false);
    assert.match(missingExplicitPiAcp.error, /missing or not executable/);
    assert.strictEqual(
      resolveFarmingOwnedExecutable('codex', { farmingCandidates: [farmingCodex] }),
      farmingCodex,
      'ACP should resolve its explicit Farming-owned executable',
    );

    const runtimeDir = path.join(tempDir, 'config', 'runtimes', 'codex');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const persistedManagedCodex = writeExecutable(runtimeDir, 'codex');
    const ownershipEnvironment = { FARMING_CONFIG_DIR: path.join(tempDir, 'config') };
    assert.deepStrictEqual(
      validatePersistedAcpExecutable('codex', persistedManagedCodex, {
        environment: ownershipEnvironment,
        requireFarmingOwned: true,
      }),
      { error: '', path: persistedManagedCodex },
      'managed ACP recovery should accept the exact persisted Farming-owned executable',
    );
    assert.match(
      validatePersistedAcpExecutable('codex', '', { environment: ownershipEnvironment }).error,
      /none was recorded/,
      'ACP recovery should fail closed when the persisted executable is missing',
    );
    assert.match(
      validatePersistedAcpExecutable('codex', 'codex', { environment: ownershipEnvironment }).error,
      /absolute path/,
      'ACP recovery should not rediscover a relative persisted executable',
    );
    assert.match(
      validatePersistedAcpExecutable('codex', systemCodex, {
        environment: ownershipEnvironment,
        requireFarmingOwned: true,
      }).error,
      /not Farming-owned/,
      'managed ACP recovery should reject a usable executable outside Farming ownership',
    );
    assert.deepStrictEqual(
      validatePersistedAcpExecutable('claude', systemCodex),
      { error: '', path: systemCodex },
      'system-policy ACP recovery should still reuse its exact persisted executable',
    );
    assert.match(
      validatePersistedAcpExecutable('pi', oldPi, {
        cacheVersions: false,
        readVersion: () => '0.79.9',
      }).error,
      /0\.80\.4 or newer/,
      'Pi Chat recovery must reject a persisted CLI older than the adapter minimum',
    );
    assert.deepStrictEqual(
      validatePersistedAcpExecutable('pi', pi, { cacheVersions: false }),
      { error: '', path: pi },
      'Pi Chat recovery should accept the exact persisted compatible CLI',
    );
    assert(names.includes('bash'), 'bash should remain available as a launch option');
    assert(names.includes('qwen'), 'an installed qwen executable should be exposed as a launch option');

    const unrelatedPiDir = makeTempDir();
    try {
      const unrelatedPi = writeExecutable(
        unrelatedPiDir,
        'pi',
        '#!/usr/bin/env bash\nprintf "%s\\n" "Raspberry Pi utility"\n',
      );
      clearExecutableVersionCache();
      assert.strictEqual(matchesExecutableIdentity('pi', unrelatedPi), false);
      assert.strictEqual(
        resolveAgentExecutable('pi', unrelatedPiDir),
        '',
        'an unrelated executable named pi must not be shown as the Pi coding agent',
      );
    } finally {
      cleanup(unrelatedPiDir);
    }

    console.log('✓ Executable discovery uses process PATH reliably');
  } finally {
    delete process.env.FARMING_CODEX_BIN;
    cleanup(tempDir);
  }
}

run();
