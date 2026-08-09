const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  compareCliVersions,
  getPathDirectories,
  getAcpFarmingOwnedExecutableCandidates,
  getFarmingOwnedExecutableCandidates,
  getPreferredExecutableCandidates,
  clearExecutableVersionCache,
  isExecutable,
  isFarmingOwnedPath,
  listAvailableAgents,
  parseCliVersion,
  resolveAgentExecutable,
  resolveCompatibleCodexExecutable,
  resolveFarmingOwnedExecutable,
  resolveTerminalCodexExecutable,
  resolveTerminalExecutable,
} = require('../executable-discovery.cjs');

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
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../server.cts'), 'utf8');
  const agentManagerSource = fs.readFileSync(path.resolve(__dirname, '../agent-manager.cts'), 'utf8');
  const launchPolicySource = fs.readFileSync(path.resolve(__dirname, '../agent-launch-policy.cts'), 'utf8');
  assert(
    serverSource.includes("agentManager.resolveAgentShellEnv('', { maxAgeMs: INTERACTIVE_REFRESH_CACHE_MAX_AGE_MS })")
      && serverSource.includes('return withLaunchCapabilities(listAvailableAgents(pathEnv))')
      && serverSource.includes("res.setHeader('Cache-Control', 'no-store')"),
    'executable discovery requests should use a short backend shell PATH cache without HTTP caching'
  );
  assert(
    agentManagerSource.includes("this.resolveAgentShellEnv('', { maxAgeMs: AGENT_DISCOVERY_CACHE_MAX_AGE_MS })"),
    'Agent launch should read the user shell PATH through the short backend discovery cache'
  );
  assert(
    [
      'resolveAgentExecutable(program, launchPathEnv)',
      "resolveTerminalCodexExecutable(options.requiredCliVersion || '', launchPathEnv)",
      'resolveFarmingOwnedExecutable(structuredRuntimeProvider)',
    ].every((ownedCall) => !agentManagerSource.includes(ownedCall)),
    'AgentManager must delegate launch executable selection instead of resolving executables itself'
  );
  assert(
    agentManagerSource.includes("terminalPolicy: { kind: 'system' }")
      && agentManagerSource.includes("kind: 'codex-versioned'")
      && agentManagerSource.includes("phase: existingProviderSessionRecord ? 'resume' : 'fresh'"),
    'AgentManager must declare an explicit runtime executable policy on every delegated selection'
  );
  assert.strictEqual(
    agentManagerSource.includes('resolvedExecutable = process.env.FARMING_CODEX_BIN'),
    false,
    'E2E executable candidates must pass through launch policy validation instead of direct assignment',
  );
  assert(
    launchPolicySource.includes('resolveSystemTerminalExecutable(program, pathEnv)')
      && launchPolicySource.includes('resolveTerminalExecutableVersion(program, requiredCliVersion, pathEnv)')
      && launchPolicySource.includes('resolveFarmingOwnedExecutable(provider)')
      && launchPolicySource.includes('resolveSystemAcpExecutable(program, pathEnv)'),
    'the launch policy must own each runtime-specific executable resolution'
  );
  assert(
    ['#selectVersionedTerminal(', '#freshManaged(', '#resumeManaged(', '#resumeSystem(']
      .every((selectionPath) => launchPolicySource.includes(selectionPath)),
    'the launch policy must keep system Terminal, Codex-versioned, fresh managed and persisted resume paths distinct'
  );
  assert(
    ["'discovered-managed'", "'persisted-managed'", "'persisted-system'", "'system'"]
      .every((decisionSource) => launchPolicySource.includes(decisionSource)),
    'each launch selection path must report its own decision source'
  );

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

    const ownershipConfigDir = path.join(tempDir, 'ownership-config');
    const ownershipRuntimeDir = path.join(ownershipConfigDir, 'runtimes');
    fs.mkdirSync(ownershipRuntimeDir, { recursive: true });
    const ownedExecutable = writeExecutable(ownershipRuntimeDir, 'owned-codex');
    const foreignDir = path.join(tempDir, 'foreign');
    fs.mkdirSync(foreignDir, { recursive: true });
    const foreignExecutable = writeExecutable(foreignDir, 'foreign-codex');
    const internalSymlink = path.join(ownershipRuntimeDir, 'internal-codex-link');
    const escapeSymlink = path.join(ownershipRuntimeDir, 'escape-codex-link');
    fs.symlinkSync(ownedExecutable, internalSymlink);
    fs.symlinkSync(foreignExecutable, escapeSymlink);
    const ownershipEnv = { FARMING_CONFIG_DIR: ownershipConfigDir };
    assert.strictEqual(
      isFarmingOwnedPath(internalSymlink, ownershipEnv),
      true,
      'an existing symlink whose canonical target stays inside the runtime root remains owned',
    );
    assert.strictEqual(
      isFarmingOwnedPath(escapeSymlink, ownershipEnv),
      false,
      'a lexical child symlink escaping the runtime root must not prove Farming ownership',
    );
    assert.strictEqual(
      isFarmingOwnedPath(path.join(ownershipRuntimeDir, 'missing-codex'), ownershipEnv),
      false,
      'a non-existing path cannot prove Farming ownership',
    );
    process.env.FARMING_CODEX_BIN = preferredCodex;

    const agents = listAvailableAgents(`${tempDir}${path.delimiter}/usr/bin`);
    const names = agents.map((agent) => agent.name);
    const codex = agents.find((agent) => agent.name === 'codex');

    assert.deepStrictEqual(
      names.slice(0, 5),
      ['codex', 'claude', 'qoder', 'qwen', 'bash'],
      'available launch agents should keep the stable product order while omitting missing agents'
    );
    assert(names.includes('claude'), 'claude should be discovered from PATH');
    assert(names.includes('qoder'), 'qoder should be discovered from qodercli on PATH');
    assert(names.includes('qwen'), 'Qwen Code should be discovered from qwen on PATH');
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
    const e2eCodex = resolveTerminalCodexExecutable('0.100.0', '', {
      environment: {
        FARMING_CODEX_BIN: newCodex,
        FARMING_E2E_FAKE_EXECUTABLES: '1',
      },
      readVersion: () => '0.147.0',
    });
    assert.strictEqual(
      e2eCodex.path,
      newCodex,
      'the E2E Codex candidate must enter the normal executable and version validation path',
    );
    assert.strictEqual(
      resolveFarmingOwnedExecutable('codex', { farmingCandidates: [farmingCodex] }),
      farmingCodex,
      'ACP should resolve its explicit Farming-owned executable',
    );
    assert(names.includes('bash'), 'bash should remain available as a launch option');
    assert(names.includes('qwen'), 'an installed qwen executable should be exposed as a launch option');

    // P1-A: malformed, absent, or timed-out version must fail closed when requiredCliVersion is set
    clearExecutableVersionCache();
    const malformedCodex = writeExecutable(tempDir, 'malformed-codex');
    const malformedResult = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [malformedCodex],
      readVersion: () => 'not-a-version',
    });
    assert.strictEqual(malformedResult.compatible, false, 'malformed --version output must be incompatible');
    assert(malformedResult.error.includes('could not be verified'), 'malformed version error must be actionable');

    clearExecutableVersionCache();
    const absentResult = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [malformedCodex],
      readVersion: () => '',
    });
    assert.strictEqual(absentResult.compatible, false, 'absent --version output must be incompatible');

    clearExecutableVersionCache();
    const timeoutResult = resolveTerminalCodexExecutable('0.142.0', '', {
      systemCandidates: [malformedCodex],
      farmingCandidates: [],
      readVersion: () => '',
    });
    assert.strictEqual(timeoutResult.compatible, false, 'timed-out --version must be incompatible via Terminal resolver');
    assert(timeoutResult.error.includes('could not be verified'), 'timeout error must be actionable');

    clearExecutableVersionCache();
    const mixedResult = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [malformedCodex, newCodex],
      readVersion(filePath) {
        return filePath === newCodex ? '0.142.3' : '';
      },
    });
    assert.strictEqual(mixedResult.compatible, true, 'a compatible known-version candidate still wins');
    assert.strictEqual(mixedResult.path, newCodex);

    clearExecutableVersionCache();
    const noRequiredMalformed = resolveCompatibleCodexExecutable('', '', {
      candidates: [malformedCodex],
      readVersion: () => 'garbage',
    });
    assert.strictEqual(noRequiredMalformed.compatible, true, 'no required version preserves existing permissive behavior');
    assert.strictEqual(noRequiredMalformed.path, malformedCodex);

    clearExecutableVersionCache();
    const preferSystemUnknown = resolveCompatibleCodexExecutable('0.142.0', '', {
      preferSystem: true,
      systemCandidates: [malformedCodex],
      farmingCandidates: [],
      readVersion: () => '',
    });
    assert.strictEqual(preferSystemUnknown.compatible, false, 'preferSystem unknown version must fail closed');

    // P1 liveness: transient timeout/malformed output must not permanently poison the cache
    clearExecutableVersionCache();
    const transientCodex = writeExecutable(tempDir, 'transient-codex');
    let transientReads = 0;
    let transientVersion = '';
    const transientReader = () => { transientReads += 1; return transientVersion; };

    const firstAttempt = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [transientCodex],
      readVersion: transientReader,
    });
    assert.strictEqual(firstAttempt.compatible, false, 'empty version from transient timeout must fail closed');
    assert.strictEqual(transientReads, 1);

    const secondAttempt = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [transientCodex],
      readVersion: transientReader,
    });
    assert.strictEqual(secondAttempt.compatible, false, 'still fails while executable is unresponsive');
    assert.strictEqual(transientReads, 2, 'empty version must not be cached — the reader must re-probe');

    transientVersion = '0.143.0';
    const recoveredAttempt = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [transientCodex],
      readVersion: transientReader,
    });
    assert.strictEqual(recoveredAttempt.compatible, true, 'explicit retry after transient failure must succeed');
    assert.strictEqual(recoveredAttempt.path, transientCodex);
    assert.strictEqual(recoveredAttempt.version, '0.143.0');
    assert.strictEqual(transientReads, 3, 'recovery requires exactly one more probe');

    const cachedAttempt = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [transientCodex],
      readVersion: transientReader,
    });
    assert.strictEqual(cachedAttempt.compatible, true, 'positive version remains cached');
    assert.strictEqual(transientReads, 3, 'positive version must be served from cache without re-probe');
    clearExecutableVersionCache();

    // P2: malformed nonempty text must not poison the cache for later explicit retries
    clearExecutableVersionCache();
    const poisonCodex = writeExecutable(tempDir, 'poison-codex');
    let poisonReads = 0;
    let poisonVersion = 'garbage-output';
    const poisonReader = () => { poisonReads += 1; return poisonVersion; };

    const malformedFirst = resolveCompatibleCodexExecutable('', '', {
      candidates: [poisonCodex],
      readVersion: poisonReader,
    });
    assert.strictEqual(malformedFirst.path, poisonCodex, 'no-required still returns the raw malformed result');
    assert.strictEqual(poisonReads, 1, 'first probe reads once');

    poisonVersion = '0.150.0';
    const validSecond = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [poisonCodex],
      readVersion: poisonReader,
    });
    assert.strictEqual(validSecond.compatible, true, 'explicit retry after malformed must re-probe and succeed');
    assert.strictEqual(validSecond.version, '0.150.0');
    assert.strictEqual(poisonReads, 2, 'malformed must not be cached — reader must be called again');

    const cachedThird = resolveCompatibleCodexExecutable('0.142.0', '', {
      candidates: [poisonCodex],
      readVersion: poisonReader,
    });
    assert.strictEqual(cachedThird.compatible, true, 'valid version remains cached after recovery');
    assert.strictEqual(cachedThird.version, '0.150.0');
    assert.strictEqual(poisonReads, 2, 'valid version must be served from cache without re-probe');
    clearExecutableVersionCache();

    // P1-B: Terminal discovery must never consume FARMING_ACP_CODEX_BIN / FARMING_ACP_CLAUDE_BIN
    const acpEnvDir = path.join(tempDir, 'acp-env');
    fs.mkdirSync(acpEnvDir, { recursive: true });
    const acpOnlyExecutable = writeExecutable(acpEnvDir, 'acp-codex');
    const acpEnv = { FARMING_ACP_CODEX_BIN: acpOnlyExecutable, FARMING_CONFIG_DIR: ownershipConfigDir };
    const terminalCandidates = getFarmingOwnedExecutableCandidates('codex', acpEnv);
    assert.strictEqual(
      terminalCandidates.includes(acpOnlyExecutable),
      false,
      'Terminal farming candidates must never include FARMING_ACP_CODEX_BIN',
    );

    // ACP env path that fails ownership proof is excluded from ACP candidates too
    const acpCandidatesUnowned = getAcpFarmingOwnedExecutableCandidates('codex', acpEnv);
    assert.strictEqual(
      acpCandidatesUnowned.includes(acpOnlyExecutable),
      false,
      'ACP candidate without canonical realpath ownership proof must be excluded',
    );

    // ACP env path that passes ownership proof is included in ACP candidates
    const acpOwnedDir = path.join(ownershipConfigDir, 'runtimes', 'acp-managed');
    fs.mkdirSync(acpOwnedDir, { recursive: true });
    const acpOwnedExecutable = writeExecutable(acpOwnedDir, 'acp-owned-codex');
    const acpOwnedEnv = { FARMING_ACP_CODEX_BIN: acpOwnedExecutable, FARMING_CONFIG_DIR: ownershipConfigDir };
    const acpCandidatesOwned = getAcpFarmingOwnedExecutableCandidates('codex', acpOwnedEnv);
    assert.strictEqual(
      acpCandidatesOwned.includes(acpOwnedExecutable),
      true,
      'ACP candidate with canonical realpath ownership proof must be included',
    );
    assert.strictEqual(
      getFarmingOwnedExecutableCandidates('codex', acpOwnedEnv).includes(acpOwnedExecutable),
      false,
      'Terminal candidates must remain independent of ACP env even when ownership passes',
    );

    // A high-version arbitrary ACP env path cannot override Terminal system candidate
    clearExecutableVersionCache();
    const systemCodexForOverride = writeExecutable(tempDir, 'system-codex-override');
    const terminalResolution = resolveTerminalCodexExecutable('0.100.0', tempDir, {
      environment: { FARMING_ACP_CODEX_BIN: acpOwnedExecutable, FARMING_CONFIG_DIR: ownershipConfigDir },
      farmingCandidates: getFarmingOwnedExecutableCandidates('codex', acpOwnedEnv),
      systemCandidates: [systemCodexForOverride],
      readVersion(filePath) {
        if (filePath === acpOwnedExecutable) return '99.0.0';
        return '0.147.0';
      },
    });
    assert.strictEqual(
      terminalResolution.path,
      systemCodexForOverride,
      'a high-version ACP env path must not override the Terminal system candidate',
    );
    assert.strictEqual(terminalResolution.compatible, true);

    // isFarmingOwnedPath rejects an arbitrary ACP env path outside Farming roots
    assert.strictEqual(
      isFarmingOwnedPath(acpOnlyExecutable, acpEnv),
      false,
      'an arbitrary ACP env path outside Farming roots cannot be mislabeled as Farming-owned',
    );

    console.log('✓ Executable discovery uses process PATH reliably');
  } finally {
    delete process.env.FARMING_CODEX_BIN;
    cleanup(tempDir);
  }
}

run();
