import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stageRemoteDeploymentArtifact } from '../../scripts/stage-remote-deployment-artifact';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-remote-artifact-'));
const project = process.cwd();
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const sshLog = path.join(root, 'ssh.log');
  const activation = path.join(root, 'activation.log');
  fs.writeFileSync(path.join(bin, 'ssh'), `#!${process.execPath}
const fs=require('fs'),cp=require('child_process');let args=process.argv.slice(2);
while(args[0]?.startsWith('-'))args.splice(0,2);args.shift();const command=args.join(' ');const input=fs.readFileSync(0);
fs.appendFileSync(${JSON.stringify(sshLog)},command+'\\n');
if(input.equals(fs.readFileSync(${JSON.stringify(path.join(project, 'scripts/activate-remote-release.sh'))}))){fs.writeFileSync(${JSON.stringify(activation)},command);process.exit(0);}
const r=cp.spawnSync('bash',['-c',command],{input,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1);
`, { mode: 0o755 });
  for (const name of ['docker', 'rsync']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho UNEXPECTED_LOCAL_TOOL >&2\nexit 99\n', { mode: 0o755 });
  const bundle = path.join(root, 'bundle'); fs.mkdirSync(bundle);
  const metadata = { type: 'app-bundle', dirty: false, gitSha: 'a'.repeat(40), platform: 'linux', arch: 'x64',
    releaseVersion: '1.0.0', packageVersion: '1.0.0', updateMethod: 'app-bundle', bundledNodeModules: true,
    bundledGlibcRuntime: true, compatibilityProfile: 'linux-x64-legacy-glibc228' };
  for (const file of ['scripts/install-release.sh', 'shared/browser-protocol.js', 'extensions/browser/backend/index.cjs',
    'extensions/computer/backend/index.cjs', 'extensions/computer/backend/cua-tools.json',
    'extensions/language-server/backend/index.cjs', 'extensions/shared-config/backend/index.cjs']) {
    const target = path.join(bundle, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture');
  }
  const source = path.join(root, "package ' $literal ;.tar.gz");
  const pack = (): string => {
    fs.writeFileSync(path.join(bundle, 'RELEASE.json'), JSON.stringify(metadata));
    const result = spawnSync('tar', ['-czf', source, '-C', root, 'bundle'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return hash(fs.readFileSync(source));
  };
  let checksum = pack();
  const destination = path.join(root, 'selection');
  const incoming = `${destination}.deploy/incoming`;
  const args = ['--ssh-host', 'fixture', '--remote-dir', destination, '--remote-artifact', source,
    '--git-sha', metadata.gitSha, '--artifact-sha256', checksum];
  const deploy = (extra: string[] = [], selected = args) => spawnSync('bash', ['scripts/deploy.sh', ...selected, ...extra],
    { cwd: project, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 30_000 });
  const result = deploy(); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no archive transfer/);
  assert(fs.existsSync(activation), 'successful verification must invoke the canonical activator');
  assert(fs.readFileSync(activation, 'utf8').includes(incoming));
  assert.equal(hash(fs.readFileSync(source)), checksum, 'the builder original must survive deployment');
  const copied = path.join(incoming, fs.readdirSync(incoming)[0]);
  assert.equal(hash(fs.readFileSync(copied)), checksum); assert.equal(fs.statSync(copied).mode & 0o777, 0o600);
  fs.rmSync(copied); fs.rmSync(activation);

  for (const extra of [['--artifact', source], ['--git-sha', 'bad'], ['--artifact-sha256', 'bad'], ['--remote-artifact', 'relative']]) {
    fs.writeFileSync(sshLog, '');
    assert.equal(deploy(extra).status, 2);
    assert.equal(fs.readFileSync(sshLog, 'utf8'), '', 'invalid options must fail before any remote action');
  }
  const withoutChecksum = args.slice(0, args.indexOf('--artifact-sha256'));
  assert.equal(deploy([], withoutChecksum).status, 2, 'remote packages require an independently pinned digest');
  const partial = path.join(root, 'partial');
  const copy = fs.copyFileSync;
  try {
    fs.copyFileSync = () => { throw new Error('fixture copy I/O failure'); };
    assert.throws(() => stageRemoteDeploymentArtifact(source, partial, metadata.gitSha, checksum), /I\/O failure/);
  } finally { fs.copyFileSync = copy; }
  assert(!fs.existsSync(partial), 'a copy failure must remove its operation-owned partial file');
  fs.mkdirSync(path.join(bundle, '.farming'));
  fs.writeFileSync(path.join(bundle, '.farming/session-token'), 'private fixture');
  checksum = pack();
  const unsafe = deploy(['--artifact-sha256', checksum]);
  assert.notEqual(unsafe.status, 0); assert(!fs.existsSync(activation));
  assert.deepEqual(fs.readdirSync(incoming), []);
  fs.rmSync(path.join(bundle, '.farming'), { recursive: true });
  checksum = pack();
  args[args.indexOf('--artifact-sha256') + 1] = checksum;
  for (const extra of [['--artifact-sha256', 'b'.repeat(64)], ['--git-sha', 'c'.repeat(40)],
    ['--remote-artifact', path.join(root, 'missing')], ['--remote-artifact', bundle]]) {
    const failed = deploy(extra); assert.notEqual(failed.status, 0, failed.stdout);
    assert(!fs.existsSync(activation)); assert.deepEqual(fs.readdirSync(incoming), []);
    assert.equal(hash(fs.readFileSync(source)), checksum);
  }
  const link = path.join(root, 'linked'); fs.symlinkSync(source, link);
  assert.match(deploy(['--remote-artifact', link]).stderr, /regular file/);
  for (const mutate of [() => { metadata.arch = 'arm64'; }, () => { metadata.arch = 'x64'; metadata.dirty = true; },
    () => { metadata.dirty = false; metadata.bundledGlibcRuntime = false; }]) {
    mutate(); checksum = pack();
    const failed = deploy(['--artifact-sha256', checksum]); assert.notEqual(failed.status, 0);
    assert(!fs.existsSync(activation)); assert.deepEqual(fs.readdirSync(incoming), []);
  }
  const occupied = path.join(root, 'occupied'); fs.writeFileSync(occupied, 'another operation');
  assert.throws(() => stageRemoteDeploymentArtifact(source, occupied, metadata.gitSha, checksum), /EEXIST/);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'another operation');
  console.log('✓ target-host artifact deployment verifies an owned copy, preserves source, rejects invalid inputs and never invokes local Docker or archive transport');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
