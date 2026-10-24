import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { checkComputerEnvironment } from './check-release-computer-environment.mjs';

const sha = 'a'.repeat(40);
const image = `example.test/desktop@sha256:${'b'.repeat(64)}`;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-cu-preflight-'));
  const write = (filename, content) => {
    fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    fs.writeFileSync(path.join(root, filename), content);
  };
  write('package.json', '{"version":"1.0.0"}');
  write('package-lock.json', '{}');
  for (const directory of ['backend', 'extensions/browser/backend', 'extensions/computer/backend',
    'extensions/language-server/backend', 'extensions/shared-config/backend', 'extensions/a2a/backend']) write(`${directory}/owner.cts`, '// source');
  for (const directory of ['backend', 'extensions/browser/backend', 'extensions/computer/backend',
    'extensions/language-server/backend', 'extensions/shared-config/backend', 'extensions/a2a/backend']) {
    write(`${directory}/owner.cjs`, '// output');
    write(`${directory}/owner.cjs.map`, JSON.stringify({ sourcesContent: ['// source'] }));
  }
  for (const filename of ['bin/farming', 'dist/index.html', 'backend/usage-history-scanner.generated.js',
    'backend/data/runtime-dependency-manifest.json', 'extensions/computer/backend/index.cjs',
    'extensions/computer/backend/cua-tools.json']) write(filename, '{}');
  write('backend/native-pty-host-identity.cjs', `exports.NATIVE_PTY_HOST_RUNTIME_FILES=["owner.cjs"];exports.nativePtyHostRuntimeIdentity=()=>({buildId:"${'d'.repeat(64)}"});`);
  write('backend/ripgrep-runtime.cjs', 'exports.MANAGED_RIPGREP_VERSION="15.2.0";exports.managedRipgrepRelativePath=()=>"dist/runtime/ripgrep/linux-x64/rg";');
  write('dist/runtime/ripgrep/linux-x64/rg', 'binary');
  fs.chmodSync(path.join(root, 'dist/runtime/ripgrep/linux-x64/rg'), 0o700);
  write('backend/packaged-node-pty.cjs', 'exports.nodePty={spawn(){}};');
  write('backend/runtime-executable-invocation.cjs', `exports.runtimeExecutableInvocation=(executablePath,args=[],env=process.env,platform=process.platform)=>platform==='linux'&&env.FARMING_NODE_LD&&env.FARMING_NODE_LIBRARY_PATH?{command:env.FARMING_NODE_LD,args:['--library-path',env.FARMING_NODE_LIBRARY_PATH,executablePath,...args]}:{command:executablePath,args};`);
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'git') return args.includes('rev-parse') ? sha : '';
    if (command === process.execPath) return '22.18.0';
    if (command.endsWith('/rg')) return 'ripgrep 15.2.0 (rev test)\n';
    if (command === 'docker' && args[0] === 'info') return '{"OSType":"linux","NCPU":8}';
    if (command === 'docker') return JSON.stringify([{ Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [image], Os: 'linux', Architecture: 'amd64' }]);
    throw Error('Unexpected command');
  };
  return { root, write, calls, execute, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function run(f, execute = f.execute) {
  return checkComputerEnvironment({ root: f.root, candidateSha: sha, image }, { platform: 'linux', arch: 'x64', execute });
}
test('ready receipt uses owner pins, child launch and read-only warmed image observations', () => {
  const f = fixture();
  try {
    const result = run(f);
    assert.equal(result.status, 'ready');
    assert.equal(result.facts.ripgrepVersion, '15.2.0');
    assert.equal(result.facts.childNodeVersion, '22.18.0');
    assert(f.calls.some(call => call.command === process.execPath && call.args.includes('-e')));
    assert(f.calls.every(call => call.command !== 'docker' || ['info', 'image'].includes(call.args[0])));
    assert(!JSON.stringify(result).includes(f.root));
  } finally { f.dispose(); }
});
test('known environment failures stop readiness and never leak command errors', () => {
  const f = fixture();
  try {
    f.write('backend/owner.cjs.map', '{"sourcesContent":["// stale"]}');
    const result = run(f, (command, args, options) => {
      if (command === process.execPath || command.endsWith('/rg') || command === 'docker') throw Error('private endpoint/token');
      return f.execute(command, args, options);
    });
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.failures, ['CU_GENERATED_RUNTIME_MISSING_OR_STALE',
      'CU_MANAGED_RIPGREP_MISSING_OR_WRONG_VERSION', 'CU_CHILD_NODE_OR_NATIVE_PTY_LOAD_FAILED',
      'CU_DOCKER_UNAVAILABLE', 'CU_PINNED_IMAGE_NOT_WARM']);
    assert(!JSON.stringify(result).includes('private endpoint'));
  } finally { f.dispose(); }
});
test('dirty source, archive self-attestation, wrong bundle SHA and unpinned images fail closed', () => {
  const f = fixture();
  try {
    assert(run(f, (command, args, options) => command === 'git' && args.includes('status')
      ? ' M src/file.ts\n' : f.execute(command, args, options)).failures.includes('CU_CANDIDATE_IDENTITY_MISMATCH'));
    f.write('RELEASE.json', JSON.stringify({ gitSha: sha, sourceSnapshot: true }));
    assert(run(f).failures.includes('CU_CANDIDATE_IDENTITY_MISMATCH'));
    f.write('RELEASE.json', JSON.stringify({ type: 'app-bundle', dirty: false, platform: 'linux', arch: 'x64', gitSha: 'd'.repeat(40) }));
    assert(run(f).failures.includes('CU_CANDIDATE_IDENTITY_MISMATCH'));
    f.calls.length = 0;
    assert.equal(checkComputerEnvironment({ root: f.root, candidateSha: sha, image: 'desktop:latest' }, {
      platform: 'linux', arch: 'x64', execute: f.execute,
    }).status, 'blocked');
    assert.equal(f.calls.length, 0);
  } finally { f.dispose(); }
});
test('app bundle supports omitted source maps but requires genuine bundle shape', () => {
  const f = fixture();
  try {
    f.write('RELEASE.json', JSON.stringify({ type: 'app-bundle', dirty: false, platform: 'linux', arch: 'x64', gitSha: sha }));
    fs.rmSync(path.join(f.root, 'backend/owner.cjs.map'));
    assert.equal(run(f).status, 'ready');
    assert(!f.calls.some(call => call.command === 'git'));
  } finally { f.dispose(); }
});
test('actual child Node load fails closed when the native boundary cannot initialize', () => {
  const f = fixture();
  const originalPackaged = process.env.FARMING_PACKAGED_RUNTIME;
  const originalConfig = process.env.FARMING_CONFIG_DIR;
  try {
    const config = path.join(f.root, 'ambient-config');
    process.env.FARMING_PACKAGED_RUNTIME = '1';
    process.env.FARMING_CONFIG_DIR = config;
    f.write('backend/packaged-node-pty.cjs', `if(process.env.FARMING_PACKAGED_RUNTIME==='1')require('node:fs').mkdirSync(${JSON.stringify(config)});exports.nodePty={spawn(){}};`);
    const execute = (command, args, options) => {
      if (command !== process.execPath) return f.execute(command, args, options);
      assert.equal(options.env.FARMING_PACKAGED_RUNTIME, '0');
      assert.equal(options.env.FARMING_CONFIG_DIR, undefined);
      return execFileSync(command, args, { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    };
    assert.equal(run(f, execute).status, 'ready');
    assert.equal(fs.existsSync(config), false, 'preflight must not prepare packaged native helpers in ambient Config');
    f.write('backend/packaged-node-pty.cjs', '');
    assert.deepEqual(run(f, execute).failures, ['CU_CHILD_NODE_OR_NATIVE_PTY_LOAD_FAILED']);
    f.write('backend/packaged-node-pty.cjs', 'throw Error("private loader/binary detail");');
    const result = run(f, execute);
    assert.deepEqual(result.failures, ['CU_CHILD_NODE_OR_NATIVE_PTY_LOAD_FAILED']);
    assert(!JSON.stringify(result).includes('private loader'));
  } finally {
    if (originalPackaged === undefined) delete process.env.FARMING_PACKAGED_RUNTIME;
    else process.env.FARMING_PACKAGED_RUNTIME = originalPackaged;
    if (originalConfig === undefined) delete process.env.FARMING_CONFIG_DIR;
    else process.env.FARMING_CONFIG_DIR = originalConfig;
    f.dispose();
  }
});

test('legacy Linux child probe uses the production runtime invocation owner', () => {
  const f = fixture();
  const env = { ...process.env, FARMING_NODE_BIN: '/managed/node', FARMING_NODE_LD: '/private/ld-2.28.so',
    FARMING_NODE_LIBRARY_PATH: '/private/lib' };
  const calls = [];
  try {
    const result = checkComputerEnvironment({ root: f.root, candidateSha: sha, image }, {
      platform: 'linux', arch: 'x64', env, execute: (command, args, options) => {
        calls.push({ command, args });
        if (command.endsWith('ld-2.28.so')) return '22.18.0';
        return f.execute(command, args, options);
      },
    });
    assert.equal(result.status, 'ready');
    const child = calls.find(call => call.command === '/private/ld-2.28.so');
    assert.deepEqual(child.args.slice(0, 4), ['--library-path', '/private/lib', '/managed/node', '-e']);
    assert.equal(result.facts.childNodeVersion, '22.18.0');
  } finally { f.dispose(); }
});
