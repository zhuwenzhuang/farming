#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { browserBuildInputs, publishBrowserBuild, restoreBrowserBuild } from './agent-browser-build-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'backend/data/agent-browser-source.json'), 'utf8'));
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64-musl': 'aarch64-unknown-linux-musl',
  'linux-x64-musl': 'x86_64-unknown-linux-musl',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const option = name => process.argv[process.argv.indexOf(name) + 1];
const platformKey = process.argv.includes('--platform') ? option('--platform') : `${process.platform}-${process.arch}`;
if (!targets[platformKey] || !process.argv.includes('--output')) {
  throw new Error('Usage: build-agent-browser-runtime.mjs --platform <platform key> --output <artifact root>');
}
const output = path.resolve(option('--output'), platformKey);
if (fs.existsSync(output)) throw new Error(`Refusing to replace existing artifact: ${output}`);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const patch = path.join(root, pin.patch);
if (sha256(fs.readFileSync(patch)) !== pin.patchSha256) throw new Error('Reviewed agent-browser patch digest mismatch');
const farmingSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const inputs = browserBuildInputs({ root, pin, platformKey, target: targets[platformKey] });
const cacheRoot = path.resolve(process.env.FARMING_AGENT_BROWSER_BUILD_CACHE || path.join(root, '.tmp/agent-browser-build-cache'));
if (restoreBrowserBuild({ cacheRoot, output, inputs, pin, farmingSha })) {
  console.log(`Verified cached Browser runtime: ${output}`);
  process.exit(0);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-agent-browser-build-'));
let outputCreated = false;
let complete = false;
const run = (command, args, cwd = work) => {
  const result = spawnSync(command, command === 'git'
    ? ['-c', `core.hooksPath=${path.join(work, 'disabled-hooks')}`, ...args] : args, {
    cwd, env: process.env, stdio: 'inherit', timeout: 20 * 60_000,
    detached: process.platform !== 'win32', killSignal: 'SIGKILL',
  });
  if (process.platform !== 'win32' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
};
// The build has one owner and no retries: pinned source -> patched/tested source
// -> release binary -> identity sidecar. No partial output is accepted by packagers.
try {
  run('git', ['init', '-q']);
  run('git', ['config', 'core.autocrlf', 'false']);
  run('git', ['remote', 'add', 'origin', pin.repository]);
  run('git', ['fetch', '--depth', '1', 'origin', pin.commit]);
  run('git', ['checkout', '--detach', 'FETCH_HEAD']);
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: work, encoding: 'utf8' }).trim();
  if (actual !== pin.commit) throw new Error('Upstream source identity mismatch');
  run('git', ['apply', '--check', patch]);
  run('git', ['apply', patch]);
  // Change only the root crate version; --locked must still prove every dependency.
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    const file = path.join(work, 'cli', name);
    const before = fs.readFileSync(file, 'utf8');
    const from = `name = "agent-browser"\nversion = "${pin.upstreamVersion}"`;
    if (!before.includes(from)) throw new Error(`Upstream ${name} version changed`);
    fs.writeFileSync(file, before.replace(from, `name = "agent-browser"\nversion = "${pin.version}"`));
  }
  // Match upstream's release dashboard embedding; never ship build.rs's placeholder.
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const pnpm = args => {
    if (process.platform === 'win32') {
      run('cmd.exe', ['/d', '/s', '/c', `${npx} --yes pnpm@${pin.pnpm} ${args.join(' ')}`]);
    } else run(npx, ['--yes', `pnpm@${pin.pnpm}`, ...args]);
  };
  pnpm(['--filter', 'dashboard...', 'install', '--frozen-lockfile', '--ignore-scripts', '--registry=https://registry.npmjs.org/']);
  pnpm(['--filter', 'dashboard', 'build']);
  const dashboard = path.join(work, 'packages/dashboard/out/index.html');
  if (!fs.existsSync(dashboard) || fs.readFileSync(dashboard, 'utf8').includes('Dashboard not built.')) {
    throw new Error('Release dashboard was not built');
  }
  const cli = path.join(work, 'cli');
  const target = targets[platformKey];
  const zig = platformKey.startsWith('linux-');
  // Keep regressions in the host test profile. Release tests require a separate
  // full-LTO test executable, so sharing dependency compilation does not remove
  // their expensive link. The artifact always retains production release flags.
  run('cargo', [`+${pin.rust}`, 'test', '--locked', 'native::cdp::chrome::tests', '--', '--nocapture'], cli);
  if (zig) {
    // cargo-zigbuild also discovers the official ziglang Python distribution.
    const directZig = spawnSync('zig', ['version'], { encoding: 'utf8', timeout: 10_000 });
    const selectedZig = directZig.error?.code === 'ENOENT'
      ? spawnSync('python', ['-m', 'ziglang', 'version'], { encoding: 'utf8', timeout: 10_000 }) : directZig;
    if (selectedZig.error || selectedZig.status !== 0) throw new Error('Pinned Zig toolchain is unavailable');
    const zigVersion = selectedZig.stdout.trim();
    if (zigVersion !== pin.zig) throw new Error(`Zig ${pin.zig} is required, found ${zigVersion}`);
    // zigbuild's cargo subcommand does not implement --version. Cargo owns the
    // installed tool receipt; match its complete package header, not a substring.
    const installed = execFileSync('cargo', [`+${pin.rust}`, 'install', '--list'], { encoding: 'utf8' });
    if (!installed.split(/\r?\n/).includes(`cargo-zigbuild v${pin.cargoZigbuild}:`)) {
      throw new Error(`cargo-zigbuild ${pin.cargoZigbuild} is not installed by cargo`);
    }
  }
  run('cargo', [`+${pin.rust}`, zig ? 'zigbuild' : 'build', '--locked', '--release', '--target',
    zig && !platformKey.endsWith('-musl') ? `${target}.2.28` : target], cli);
  const binaryName = platformKey.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser';
  const targetDir = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(cli, 'target');
  const binary = path.join(targetDir, target, 'release', binaryName);
  if (platformKey.startsWith('linux-') && !platformKey.endsWith('-musl')) {
    const symbols = execFileSync('objdump', ['-T', binary], { encoding: 'utf8', timeout: 10_000 });
    for (const match of symbols.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      if (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) > 28)) {
        throw new Error(`Native artifact exceeds glibc 2.28 floor: ${match[0]}`);
      }
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  outputCreated = true;
  fs.copyFileSync(binary, path.join(output, binaryName));
  if (!platformKey.startsWith('win32-')) fs.chmodSync(path.join(output, binaryName), 0o755);
  if (platformKey.replace(/-musl$/, '') === `${process.platform}-${process.arch}`) {
    const version = execFileSync(path.join(output, binaryName), ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (version.trim() !== `agent-browser ${pin.version}`) throw new Error(`Unexpected built version: ${version}`);
  }
  for (const name of ['LICENSE', 'NOTICE']) {
    if (fs.existsSync(path.join(work, name))) fs.copyFileSync(path.join(work, name), path.join(output, name));
  }
  const binarySha256 = sha256(fs.readFileSync(binary));
  const compilationOrigin = {
    farmingSha, sourceId: inputs.sourceId, recipeSha256: inputs.recipeSha256, sha256: binarySha256,
    ...(process.env.GITHUB_RUN_ID ? { runId: Number(process.env.GITHUB_RUN_ID) } : {}),
  };
  fs.writeFileSync(path.join(output, 'identity.json'), `${JSON.stringify({
    version: pin.version, platformKey, sourceId: sha256(JSON.stringify(pin)),
    sha256: binarySha256, farmingSha, compilationOrigin,
  }, null, 2)}\n`, { flag: 'wx' });
  publishBrowserBuild({ cacheRoot, output, inputs, pin });
  complete = true;
  console.log(`Verified patched runtime: ${output}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  if (outputCreated && !complete) fs.rmSync(output, { recursive: true, force: true });
}
