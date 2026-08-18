const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tar = require('tar');
const storageLayout = require('../storage-layout.cjs');
const { runtimeExecutableInvocation } = require('../runtime-executable-invocation.cjs');
const {
  MANIFEST,
  SOURCE_CONFIG,
  dependencyCacheDir,
  dependencyPlatformKey,
  downloadArtifact,
  extractArtifact,
  managedRuntimeUsesConfiguredLoader,
  prepareRuntimeDependencies,
  pruneRuntimeDependencies,
  readRuntimeBinding,
  runtimeArtifactDownloadUrls,
  runtimeBindingId,
  runtimeBindings,
  runtimePlatformKey,
  selectedDependencyDefinitions,
  verifyExecutable,
} = require('../runtime-dependency-manager.cjs');
const { buildManifest } = require('../../scripts/build-runtime-dependency-manifest');

type RuntimeArtifactFixture = {
  url: string;
  archive?: string;
  archiveEntry?: string;
  archivePrefix?: string;
  packagedEntry?: string;
};

type RuntimeDependencyFixture = {
  artifacts: Record<string, RuntimeArtifactFixture>;
};

function writeVersionExecutable(directory, name, version) {
  const target = path.join(directory, process.platform === 'win32' ? `${name}.cmd` : name);
  const source = process.platform === 'win32'
    ? `@echo off\r\necho ${name} ${version}\r\n`
    : `#!/usr/bin/env node\nconsole.log(${JSON.stringify(`${name} ${version}`)});\n`;
  fs.writeFileSync(target, source, { mode: 0o700 });
  return target;
}

