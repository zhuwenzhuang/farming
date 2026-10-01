#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinFile = 'backend/data/agent-browser-source.json';
const pin = JSON.parse(fs.readFileSync(path.join(root, pinFile), 'utf8'));
const recipe = 'scripts/build-agent-browser-runtime.mjs';
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'win32-x64'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceId = hash(JSON.stringify(pin));
const recipeSha256 = hash(fs.readFileSync(path.join(root, recipe)));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 }).trim();
const gh = args => JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/observe-release-gh.mjs'), ...args], { cwd: root, encoding: 'utf8' }));
const candidateSha = git(['rev-parse', 'HEAD']);
assert(/^[a-f0-9]{40}$/.test(candidateSha), 'Candidate must have an exact SHA');

function matchingInputs(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) return false;
  try {
    git(['merge-base', '--is-ancestor', sha, candidateSha]);
    return [pinFile, pin.patch, recipe].every(file => hash(execFileSync('git', ['show', `${sha}:${file}`], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    })) === hash(fs.readFileSync(path.join(root, file))));
  } catch { return false; }
}

function authenticateOrigin(origin) {
  assert(process.env.GITHUB_REPOSITORY, 'Repository identity is required');
  assert.equal(origin.repository?.full_name, process.env.GITHUB_REPOSITORY, 'Origin repository mismatch');
  assert.equal(origin.path, '.github/workflows/release.yml', 'Origin must be release preparation');
  assert.equal(origin.status, 'completed');
  assert.equal(origin.conclusion, 'success');
  assert(Number.isSafeInteger(origin.id) && origin.id > 0, 'Origin run identity is invalid');
  assert(matchingInputs(origin.head_sha), 'Origin source, patch or production recipe changed');
}

function select(output) {
  const runs = gh(['run', 'list', '--repo', process.env.GITHUB_REPOSITORY, '--workflow', 'release.yml',
    '--branch', 'main', '--status', 'success', '--limit', '5', '--json', 'databaseId,headSha']);
  let selected;
  for (const run of runs) {
    if (!matchingInputs(run.headSha)) continue;
    const origin = gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.databaseId}`]);
    authenticateOrigin(origin);
    const artifacts = gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.databaseId}/artifacts?per_page=100`]);
    if (!platforms.every(platform => artifacts.artifacts?.some(artifact => artifact.name === `farming-agent-browser-${platform}`
      && artifact.expired === false && artifact.size_in_bytes > 0))) continue;
    selected = origin;
    break;
  }
  if (selected) fs.writeFileSync(output, `${JSON.stringify(selected, null, 2)}\n`, { flag: 'wx' });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${selected?.id || ''}\n`);
  console.log(selected ? `Verified unchanged Browser component from preparation ${selected.id}.`
    : 'No retained preparation matches every Browser input; compile the pinned source.');
}

function regular(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), `Expected regular artifact file: ${path.basename(file)}`);
}

function emit(platform, inputRoot, originFile, outputRoot) {
  assert(platforms.includes(platform), 'Unsupported Browser platform');
  const origin = JSON.parse(fs.readFileSync(originFile, 'utf8'));
  authenticateOrigin(origin);
  const input = path.resolve(inputRoot, platform);
  assert(fs.lstatSync(input).isDirectory() && !fs.lstatSync(input).isSymbolicLink(), 'Origin directory must be regular');
  const filename = platform.startsWith('win32-') ? 'agent-browser.exe' : 'agent-browser';
  for (const name of [filename, 'identity.json', 'LICENSE']) regular(path.join(input, name));
  const identity = JSON.parse(fs.readFileSync(path.join(input, 'identity.json'), 'utf8'));
  assert.equal(identity.farmingSha, origin.head_sha, 'Origin artifact SHA mismatch');
  assert.equal(identity.version, pin.version);
  assert.equal(identity.platformKey, platform);
  assert.equal(identity.sourceId, sourceId);
  const bytes = fs.readFileSync(path.join(input, filename));
  assert.equal(hash(bytes), identity.sha256, 'Origin executable digest mismatch');
  const compilationOrigin = identity.compilationOrigin || {
    farmingSha: origin.head_sha, runId: origin.id, sourceId, recipeSha256, sha256: identity.sha256,
  };
  assert.equal(compilationOrigin.sourceId, sourceId);
  assert.equal(compilationOrigin.recipeSha256, recipeSha256);
  assert(matchingInputs(compilationOrigin.farmingSha), 'Compilation provenance source changed');
  assert(Number.isSafeInteger(compilationOrigin.runId) && compilationOrigin.runId > 0);
  assert(/^[a-f0-9]{64}$/.test(compilationOrigin.sha256), 'Compilation provenance digest is invalid');
  const output = path.resolve(outputRoot, platform);
  assert(!fs.existsSync(output), 'Refuse to replace an existing Browser artifact');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(output), '.assembling-browser-'));
  try {
    const binary = path.join(staging, filename);
    fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o755 });
    if (platform.startsWith('darwin-')) {
      assert.equal(platform, `${process.platform}-${process.arch}`, 'Mac assembly requires the matching native runner');
      execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit', timeout: 10_000 });
      execFileSync('codesign', ['--verify', '--strict', binary], { stdio: 'inherit', timeout: 10_000 });
    }
    if (platform.replace(/-musl$/, '') === `${process.platform}-${process.arch}`) {
      const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL', detached: process.platform !== 'win32' });
      if (process.platform !== 'win32' && result.pid) {
        try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      assert.equal(result.status, 0, 'Assembled native Browser could not launch');
      assert.equal(result.stdout.trim(), `agent-browser ${pin.version}`);
    }
    for (const name of ['LICENSE', 'NOTICE']) {
      if (fs.existsSync(path.join(input, name))) { regular(path.join(input, name)); fs.copyFileSync(path.join(input, name), path.join(staging, name)); }
    }
    fs.writeFileSync(path.join(staging, 'identity.json'), `${JSON.stringify({
      version: pin.version, platformKey: platform, sourceId, farmingSha: candidateSha,
      sha256: hash(fs.readFileSync(binary)), compilationOrigin,
      acceptedFromPreparation: { runId: origin.id, farmingSha: origin.head_sha, sha256: identity.sha256 },
    }, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(staging, output);
    console.log(`Verified candidate Browser assembly: ${platform}`);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'select' && args.length === 1) select(args[0]);
  else if (command === 'emit' && args.length === 4) emit(...args);
  else throw new Error('Usage: reuse-agent-browser-runtime.mjs select <origin JSON> | emit <platform> <input root> <origin JSON> <output root>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
