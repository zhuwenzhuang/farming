import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const projectRoot = path.resolve(__dirname, '../..');
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function fixture(legacy = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-user-install-'));
  const archives = new Map<string, Buffer>();
  const fakePath = path.join(directory, 'tools');
  fs.mkdirSync(fakePath);
  // Deliberately no node or npm in PATH. Their fixtures call a known absolute
  // executable so these tests neither download nor depend on a system install.
  for (const name of ['bash', 'dirname', 'mkdir', 'rmdir', 'rm', 'readlink', 'openssl', 'tar', 'gzip', 'curl', 'sed', 'tr', 'mktemp', 'chmod', 'touch', 'mv', 'ln', 'cat']) {
    const target = execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
    fs.symlinkSync(target, path.join(fakePath, name));
  }
  const executable = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode: 0o755 });
  };
  executable(path.join(fakePath, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo ${legacy ? 'Linux' : 'Darwin'};; -m) echo ${legacy ? 'x86_64' : 'arm64'};; esac\n`);
  executable(path.join(fakePath, 'getconf'), '#!/bin/sh\necho "glibc 2.17"\n');
  const carrier = legacy ? 'node-linux-x64' : 'node-bin-darwin-arm64';
  function pack(name: string, version: string, prepare: (root: string) => void) {
    const root = path.join(directory, 'packages', name, 'package');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version }));
    prepare(root);
    const output = path.join(directory, `${name}.tgz`);
    execFileSync('tar', ['-czf', output, '-C', path.dirname(root), 'package']);
    archives.set(name, fs.readFileSync(output));
  }
  pack(carrier, '22.23.2', root => executable(path.join(root, 'bin/node'), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`));
  pack('npm', '12.1.0', root => executable(path.join(root, 'bin/npm-cli.js'), `
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const args = process.argv.slice(2);
if (args[0] === 'cache') process.exit(0);
assert(args.includes('--ignore-scripts')); assert(args.includes('--include=optional'));
const prefix = args[args.indexOf('--prefix') + 1];
const stage = path.dirname(prefix); const target = path.join(prefix, 'lib/node_modules/farming-code');
fs.cpSync(path.join(stage, 'farming/package'), target, { recursive: true });
`));
  pack('farming-code', '1.0.0', root => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'farming-code', version: '1.0.0', farmingUserRuntimeDependencies: { [carrier]: '22.23.2', npm: '12.1.0' } }));
    for (const name of ['farming-node', 'farming-npm']) {
      executable(path.join(root, 'bin', name), fs.readFileSync(path.join(projectRoot, 'bin', name), 'utf8'));
    }
    executable(path.join(root, 'bin/farming'), `
const fs = require('fs');
if (process.argv[2] === 'runtime' && process.env.FARMING_TEST_FAIL_PREFLIGHT) process.exit(19);
fs.appendFileSync(process.env.FARMING_TEST_CALLS, JSON.stringify({command:process.argv[2],runtime:process.env.FARMING_MANAGED_NODE_ROOT,registry:process.env.npm_config_registry,cache:process.env.npm_config_cache,images:process.env.FARMING_PACKAGE_INSTALLATIONS_DIR})+'\\n');
`);
    executable(path.join(root, 'node_modules/node-pty/index.js'), 'module.exports = {};');
    executable(path.join(root, 'dist/runtime/glibc228/ld-2.28.so'), '#!/bin/sh\n[ "$1" = --library-path ] || exit 9\nshift 2\nexec "$@"\n');
  });
  let requests = 0;
  let corrupt = false;
  const server = http.createServer((request, response) => {
    requests++;
    const send = () => {
      const name = request.url!.split('/')[1];
      const body = archives.get(name);
      if (!body) { response.writeHead(404).end(); return; }
      if (request.url!.endsWith('.tgz')) { response.end(body); return; }
      const address = server.address();
      assert(address && typeof address !== 'string');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ name, dist: {
        tarball: `http://127.0.0.1:${address.port}/${name}/archive.tgz`,
        integrity: `sha512-${corrupt ? 'invalid' : createHash('sha512').update(body).digest('base64')}`,
      } }));
    };
    send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const registryUrl = `http://127.0.0.1:${address.port}`;
  const root = path.join(directory, 'install with spaces');
  const bin = path.join(directory, 'user bin');
  const calls = path.join(directory, 'calls');
  async function shell(args: string[], env: NodeJS.ProcessEnv = {}) {
    const child = spawn('/bin/bash', args, {
      env: { ...process.env, PATH: fakePath, HOME: directory, FARMING_INSTALL_ROOT: root,
        FARMING_BIN_DIR: bin, FARMING_NPM_REGISTRY: registryUrl,
        FARMING_TEST_CALLS: calls, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    return { code, output };
  }
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) => shell([path.join(projectRoot, 'bin/install.sh'), ...args], env);
  const start = (command: string) => shell(['-c', command], { FARMING_NPM_REGISTRY: '', npm_config_registry: '' });
  return { directory, root, bin, calls, run, start, fakePath,
    requests: () => requests,
    corrupt: () => { corrupt = true; },
    async close() {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const legacy of [false, true]) {
  test(`user installer without system Node, legacy=${legacy}`, async () => {
    const f = await fixture(legacy);
    try {
      const first = await f.run();
      assert.equal(first.code, 0, first.output);
      assert(fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
      assert.equal(fs.readlinkSync(path.join(f.bin, 'farming')), path.join(f.root, 'farming'));
      const installedCalls = fs.readFileSync(f.calls, 'utf8');
      assert.deepEqual(installedCalls.trim().split('\n').map(line => JSON.parse(line).command), ['runtime'],
        'installation must verify the runtime without starting a daemon');
      const startCommand = first.output.match(/Start Farming:\n {2}(.+)\n/)?.[1];
      assert(startCommand, 'installer must print a shell-safe CLI command');
      const started = await f.start(startCommand);
      assert.equal(started.code, 0, started.output);
      const startedCalls = fs.readFileSync(f.calls, 'utf8');
      const before = f.requests();
      const second = await f.run([], { FARMING_NPM_REGISTRY: '', npm_config_registry: '' });
      assert.equal(second.code, 0, second.output);
      assert.equal(f.requests(), before, 'repeat install must not overwrite or download');
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

test('installer reports missing base tools together before downloading', async () => {
  const f = await fixture();
  try {
    fs.unlinkSync(path.join(f.fakePath, 'openssl'));
    fs.unlinkSync(path.join(f.fakePath, 'tar'));
    const result = await f.run();
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Missing basic tools: tar openssl/);
    assert.match(result.output, /Node.js and npm are downloaded automatically/);
    assert.equal(f.requests(), 0);
    assert(!fs.existsSync(f.root));
    assert(!fs.existsSync(`${f.root}.install-lock`));
  } finally { await f.close(); }
});

for (const failure of ['integrity', 'preflight', 'existing-entry', 'unmanaged-root']) {
  test(`installer preserves user files on ${failure} failure`, async () => {
    const f = await fixture();
    try {
      if (failure === 'integrity') f.corrupt();
      if (failure === 'existing-entry') { fs.mkdirSync(f.bin); fs.writeFileSync(path.join(f.bin, 'farming'), 'owned by user'); }
      if (failure === 'unmanaged-root') { fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, 'keep'), 'owned by user'); }
      const result = await f.run([], failure === 'preflight' ? { FARMING_TEST_FAIL_PREFLIGHT: '1' } : {});
      assert.notEqual(result.code, 0, result.output);
      assert(!fs.existsSync(path.join(f.root, '.farming-user-install-v1')));
      assert(!fs.existsSync(`${f.root}.install-lock`));
      assert(!fs.readdirSync(f.directory).some(name => name.includes('.staging.')));
      if (failure === 'existing-entry') assert.equal(fs.readFileSync(path.join(f.bin, 'farming'), 'utf8'), 'owned by user');
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
    for (const args of [['--start'], ['--no-start'], ['--help', '--start']]) {
      const result = await f.run(args);
      assert.notEqual(result.code, 0, result.output);
    }
    assert.equal(f.requests(), 0);
    assert(!fs.existsSync(f.root));
    assert(!fs.existsSync(f.calls));
  } finally { await f.close(); }
});
