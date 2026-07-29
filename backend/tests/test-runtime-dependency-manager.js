const assert = require('assert');
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
  downloadArtifact,
  extractArtifact,
  managedRuntimeUsesConfiguredLoader,
  prepareRuntimeDependencies,
  pruneRuntimeDependencies,
  runtimeArtifactDownloadUrls,
  runtimePlatformKey,
  verifyExecutable,
} = require('../runtime-dependency-manager.cjs');
const { buildManifest } = require('../../scripts/build-runtime-dependency-manifest');

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
  assert.strictEqual(managedRuntimeUsesConfiguredLoader('codex'), false);
  assert.strictEqual(managedRuntimeUsesConfiguredLoader('claude'), false);
  assert(MANIFEST.dependencies.codex.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.claude.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.agentBrowser.artifacts[runtimePlatformKey()]);
  for (const dependency of Object.values(MANIFEST.dependencies)) {
    for (const artifact of Object.values(dependency.artifacts)) {
      assert.match(
        artifact.url,
        /^https:\/\/registry\.npmjs\.org\//,
        'startup dependencies must use the public npm registry',
      );
    }
  }
  for (const artifact of Object.values(MANIFEST.dependencies.agentBrowser.artifacts)) {
    assert.strictEqual(artifact.archive, 'tgz');
    assert.match(artifact.archiveEntry, /^package\/bin\/agent-browser-/);
    assert(!artifact.archivePrefix);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-manager.'));
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
  await downloadArtifact(downloadArtifactFixture, downloadedFixture, {
    env: { FARMING_RUNTIME_NPM_MIRROR: 'https://registry.npmmirror.com/' },
    fetch: async url => {
      requestedUrls.push(String(url));
      if (String(url).startsWith('https://registry.npmmirror.com/')) {
        return new globalThis.Response('', { status: 404 });
      }
      return new globalThis.Response(downloadBody);
    },
  });
  assert.deepStrictEqual(requestedUrls, [
    'https://registry.npmmirror.com/example/1.0.0',
    downloadArtifactFixture.url,
  ]);
  assert.deepStrictEqual(fs.readFileSync(downloadedFixture), downloadBody);
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
  const env = {
    PATH: process.env.PATH,
    FARMING_CODEX_BIN: writeVersionExecutable(binDir, 'codex', '0.144.6'),
    FARMING_CLAUDE_BIN: writeVersionExecutable(binDir, 'claude', '2.1.0'),
    FARMING_AGENT_BROWSER_BIN: writeVersionExecutable(binDir, 'agent-browser', '0.32.3'),
  };
  const managedAgentBrowser = writeVersionExecutable(binDir, 'managed-agent-browser', '0.32.3');
  const installRuntime = async (_configDir, definition) => {
    assert.strictEqual(definition.id, 'agentBrowser');
    return {
      id: 'agentBrowser',
      version: MANIFEST.dependencies.agentBrowser.version,
      source: 'managed',
      executablePath: managedAgentBrowser,
    };
  };
  const result = await prepareRuntimeDependencies({ configDir: root, env, installRuntime });
  assert.strictEqual(result.dependencies.length, 3);
  assert.deepStrictEqual(
    result.dependencies.map(item => item.source),
    ['system', 'system', 'managed'],
  );
  assert.strictEqual(env.CODEX_PATH, env.FARMING_CODEX_BIN);
  assert.strictEqual(env.CLAUDE_CODE_EXECUTABLE, env.FARMING_CLAUDE_BIN);
  assert.strictEqual(env.FARMING_AGENT_BROWSER_EXECUTABLE, env.FARMING_AGENT_BROWSER_BIN);
  assert.strictEqual(env.FARMING_AGENT_BROWSER_BIN, managedAgentBrowser);
  assert.strictEqual(env.FARMING_RUNTIME_MANIFEST_ID, MANIFEST.manifestId);
  const active = JSON.parse(fs.readFileSync(storageLayout.runtimeDependenciesActiveFile(root), 'utf8'));
  assert.strictEqual(active.manifestId, MANIFEST.manifestId);
  assert.deepStrictEqual(Object.keys(active.dependencies), ['codex', 'claude', 'agentBrowser']);

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
    ['system', 'system', 'managed'],
  );
  assert.strictEqual(staleInjectedEnv.FARMING_CODEX_BIN, env.FARMING_CODEX_BIN);
  assert.strictEqual(staleInjectedEnv.FARMING_CLAUDE_BIN, env.FARMING_CLAUDE_BIN);
  assert.strictEqual(
    staleInjectedEnv.FARMING_AGENT_BROWSER_BIN,
    env.FARMING_AGENT_BROWSER_BIN,
  );

  const invalid = writeVersionExecutable(binDir, 'wrong-codex', '0.1.0');
  assert.strictEqual((await verifyExecutable(invalid, '0.144.6')).valid, false);
  await assert.rejects(
    prepareRuntimeDependencies({
      configDir: path.join(root, 'wrong'),
      env: {
        ...env,
        FARMING_CODEX_BIN: invalid,
        FARMING_RUNTIME_MANIFEST_ID: '',
      },
    }),
    /FARMING_CODEX_BIN must provide codex 0\.144\.6/,
  );

  console.log('✓ startup dependencies keep agent-browser managed and publish one active manifest');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
