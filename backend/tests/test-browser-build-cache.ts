import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-cache-'));
  const repo = path.join(root, 'repo');
  const upstream = path.join(root, 'upstream');
  const cache = path.join(root, 'cache');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'commands.log');
  const temporary = path.join(root, 'tmp');
  const hash = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
  const command = (cwd: string, args: string[]): string => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.com', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    for (const dir of [repo, upstream, bin, temporary]) fs.mkdirSync(dir);
    fs.mkdirSync(path.join(upstream, 'cli'));
    for (const name of ['Cargo.toml', 'Cargo.lock']) {
      fs.writeFileSync(path.join(upstream, 'cli', name), 'name = "agent-browser"\nversion = "1.0.0"\n');
    }
    fs.writeFileSync(path.join(upstream, 'LICENSE'), 'fixture license');
    fs.writeFileSync(path.join(upstream, 'README'), 'before\n');
    command(upstream, ['init', '-q']); command(upstream, ['add', '.']); command(upstream, ['commit', '-qm', 'upstream']);
    fs.mkdirSync(path.join(repo, 'backend/data'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'scripts'));
    for (const name of ['build-agent-browser-runtime.mjs', 'agent-browser-build-cache.mjs']) {
      fs.copyFileSync(path.join(process.cwd(), 'scripts', name), path.join(repo, 'scripts', name));
    }
    const patch = 'diff --git a/README b/README\n--- a/README\n+++ b/README\n@@ -1 +1 @@\n-before\n+reviewed\n';
    fs.writeFileSync(path.join(repo, 'reviewed.patch'), patch);
    const pin = { upstreamVersion: '1.0.0', version: '1.0.0-farming.1', repository: upstream,
      commit: command(upstream, ['rev-parse', 'HEAD']), patch: 'reviewed.patch', patchSha256: hash(patch),
      rust: '1.96.1', pnpm: '11.1.3', cargoZigbuild: '0.22.3', zig: '0.15.2' };
    const writePin = (): void => fs.writeFileSync(path.join(repo, 'backend/data/agent-browser-source.json'), JSON.stringify(pin));
    writePin();
    command(repo, ['init', '-q']); command(repo, ['add', '.']); command(repo, ['commit', '-qm', 'candidate A']);
    const shaA = command(repo, ['rev-parse', 'HEAD']);
    const fakeTool = `#!${process.execPath}
const fs=require('fs'),path=require('path');
const args=process.argv.slice(2); const name=path.basename(process.argv[1]);
fs.appendFileSync(process.env.FIXTURE_CALLS,name+' '+args.join(' ')+'\\n');
if(name==='npx'){ if(args.includes('build')) {fs.mkdirSync('packages/dashboard/out',{recursive:true});fs.writeFileSync('packages/dashboard/out/index.html','built');}process.exit(0);}
if(name==='zig'){console.log('0.15.2');process.exit(0);}
if(args.includes('--list')) {console.log('cargo-zigbuild v0.22.3:');process.exit(0);}
if(process.env.FIXTURE_FAIL==='1') process.exit(7);
if(args.includes('--release')) {Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,80);const target=args[args.indexOf('--target')+1];const dir=path.join(process.env.CARGO_TARGET_DIR,target,'release');fs.mkdirSync(dir,{recursive:true});const temporary=path.join(dir,'.agent-browser-'+process.pid);fs.writeFileSync(temporary,'#!/bin/sh\\nprintf "agent-browser 1.0.0-farming.1\\\\n"\\n',{mode:0o755});fs.renameSync(temporary,path.join(dir,'agent-browser'));}
`;
    for (const name of ['cargo', 'npx', 'zig']) fs.writeFileSync(path.join(bin, name), fakeTool, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, TMPDIR: temporary,
      FARMING_AGENT_BROWSER_BUILD_CACHE: cache, CARGO_TARGET_DIR: path.join(root, 'cargo'), FIXTURE_CALLS: calls };
    const build = (name: string, extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath,
      ['scripts/build-agent-browser-runtime.mjs', '--platform', 'linux-x64-musl', '--output', path.join(root, name)],
      { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 });
    const identity = (name: string) => JSON.parse(fs.readFileSync(path.join(root, name, 'linux-x64-musl/identity.json'), 'utf8'));
    const cold = build('cold'); assert.equal(cold.status, 0, cold.stderr);
    const initialCalls = fs.readFileSync(calls, 'utf8');
    command(repo, ['commit', '--allow-empty', '-qm', 'candidate B']);
    const warm = build('warm'); assert.equal(warm.status, 0, warm.stderr);
    assert.match(warm.stdout, /Verified cached Browser runtime/);
    assert.equal(fs.readFileSync(calls, 'utf8'), initialCalls, 'warm restore must not fetch dependencies or run Cargo');
    assert.equal(identity('warm').farmingSha, command(repo, ['rev-parse', 'HEAD']));
    assert.equal(identity('warm').compilationOrigin.farmingSha, shaA);
    assert.deepEqual(identity('warm').compilationOrigin, identity('cold').compilationOrigin);
    assert.equal(identity('warm').sha256, identity('cold').sha256);

    const entry = path.join(cache, fs.readdirSync(cache)[0]);
    for (const name of ['agent-browser', 'LICENSE', 'identity.json']) {
      const file = path.join(entry, name); const bytes = fs.readFileSync(file);
      fs.appendFileSync(file, 'corrupt');
      const broken = build(`corrupt-${name}`);
      assert.notEqual(broken.status, 0); assert.match(broken.stderr, /cache digest mismatch/);
      assert.equal(fs.readFileSync(calls, 'utf8'), initialCalls, 'corruption must fail without an automatic rebuild');
      fs.writeFileSync(file, bytes);
    }
    const binary = path.join(entry, 'agent-browser'); const bytes = fs.readFileSync(binary);
    fs.unlinkSync(binary); fs.symlinkSync(path.join(root, 'cold/linux-x64-musl/agent-browser'), binary);
    assert.match(build('symlink').stderr, /regular file/);
    fs.unlinkSync(binary); fs.writeFileSync(binary, bytes, { mode: 0o755 });

    fs.appendFileSync(path.join(repo, 'scripts/build-agent-browser-runtime.mjs'), '\n// changed recipe\n');
    assert.equal(build('recipe').status, 0);
    assert.equal(fs.readdirSync(cache).length, 2, 'recipe changes invalidate binary reuse');
    pin.rust = '1.97.0'; writePin();
    assert.equal(build('toolchain').status, 0);
    assert.equal(fs.readdirSync(cache).length, 3, 'toolchain pins invalidate binary reuse');
    const updatedPatch = patch.replace('+reviewed', '+updated');
    fs.writeFileSync(path.join(repo, 'reviewed.patch'), updatedPatch); pin.patchSha256 = hash(updatedPatch); writePin();
    assert.equal(build('patch').status, 0);
    assert.equal(fs.readdirSync(cache).length, 4, 'reviewed patch changes invalidate binary reuse');
    command(upstream, ['commit', '--allow-empty', '-qm', 'new upstream source']);
    pin.commit = command(upstream, ['rev-parse', 'HEAD']); writePin();
    assert.equal(build('source').status, 0);
    assert.equal(fs.readdirSync(cache).length, 5, 'upstream source changes invalidate binary reuse');
    const otherPlatform = spawnSync(process.execPath, ['scripts/build-agent-browser-runtime.mjs', '--platform', 'linux-arm64-musl',
      '--output', path.join(root, 'other-platform')], { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(otherPlatform.status, 0, otherPlatform.stderr);
    assert.equal(fs.readdirSync(cache).length, 6, 'platform changes select another entry');
    pin.rust = '1.98.0'; writePin();
    const failed = build('failed', { FIXTURE_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.readdirSync(cache).length, 6);
    assert.equal(fs.existsSync(path.join(root, 'failed/linux-x64-musl')), false);
    assert.deepEqual(fs.readdirSync(temporary), [], 'failed builds must remove their own source staging');

    const concurrent = (name: string) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath,
        ['scripts/build-agent-browser-runtime.mjs', '--platform', 'linux-x64-musl', '--output', path.join(root, name)],
        { cwd: repo, env, timeout: 30_000 });
      let errors = ''; child.stderr.on('data', bytes => { errors += bytes; }); child.stdout.resume();
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
    });
    const outcomes = await Promise.allSettled([concurrent('concurrent-A'), concurrent('concurrent-B')]);
    for (const outcome of outcomes) assert.equal(outcome.status, 'fulfilled', outcome.status === 'rejected' ? String(outcome.reason) : '');
    assert.equal(fs.readdirSync(cache).length, 7, 'concurrent publishers converge on one complete entry');
    assert(!fs.readdirSync(cache).some(name => name.startsWith('.')));
    assert.deepEqual(fs.readdirSync(temporary), []);
    console.log('✓ Browser builds reuse verified binaries across SHAs, invalidate changed inputs, reject tampering and clean failed/concurrent staging');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
