import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import manifest from '../data/runtime-dependency-manifest.json';
import { prepareSourceBrowserRuntime } from '../../scripts/prepare-source-browser-runtime';

async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-source-browser-'));
  const platformKey = 'darwin-arm64';
  const artifact = manifest.dependencies.agentBrowser.artifacts[platformKey];
  let builds = 0;
  const build = async (output: string): Promise<void> => {
    builds += 1;
    const directory = path.join(output, platformKey);
    fs.mkdirSync(directory);
    const bytes = 'fixture-native-runtime';
    fs.writeFileSync(path.join(directory, artifact.entry), bytes);
    fs.writeFileSync(path.join(directory, 'LICENSE'), 'fixture license');
    fs.writeFileSync(path.join(directory, 'identity.json'), JSON.stringify({
      version: manifest.dependencies.agentBrowser.version, platformKey,
      sourceId: artifact.packagedIdentity, farmingSha: 'a'.repeat(40),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }));
  };
  try {
    const options = { projectRoot: root, platformKey, build };
    const executable = await prepareSourceBrowserRuntime(options);
    assert.equal(builds, 1);
    // Model npm restart: Vite clears dist before source preparation runs again.
    fs.rmSync(path.join(root, 'dist'), { recursive: true });
    await prepareSourceBrowserRuntime(options);
    assert.equal(builds, 1, 'restart must reuse verified native artifacts');
    assert.equal(fs.readFileSync(executable, 'utf8'), 'fixture-native-runtime');
    const concurrentRoot = path.join(root, 'concurrent');
    const concurrentOptions = { projectRoot: concurrentRoot, platformKey, build };
    const published = await Promise.all([
      prepareSourceBrowserRuntime(concurrentOptions),
      prepareSourceBrowserRuntime(concurrentOptions),
    ]);
    assert.equal(published[0], published[1], 'concurrent preparation must converge on one verified runtime');
    const concurrentCache = path.join(concurrentRoot, 'node_modules', '.cache', 'farming', 'agent-browser', artifact.packagedIdentity);
    assert.deepEqual(fs.readdirSync(concurrentCache), [platformKey], 'concurrent staging must be cleaned');
    const imported = await prepareSourceBrowserRuntime({
      projectRoot: path.join(root, 'imported'), platformKey, artifactRoot: concurrentCache,
      build: async () => { throw new Error('supplied artifacts must not trigger a build'); },
    });
    assert.equal(fs.readFileSync(imported, 'utf8'), 'fixture-native-runtime');
    const completedBuilds = builds;
    const cache = path.join(root, 'node_modules', '.cache', 'farming', 'agent-browser', artifact.packagedIdentity);
    fs.appendFileSync(path.join(cache, platformKey, artifact.entry), 'corrupt');
    await assert.rejects(() => prepareSourceBrowserRuntime(options), /digest mismatch/);
    assert.equal(builds, completedBuilds, 'corrupt cache must fail visibly');
    const failedRoot = path.join(root, 'failed-build');
    await assert.rejects(() => prepareSourceBrowserRuntime({
      projectRoot: failedRoot, platformKey,
      build: async () => { throw new Error('build failure'); },
    }), /build failure/);
    assert.deepEqual(fs.readdirSync(path.join(failedRoot, 'node_modules', '.cache', 'farming', 'agent-browser', artifact.packagedIdentity)), []);
    console.log('✓ source startup restores native runtime after dist cleanup without rebuilding');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void run().catch(error => { console.error(error); process.exitCode = 1; });
