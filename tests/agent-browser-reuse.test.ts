import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import pin from '../backend/data/agent-browser-source.json';

test('unchanged compiled Browser inputs preserve provenance while candidate assembly rejects untrusted artifacts', { skip: process.platform === 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-browser-reuse-'));
  try {
    const project = path.join(directory, 'project');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    for (const file of ['scripts/reuse-agent-browser-runtime.mjs', 'scripts/observe-release-gh.mjs', 'scripts/build-agent-browser-runtime.mjs', 'backend/data/agent-browser-source.json', pin.patch]) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.copyFileSync(file, path.join(project, file));
    }
    const git = (args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']);
    git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', 'fixture@example.test']);
    git(['config', 'core.hooksPath', path.join(directory, 'disabled-hooks')]);
    git(['add', '.']); git(['commit', '-qm', 'compiled source']);
    const originSha = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(project, 'candidate.txt'), 'Unrelated candidate input\n');
    git(['add', '.']); git(['commit', '-qm', 'candidate assembly']);
    const candidateSha = git(['rev-parse', 'HEAD']);
    const origin = { id: 123, path: '.github/workflows/release.yml', status: 'completed', conclusion: 'success', head_sha: originSha, repository: { full_name: 'example/farming' } };
    const originFile = path.join(directory, 'origin.json');
    fs.writeFileSync(originFile, JSON.stringify(origin));
    const platform = `${process.platform}-${process.arch}`;
    const input = path.join(directory, 'input', platform);
    fs.mkdirSync(input, { recursive: true });
    const bytes = Buffer.from(`#!/bin/sh\necho 'agent-browser ${pin.version}'\n`);
    const identity = { farmingSha: originSha, version: pin.version, platformKey: platform,
      sourceId: crypto.createHash('sha256').update(JSON.stringify(pin)).digest('hex'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(path.join(input, 'agent-browser'), bytes, { mode: 0o644 });
    fs.writeFileSync(path.join(input, 'identity.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(input, 'LICENSE'), 'Fixture component license\n');
    fs.writeFileSync(path.join(bin, 'codesign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'example/farming' };
    const run = (destination: string, selectedOrigin = originFile) => spawnSync(process.execPath,
      [path.join(project, 'scripts/reuse-agent-browser-runtime.mjs'), 'emit', platform, path.dirname(input), selectedOrigin, destination],
      { env, cwd: project, encoding: 'utf8', timeout: 10_000 });
    const output = path.join(directory, 'output');
    const valid = run(output);
    assert.equal(valid.status, 0, valid.stderr);
    const assembled = JSON.parse(fs.readFileSync(path.join(output, platform, 'identity.json'), 'utf8'));
    assert.equal(assembled.farmingSha, candidateSha);
    assert.equal(assembled.compilationOrigin.farmingSha, originSha);
    assert.equal(assembled.compilationOrigin.runId, origin.id);
    assert.equal(assembled.acceptedFromPreparation.sha256, identity.sha256);
    assert.equal(assembled.sha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(output, platform, 'agent-browser'))).digest('hex'));
    assert.notEqual(run(output).status, 0, 'candidate output must be immutable');

    for (const [field, value] of [['conclusion', 'failure'], ['path', '.github/workflows/other.yml'], ['repository', { full_name: 'other/repository' }]] as const) {
      const badOrigin = path.join(directory, `origin-${field}.json`);
      fs.writeFileSync(badOrigin, JSON.stringify({ ...origin, [field]: value }));
      const destination = path.join(directory, `failed-${field}`);
      assert.notEqual(run(destination, badOrigin).status, 0);
      assert(!fs.existsSync(path.join(destination, platform)));
    }
    fs.writeFileSync(path.join(input, 'agent-browser'), 'tampered');
    assert.notEqual(run(path.join(directory, 'tampered')).status, 0);
    assert(!fs.existsSync(path.join(directory, 'tampered', platform)));
    fs.writeFileSync(path.join(input, 'agent-browser'), bytes);
    fs.writeFileSync(path.join(input, 'identity.json'), JSON.stringify({ ...identity, farmingSha: candidateSha }));
    assert.notEqual(run(path.join(directory, 'wrong-sha')).status, 0);
    fs.writeFileSync(path.join(input, 'identity.json'), JSON.stringify(identity));
    fs.writeFileSync(path.join(project, pin.patch), 'changed patch');
    assert.notEqual(run(path.join(directory, 'changed-source')).status, 0);
    git(['checkout', '--', pin.patch]);
    fs.writeFileSync(path.join(input, 'agent-browser'), '#!/bin/sh\nexit 7\n');
    const failedBytes = fs.readFileSync(path.join(input, 'agent-browser'));
    fs.writeFileSync(path.join(input, 'identity.json'), JSON.stringify({ ...identity, sha256: crypto.createHash('sha256').update(failedBytes).digest('hex') }));
    const failedVersionOutput = path.join(directory, 'failed-version');
    assert.notEqual(run(failedVersionOutput).status, 0);
    assert.deepEqual(fs.readdirSync(failedVersionOutput), [], 'failed native launch must remove its staging output');

    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
if [ "$1 $2" = 'run list' ]; then printf '%s' "$FAKE_RUNS";
elif echo "$*" | /usr/bin/grep -q '/artifacts?'; then printf '%s' "$FAKE_ARTIFACTS";
else printf '%s' "$FAKE_ORIGIN"; fi
`, { mode: 0o755 });
    const artifacts = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'linux-arm64-musl', 'linux-x64-musl', 'win32-x64']
      .map(platform => ({ name: `farming-agent-browser-${platform}`, expired: false, size_in_bytes: 100 }));
    const outputFile = path.join(directory, 'selected.json');
    const stepOutput = path.join(directory, 'step-output');
    const select = (selectedArtifacts: unknown[]) => spawnSync(process.execPath,
      [path.join(project, 'scripts/reuse-agent-browser-runtime.mjs'), 'select', outputFile], {
        cwd: project, encoding: 'utf8', timeout: 10_000,
        env: { ...env, GITHUB_OUTPUT: stepOutput, FAKE_RUNS: JSON.stringify([{ databaseId: origin.id, headSha: originSha }]),
          FAKE_ORIGIN: JSON.stringify(origin), FAKE_ARTIFACTS: JSON.stringify({ artifacts: selectedArtifacts }) },
      });
    const retained = select(artifacts);
    assert.equal(retained.status, 0, retained.stderr);
    assert.equal(JSON.parse(fs.readFileSync(outputFile, 'utf8')).id, 123);
    assert.match(fs.readFileSync(stepOutput, 'utf8'), /run_id=123/);
    fs.rmSync(outputFile); fs.rmSync(stepOutput);
    assert.equal(select(artifacts.slice(1)).status, 0);
    assert(!fs.existsSync(outputFile), 'partial platform publication must use fresh source compilation');
    assert.equal(fs.readFileSync(stepOutput, 'utf8'), 'run_id=\n');
    fs.rmSync(stepOutput);
    assert.equal(select(artifacts.map((artifact, index) => index === 0 ? { ...artifact, expired: true } : artifact)).status, 0);
    assert(!fs.existsSync(outputFile), 'expired origin cannot authorize reuse');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
