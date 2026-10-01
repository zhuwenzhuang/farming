#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const regular = file => assert(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), `Expected regular artifact file: ${file}`);

// A current-run component is an input to acceptance, not an accepted release.
// Signing on the final native host can change its digest; compilation provenance
// always retains the producer's bytes and never claims the consumer compiled it.
export function transferNativeBrowser({ platform, inputRoot, outputRoot, candidateSha, runId, pin, recipeSha256,
  hostPlatform = process.platform, hostArch = process.arch, sign, version }) {
  assert.equal(hostPlatform, 'darwin', 'Native Browser transfer requires macOS');
  assert.equal(platform, `${hostPlatform}-${hostArch}`, 'Browser target must match native host');
  assert(/^[a-f0-9]{40}$/.test(candidateSha));
  const input = path.resolve(inputRoot, platform);
  assert(fs.lstatSync(input).isDirectory() && !fs.lstatSync(input).isSymbolicLink());
  for (const name of ['agent-browser', 'identity.json', 'LICENSE']) regular(path.join(input, name));
  const identity = JSON.parse(fs.readFileSync(path.join(input, 'identity.json'), 'utf8'));
  assert.equal(identity.farmingSha, candidateSha, 'Transferred Browser candidate SHA mismatch');
  assert.equal(identity.platformKey, platform);
  assert.equal(identity.version, pin.version);
  const sourceId = hash(JSON.stringify(pin));
  assert.equal(identity.sourceId, sourceId);
  const bytes = fs.readFileSync(path.join(input, 'agent-browser'));
  assert.equal(hash(bytes), identity.sha256, 'Transferred Browser digest mismatch');
  const compilationOrigin = identity.compilationOrigin || {
    farmingSha: candidateSha, runId, sourceId, recipeSha256, sha256: identity.sha256,
  };
  assert.equal(compilationOrigin.sourceId, sourceId);
  assert.equal(compilationOrigin.recipeSha256, recipeSha256);
  assert(/^[a-f0-9]{40}$/.test(compilationOrigin.farmingSha));
  assert(Number.isSafeInteger(compilationOrigin.runId) && compilationOrigin.runId > 0);
  assert(/^[a-f0-9]{64}$/.test(compilationOrigin.sha256));
  const output = path.resolve(outputRoot, platform);
  assert(!fs.existsSync(output), 'Refuse to replace an existing native Browser');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.native-browser-'));
  try {
    const binary = path.join(staging, 'agent-browser');
    fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o755 });
    sign(binary);
    assert.equal(version(binary), `agent-browser ${pin.version}`, 'Transferred native Browser version mismatch');
    for (const name of ['LICENSE', 'NOTICE']) {
      if (fs.existsSync(path.join(input, name))) { regular(path.join(input, name)); fs.copyFileSync(path.join(input, name), path.join(staging, name)); }
    }
    fs.writeFileSync(path.join(staging, 'identity.json'), `${JSON.stringify({ ...identity,
      sha256: hash(fs.readFileSync(binary)), compilationOrigin,
    }, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(staging, output);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [platform, inputRoot, outputRoot, ...extra] = process.argv.slice(2);
    assert(platform && inputRoot && outputRoot && extra.length === 0, 'Expected native platform, input root and output root');
    transferNativeBrowser({ platform, inputRoot, outputRoot,
      candidateSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim(),
      runId: Number(process.env.GITHUB_RUN_ID),
      pin: JSON.parse(fs.readFileSync(path.join(root, 'backend/data/agent-browser-source.json'), 'utf8')),
      recipeSha256: hash(fs.readFileSync(path.join(root, 'scripts/build-agent-browser-runtime.mjs'))),
      sign: binary => {
        execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit', timeout: 10_000 });
        execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'inherit', timeout: 10_000 });
      },
      version: binary => {
        const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', detached: true });
        if (result.pid) {
          try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
        assert.equal(result.status, 0, 'Transferred native Browser failed to launch');
        return result.stdout.trim();
      },
    });
    console.log(`Verified native candidate Browser: ${platform}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