async function run() {
  assert.deepStrictEqual(buildManifest(), MANIFEST, 'checked-in runtime manifest must match package-lock');
  assert.strictEqual(SOURCE_CONFIG.authoritativeNpmRegistry, 'https://registry.npmjs.org/');
  assert.strictEqual(SOURCE_CONFIG.defaultNpmMirror, 'https://registry.npmmirror.com/');
  const directInvocation = runtimeExecutableInvocation('/runtime/agent-browser', ['--version'], {});
  assert.deepStrictEqual(directInvocation, {
    command: '/runtime/agent-browser',
    args: ['--version'],
  });
  const loaderInvocation = runtimeExecutableInvocation(
    '/runtime/agent-browser',
    ['--version'],
    {
      FARMING_NODE_LD: '/runtime/ld-2.28.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
    },
    'linux',
  );
  assert.deepStrictEqual(loaderInvocation, {
    command: '/runtime/ld-2.28.so',
    args: ['--library-path', '/runtime/lib', '/runtime/agent-browser', '--version'],
  });
  assert.strictEqual(managedRuntimeUsesConfiguredLoader('agentBrowser'), true);
  assert.strictEqual(
    managedRuntimeUsesConfiguredLoader('agentBrowser', 'linux-x64-musl'),
    false,
  );
  assert.strictEqual(managedRuntimeUsesConfiguredLoader('codex'), false);
  assert.strictEqual(managedRuntimeUsesConfiguredLoader('claude'), false);
  assert.deepStrictEqual(
    selectedDependencyDefinitions(['agentBrowser', 'codex']).map(definition => definition.id),
    ['codex', 'agentBrowser'],
  );
  assert.throws(() => selectedDependencyDefinitions(['unknown']), /Unknown runtime dependency/);
  assert.strictEqual(
    dependencyPlatformKey('agentBrowser', 'linux-x64', {
      FARMING_NODE_LD: '/runtime/ld-2.28.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
    }),
    'linux-x64-musl',
  );
  assert.strictEqual(
    dependencyPlatformKey('codex', 'linux-x64', {
      FARMING_NODE_LD: '/runtime/ld-2.28.so',
      FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
    }),
    'linux-x64',
  );
  assert(MANIFEST.dependencies.codex.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.claude.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.agentBrowser.artifacts[runtimePlatformKey()]);
  for (const dependency of Object.values(MANIFEST.dependencies) as RuntimeDependencyFixture[]) {
    for (const artifact of Object.values(dependency.artifacts)) {
      assert.match(
        artifact.url,
        /^https:\/\/registry\.npmjs\.org\//,
        'startup dependencies must use the public npm registry',
      );
    }
  }
  for (
    const artifact of Object.values(
      MANIFEST.dependencies.agentBrowser.artifacts,
    ) as RuntimeArtifactFixture[]
  ) {
    assert.strictEqual(artifact.archive, 'tgz');
    assert.match(artifact.archiveEntry, /^package\/bin\/agent-browser-/);
    assert(!artifact.archivePrefix);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-manager.'));
  const seedRoot = path.join(root, 'install-seed');
  const targetRoot = path.join(root, 'desktop-target');
  const seedPlatformKey = runtimePlatformKey();
  const browserDependency = MANIFEST.dependencies.agentBrowser;
  const browserArtifact = browserDependency.artifacts[seedPlatformKey];
  const browserCache = dependencyCacheDir(
    seedRoot,
    'agentBrowser',
    browserDependency.version,
    seedPlatformKey,
  );
  fs.mkdirSync(browserCache, { recursive: true });
  const seededBrowser = writeVersionExecutable(
    browserCache,
    browserArtifact.entry,
    browserDependency.reportedVersion || browserDependency.version,
  );
  fs.writeFileSync(path.join(browserCache, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    manifestId: MANIFEST.manifestId,
    id: 'agentBrowser',
    version: browserDependency.version,
    platformKey: seedPlatformKey,
    integrity: browserArtifact.integrity,
    entry: browserArtifact.entry,
    executableSha256: crypto.createHash('sha256').update(fs.readFileSync(seededBrowser)).digest('hex'),
    installedAt: new Date().toISOString(),
  }));
  let seedFetches = 0;
  const seeded = await prepareRuntimeDependencies({
    configDir: targetRoot,
    dependencyIds: ['agentBrowser'],
    env: {
      PATH: process.env.PATH,
      FARMING_RUNTIME_DOWNLOAD_POLICY: 'forbid',
      FARMING_RUNTIME_SEED_DIR: seedRoot,
    },
    fetch: async () => {
      seedFetches += 1;
      throw new Error('startup must not fetch a prepared runtime');
    },
  });
  assert.strictEqual(seedFetches, 0);
  assert.strictEqual(seeded.dependencies[0].executablePath, seededBrowser);
  assert.strictEqual(seeded.dependencies[0].source, 'managed');
  let packagedFetches = 0;
  const packagedRoot = path.join(root, 'package-image');
  const packagedBrowser = path.join(packagedRoot, browserArtifact.packagedEntry);
  const agentBrowserPackageRoot = path.dirname(require.resolve('agent-browser/package.json'));
  const packagedBrowserSource = path.join(
    agentBrowserPackageRoot,
    browserArtifact.archiveEntry.replace(/^package\//, ''),
  );
  fs.mkdirSync(path.dirname(packagedBrowser), { recursive: true });
  fs.copyFileSync(packagedBrowserSource, packagedBrowser);
  if (process.platform !== 'win32') fs.chmodSync(packagedBrowser, 0o755);
  const packaged = await prepareRuntimeDependencies({
    configDir: path.join(root, 'packaged-target'),
    dependencyIds: ['agentBrowser'],
    env: {
      PATH: process.env.PATH,
      FARMING_PACKAGED_RUNTIME_ROOT: packagedRoot,
      FARMING_RUNTIME_DOWNLOAD_POLICY: 'forbid',
    },
    fetch: async () => {
      packagedFetches += 1;
      throw new Error('packaged runtime resolution must not fetch');
    },
  });
  assert.strictEqual(packagedFetches, 0);
  assert.strictEqual(packaged.dependencies[0].source, 'managed');
  assert.strictEqual(
    packaged.dependencies[0].executablePath,
    fs.realpathSync(packagedBrowser),
  );
  const incompletePackageRoot = path.join(root, 'incomplete-package');
  fs.mkdirSync(incompletePackageRoot);
  await assert.rejects(
    prepareRuntimeDependencies({
      configDir: path.join(root, 'incomplete-package-target'),
      dependencyIds: ['agentBrowser'],
      env: {
        PATH: process.env.PATH,
        FARMING_PACKAGED_RUNTIME_ROOT: incompletePackageRoot,
        FARMING_RUNTIME_DOWNLOAD_POLICY: 'forbid',
      },
      fetch: async () => {
        packagedFetches += 1;
        throw new Error('incomplete package image must not fetch');
      },
    }),
    /missing or corrupt in the Farming package image/,
  );
  assert.strictEqual(packagedFetches, 0);
  fs.appendFileSync(seededBrowser, '\ncorrupted after install\n');
  await assert.rejects(
    prepareRuntimeDependencies({
      configDir: path.join(root, 'desktop-corrupt-seed'),
      dependencyIds: ['agentBrowser'],
      env: {
        PATH: process.env.PATH,
        FARMING_RUNTIME_DOWNLOAD_POLICY: 'forbid',
        FARMING_RUNTIME_SEED_DIR: seedRoot,
      },
      fetch: async () => {
        seedFetches += 1;
        throw new Error('corrupt startup seed must not fall back to fetch');
      },
    }),
    /was not prepared during npm install/,
  );
  assert.strictEqual(seedFetches, 0);
  const downloadBody = Buffer.from('verified runtime artifact');
  const downloadArtifactFixture = {
    url: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
    integrity: `sha512-${require('crypto').createHash('sha512').update(downloadBody).digest('base64')}`,
    size: downloadBody.length,
  };
  assert.deepStrictEqual(
    await runtimeArtifactDownloadUrls(downloadArtifactFixture, {
      env: {},
      fetch: async () => new globalThis.Response(JSON.stringify({
        version: '1.0.0',
        dist: {
          integrity: downloadArtifactFixture.integrity,
          tarball: 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
        },
      })),
    }),
    [
      'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
      downloadArtifactFixture.url,
    ],
  );
  assert.deepStrictEqual(
    await runtimeArtifactDownloadUrls(downloadArtifactFixture, {
      env: { FARMING_RUNTIME_NPM_MIRROR: 'off' },
    }),
    [downloadArtifactFixture.url],
  );
  await assert.rejects(
    runtimeArtifactDownloadUrls(downloadArtifactFixture, {
      env: { FARMING_RUNTIME_NPM_MIRROR: 'http://registry.example.com/' },
    }),
    /must be an HTTPS registry origin/,
  );
  const downloadedFixture = path.join(root, 'downloaded-fixture.tgz');
  const requestedUrls = [];
  const downloadProgress = [];
  const downloadRetries = [];
  await downloadArtifact(downloadArtifactFixture, downloadedFixture, {
    env: { FARMING_RUNTIME_NPM_MIRROR: 'https://registry.npmmirror.com/' },
    fetch: async url => {
      requestedUrls.push(String(url));
      if (String(url) === 'https://registry.npmmirror.com/example/1.0.0') {
        return new globalThis.Response(JSON.stringify({
          version: '1.0.0',
          dist: {
            integrity: downloadArtifactFixture.integrity,
            tarball: 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
          },
        }));
      }
      if (String(url) === 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz') {
        return new globalThis.Response('', { status: 404 });
      }
      return new globalThis.Response(downloadBody);
    },
    onDownloadProgress: progress => downloadProgress.push(progress),
    onDownloadRetry: retry => {
      downloadRetries.push(retry);
      throw new Error('progress observer failure must be isolated');
    },
  });
  assert.deepStrictEqual(requestedUrls, [
    'https://registry.npmmirror.com/example/1.0.0',
    'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
    downloadArtifactFixture.url,
  ]);
  assert.deepStrictEqual(fs.readFileSync(downloadedFixture), downloadBody);
  assert.strictEqual(downloadRetries.length, 1);
  assert.match(downloadRetries[0].error, /HTTP 404/);
  assert.strictEqual(downloadProgress[0].receivedBytes, 0);
  assert.strictEqual(downloadProgress.at(-1).receivedBytes, downloadBody.length);
  assert.strictEqual(downloadProgress.at(-1).totalBytes, downloadBody.length);
  const mirroredFixture = path.join(root, 'mirrored-fixture.tgz');
  const mirroredUrls = [];
  await downloadArtifact(downloadArtifactFixture, mirroredFixture, {
    env: { FARMING_RUNTIME_NPM_MIRROR: 'https://registry.npmmirror.com/' },
    fetch: async url => {
      mirroredUrls.push(String(url));
      if (String(url) === 'https://registry.npmmirror.com/example/1.0.0') {
        return new globalThis.Response(JSON.stringify({
          version: '1.0.0',
          dist: {
            integrity: downloadArtifactFixture.integrity,
            tarball: 'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
          },
        }));
      }
      return new globalThis.Response(downloadBody);
    },
  });
  assert.deepStrictEqual(mirroredUrls, [
    'https://registry.npmmirror.com/example/1.0.0',
    'https://registry.npmmirror.com/example/-/example-1.0.0.tgz',
  ]);
  assert.deepStrictEqual(fs.readFileSync(mirroredFixture), downloadBody);

  const archiveFixture = path.join(root, 'archive-fixture');
  const archivePackageBin = path.join(archiveFixture, 'package', 'bin');
  const selectiveArchive = path.join(root, 'agent-browser.tgz');
  const selectiveStaging = path.join(root, 'selective-staging');
  fs.mkdirSync(archivePackageBin, { recursive: true });
  fs.mkdirSync(selectiveStaging);
  fs.writeFileSync(path.join(archivePackageBin, 'agent-browser-platform'), 'selected');
  fs.writeFileSync(path.join(archivePackageBin, 'agent-browser-other'), 'excluded');
  await tar.c({ cwd: archiveFixture, file: selectiveArchive, gzip: true }, ['package']);
  const extracted = await extractArtifact({
    archive: 'tgz',
    archiveEntry: 'package/bin/agent-browser-platform',
    entry: 'agent-browser',
  }, selectiveArchive, selectiveStaging);
  assert.strictEqual(fs.readFileSync(extracted, 'utf8'), 'selected');
  assert(!fs.existsSync(path.join(selectiveStaging, 'agent-browser-other')));

  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    FARMING_CODEX_BIN: writeVersionExecutable(binDir, 'codex', '0.148.0'),
    FARMING_CLAUDE_BIN: writeVersionExecutable(binDir, 'claude', '2.1.0'),
    FARMING_AGENT_BROWSER_BIN: writeVersionExecutable(binDir, 'agent-browser', '0.33.2'),
  };
  const managedCodex = writeVersionExecutable(binDir, 'managed-codex', '0.148.0');
  const managedClaude = writeVersionExecutable(binDir, 'managed-claude', '2.1.0');
  const managedAgentBrowser = writeVersionExecutable(binDir, 'managed-agent-browser', '0.33.2');
  const installRuntime = async (_configDir, definition) => {
    const executablePath = {
      codex: managedCodex,
      claude: managedClaude,
      agentBrowser: managedAgentBrowser,
    }[definition.id];
    assert(executablePath, `unexpected runtime dependency ${definition.id}`);
    return {
      id: definition.id,
      version: MANIFEST.dependencies[definition.id].version,
      source: 'managed',
      executablePath,
    };
  };
  const dependencyProgress = [];
  const result = await prepareRuntimeDependencies({
    configDir: root,
    env,
    installRuntime,
    onProgress: progress => dependencyProgress.push(progress),
  });
  assert.strictEqual(result.dependencies.length, 3);
  assert.deepStrictEqual(
    result.dependencies.map(item => item.source),
    ['managed', 'managed', 'managed'],
  );
  assert.strictEqual(env.FARMING_CODEX_BIN, managedCodex);
  assert.strictEqual(env.CODEX_PATH, managedCodex);
  assert.strictEqual(env.FARMING_CLAUDE_BIN, managedClaude);
  assert.strictEqual(env.CLAUDE_CODE_EXECUTABLE, managedClaude);
  assert.strictEqual(env.FARMING_AGENT_BROWSER_EXECUTABLE, env.FARMING_AGENT_BROWSER_BIN);
  assert.strictEqual(env.FARMING_AGENT_BROWSER_BIN, managedAgentBrowser);
  assert.strictEqual(env.FARMING_RUNTIME_MANIFEST_ID, MANIFEST.manifestId);
  assert.deepStrictEqual(
    dependencyProgress.map(progress => [progress.dependencyId, progress.phase, progress.source]),
    [
      ['codex', 'ready', 'managed'],
      ['claude', 'ready', 'managed'],
      ['agentBrowser', 'ready', 'managed'],
    ],
  );
  const active = JSON.parse(fs.readFileSync(storageLayout.runtimeDependenciesActiveFile(root), 'utf8'));
  const activeBindingId = runtimeBindingId(MANIFEST.manifestId, runtimePlatformKey());
  assert.strictEqual(active.schemaVersion, 2);
  assert.strictEqual(active.bindingId, activeBindingId);
  assert.strictEqual(active.manifestId, MANIFEST.manifestId);
  assert.deepStrictEqual(Object.keys(active.dependencies), ['codex', 'claude', 'agentBrowser']);
  assert.deepStrictEqual(readRuntimeBinding(root, activeBindingId), active);
  assert.deepStrictEqual(runtimeBindings(root), [active]);

  const partialRoot = path.join(root, 'partial');
  const partialEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    FARMING_CODEX_BIN: env.FARMING_CODEX_BIN,
    FARMING_CLAUDE_BIN: env.FARMING_CLAUDE_BIN,
  };
  const partialBrowser = await prepareRuntimeDependencies({
    activate: false,
    configDir: partialRoot,
    dependencyIds: ['agentBrowser'],
    env: partialEnv,
    installRuntime,
  });
  assert.deepStrictEqual(partialBrowser.dependencies.map(item => item.id), ['agentBrowser']);
  assert.strictEqual(fs.existsSync(storageLayout.runtimeDependenciesActiveFile(partialRoot)), false);
  assert.deepStrictEqual(
    Object.keys(readRuntimeBinding(partialRoot, activeBindingId).dependencies),
    ['agentBrowser'],
  );
  const partialCodex = await prepareRuntimeDependencies({
    configDir: partialRoot,
    dependencyIds: ['codex'],
    env: partialEnv,
    installRuntime,
  });
  assert.deepStrictEqual(partialCodex.dependencies.map(item => item.id), ['codex']);
  assert.deepStrictEqual(
    Object.keys(JSON.parse(
      fs.readFileSync(storageLayout.runtimeDependenciesActiveFile(partialRoot), 'utf8'),
    ).dependencies),
    ['agentBrowser', 'codex'],
  );

  const stagedRoot = path.join(root, 'staged');
  fs.mkdirSync(storageLayout.runtimeDependenciesDir(stagedRoot), { recursive: true });
  fs.writeFileSync(storageLayout.runtimeDependenciesActiveFile(stagedRoot), JSON.stringify({
    schemaVersion: 1,
    manifestId: 'running-manifest',
    platformKey: runtimePlatformKey(),
    dependencies: {},
    preparedAt: '2026-07-30T09:00:00.000Z',
  }));
  await prepareRuntimeDependencies({
    activate: false,
    configDir: stagedRoot,
    dependencyIds: ['agentBrowser'],
    env: { PATH: process.env.PATH },
    installRuntime,
  });
  assert.strictEqual(
    JSON.parse(fs.readFileSync(storageLayout.runtimeDependenciesActiveFile(stagedRoot), 'utf8')).manifestId,
    'running-manifest',
    'preparing an update must not replace the running release binding',
  );
  assert(readRuntimeBinding(stagedRoot, activeBindingId));

  const legacyConfigDir = path.join(root, 'legacy-glibc');
  const legacyEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    FARMING_CODEX_BIN: env.FARMING_CODEX_BIN,
    FARMING_CLAUDE_BIN: env.FARMING_CLAUDE_BIN,
    FARMING_NODE_LD: '/runtime/ld-2.28.so',
    FARMING_NODE_LIBRARY_PATH: '/runtime/lib',
  };
  let selectedAgentBrowserPlatform = '';
  await prepareRuntimeDependencies({
    configDir: legacyConfigDir,
    env: legacyEnv,
    platform: 'linux',
    arch: 'x64',
    installRuntime: async (_configDir, definition, selectedPlatformKey) => {
      if (definition.id !== 'agentBrowser') return installRuntime(_configDir, definition);
      selectedAgentBrowserPlatform = selectedPlatformKey;
      return {
        id: 'agentBrowser',
        version: MANIFEST.dependencies.agentBrowser.version,
        platformKey: selectedPlatformKey,
        source: 'managed',
        executablePath: managedAgentBrowser,
      };
    },
  });
  assert.strictEqual(selectedAgentBrowserPlatform, 'linux-x64-musl');
  assert.strictEqual(legacyEnv.FARMING_AGENT_BROWSER_STATIC, '1');
  const legacyMuslCache = dependencyCacheDir(
    legacyConfigDir,
    'agentBrowser',
    MANIFEST.dependencies.agentBrowser.version,
    'linux-x64-musl',
  );
  const legacyGlibcCache = dependencyCacheDir(
    legacyConfigDir,
    'agentBrowser',
    MANIFEST.dependencies.agentBrowser.version,
    'linux-x64',
  );
  fs.mkdirSync(legacyMuslCache, { recursive: true });
  fs.mkdirSync(legacyGlibcCache, { recursive: true });
  fs.writeFileSync(path.join(legacyMuslCache, 'keep.txt'), 'active static runtime');
  fs.writeFileSync(path.join(legacyGlibcCache, 'remove.txt'), 'inactive glibc runtime');
  await pruneRuntimeDependencies({ configDir: legacyConfigDir, env: legacyEnv });
  assert(fs.existsSync(legacyMuslCache), 'prune must retain the selected musl agent-browser');
  assert(!fs.existsSync(legacyGlibcCache), 'prune must remove the inactive glibc agent-browser');

  const platformKey = runtimePlatformKey();
  const currentAgentBrowserCache = dependencyCacheDir(
    root,
    'agentBrowser',
    MANIFEST.dependencies.agentBrowser.version,
    platformKey,
  );
  const oldAgentBrowserCache = dependencyCacheDir(root, 'agentBrowser', '0.31.0', platformKey);
  const oldCodexCache = dependencyCacheDir(root, 'codex', '0.143.0', platformKey);
  fs.mkdirSync(currentAgentBrowserCache, { recursive: true });
  fs.mkdirSync(oldAgentBrowserCache, { recursive: true });
  fs.mkdirSync(oldCodexCache, { recursive: true });
  const outsideCache = path.join(root, 'outside-cache');
  fs.mkdirSync(outsideCache);
  fs.writeFileSync(path.join(outsideCache, 'keep.txt'), 'keep');
  if (process.platform !== 'win32') {
    fs.symlinkSync(
      outsideCache,
      path.join(path.dirname(currentAgentBrowserCache), 'other-platform'),
      'dir',
    );
  }
  const pruned = await pruneRuntimeDependencies({ configDir: root, env });
  assert(pruned.removed.includes(path.dirname(oldAgentBrowserCache)));
  assert(pruned.removed.includes(path.dirname(oldCodexCache)));
  assert(fs.existsSync(currentAgentBrowserCache));
  assert(!fs.existsSync(oldAgentBrowserCache));
  assert(!fs.existsSync(oldCodexCache));
  assert.strictEqual(fs.readFileSync(path.join(outsideCache, 'keep.txt'), 'utf8'), 'keep');

  const multiRoot = path.join(root, 'multi-binding');
  const multiPlatform = runtimePlatformKey();
  const bindingVersions = [
    ['active-binding', '0.40.0', '2026-07-30T10:00:00.000Z'],
    ['prepared-binding', '0.41.0', '2026-07-30T12:00:00.000Z'],
    ['previous-binding', '0.39.0', '2026-07-30T11:00:00.000Z'],
    ['stale-binding', '0.38.0', '2026-07-29T10:00:00.000Z'],
  ];
  fs.mkdirSync(storageLayout.runtimeDependencyBindingsDir(multiRoot), { recursive: true });
  for (const [bindingId, version, preparedAt] of bindingVersions) {
    const cacheDir = dependencyCacheDir(multiRoot, 'agentBrowser', version, multiPlatform);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'runtime'), bindingId);
    const binding = {
      schemaVersion: 2,
      bindingId,
      manifestId: bindingId,
      platformKey: multiPlatform,
      dependencies: {
        agentBrowser: {
          version,
          platformKey: multiPlatform,
          source: 'managed',
          executablePath: path.join(cacheDir, 'agent-browser'),
        },
      },
      preparedAt,
    };
    fs.writeFileSync(
      storageLayout.runtimeDependencyBindingFile(multiRoot, bindingId),
      JSON.stringify(binding),
    );
    if (bindingId === 'active-binding') {
      fs.writeFileSync(storageLayout.runtimeDependenciesActiveFile(multiRoot), JSON.stringify(binding));
    }
  }
  const multiPruned = await pruneRuntimeDependencies({
    configDir: multiRoot,
    env,
    retainedBindings: 3,
  });
  for (const version of ['0.40.0', '0.41.0', '0.39.0']) {
    assert(fs.existsSync(dependencyCacheDir(multiRoot, 'agentBrowser', version, multiPlatform)));
  }
  assert(!fs.existsSync(dependencyCacheDir(multiRoot, 'agentBrowser', '0.38.0', multiPlatform)));
  assert(!fs.existsSync(storageLayout.runtimeDependencyBindingFile(multiRoot, 'stale-binding')));
  assert(multiPruned.removed.includes(
    storageLayout.runtimeDependencyBindingFile(multiRoot, 'stale-binding'),
  ));

  const staleInjectedEnv = {
    PATH: [
      binDir,
      path.dirname(process.execPath),
      '/usr/bin',
      '/bin',
    ].join(path.delimiter),
    FARMING_CODEX_BIN: '/old-farming-runtime/codex',
    FARMING_CLAUDE_BIN: '/old-farming-runtime/claude',
    FARMING_AGENT_BROWSER_BIN: '/old-farming-runtime/agent-browser',
    FARMING_RUNTIME_MANIFEST_ID: 'previous-manifest',
  };
  const refreshed = await prepareRuntimeDependencies({
    configDir: path.join(root, 'stale-manifest'),
    env: staleInjectedEnv,
    installRuntime,
  });
  assert.deepStrictEqual(
    refreshed.dependencies.map(item => item.source),
    ['managed', 'managed', 'managed'],
  );
  assert.strictEqual(staleInjectedEnv.FARMING_CODEX_BIN, managedCodex);
  assert.strictEqual(staleInjectedEnv.FARMING_CLAUDE_BIN, managedClaude);
  assert.strictEqual(
    staleInjectedEnv.FARMING_AGENT_BROWSER_BIN,
    env.FARMING_AGENT_BROWSER_BIN,
  );

  const invalid = writeVersionExecutable(binDir, 'wrong-codex', '0.1.0');
  assert.strictEqual((await verifyExecutable(invalid, '0.148.0')).valid, false);
  const ignoredSystemOverride = await prepareRuntimeDependencies({
    configDir: path.join(root, 'wrong'),
    env: {
      ...env,
      FARMING_CODEX_BIN: invalid,
      FARMING_RUNTIME_MANIFEST_ID: '',
    },
    installRuntime,
  });
  assert.strictEqual(
    ignoredSystemOverride.dependencies.find(item => item.id === 'codex').executablePath,
    managedCodex,
    'managed ACP preparation must not accept a system Codex override',
  );

  console.log('✓ startup dependencies publish retained multi-version bindings and activate atomically');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
