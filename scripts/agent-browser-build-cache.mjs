import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const regular = file => assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(),
  `Browser cache requires a regular file: ${file}`);
const present = file => {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

export function browserBuildInputs({ root, pin, platformKey, target, hostPlatform = process.platform, hostArch = process.arch }) {
  const patchSha256 = hash(fs.readFileSync(path.join(root, pin.patch)));
  assert.equal(patchSha256, pin.patchSha256, 'Reviewed agent-browser patch digest mismatch');
  return {
    sourceId: hash(JSON.stringify(pin)), patchSha256, platformKey, target, hostPlatform, hostArch,
    nodeVersion: process.versions.node,
    compilerEnvironment: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS)$/.test(key)
      || /^CARGO_PROFILE_RELEASE_|^CARGO_TARGET_.*_(RUSTFLAGS|LINKER|RUNNER)$/.test(key)).sort(([a], [b]) => a.localeCompare(b))),
    recipeSha256: hash(fs.readFileSync(path.join(root, 'scripts/build-agent-browser-runtime.mjs'))),
    cacheRecipeSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  };
}

export function browserBuildKey(inputs) { return hash(JSON.stringify(inputs)); }

function verify(directory, inputs, pin) {
  assert(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(),
    'Browser cache entry must be a regular directory');
  regular(path.join(directory, 'cache.json'));
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'cache.json'), 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Unsupported Browser cache receipt');
  assert.deepEqual(receipt.inputs, inputs, 'Browser cache build inputs changed');
  assert.equal(receipt.cacheKey, browserBuildKey(inputs), 'Browser cache key mismatch');
  const filename = inputs.platformKey.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser';
  assert.deepEqual(Object.keys(receipt.files).sort(),
    [filename, 'identity.json', 'LICENSE', ...(present(path.join(directory, 'NOTICE')) ? ['NOTICE'] : [])].sort(),
    'Browser cache file inventory mismatch');
  for (const [name, digest] of Object.entries(receipt.files)) {
    regular(path.join(directory, name));
    assert.equal(hash(fs.readFileSync(path.join(directory, name))), digest, `Browser cache digest mismatch: ${name}`);
  }
  const identity = JSON.parse(fs.readFileSync(path.join(directory, 'identity.json'), 'utf8'));
  assert.equal(identity.version, pin.version);
  assert.equal(identity.platformKey, inputs.platformKey);
  assert.equal(identity.sourceId, inputs.sourceId);
  assert.equal(identity.sha256, receipt.files[filename]);
  assert.match(identity.farmingSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(identity.compilationOrigin, receipt.compilationOrigin, 'Browser compilation origin changed');
  assert.equal(identity.compilationOrigin.farmingSha, identity.farmingSha);
  assert.equal(identity.compilationOrigin.sourceId, inputs.sourceId);
  assert.equal(identity.compilationOrigin.recipeSha256, inputs.recipeSha256);
  assert.equal(identity.compilationOrigin.sha256, identity.sha256);
  return { identity, receipt };
}

// A cache entry is an immutable, local build receipt, not an accepted release.
// Each candidate is assembled with its own SHA while retaining compilation origin.
export function restoreBrowserBuild({ cacheRoot, output, inputs, pin, farmingSha }) {
  assert.match(farmingSha, /^[a-f0-9]{40}$/);
  const entry = path.join(cacheRoot, browserBuildKey(inputs));
  if (!present(entry)) return false;
  const { identity, receipt } = verify(entry, inputs, pin);
  assert(!present(output), `Refusing to replace existing artifact: ${output}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.assembling-browser-'));
  try {
    for (const [name, digest] of Object.entries(receipt.files)) {
      fs.copyFileSync(path.join(entry, name), path.join(staging, name));
      assert.equal(hash(fs.readFileSync(path.join(staging, name))), digest, `Browser cache changed while copying: ${name}`);
    }
    fs.writeFileSync(path.join(staging, 'identity.json'), `${JSON.stringify({
      ...identity, farmingSha, acceptedFromBuildCache: browserBuildKey(inputs),
    }, null, 2)}\n`);
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return true;
}

export function publishBrowserBuild({ cacheRoot, output, inputs, pin }) {
  const entry = path.join(cacheRoot, browserBuildKey(inputs));
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, '.building-browser-'));
  try {
    const filename = inputs.platformKey.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser';
    const files = {};
    for (const name of [filename, 'identity.json', 'LICENSE', ...(present(path.join(output, 'NOTICE')) ? ['NOTICE'] : [])]) {
      regular(path.join(output, name));
      fs.copyFileSync(path.join(output, name), path.join(staging, name));
      files[name] = hash(fs.readFileSync(path.join(staging, name)));
    }
    const identity = JSON.parse(fs.readFileSync(path.join(staging, 'identity.json'), 'utf8'));
    fs.writeFileSync(path.join(staging, 'cache.json'), `${JSON.stringify({
      schemaVersion: 1, inputs, cacheKey: browserBuildKey(inputs), files, compilationOrigin: identity.compilationOrigin,
    }, null, 2)}\n`, { flag: 'wx' });
    verify(staging, inputs, pin);
    try { fs.renameSync(staging, entry); } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      verify(entry, inputs, pin);
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
