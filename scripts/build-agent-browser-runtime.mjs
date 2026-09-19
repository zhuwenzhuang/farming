#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
  run('cargo', [`+${pin.rust}`, 'test', '--locked', 'native::cdp::chrome::tests', '--', '--nocapture'], cli);
  const target = targets[platformKey];
  const zig = platformKey.startsWith('linux-');
  if (zig) {
    const version = execFileSync('cargo', ['zigbuild', '--version'], { encoding: 'utf8' }).trim();
    if (version !== `cargo-zigbuild ${pin.cargoZigbuild}`) throw new Error(`Unexpected zigbuild: ${version}`);
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
  fs.mkdirSync(output, { recursive: true });
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
  fs.writeFileSync(path.join(output, 'identity.json'), `${JSON.stringify({
    version: pin.version, platformKey, sourceId: sha256(JSON.stringify(pin)),
    sha256: sha256(fs.readFileSync(binary)), farmingSha,
  }, null, 2)}\n`, { flag: 'wx' });
  complete = true;
  console.log(`Verified patched runtime: ${output}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  if (outputCreated && !complete) fs.rmSync(output, { recursive: true, force: true });
}
