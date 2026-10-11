import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import * as pty from 'node-pty';

const projectRoot = path.resolve(__dirname, '../..');
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

type IntegrityTool = 'sha512sum' | 'shasum' | 'openssl';
const hasTool = (name: string) => spawnSync('/bin/sh', ['-c', `command -v ${name}`]).status === 0;

type RuntimeDownloads = 'normal' | 'overlap' | 'fail-node' | 'fail-npm' | 'stall' | 'redirect';
type MirrorMode = 'none' | 'available' | 'missing' | 'slow' | 'corrupt' | 'unavailable' | 'metadata-failure';

async function fixture(legacy = false, integrityTool: IntegrityTool = 'openssl', runtimeDownloads: RuntimeDownloads = 'normal', mirrorMode: MirrorMode = 'none', platformPackages = false, realNpm = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-user-install-'));
  const archives = new Map<string, Buffer>();
  const fakePath = path.join(directory, 'tools');
  fs.mkdirSync(fakePath);
  const integrityTools = integrityTool === 'openssl' ? ['openssl'] : [integrityTool, 'base64', 'od'];
  // Deliberately no node or npm in PATH. Their fixtures call a known absolute
  // executable so these tests neither download nor depend on a system install.
  for (const name of ['bash', 'dirname', 'mkdir', 'rmdir', 'rm', 'readlink', ...integrityTools, 'tar', 'gzip', 'curl', 'sed', 'tr', 'mktemp', 'chmod', 'touch', 'mv', 'ln', 'cat', 'sleep', 'tail', 'awk']) {
    const target = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    fs.symlinkSync(target, path.join(fakePath, name));
  }
  const executable = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o755 });
  };
  executable(path.join(fakePath, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${legacy ? 'Linux' : 'Darwin'};; -m) echo ${legacy ? 'x86_64' : 'arm64'};; esac\n`);
  executable(path.join(fakePath, 'getconf'), '#!/bin/sh\necho "glibc 2.17"\n');
  const extractions = path.join(directory, 'extractions');
  const tar = fs.readlinkSync(path.join(fakePath, 'tar'));
  fs.unlinkSync(path.join(fakePath, 'tar'));
  executable(path.join(fakePath, 'tar'), `#!/bin/sh\nprintf '%s\\n' extracting >> ${quote(extractions)}\nexec ${quote(tar)} "$@"\n`);
  const carrier = legacy ? 'node-linux-x64' : 'node-bin-darwin-arm64';
  function pack(name: string, version: string, prepare: (root: string) => void, archiveKey = name) {
    const root = path.join(directory, 'packages', archiveKey, 'package');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
    prepare(root);
    const output = path.join(directory, `${archiveKey}.tgz`);
    execFileSync('tar', ['-czf', output, '-C', path.dirname(root), 'package']);
    archives.set(archiveKey, fs.readFileSync(output));
  }
  pack(carrier, '22.23.2', root => executable(path.join(root, 'bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`));
  const npmCli = realNpm ? fs.realpathSync(execFileSync('/bin/sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim()) : '';
  pack('npm', '12.1.0', root => executable(path.join(root, 'bin/npm-cli.js'), realNpm ? `
const args = process.argv.slice(2).map(arg => arg.replace('https://registry.npmmirror.com', process.env.FARMING_TEST_REGISTRY + '/mirror'));
const child = require('child_process').spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...args], { stdio: 'inherit', timeout: 10000 });
process.exit(child.status ?? 1);
` : `
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const args = process.argv.slice(2);
if (args[0] === 'cache') process.exit(0);
assert(args.includes('--ignore-scripts')); assert(args.includes('--include=optional'));
const prefix = args[args.indexOf('--prefix') + 1];
const stage = path.dirname(prefix); const target = path.join(prefix, 'lib/node_modules/farming-code');
fs.cpSync(path.join(stage, 'farming/package'), target, { recursive: true });
`));
  const runtimePlatform = legacy ? 'linux-x64' : 'darwin-arm64';
  const runtimeVersion = `1.0.0-runtime-${runtimePlatform}`;
  let farmingVersion = '1.0.0';
  function publishVersion(version: string) {
  farmingVersion = version;
  pack('farming-code', version, root => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'farming-code', version, ...(platformPackages ? { farmingRuntimePackages: 1, optionalDependencies: { [`farming-code-runtime-${runtimePlatform}`]: `npm:farming-code@${runtimeVersion}` } } : {}), farmingUserRuntimeDependencies: { [carrier]: '22.23.2', npm: '12.1.0' } }));
    for (const name of ['farming-node', 'farming-npm']) {
      executable(path.join(root, 'bin', name), fs.readFileSync(path.join(projectRoot, 'bin', name), 'utf8'));
    }
    executable(path.join(root, 'bin/farming'), `
const fs = require('fs');
const path = require('path');
const active = require('../backend/package-installation.cjs').resolvePackageLaunch(path.resolve(__dirname, '..'), process.env).packageRoot;
const version = JSON.parse(fs.readFileSync(path.join(active, 'package.json'), 'utf8')).version;
if (process.argv[2] === 'runtime') console.log(JSON.stringify({ executablePath: __filename }));
if (process.argv[2] === 'runtime' && process.env.FARMING_TEST_FAIL_PREFLIGHT) process.exit(19);
fs.appendFileSync(process.env.FARMING_TEST_CALLS, JSON.stringify({command:process.argv[2],version,runtime:process.env.FARMING_MANAGED_NODE_ROOT,registry:process.env.npm_config_registry,metadataRegistry:process.env.FARMING_NPM_REGISTRY,cache:process.env.npm_config_cache,images:process.env.FARMING_PACKAGE_INSTALLATIONS_DIR})+'\\n');
`);
    executable(path.join(root, 'backend/packaged-node-pty.cjs'), 'exports.nodePty = {};');
    for (const module of ['package-installation', 'config-instance', 'server-process-identity']) {
      fs.copyFileSync(path.join(projectRoot, 'backend', `${module}.cjs`), path.join(root, 'backend', `${module}.cjs`));
    }
    if (!platformPackages) executable(path.join(root, 'dist/runtime/glibc228/ld-2.28.so'), '#!/bin/sh\n[ "$1" = --library-path ] || exit 9\nshift 2\nexec "$@"\n');
  });
  }
  publishVersion('1.0.0');
  if (platformPackages) pack('farming-code', runtimeVersion, root => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'farming-code', version: runtimeVersion, farmingRuntimePlatform: runtimePlatform }));
    if (legacy) executable(path.join(root, 'dist/runtime/glibc228/ld-2.28.so'), '#!/bin/sh\n[ "$1" = --library-path ] || exit 9\nshift 2\nexec "$@"\n');
  }, 'farming-code-runtime');
  let requests = 0;
  let corrupt = false;
  const runtimeResponses = new Map<string, http.ServerResponse>();
  const abortedDownloads: string[] = [];
  const timers: ReturnType<typeof setTimeout>[] = [];
  const requestPaths: string[] = [];
  const server = http.createServer((request, response) => {
    requests++;
    requestPaths.push(request.url!);
    const send = () => {
      const isMirror = request.url!.startsWith('/mirror/');
      const requestPath = request.url!.replace(/^\/(mirror|upstream)\//, '/');
      const name = platformPackages && requestPath.includes('-runtime') ? 'farming-code-runtime' : requestPath.split('/')[1];
      const body = archives.get(name);
      if (!body) { response.writeHead(404).end(); return; }
      if (mirrorMode === 'metadata-failure' && !requestPath.endsWith('.tgz')) { response.writeHead(404).end(); return; }
      if (isMirror && !requestPath.endsWith('.tgz')) {
        response.end(JSON.stringify({ name, version: '0.0.1', dist: {} })); return;
      }
      if (request.url!.endsWith('.tgz')) {
        if (runtimeDownloads === 'redirect' && !requestPath.endsWith('/final.tgz')) {
          response.writeHead(302, { location: `/${name}/final.tgz` }).end('redirect body');
          return;
        }
        if (runtimeDownloads === 'redirect') {
          // Leave time to observe the redirect meter before final headers arrive.
          timers.push(setTimeout(() => {
            if (name !== 'npm') response.setHeader('content-length', body.length);
            const midpoint = Math.floor(body.length / 2);
            response.write(body.subarray(0, midpoint));
            timers.push(setTimeout(() => response.end(body.subarray(midpoint)), 1500));
          }, 1200));
          return;
        }
        if (mirrorMode === 'unavailable' || (isMirror && mirrorMode === 'missing')) { response.writeHead(404).end(); return; }
        if (isMirror && mirrorMode === 'corrupt') { response.end('tampered mirror'); return; }
        if (isMirror && mirrorMode === 'slow') {
          response.setHeader('content-length', body.length);
          response.write(body.subarray(0, 1));
          response.on('close', () => { if (!response.writableFinished) abortedDownloads.push(name); });
          return;
        }
        if (name === 'farming-code' || runtimeDownloads === 'normal') { response.end(body); return; }
        runtimeResponses.set(name, response);
        response.on('close', () => { if (!response.writableFinished) abortedDownloads.push(name); });
        // Neither transfer can finish until both have reached the server.
        if (runtimeResponses.size === 2) {
          for (const [runtimeName, runtimeResponse] of runtimeResponses) {
            const fails = runtimeDownloads === 'fail-node' && runtimeName === carrier
              || runtimeDownloads === 'fail-npm' && runtimeName === 'npm';
            if (fails) { runtimeResponse.writeHead(404).end(); continue; }
            const archive = archives.get(runtimeName)!;
            if (runtimeName !== 'npm') runtimeResponse.setHeader('content-length', archive.length);
            const midpoint = Math.floor(archive.length / 2);
            runtimeResponse.write(archive.subarray(0, midpoint));
            if (runtimeDownloads === 'overlap') {
              timers.push(setTimeout(() => runtimeResponse.end(archive.subarray(midpoint)), 2500));
            }
          }
        }
        return;
      }
      const address = server.address();
      assert(address && typeof address !== 'string');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name, version: name === 'farming-code-runtime' ? runtimeVersion : name === 'farming-code' ? farmingVersion : name === 'npm' ? '12.1.0' : '22.23.2', dist: {
        tarball: mirrorMode === 'none' ? `http://127.0.0.1:${address.port}/${name}/archive.tgz`
          : `https://registry.npmjs.org/${name}/archive.tgz`,
        integrity: `sha512-${createHash('sha512').update(corrupt ? Buffer.from('tampered') : body).digest('base64')}`,
      } }));
    };
    send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const registryUrl = `http://127.0.0.1:${address.port}`;
  if (mirrorMode !== 'none' || runtimeDownloads === 'redirect') {
    const curl = fs.readlinkSync(path.join(fakePath, 'curl'));
    fs.unlinkSync(path.join(fakePath, 'curl'));
    // Map production endpoints to two isolated registry namespaces. exec keeps
    // curl as the direct child so cancellation exercises real process ownership.
    executable(path.join(fakePath, 'curl'), `#!/bin/bash
args=()
speed_time=0
archive_request=0
verbose=0
for arg in "$@"; do
  if [ "$speed_time" = 1 ]; then arg=1; speed_time=0; fi
  if [ "$arg" = --speed-time ]; then speed_time=1; fi
  if [ "$arg" = --verbose ]; then verbose=1; fi
  case "$arg" in http*.tgz) archive_request=1 ;; esac
  case "$arg" in
    https://registry.npmjs.org/*) arg="${registryUrl}/upstream/\${arg#https://registry.npmjs.org/}" ;;
    https://registry.npmmirror.com/*) arg="${registryUrl}/mirror/\${arg#https://registry.npmmirror.com/}" ;;
  esac
  args+=("$arg")
done
${runtimeDownloads === 'redirect' ? `# Older curl versions report redirect-body completion while awaiting the CDN.
if [ "$archive_request" = 1 ]; then
  if [ "$verbose" = 1 ]; then printf '< HTTP/1.1 302 Found\\r\\n< Content-Length: 13\\r\\n< \\r\\n' >&2; fi
  printf '\\r100 13 100 13 0 0 130 0 --:--:-- --:--:-- --:--:-- 130' >&2
  sleep 0.6
fi` : ''}
exec ${quote(curl)} "\${args[@]}"
`);
  }
  const root = path.join(directory, 'install with spaces');
  const bin = path.join(directory, 'user bin');
  const calls = path.join(directory, 'calls');
  const installEnv = { ...process.env, PATH: fakePath, HOME: directory, FARMING_INSTALL_ROOT: root,
    FARMING_NPM_REGISTRY: registryUrl, FARMING_TEST_REGISTRY: registryUrl, FARMING_TEST_CALLS: calls };
  async function runTTY(env: NodeJS.ProcessEnv = {}, columns = 80, onOutput?: (output: string, terminal: pty.IPty) => void) {
    const terminalEnv: NodeJS.ProcessEnv = { ...installEnv, TERM: 'xterm-256color', COLUMNS: String(columns), ...env };
    if (!Object.hasOwn(env, 'NO_COLOR')) delete terminalEnv.NO_COLOR;
    const terminal = pty.spawn('/bin/bash', [path.join(projectRoot, 'bin/install.sh')], {
      name: env.TERM || 'xterm-256color', cols: columns, rows: 30,
      env: terminalEnv,
    });
    let output = '';
    terminal.onData(value => { output += value; onOutput?.(output, terminal); });
    const timer = setTimeout(() => terminal.kill('SIGKILL'), 20_000);
    try {
      const code = await new Promise<number>(resolve => terminal.onExit(event => resolve(event.exitCode)));
      return { code, output };
    } finally { clearTimeout(timer); }
  }
  async function shell(args: string[], env: NodeJS.ProcessEnv = {}, onOutput?: (output: string, child: ChildProcess) => void) {
    const child = spawn('/bin/bash', args, {
      detached: true,
      env: { ...installEnv, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', value => { output += value; onOutput?.(output, child); });
    child.stderr.on('data', value => { output += value; onOutput?.(output, child); });
    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    }, 20_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    return { code, output };
  }
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}, onOutput?: (output: string, child: ChildProcess) => void) => shell([path.join(projectRoot, 'bin/install.sh'), ...args], env, onOutput);
  const start = (command: string) => shell(['-c', command], { FARMING_NPM_REGISTRY: '', npm_config_registry: '' });
  return { directory, root, bin, calls, run, runTTY, start, fakePath, extractions, runtimeResponses, abortedDownloads, requestPaths,
    publishVersion, requests: () => requests,
    corrupt: () => { corrupt = true; },
    async close() {
      timers.forEach(clearTimeout);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

// Every case owns its registry, install root, child processes and cleanup. Bound
// parallel I/O so the complete suite fits the ordinary per-file test deadline.
describe('user installer', { concurrency: 4 }, () => {
for (const mode of ['available', 'missing', 'slow'] as const) {
  test(`China mirror ${mode} keeps official versions and separate update/download registries`, async () => {
    const f = await fixture(false, 'openssl', 'normal', mode);
    try {
      const result = await f.run(['--mirror', 'cn', '--dir', f.root]);
      assert.equal(result.code, 0, result.output);
      assert(f.requestPaths.includes('/upstream/farming-code/latest'));
      assert(!f.requestPaths.some(url => url.startsWith('/mirror/') && !url.endsWith('.tgz')), 'stale mirror tags must never select the target');
      for (const name of ['farming-code', 'node-bin-darwin-arm64', 'npm']) {
        assert(f.requestPaths.includes(`/mirror/${name}/archive.tgz`));
        assert.equal(f.requestPaths.includes(`/upstream/${name}/archive.tgz`), mode !== 'available');
      }
      if (mode !== 'available') assert.match(result.output, /Downloading the same version from official npm/);
      if (mode === 'slow') assert.deepEqual(f.abortedDownloads.sort(), ['farming-code', 'node-bin-darwin-arm64', 'npm']);
      assert.equal(fs.readFileSync(path.join(f.root, '.farming-npm-registry'), 'utf8').trim(), 'https://registry.npmjs.org');
      assert.equal(fs.readFileSync(path.join(f.root, '.farming-download-registry'), 'utf8').trim(), 'https://registry.npmmirror.com');
      const startCommand = result.output.match(/Background start \(continue after closing this terminal\):\n {2}(.+)\n/)?.[1];
      assert(startCommand);
      const started = await f.start(startCommand);
      assert.equal(started.code, 0, started.output);
      const call = JSON.parse(fs.readFileSync(f.calls, 'utf8').trim().split('\n').at(-1)!);
      assert.equal(call.metadataRegistry, 'https://registry.npmjs.org');
      assert.equal(call.registry, 'https://registry.npmmirror.com');
    } finally { await f.close(); }
  });
}

for (const mode of ['corrupt', 'unavailable', 'metadata-failure'] as const) {
  test(`China mirror ${mode} fails without publishing or downgrading`, async () => {
    const f = await fixture(false, 'openssl', 'normal', mode);
    try {
      const result = await f.run(['--dir', f.root, '--mirror', 'cn']);
      assert.notEqual(result.code, 0, result.output);
      if (mode === 'corrupt') {
        assert.match(result.output, /SHA-512 verification failed/);
        assert(!f.requestPaths.includes('/upstream/farming-code/archive.tgz'), 'integrity failure must not fall back');
      }
      if (mode === 'metadata-failure') assert(!f.requestPaths.some(url => url.startsWith('/mirror/')));
      if (mode === 'unavailable') assert.equal(f.requestPaths.filter(url => url.endsWith('.tgz')).length, 2);
      assert(!fs.existsSync(f.root));
      assert(!fs.existsSync(f.extractions));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
    } finally { await f.close(); }
  });
}

test('runtime archives overlap and report progress before either finishes', async () => {
  const f = await fixture(false, 'openssl', 'overlap');
  try {
    let progressWhileDownloading = false;
    const result = await f.run([], {}, output => {
      if (/node-bin-darwin-arm64:.*\d/.test(output) && /npm:.*\d/.test(output)
          && [...f.runtimeResponses.values()].every(response => !response.writableFinished)) {
        progressWhileDownloading = true;
      }
    });
    assert.equal(result.code, 0, result.output);
    assert.equal(f.runtimeResponses.size, 2);
    assert(progressWhileDownloading, result.output);
    assert.match(result.output, /npm:.*total unknown/);
    assert(fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
    assert.match(result.output, /Installing Farming dependencies/);
    assert(!result.output.includes('.staging.'), result.output);
    assert(!result.output.includes('executablePath'), result.output);
    assert(!result.output.includes('\u001b['), result.output);
    assert(!result.output.includes('% Total'), result.output);
  } finally { await f.close(); }
});

test('redirect bodies never appear as completed archive progress', async () => {
  const f = await fixture(false, 'openssl', 'redirect');
  try {
    const result = await f.runTTY();
    assert.equal(result.code, 0, result.output);
    assert(f.requestPaths.includes('/farming-code/final.tgz'));
    assert.match(result.output, /Connecting…/);
    assert.match(result.output, /━+─+/);
    assert.match(result.output, /total unknown/);
    assert(!/100%\s+13 \/ 13/.test(result.output), result.output);
    assert(!result.output.includes('HTTP/1.1'), result.output);
    assert(!result.output.includes('Location:'), result.output);
  } finally { await f.close(); }
});

for (const presentation of ['color', 'no-color', 'dumb', 'narrow'] as const) {
  test(`installer terminal progress uses startup styling: ${presentation}`, async () => {
    const f = await fixture(false, 'openssl', 'overlap');
    try {
      const env = presentation === 'no-color' ? { NO_COLOR: '' }
        : presentation === 'dumb' ? { TERM: 'dumb' } : {};
      const result = await f.runTTY(env, presentation === 'narrow' ? 40 : 80);
      assert.equal(result.code, 0, result.output);
      assert(!result.output.includes('% Total'), result.output);
      assert(!result.output.includes('.staging.'), result.output);
      assert(!result.output.includes('executablePath'), result.output);
      assert.match(result.output, /total unknown/);
      if (presentation === 'dumb') {
        assert(!result.output.includes('\u001b['), result.output);
      } else {
        assert.match(result.output, /━+─+/);
        assert.match(result.output, /\u001b\[\d+A\r\u001b\[J/);
        assert.match(result.output, /\u001b\[\?25l/);
        assert(result.output.lastIndexOf('\u001b[?25h') > result.output.lastIndexOf('\u001b[?25l'));
        if (presentation === 'no-color') assert(!/\u001b\[\d+m/.test(result.output));
        if (presentation === 'color') assert.match(result.output, /\u001b\[36m/);
        const liveFrames = result.output.split('\u001b[?25l').slice(1);
        for (const frame of liveFrames) {
          for (const line of frame.split('\r\n').slice(0, 4)) {
            const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
            assert([...plain].length < (presentation === 'narrow' ? 40 : 80), plain);
          }
        }
      }
    } finally { await f.close(); }
  });
}

test('cancelling terminal downloads restores the cursor and cleans exact staging', async () => {
  const f = await fixture(false, 'openssl', 'stall');
  try {
    let cancelled = false;
    const result = await f.runTTY({}, 80, (output, terminal) => {
      if (!cancelled && output.includes('total unknown') && f.runtimeResponses.size === 2) {
        cancelled = true;
        terminal.kill('SIGTERM');
      }
    });
    assert(cancelled, result.output);
    assert.equal(result.code, 143, result.output);
    assert(result.output.lastIndexOf('\u001b[?25h') > result.output.lastIndexOf('\u001b[?25l'));
    assert.deepEqual(f.abortedDownloads.sort(), ['node-bin-darwin-arm64', 'npm']);
    assert(!fs.existsSync(`${f.root}.install-lock`));
    assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
  } finally { await f.close(); }
});

for (const failure of ['fail-node', 'fail-npm'] as const) {
  test(`runtime download ${failure} stops the other transfer before cleanup`, async () => {
    const f = await fixture(false, 'openssl', failure);
    try {
      const result = await f.run();
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /Download failed:/);
      assert.equal(f.runtimeResponses.size, 2);
      assert.deepEqual(f.abortedDownloads, [failure === 'fail-node' ? 'npm' : 'node-bin-darwin-arm64']);
      assert(!fs.existsSync(f.root));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
      assert.equal(fs.readFileSync(f.extractions, 'utf8').trim(), 'extracting', 'runtime archives must not be extracted after a download failure');
    } finally { await f.close(); }
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`installer ${signal} cancels both owned runtime downloads`, async () => {
    const f = await fixture(false, 'openssl', 'stall');
    try {
      let cancelled = false;
      const result = await f.run([], {}, (output, child) => {
        if (!cancelled && /npm:.*\d/.test(output) && f.runtimeResponses.size === 2) {
          cancelled = true;
          child.kill(signal);
        }
      });
      assert(cancelled, result.output);
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.output);
      assert.deepEqual(f.abortedDownloads.sort(), ['node-bin-darwin-arm64', 'npm']);
      assert(!fs.existsSync(f.root));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
    } finally { await f.close(); }
  });
}

for (const integrityTool of ['sha512sum', 'shasum', 'openssl'] as const) {
  for (const legacy of [false, true]) {
    test(`user installer without system Node, legacy=${legacy}, SHA-512=${integrityTool}`, { skip: !hasTool(integrityTool) }, async () => {
      const f = await fixture(legacy, integrityTool);
      try {
        const first = await f.run();
        assert.equal(first.code, 0, first.output);
        assert.match(first.output, /Fresh installation · Farming 1\.0\.0/);
        assert.match(first.output, /Starting again stops the current instance and its Agents/);
        assert(fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
        assert(!fs.existsSync(f.bin), 'installation must not create an external command directory');
        const installedCalls = fs.readFileSync(f.calls, 'utf8');
        assert.deepEqual(installedCalls.trim().split('\n').map(line => JSON.parse(line).command), ['runtime'],
          'installation must verify the runtime without starting a daemon');
        const startCommand = first.output.match(/Background start \(continue after closing this terminal\):\n {2}(.+)\n/)?.[1];
        assert(startCommand, 'installer must print a shell-safe CLI command');
        const started = await f.start(startCommand);
        assert.equal(started.code, 0, started.output);
        const startedCalls = fs.readFileSync(f.calls, 'utf8');
        const before = f.requests();
        const second = await f.run([], { FARMING_NPM_REGISTRY: '', npm_config_registry: '' });
        assert.equal(second.code, 0, second.output);
        assert.equal(f.requests(), before + 1, 'repeat install checks metadata without downloading archives');
        assert.match(second.output, /already installed; no update needed/);
        assert.equal(fs.readFileSync(f.calls, 'utf8'), startedCalls, 'repeat install must not invoke the existing application');
        const restarted = await f.start(startCommand);
        assert.equal(restarted.code, 0, restarted.output);
        const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(calls.map(call => call.command), ['runtime', 'daemon', 'daemon']);
        assert(calls[1].runtime.startsWith(f.root), 'published launcher must not use deleted staging paths');
        assert.equal(calls[1].cache, path.join(f.root, 'cache/npm'));
        assert.equal(calls[1].images, path.join(f.root, 'packages'));
        assert.match(calls[1].registry, /^http:\/\/127\.0\.0\.1:/);
        assert.equal(calls[2].registry, calls[1].registry, 'subsequent launches and updates must retain the selected registry');
        assert(!fs.existsSync(`${f.root}.install-lock`));
      } finally { await f.close(); }
    });
  }
}

for (const existingCommand of [false, true]) {
  test(`directory installation stays local with existing PATH command=${existingCommand}`, async () => {
    const f = await fixture();
    try {
      const externalBin = path.join(f.directory, '.local/bin');
      const externalCommand = path.join(externalBin, 'farming');
      if (existingCommand) {
        fs.mkdirSync(externalBin, { recursive: true });
        fs.writeFileSync(externalCommand, 'another installation');
      }
      const first = await f.run(['--dir', f.root]);
      assert.equal(first.code, 0, first.output);
      assert(!fs.existsSync(f.bin));
      assert(!fs.lstatSync(path.join(f.root, 'farming')).isSymbolicLink());
      assert(!first.output.includes('Optional command link:'));
      assert(!first.output.includes('add this directory to PATH'));
      const startCommand = first.output.match(/Background start \(continue after closing this terminal\):\n {2}(.+)\n/)?.[1];
      assert(startCommand);
      for (const [label, command] of [['Foreground start (keep this terminal open)', 'start'], ['Stop Farming and its Agents', 'stop']]) {
        const line = first.output.split(`${label}:\n  `)[1]?.split('\n')[0];
        assert(line?.endsWith(` ${command}`), first.output);
        const invoked = await f.start(line);
        assert.equal(invoked.code, 0, invoked.output);
        const calls = fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(row => JSON.parse(row));
        assert.equal(calls.at(-1).command, command);
      }
      const started = await f.start(startCommand);
      assert.equal(started.code, 0, started.output);
      const before = f.requests();
      const repeated = await f.run(['--dir', f.root]);
      assert.equal(repeated.code, 0, repeated.output);
      assert.equal(f.requests(), before + 1);
      const secondRoot = path.join(f.directory, 'second installation');
      const second = await f.run(['--dir', secondRoot]);
      assert.equal(second.code, 0, second.output);
      assert(fs.existsSync(path.join(secondRoot, 'farming')));
      if (existingCommand) assert.equal(fs.readFileSync(externalCommand, 'utf8'), 'another installation');
      else assert(!fs.existsSync(path.join(f.directory, '.local')));
      assert(!fs.existsSync(f.bin));
      assert(!fs.readdirSync(f.directory).some(name => /\.(staging\.|install-lock$)/.test(name)));
    } finally { await f.close(); }
  });
}

for (const outcome of ['success', 'preflight-failure', 'integrity-failure', 'concurrent-update'] as const) {
  test(`repeat installation updates the selected image: ${outcome}`, async () => {
    const f = await fixture(true, 'openssl', 'normal', 'none', true);
    try {
      const first = await f.run();
      assert.equal(first.code, 0, first.output);
      const bootstrap = path.join(f.root, 'lib/node_modules/farming-code');
      const images = require(path.join(bootstrap, 'backend/package-installation.cjs'));
      const env = { FARMING_PACKAGE_INSTALLATIONS_DIR: path.join(f.root, 'packages') };
      const context = images.resolvePackageInstallationContext(bootstrap, env);
      const before = fs.readFileSync(path.join(bootstrap, 'package.json'), 'utf8');
      fs.writeFileSync(path.join(f.directory, 'user-history'), 'keep user history');
      f.publishVersion('1.1.0');
      if (outcome === 'integrity-failure') f.corrupt();
      let concurrent = false;
      const updated = await f.run([], outcome === 'preflight-failure' ? { FARMING_TEST_FAIL_PREFLIGHT: '1' } : {}, output => {
        if (outcome !== 'concurrent-update' || concurrent || !output.includes('Installing Farming dependencies')) return;
        concurrent = true;
        const oldImage = images.publishRunningPackageImage(context, bootstrap);
        images.initializeCurrentPackageImage(context, oldImage);
        const newerRoot = path.join(f.directory, 'newer-image');
        fs.cpSync(bootstrap, newerRoot, { recursive: true });
        const metadata = JSON.parse(before); metadata.version = '1.2.0';
        fs.writeFileSync(path.join(newerRoot, 'package.json'), JSON.stringify(metadata));
        const newerImage = images.publishPreparedPackageImage(context, newerRoot, '1.2.0', 'test-newer-integrity');
        images.activatePackageImage(context, newerImage, oldImage.imageId);
      });
      assert.match(updated.output, /Update available: 1\.0\.0 → 1\.1\.0/);
      assert.match(updated.output, /Configuration and history are preserved/);
      assert(updated.output.indexOf('Update available:') < updated.output.indexOf('Installing Farming dependencies') || outcome === 'integrity-failure');
      assert.equal(updated.code === 0, outcome === 'success', updated.output);
      assert.equal(fs.readFileSync(path.join(bootstrap, 'package.json'), 'utf8'), before, 'live bootstrap files must remain unchanged');
      assert.equal(fs.readFileSync(path.join(f.directory, 'user-history'), 'utf8'), 'keep user history');
      const selected = images.resolvePackageLaunch(bootstrap, env);
      const selectedVersion = JSON.parse(fs.readFileSync(path.join(selected.packageRoot, 'package.json'), 'utf8')).version;
      assert.equal(selectedVersion, outcome === 'success' ? '1.1.0' : outcome === 'concurrent-update' ? '1.2.0' : '1.0.0');
      if (outcome === 'concurrent-update') assert(concurrent);
      if (outcome === 'success') {
        assert.match(updated.output, /Updated Farming 1.0.0 → 1.1.0/);
        const started = await f.start(`${quote(path.join(f.root, 'farming'))} daemon`);
        assert.equal(started.code, 0, started.output);
        const call = JSON.parse(fs.readFileSync(f.calls, 'utf8').trim().split('\n').at(-1)!);
        assert.equal(call.version, '1.1.0');
        const requests = f.requests();
        const repeated = await f.run();
        assert.equal(repeated.code, 0, repeated.output);
        assert.match(repeated.output, /already installed; no update needed/);
        assert.equal(f.requests(), requests + 1);
      }
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
      assert(!fs.existsSync(f.bin));
    } finally { await f.close(); }
  });
}

test('installer reports missing base tools together before downloading', async () => {
  const f = await fixture();
  try {
    fs.unlinkSync(path.join(f.fakePath, 'tar'));
    fs.unlinkSync(path.join(f.fakePath, 'gzip'));
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Missing basic tools: tar gzip/);
    assert.match(result.output, /Node.js and npm are downloaded automatically/);
    assert.equal(f.requests(), 0);
    assert(!fs.existsSync(f.root));
    assert(!fs.existsSync(`${f.root}.install-lock`));
  } finally { await f.close(); }
});

test('installer requires a SHA-512 verifier before downloading', async () => {
  const f = await fixture();
  try {
    fs.unlinkSync(path.join(f.fakePath, 'openssl'));
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Missing SHA-512 tools/);
    assert.equal(f.requests(), 0);
    assert(!fs.existsSync(f.root));
    assert(!fs.existsSync(`${f.root}.install-lock`));
  } finally { await f.close(); }
});

test('installer --dir takes precedence over the environment and preserves spaces', async () => {
  const f = await fixture();
  try {
    const unusedRoot = path.join(f.directory, 'unused-install');
    const result = await f.run(['--dir', f.root], { FARMING_INSTALL_ROOT: unusedRoot });
    assert.equal(result.code, 0, result.output);
    assert(fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
    assert(!fs.existsSync(unusedRoot));
    assert(!fs.existsSync(f.bin), 'installation must not create an external command directory');
  } finally { await f.close(); }
});

for (const tool of ['sha512sum', 'shasum', 'openssl'] as const) {
  test(`installer rejects tampered archives before extraction with ${tool}`, { skip: !hasTool(tool) }, async () => {
    const f = await fixture(false, tool);
    try {
      f.corrupt();
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /SHA-512 verification failed/);
      assert(!fs.existsSync(f.extractions));
      assert(!fs.existsSync(f.root));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
    } finally { await f.close(); }
  });
}

for (const tool of ['sha512sum', 'base64'] as const) {
  test(`installer stops on ${tool} execution failure without switching tools`, { skip: !hasTool('sha512sum') }, async () => {
    const f = await fixture(false, 'sha512sum');
    try {
      const realTool = fs.readlinkSync(path.join(f.fakePath, tool));
      fs.unlinkSync(path.join(f.fakePath, tool));
      // Even correct output must not hide a failed verifier/decoder exit.
      fs.writeFileSync(path.join(f.fakePath, tool), `#!/bin/sh\n${quote(realTool)} "$@"\nexit 1\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(f.fakePath, 'openssl'), '#!/bin/sh\necho unexpected-fallback >&2\nexit 1\n', { mode: 0o755 });
      const result = await f.run();
      assert.notEqual(result.code, 0);
      assert.match(result.output, /SHA-512 verification failed/);
      assert.doesNotMatch(result.output, /unexpected-fallback/);
      assert(!fs.existsSync(f.extractions));
      assert(!fs.existsSync(f.root));
    } finally { await f.close(); }
  });
}

for (const failure of ['integrity', 'preflight', 'unmanaged-root']) {
  test(`installer preserves user files on ${failure} failure`, async () => {
    const f = await fixture();
    try {
      if (failure === 'integrity') f.corrupt();
      if (failure === 'unmanaged-root') { fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'keep'), 'owned by user'); }
      const result = await f.run([], failure === 'preflight' ? { FARMING_TEST_FAIL_PREFLIGHT: '1' } : {});
      assert.notEqual(result.code, 0, result.output);
      assert(!fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
      if (failure === 'preflight') {
        assert(!result.output.includes('.staging.'), result.output);
        const diagnostic = result.output.match(/Diagnostic log: (.+)/)?.[1];
        assert(diagnostic);
        assert.match(fs.readFileSync(diagnostic, 'utf8'), /executablePath.*\.staging\./);
        assert.equal(fs.statSync(diagnostic).mode & 0o077, 0, 'diagnostic logs must stay private');
        assert.equal(result.code, 19);
      }
      if (failure === 'unmanaged-root') assert.equal(fs.readFileSync(path.join(f.root, 'keep'), 'utf8'), 'owned by user');
    } finally { await f.close(); }
  });
}

test('concurrent installer cannot replace the owner', async () => {
  const f = await fixture();
  try {
    fs.mkdirSync(`${f.root}.install-lock`);
    const second = await f.run();
    assert.notEqual(second.code, 0);
    assert.match(second.output, /Another installation owns/);
    assert(fs.existsSync(`${f.root}.install-lock`));
    fs.rmdirSync(`${f.root}.install-lock`);
    const result = await f.run();
    assert.equal(result.code, 0, result.output);
  } finally { await f.close(); }
});

test('installer help and unsupported startup options do not install or launch', async () => {
  const f = await fixture();
  try {
    const help = await f.run(['--help']);
    assert.equal(help.code, 0, help.output);
    assert.match(help.output, /Start it separately with the Farming CLI/);
    for (const args of [['--start'], ['--no-start'], ['--help', '--start'], ['--dir'], ['--dir', ''], ['--dir', 'relative'], ['--dir', '/unused', 'extra'], ['--mirror'], ['--mirror', 'unknown'], ['--mirror', 'cn', '--mirror', 'cn'], ['--dir', '/unused', '--dir', '/unused'], ['--mirror', 'cn', '--help']]) {
      const result = await f.run(args);
      assert.notEqual(result.code, 0, result.output);
    }
    assert.equal(f.requests(), 0);
    assert(!fs.existsSync(f.root));
    assert(!fs.existsSync(f.calls));
  } finally { await f.close(); }
});

test('real npm with a stale China mirror retains the verified platform carrier', async () => {
  const f = await fixture(false, 'openssl', 'normal', 'missing', true, true);
  try {
    const result = await f.run(['--mirror', 'cn']);
    assert.equal(result.code, 0, result.output);
    assert(f.requestPaths.includes('/mirror/farming-code'), 'exercise real npm alias resolution against stale metadata');
    const installed = path.join(f.root, 'lib/node_modules/farming-code/node_modules/farming-code-runtime-darwin-arm64/package.json');
    assert.equal(JSON.parse(fs.readFileSync(installed, 'utf8')).version, '1.0.0-runtime-darwin-arm64');
    assert(f.requestPaths.includes('/upstream/farming-code-runtime/archive.tgz'));
  } finally { await f.close(); }
});

for (const legacy of [false, true]) {
  test(`platform carrier bootstrap installs without system Node on ${legacy ? 'legacy Linux' : 'macOS'}`, async () => {
    const f = await fixture(legacy, 'openssl', 'normal', 'none', true);
    try {
      const result = await f.run();
      assert.equal(result.code, 0, result.output);
      const platform = legacy ? 'linux-x64' : 'darwin-arm64';
      assert(f.requestPaths.includes(`/farming-code/1.0.0-runtime-${platform}`));
      const image = path.join(f.root, 'lib/node_modules/farming-code');
      assert(!fs.existsSync(path.join(image, 'dist/runtime/glibc228')));
      assert(fs.existsSync(path.join(image, 'node_modules', `farming-code-runtime-${platform}`, 'package.json')));
      const started = await f.start(`${quote(path.join(f.root, 'farming'))} help`);
      assert.equal(started.code, 0, started.output);
    } finally { await f.close(); }
  });
}
});
