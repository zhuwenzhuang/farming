import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function run(): Promise<void> {
  const { transferNativeBrowser } = await import(pathToFileURL(path.join(process.cwd(), 'scripts/transfer-native-browser-runtime.mjs')).href);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-release-transfer-'));
  const hash = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    const expected = { candidateSha: 'a'.repeat(40) };
    const native = path.join(work, 'native', 'darwin-arm64');
    fs.mkdirSync(native, { recursive: true });
    const pin = { version: '1.0.0-farming.1', patch: 'reviewed' };
    const bytes = 'native executable';
    const origin = { farmingSha: 'c'.repeat(40), runId: 7, sourceId: hash(JSON.stringify(pin)), recipeSha256: 'd'.repeat(64), sha256: hash('original compile') };
    const identity = { farmingSha: expected.candidateSha, platformKey: 'darwin-arm64', version: pin.version, sourceId: origin.sourceId, sha256: hash(bytes), compilationOrigin: origin };
    fs.writeFileSync(path.join(native, 'agent-browser'), bytes);
    fs.chmodSync(path.join(native, 'agent-browser'), 0o644);
    fs.writeFileSync(path.join(native, 'LICENSE'), 'license');
    const identityFile = path.join(native, 'identity.json');
    fs.writeFileSync(identityFile, JSON.stringify(identity));
    const transferOptions = { platform: 'darwin-arm64', inputRoot: path.dirname(native), candidateSha: expected.candidateSha,
      runId: 9, pin, recipeSha256: origin.recipeSha256, hostPlatform: 'darwin', hostArch: 'arm64',
      sign: (binary: string) => { assert(fs.statSync(binary).mode & 0o100); fs.appendFileSync(binary, ' signed'); },
      version: () => `agent-browser ${pin.version}` };
    const output = path.join(work, 'signed');
    transferNativeBrowser({ ...transferOptions, outputRoot: output });
    const transferred = JSON.parse(fs.readFileSync(path.join(output, 'darwin-arm64', 'identity.json'), 'utf8'));
    assert.deepEqual(transferred.compilationOrigin, origin);
    assert.equal(transferred.sha256, hash(`${bytes} signed`));
    assert.equal(transferred.farmingSha, expected.candidateSha);
    assert.throws(() => transferNativeBrowser({ ...transferOptions, outputRoot: output }), /replace/);
    for (const [name, overrides, pattern] of [
      ['sha', { candidateSha: 'e'.repeat(40) }, /candidate SHA mismatch/],
      ['arch', { hostArch: 'x64' }, /native host/],
      ['platform', { hostPlatform: 'linux' }, /macOS/],
      ['launch', { version: () => 'wrong' }, /version mismatch/],
      ['sign', { sign: () => { throw Error('strict signature verification failed'); } }, /strict signature/],
    ] as const) {
      const failed = path.join(work, `failed-${name}`);
      assert.throws(() => transferNativeBrowser({ ...transferOptions, ...overrides, outputRoot: failed }), pattern);
      assert(!fs.existsSync(path.join(failed, 'darwin-arm64')));
      if (fs.existsSync(failed)) assert.deepEqual(fs.readdirSync(failed), []);
    }
    fs.writeFileSync(path.join(native, 'agent-browser'), 'corrupt');
    assert.throws(() => transferNativeBrowser({ ...transferOptions, outputRoot: path.join(work, 'bad-digest') }), /digest mismatch/);
    fs.writeFileSync(path.join(native, 'agent-browser'), bytes);
    fs.writeFileSync(identityFile, JSON.stringify({ ...identity, compilationOrigin: undefined }));
    const coldOutput = path.join(work, 'cold');
    transferNativeBrowser({ ...transferOptions, outputRoot: coldOutput });
    const cold = JSON.parse(fs.readFileSync(path.join(coldOutput, 'darwin-arm64', 'identity.json'), 'utf8'));
    assert.equal(cold.compilationOrigin.farmingSha, expected.candidateSha);
    assert.equal(cold.compilationOrigin.runId, 9);
    assert.equal(cold.compilationOrigin.sha256, hash(bytes));
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
  console.log('✓ native transfer rejects stale or corrupt inputs and preserves compilation provenance');
}
void run();
