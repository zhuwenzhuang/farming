const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const storageLayout = require('../storage-layout');
const {
  MANIFEST,
  prepareRuntimeDependencies,
  runtimePlatformKey,
  verifyExecutable,
} = require('../runtime-dependency-manager');
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
  assert(MANIFEST.dependencies.codex.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.claude.artifacts[runtimePlatformKey()]);
  assert(MANIFEST.dependencies.agentBrowser.artifacts[runtimePlatformKey()]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-manager.'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  const env = {
    PATH: process.env.PATH,
    FARMING_CODEX_BIN: writeVersionExecutable(binDir, 'codex', '0.144.6'),
    FARMING_CLAUDE_BIN: writeVersionExecutable(binDir, 'claude', '2.1.0'),
    FARMING_AGENT_BROWSER_BIN: writeVersionExecutable(binDir, 'agent-browser', '0.32.3'),
  };
  const result = await prepareRuntimeDependencies({ configDir: root, env });
  assert.strictEqual(result.dependencies.length, 3);
  assert(result.dependencies.every(item => item.source === 'system'));
  assert.strictEqual(env.CODEX_PATH, env.FARMING_CODEX_BIN);
  assert.strictEqual(env.CLAUDE_CODE_EXECUTABLE, env.FARMING_CLAUDE_BIN);
  assert.strictEqual(env.FARMING_AGENT_BROWSER_EXECUTABLE, env.FARMING_AGENT_BROWSER_BIN);
  assert.strictEqual(env.FARMING_RUNTIME_MANIFEST_ID, MANIFEST.manifestId);
  const active = JSON.parse(fs.readFileSync(storageLayout.runtimeDependenciesActiveFile(root), 'utf8'));
  assert.strictEqual(active.manifestId, MANIFEST.manifestId);
  assert.deepStrictEqual(Object.keys(active.dependencies), ['codex', 'claude', 'agentBrowser']);

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
  });
  assert(refreshed.dependencies.every(item => item.source === 'system'));
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

  console.log('✓ startup dependencies resolve exact system versions and publish one active manifest');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
