// Exercise installation and optional upgrade/rollback using unpublished npm
// tarballs. A loopback registry serves candidates and proxies dependencies.
// FARMING_INSTALL_SMOKE_MODE=npm additionally tests ordinary npm installation
// with a test-only supported external Node; the default needs no system Node.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const archive = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.statSync(archive).isFile()) throw new Error('Usage: node scripts/smoke-user-install.mjs <npm.tgz> [installer.sh [upgrade.tgz [broken-activation.tgz]]]');
const installer = path.resolve(process.argv[3] || fileURLToPath(new URL('../bin/install.sh', import.meta.url)));
const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
// Optional real upgrade and deliberately broken activation candidates. These
// are unpublished fixtures; all mutations remain inside the temporary root.
const candidates = process.argv.slice(4).map(file => {
  const archive = path.resolve(file);
  const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
  return { archive, metadata, integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}` };
});
assert(candidates.length <= 2, 'At most one upgrade and one rollback candidate');
const packages = [{ archive, metadata, integrity }, ...candidates];
let latest = metadata.version;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-installer-smoke-'));
const installRoot = path.join(temporary, 'installation');
const binDir = path.join(temporary, 'bin');
const configDir = path.join(temporary, 'config');
const upstream = (process.env.FARMING_NPM_SMOKE_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const proxy = http.createServer(async (request, response) => {
  try {
    const address = proxy.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const tarball = packages.find(item => request.url === `/farming-code/-/${item.metadata.version}.tgz`);
    if (tarball) {
      response.setHeader('content-length', fs.statSync(tarball.archive).size);
      await pipeline(fs.createReadStream(tarball.archive), response);
    } else if (request.url?.startsWith('/farming-code')) {
      const versions = Object.fromEntries(packages.map(item => [item.metadata.version, {
        ...item.metadata, dist: { tarball: `${origin}/farming-code/-/${item.metadata.version}.tgz`, integrity: item.integrity },
      }]));
      const requested = request.url.slice('/farming-code/'.length);
      const value = versions[requested === 'latest' ? latest : requested];
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url === '/farming-code'
        ? { name: metadata.name, 'dist-tags': { latest }, versions }
        : value));
    } else {
      const result = await fetch(`${upstream}${request.url}`, { signal: AbortSignal.timeout(600_000) });
      response.writeHead(result.status, { 'content-type': result.headers.get('content-type') || 'application/octet-stream' });
      if (result.body) await pipeline(Readable.fromWeb(result.body), response);
      else response.end();
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(502);
    if (!response.destroyed) response.end(String(error));
  }
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
const portProbe = net.createServer();
await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const env = {
  ...process.env,
  HOME: temporary,
  XDG_DATA_HOME: path.join(temporary, 'data'),
  XDG_CACHE_HOME: path.join(temporary, 'xdg-cache'),
  XDG_CONFIG_HOME: path.join(temporary, 'xdg-config'),
  TMPDIR: temporary,
  FARMING_SERVER_HOME: temporary,
  FARMING_INSTALL_ROOT: installRoot,
  FARMING_BIN_DIR: binDir,
  FARMING_PACKAGE_INSTALLATIONS_DIR: path.join(temporary, 'images'),
  FARMING_NPM_REGISTRY: `http://127.0.0.1:${proxy.address().port}`,
  npm_config_registry: `http://127.0.0.1:${proxy.address().port}`,
  npm_config_cache: path.join(temporary, 'cache'),
  npm_config_userconfig: '/dev/null',
  FARMING_RUNTIME_NPM_MIRROR: 'off',
};
if (process.env.FARMING_INSTALL_SMOKE_PATH) env.PATH = process.env.FARMING_INSTALL_SMOKE_PATH;
let cli = path.join(binDir, 'farming');
const mode = process.env.FARMING_INSTALL_SMOKE_MODE || 'directory';
assert(['directory', 'npm'].includes(mode), 'Unknown smoke installation mode');
if (mode === 'directory') {
  delete env.npm_config_cache;
  delete env.FARMING_PACKAGE_INSTALLATIONS_DIR;
}
const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const runtimeCommand = packageRoot => mode === 'npm'
  ? path.join(temporary, 'external-toolchain/node') : path.join(packageRoot, 'bin/farming-node');
function verifySlimImage(packageRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (!manifest.farmingUserRuntimeDependencies) return;
  const excluded = ['@visactor/vtable', 'mermaid', 'monaco-editor'];
  if (mode === 'npm') excluded.push(...Object.keys(manifest.farmingUserRuntimeDependencies));
  for (const name of excluded) {
    assert(!fs.existsSync(path.join(packageRoot, 'node_modules', name)), `Unexpected duplicate dependency: ${name}`);
  }
  assert(fs.statSync(path.join(packageRoot, 'dist/frontend-licenses.txt')).size > 0, 'frontend dependency notices must be preserved');
}
async function run(command, args, timeout = 600_000) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const log = [];
  child.stdout.on('data', data => log.push(data));
  child.stderr.on('data', data => log.push(data));
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  } finally {
    clearTimeout(timer);
  }
  const output = Buffer.concat(log).toString();
  if (code !== 0) throw new Error(`${path.basename(command)} failed (${code}):\n${output}`);
  return output;
}
let startAttempted = false;
async function updateStatus() {
  const response = await fetch(`http://127.0.0.1:${port}/farming/api/update?force=1`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  return (await response.json()).update;
}
async function postUpdate(action, body = {}) {
  // Never retry a mutation after an uncertain transport outcome.
  const response = await fetch(`http://127.0.0.1:${port}/farming/api/update/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.equal(response.status, 202, JSON.stringify(result));
  return result.update.state;
}
async function waitPhase(expected) {
  const deadline = Date.now() + 600_000;
  const stateFile = path.join(configDir, 'farming-update.json');
  let state;
  let previousPhase;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state?.phase !== previousPhase) {
      console.log(`Update phase: ${state?.phase}`);
      previousPhase = state?.phase;
    }
    if (state?.phase === expected) return state;
    if (['failed', 'rolled-back', 'succeeded'].includes(state?.phase)) throw new Error(JSON.stringify(state));
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${expected}: ${JSON.stringify(state)}`);
}
async function nativePty(packageRoot) {
  await run(runtimeCommand(packageRoot), ['-e', `
const pty = require(${JSON.stringify(path.join(packageRoot, 'node_modules/node-pty'))});
const terminal = pty.spawn('/bin/sh', ['-c', 'printf farming-native-ready'], { env: process.env });
let output = ''; const timer = setTimeout(() => { terminal.kill(); process.exit(1); }, 10000);
terminal.onData(data => { output += data; });
terminal.onExit(() => { clearTimeout(timer); process.exit(output.includes('farming-native-ready') ? 0 : 1); });
`], 15_000);
}
try {
  console.log(`Isolated ${mode} test root: ${temporary}`);
  await run('/bin/bash', [installer]);
  console.log('Installed with private Node/npm and npm scripts disabled.');
  await run('/bin/bash', [installer]);
  console.log('Repeated installation preserved the existing program.');
  let packageRoot = path.join(installRoot, 'lib/node_modules/farming-code');
  if (mode === 'npm') {
    // This old-Linux host needs a compatible external Node for the normal npm
    // path. Reuse the test-only runtime as an external toolchain; deliberately
    // do not enter farming-node or set FARMING_MANAGED_NODE_ROOT when launching
    // Farming. No system binary or persistent PATH is changed.
    const external = path.join(temporary, 'external-toolchain');
    fs.mkdirSync(external);
    const nodeInfo = JSON.parse(await run(path.join(packageRoot, 'bin/farming-node'), ['-e',
      'console.log(JSON.stringify({node:process.env.FARMING_NODE_BIN || process.execPath,loader:process.env.FARMING_NODE_LD,library:process.env.FARMING_NODE_LIBRARY_PATH}))']));
    const node = path.join(external, 'node');
    fs.writeFileSync(node, `#!/bin/sh\nunset FARMING_MANAGED_NODE_ROOT FARMING_NPM_COMMAND\nexport FARMING_NODE_BIN=${shellQuote(nodeInfo.node)}\n`
      + (nodeInfo.loader
        ? `export FARMING_NODE_LD=${shellQuote(nodeInfo.loader)} FARMING_NODE_LIBRARY_PATH=${shellQuote(nodeInfo.library)}\nexec ${shellQuote(nodeInfo.loader)} --library-path ${shellQuote(nodeInfo.library)} ${shellQuote(nodeInfo.node)} "$@"\n`
        : `exec ${shellQuote(nodeInfo.node)} "$@"\n`), { mode: 0o755 });
    const npm = path.join(external, 'npm');
    fs.writeFileSync(npm, `#!/bin/sh\nexec ${shellQuote(node)} ${shellQuote(path.join(packageRoot, 'node_modules/npm/bin/npm-cli.js'))} "$@"\n`, { mode: 0o755 });
    env.PATH = `${external}:${env.PATH}`;
    const prefix = path.join(temporary, 'npm-prefix');
    await run(npm, ['install', '--global', '--prefix', prefix, `farming-code@${metadata.version}`, '--registry', env.FARMING_NPM_REGISTRY, '--no-audit', '--no-fund']);
    packageRoot = path.join(prefix, 'lib/node_modules/farming-code');
    cli = path.join(prefix, 'bin/farming');
    console.log('Ordinary npm global installation completed with a supported external Node; no managed runtime selection.');
  }
  await nativePty(packageRoot);
  console.log('Native PTY created a real shell and received its output.');
  startAttempted = true;
  await run(cli, ['daemon', '--config-dir', configDir, '--port', String(port), '--no-auth'], 180_000);
  const response = await fetch(`http://127.0.0.1:${port}/farming/api/auth/status`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).authRequired, false);
  verifySlimImage(packageRoot);
  console.log(`Farming ${metadata.version} started and answered HTTP.`);
  if (candidates.length) {
    const initialStatus = await updateStatus();
    if (mode === 'directory') {
      assert(initialStatus.target.installationRoot.startsWith(`${installRoot}/packages/`));
      assert(fs.existsSync(path.join(installRoot, 'cache/npm')));
      assert(!fs.existsSync(path.join(temporary, '.npm')), 'directory install must not use the HOME npm cache');
      console.log('Cache and package images follow the installation directory without storage environment overrides.');
    }
    // Six complete historical images exercise the actual startup retention
    // policy without pretending to have performed six more release upgrades.
    const historical = JSON.parse(await run(runtimeCommand(packageRoot), ['-e', `
const fs = require('node:fs'); const path = require('node:path');
const p = require(${JSON.stringify(path.join(packageRoot, 'backend/package-installation.cjs'))});
const context = p.resolvePackageInstallationContext(${JSON.stringify(initialStatus.target.activePackageRoot)}, {
  ...process.env,
  FARMING_PACKAGE_INSTALLATION_ID: ${JSON.stringify(initialStatus.target.installationId)},
  FARMING_PACKAGE_INSTALLATION_ROOT: ${JSON.stringify(initialStatus.target.installationRoot)},
  FARMING_BOOTSTRAP_PACKAGE_ROOT: ${JSON.stringify(initialStatus.target.bootstrapPackageRoot)},
});
const result = [];
for (let i = 0; i < 6; i++) {
  const stage = path.join(${JSON.stringify(temporary)}, 'history-' + i);
  fs.cpSync(${JSON.stringify(packageRoot)}, stage, {recursive:true});
  fs.rmSync(path.join(stage, p.PACKAGE_IMAGE_MARKER_NAME), {force:true});
  const image = p.publishPreparedPackageImage(context, stage, ${JSON.stringify(metadata.version)}, 'smoke-history-' + i);
  const old = new Date(Date.now() - (10-i)*86400000); fs.utimesSync(image.packageRoot, old, old);
  result.push(image.packageRoot);
}
console.log(JSON.stringify(result));
`], 180_000));
    console.log('Seeded six complete historical images, including native dependencies, to verify retention.');
    const oldRuntimes = JSON.parse(await run(runtimeCommand(packageRoot), ['-e', `
const fs = require('node:fs'); const path = require('node:path');
const storage = require(${JSON.stringify(path.join(packageRoot, 'backend/storage-layout.cjs'))});
const runtime = require(${JSON.stringify(path.join(packageRoot, 'backend/runtime-dependency-manager.cjs'))});
const config = ${JSON.stringify(configDir)}; const result = [];
fs.mkdirSync(storage.runtimeDependencyBindingsDir(config), {recursive:true});
for (let i = 0; i < 4; i++) {
  const version = '0.0.' + (i+1); const bindingId = 'smoke-history-' + i;
  const cache = runtime.dependencyCacheDir(config, 'agentBrowser', version, 'linux-x64');
  fs.mkdirSync(cache, {recursive:true});
  fs.writeFileSync(path.join(cache, 'obsolete-dependency'), Buffer.alloc(1024*1024, i));
  fs.writeFileSync(storage.runtimeDependencyBindingFile(config, bindingId), JSON.stringify({
    schemaVersion:2, bindingId, manifestId:bindingId, platformKey:'linux-x64',
    preparedAt:new Date(Date.now()-(10-i)*86400000).toISOString(),
    dependencies:{agentBrowser:{version,platformKey:'linux-x64',source:'managed',executablePath:path.join(cache,'obsolete-dependency')}}
  }));
  result.push(cache);
}
console.log(JSON.stringify({caches:result,bindings:storage.runtimeDependencyBindingsDir(config)}));
`]));
    for (const [index, candidate] of candidates.entries()) {
      latest = candidate.metadata.version;
      const before = await updateStatus();
      assert.equal(before.installable, true, JSON.stringify(before));
      const installing = await postUpdate('install', { assetName: latest });
      assert.equal(typeof installing.stagingPrefix, 'string');
      await waitPhase('ready-to-restart');
      assert(!fs.existsSync(installing.stagingPrefix), 'successful preparation must remove its staging directory');
      await postUpdate('restart');
      const state = await waitPhase(index === 0 ? 'succeeded' : 'rolled-back');
      const status = await updateStatus();
      const expectedVersion = candidates[0].metadata.version;
      assert.equal(status.current.releaseVersion || status.current.packageVersion, expectedVersion);
      const pointer = JSON.parse(fs.readFileSync(path.join(state.installationRoot, 'current.json'), 'utf8'));
      assert.equal(pointer.version, expectedVersion);
      const activeRoot = path.join(state.installationRoot, pointer.relativePath);
      verifySlimImage(activeRoot);
      await nativePty(activeRoot);
      console.log(`${index === 0 ? 'Upgrade succeeded' : 'Failed activation rolled back'}; HTTP and native PTY verified on ${expectedVersion}.`);
      const remaining = fs.readdirSync(path.join(state.installationRoot, 'versions'));
      assert.equal(remaining.length, 5, 'startup must retain the default five images in this unshared installation');
      const removed = historical.filter(root => !fs.existsSync(root));
      assert(removed.length >= 2, 'old complete images and all their dependencies must be removed');
      assert(fs.existsSync(path.join(packageRoot, 'node_modules')), 'bootstrap is intentionally preserved');
      assert(fs.existsSync(mode === 'directory' ? path.join(installRoot, 'cache/npm') : env.npm_config_cache), 'npm cache is intentionally preserved');
      console.log(`Cleanup verified: ${removed.length}/6 historical images deleted with their dependencies; ${remaining.length} images retained. Bootstrap and npm cache preserved.`);
      const deadline = Date.now() + 30_000;
      while (fs.existsSync(oldRuntimes.caches[0]) && Date.now() < deadline) await delay(250);
      assert(!fs.existsSync(oldRuntimes.caches[0]), 'startup must remove stale runtime dependencies');
      assert.equal(fs.readdirSync(oldRuntimes.bindings).filter(name => name.endsWith('.json')).length, 3);
      console.log('Runtime cache cleanup verified: stale dependency deleted; three bindings retained.');
    }
  }
} catch (error) {
  const log = path.join(configDir, 'farming-update.log');
  if (fs.existsSync(log)) console.error(fs.readFileSync(log, 'utf8').slice(-24000));
  throw error;
} finally {
  let stopped = !startAttempted;
  try {
    if (startAttempted) {
      await run(cli, ['stop', '--config-dir', configDir], 30_000);
      stopped = true;
    }
  } finally {
    proxy.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve));
    if (stopped) {
      fs.rmSync(temporary, { recursive: true, force: true });
      console.log('Stopped the isolated Config and removed its exact test directory.');
    }
    else console.error(`Cleanup could not prove the Config stopped; retained ${temporary}`);
  }
}
