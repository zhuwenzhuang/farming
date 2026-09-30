import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('native tests reuse the release target while Linux tests remain host-native; every artifact has fresh identity', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-recipe-'));
  try {
    const project = path.join(fixture, 'project');
    const bin = path.join(fixture, 'bin');
    for (const directory of ['scripts', 'backend/data', 'patches/agent-browser']) fs.mkdirSync(path.join(project, directory), { recursive: true });
    fs.mkdirSync(bin);
    const pin = JSON.parse(fs.readFileSync('backend/data/agent-browser-source.json', 'utf8'));
    for (const file of ['scripts/build-agent-browser-runtime.mjs', 'backend/data/agent-browser-source.json', pin.patch]) {
      fs.copyFileSync(file, path.join(project, file));
    }
    const fake = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const pin=JSON.parse(fs.readFileSync(path.join(process.env.RECIPE_PROJECT,'backend/data/agent-browser-source.json')));
const command=path.basename(process.argv[1]);let args=process.argv.slice(2);
fs.appendFileSync(process.env.RECIPE_CALLS,JSON.stringify({command,args})+'\\n');
if(command==='git'){
  if(args[0]==='-c') args=args.slice(2);
  if(args[0]==='rev-parse') console.log(process.cwd()===fs.realpathSync(process.env.RECIPE_PROJECT)?process.env.RECIPE_SHA:pin.commit);
  if(args[0]==='checkout'){
    fs.mkdirSync('cli');for(const name of ['Cargo.toml','Cargo.lock'])fs.writeFileSync('cli/'+name,'name = "agent-browser"\\nversion = "'+pin.upstreamVersion+'"');
    fs.writeFileSync('LICENSE','fixture license');
  }
} else if(command==='npx'){
  if(args.includes('build')){fs.mkdirSync('packages/dashboard/out',{recursive:true});fs.writeFileSync('packages/dashboard/out/index.html','fixture dashboard');}
} else if(command==='cargo'){
  if(args.includes('--list')) console.log('cargo-zigbuild v'+pin.cargoZigbuild+':');
  if(args.includes('test')&&process.env.RECIPE_FAIL_TEST==='1') process.exit(21);
  if(args.includes('build')||args.includes('zigbuild')){
    const target=args[args.indexOf('--target')+1].replace(/\\.2\\.28$/,'');
    const destination=path.join(process.env.CARGO_TARGET_DIR,target,'release');fs.mkdirSync(destination,{recursive:true});
    const name=target.includes('windows')?'agent-browser.exe':'agent-browser';
    fs.writeFileSync(path.join(destination,name),'#!/bin/sh\\necho "agent-browser '+pin.version+'"\\n',{mode:0o755});
  }
} else if(command==='objdump') console.log('GLIBC_2.28');
`;
    for (const command of ['git', 'npx', 'cargo', 'objdump']) fs.writeFileSync(path.join(bin, command), fake, { mode: 0o755 });
    const targets = {
      'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
      'linux-x64': 'x86_64-unknown-linux-gnu', 'linux-x64-musl': 'x86_64-unknown-linux-musl',
      'win32-x64': 'x86_64-pc-windows-msvc',
    };
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RECIPE_PROJECT: project,
      RECIPE_CALLS: path.join(fixture, 'calls'), RECIPE_SHA: 'a'.repeat(40), CARGO_TARGET_DIR: path.join(fixture, 'cargo') };
    for (const [platform, target] of Object.entries(targets)) {
      fs.writeFileSync(env.RECIPE_CALLS, '');
      const result = spawnSync(process.execPath, [path.join(project, 'scripts/build-agent-browser-runtime.mjs'),
        '--platform', platform, '--output', path.join(fixture, 'artifacts')], { env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(env.RECIPE_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const cargo = calls.filter(call => call.command === 'cargo');
      const unit = cargo.find(call => call.args.includes('test')).args;
      const build = cargo.find(call => call.args.includes('build') || call.args.includes('zigbuild')).args;
      assert.deepEqual(unit, [`+${pin.rust}`, 'test', '--locked', '--release',
        ...(platform.startsWith('linux-') ? [] : ['--target', target]), 'native::cdp::chrome::tests', '--', '--nocapture']);
      assert.deepEqual(build, [`+${pin.rust}`, platform.startsWith('linux-') ? 'zigbuild' : 'build', '--locked', '--release',
        '--target', platform === 'linux-x64' ? `${target}.2.28` : target]);
      const directory = path.join(fixture, 'artifacts', platform);
      const identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
      assert.equal(identity.farmingSha, env.RECIPE_SHA);
      assert.equal(identity.sourceId, crypto.createHash('sha256').update(JSON.stringify(pin)).digest('hex'));
      const executable = fs.readFileSync(path.join(directory, platform.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser'));
      assert.equal(identity.sha256, crypto.createHash('sha256').update(executable).digest('hex'));
    }
    fs.writeFileSync(env.RECIPE_CALLS, '');
    const failedOutput = path.join(fixture, 'failed');
    const failed = spawnSync(process.execPath, [path.join(project, 'scripts/build-agent-browser-runtime.mjs'),
      '--platform', 'darwin-arm64', '--output', failedOutput], { env: { ...env, RECIPE_FAIL_TEST: '1' }, encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(failed.status, 0);
    assert.equal(fs.existsSync(failedOutput), false, 'a failed regression must not publish an artifact');
    const failedCalls = fs.readFileSync(env.RECIPE_CALLS, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(!failedCalls.some(call => call.command === 'cargo' && (call.args.includes('build') || call.args.includes('zigbuild'))),
      'a failed test must prevent compilation of the artifact');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
