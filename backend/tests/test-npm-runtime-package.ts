import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { npmRuntimePackageRoot } from '../npm-runtime-package.cjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-carrier-'));
  const image = path.join(root, 'image');
  fs.mkdirSync(image);
  const carrier = path.join(image, 'node_modules/farming-code-runtime-linux-x64');
  const manifest = { farmingRuntimePackages: 1, optionalDependencies: {
    'farming-code-runtime-linux-x64': 'npm:farming-code@1.0.0-runtime-linux-x64',
  } };
  const identity = { name: 'farming-code', version: '1.0.0-runtime-linux-x64', farmingRuntimePlatform: 'linux-x64' };
  const write = (file: string, data: object) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  return { root, image, carrier, manifest, identity, write, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('source and legacy images retain their embedded runtime boundary', () => {
  const f = fixture();
  try {
    assert.equal(npmRuntimePackageRoot(f.image, 'linux-x64'), f.image);
    f.write(path.join(f.image, 'package.json'), { name: 'farming-code', version: '1.0.0' });
    assert.equal(npmRuntimePackageRoot(f.image, 'linux-x64'), f.image);
  } finally { f.close(); }
});

test('npm carrier resolves GNU and musl entries within the same OS/CPU image', () => {
  const f = fixture();
  try {
    f.write(path.join(f.image, 'package.json'), f.manifest);
    assert.throws(() => npmRuntimePackageRoot(f.image, 'linux-x64'), /reinstall with optional dependencies/);
    f.write(path.join(f.carrier, 'package.json'), f.identity);
    assert.equal(npmRuntimePackageRoot(f.image, 'linux-x64'), f.carrier);
    assert.equal(npmRuntimePackageRoot(f.image, 'linux-x64-musl'), f.carrier);
    assert.throws(() => npmRuntimePackageRoot(f.image, 'darwin-arm64'), /Missing runtime package pin/);
    for (const identity of [{ ...f.identity, version: '0.9.0' }, { ...f.identity, farmingRuntimePlatform: 'darwin-arm64' }]) {
      f.write(path.join(f.carrier, 'package.json'), identity);
      assert.throws(() => npmRuntimePackageRoot(f.image, 'linux-x64'), /missing or invalid/);
    }
  } finally { f.close(); }
});

test('npm carrier cannot escape its immutable image or fall back to embedded files', () => {
  const f = fixture();
  try {
    f.write(path.join(f.image, 'package.json'), f.manifest);
    f.write(path.join(f.image, 'dist/runtime/ripgrep/linux-x64/rg'), {});
    const outside = path.join(f.root, 'outside');
    f.write(path.join(outside, 'package.json'), f.identity);
    fs.mkdirSync(path.dirname(f.carrier), { recursive: true });
    fs.symlinkSync(outside, f.carrier, 'junction');
    assert.throws(() => npmRuntimePackageRoot(f.image, 'linux-x64'), /missing or invalid/);
  } finally { f.close(); }
});
