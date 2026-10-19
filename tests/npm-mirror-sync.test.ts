import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { syncNpmMirror } from '../scripts/sync-npm-mirror.mjs';

const sha = 'a'.repeat(40);
const digest = (text: string) => ({
  integrity: `sha512-${crypto.createHash('sha512').update(text).digest('base64')}`,
  shasum: crypto.createHash('sha1').update(text).digest('hex'),
});
async function fixture(t: test.TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-mirror-sync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'mirror.json');
  const receipt = { schemaVersion: 1, packageName: 'farming-code', version: '1.2.3', gitHead: sha,
    filename: 'farming-code-1.2.3.tgz', bytes: 123, sha256: 'b'.repeat(64), ...digest('main') };
  const versions = [receipt.version, ...['darwin', 'linux', 'win32'].flatMap(os =>
    ['x64', 'arm64'].map(cpu => `${receipt.version}-runtime-${os}-${cpu}`))];
  const documents = Object.fromEntries(versions.map(version => [version, {
    name: 'farming-code', version, gitHead: sha, dist: digest(version === receipt.version ? 'main' : version),
  }]));
  const source = { ...documents[receipt.version], optionalDependencies: Object.fromEntries(versions.slice(1).map((v, i) =>
    [`runtime-${i}`, `npm:farming-code@${v}`])) };
  let ready = false;
  let installReady = true;
  let failCreate = false;
  let corruptMirror = false;
  let latest = receipt.version;
  let taskState = 'success';
  const mutations: Record<string, unknown>[] = [];
  const polls: string[] = [];
  const fetcher = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    assert.equal(new Headers(init.headers).has('authorization'), false, 'npm credentials must never reach the mirror');
    const suffix = decodeURIComponent(url.pathname.slice('/farming-code/'.length));
    if (url.hostname === 'registry.npmjs.org') {
      if (suffix === 'latest') return Response.json({ ...source, version: latest });
      if (suffix === receipt.version) return Response.json(source);
      assert(versions.includes(suffix), 'official reads must select only the current release');
      return Response.json(documents[suffix]);
    }
    assert.equal(url.hostname, 'registry.npmmirror.com');
    if (init.method === 'PUT') {
      mutations.push(JSON.parse(String(init.body)));
      if (failCreate) throw new TypeError('Connection lost after request');
      return Response.json({ ok: true, id: 'task-1', state: 'waiting' }, { status: 201 });
    }
    if (url.pathname.includes('/syncs/')) {
      polls.push(url.pathname);
      if (taskState === 'success') ready = true;
      return Response.json({ id: 'task-1', state: taskState });
    }
    if (url.pathname === '/farming-code') {
      assert.equal(new Headers(init.headers).get('accept'), 'application/vnd.npm.install-v1+json');
      return Response.json({ name: 'farming-code', 'dist-tags': { latest: installReady ? receipt.version : '0.0.1' }, versions: documents });
    }
    if (suffix === 'latest') return Response.json(ready
      ? { ...source, dist: corruptMirror ? digest('wrong bytes') : source.dist }
      : { name: 'farming-code', version: '0.0.1' });
    assert(versions.includes(suffix), 'mirror reads must not request historical versions');
    return Response.json(documents[suffix]);
  };
  const run = (timeoutMs = 500) => syncNpmMirror(receipt, sha, file, { fetch: fetcher, timeoutMs, pollMs: 1 });
  return { receipt, file, versions, mutations, polls, run,
    ready: (value: boolean) => { ready = value; },
    installReady: (value: boolean) => { installReady = value; },
    failCreate: () => { failCreate = true; },
    corrupt: () => { corruptMirror = true; },
    latest: (value: string) => { latest = value; },
    taskState: (value: string) => { taskState = value; },
  };
}

test('mirror sync selects exactly the verified main image and all six runtime carriers', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, 'verified');
  assert.equal(f.mutations.length, 1);
  assert.deepEqual(f.mutations[0], { skipDependencies: true, specificVersions: JSON.stringify(f.versions) });
  assert.equal(result.taskId, 'task-1');
  assert.equal(f.polls.length, 1);
});

test('already correct cache and a superseding official latest submit no task', async t => {
  const f = await fixture(t); f.ready(true);
  assert.equal((await f.run()).status, 'verified');
  f.latest('1.2.4');
  assert.equal((await f.run()).status, 'not-latest');
  assert.equal(f.mutations.length, 0);
});

test('an uncertain create is reconciled without replaying its mutation', async t => {
  const f = await fixture(t); f.failCreate();
  assert.equal((await f.run()).status, 'uncertain');
  assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.mutations.length, 1);
  f.ready(true);
  assert.equal((await f.run()).status, 'verified');
  assert.equal(f.mutations.length, 1);
});

test('a live task survives the deadline and resumes its exact ID', async t => {
  const f = await fixture(t); f.taskState('processing');
  assert.equal((await f.run(40)).status, 'pending');
  f.taskState('success');
  assert.equal((await f.run()).status, 'verified');
  assert.equal(f.mutations.length, 1);
  assert(f.polls.every(url => url.endsWith('/task-1')));
});

test('task success is insufficient while npm install still sees an old tag', async t => {
  const f = await fixture(t); f.installReady(false);
  assert.equal((await f.run(40)).status, 'incomplete');
  f.installReady(true);
  assert.equal((await f.run()).status, 'verified');
  assert.equal(f.mutations.length, 1);
});

test('a definitive task failure or digest conflict is explicit and never replayed', async t => {
  const f = await fixture(t); f.taskState('fail');
  assert.equal((await f.run()).status, 'failed');
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.mutations.length, 1);
  const conflict = await fixture(t); conflict.ready(true); conflict.corrupt();
  assert.equal((await conflict.run()).status, 'failed');
  assert.equal(conflict.mutations.length, 0);
});

test('a mismatched official digest or journal cannot authorize a sync', async t => {
  const f = await fixture(t);
  f.receipt.integrity = digest('other bytes').integrity;
  assert.equal((await f.run()).status, 'failed');
  assert.equal(f.mutations.length, 0);
  const other = await fixture(t);
  await fs.writeFile(other.file, JSON.stringify({ packageName: 'farming-code', version: '9.0.0', gitHead: sha }));
  await assert.rejects(other.run(), /does not belong/);
  assert.equal(other.mutations.length, 0);
});

test('publication and delayed observation synchronize only after official success and retain evidence', async () => {
  for (const [workflow, job, owner] of [
    ['publish-release', 'publish-release', 'npm-publication'],
    ['observe-npm-publication', 'observe', 'observation'],
  ]) {
    const document = YAML.parse(await fs.readFile(path.resolve(__dirname, `../.github/workflows/${workflow}.yml`), 'utf8'));
    const steps = document.jobs[job].steps as { name: string; if?: string; 'continue-on-error'?: boolean; run?: string }[];
    const index = steps.findIndex(step => step.name === 'Synchronize this release to China npm mirror');
    assert(index > steps.findIndex(step => step.name === 'Record npm publication status'));
    const step = steps[index];
    assert.equal(step.if, `steps.${owner}.outputs.commit_state == 'success'`);
    assert.equal(step['continue-on-error'], true, 'replica failure must not rewrite verified official publication');
    assert.match(step.run || '', /sync-npm-mirror\.mjs.*npm-smoke-receipt\.json/);
    assert.match(step.run || '', /--input npm-evidence\/mirror-sync\.json\.github-status\.json/);
    const upload = steps.findIndex(item => item.name.includes('Upload') && item.name.includes('npm publication evidence'));
    assert(upload > index, 'the existing evidence upload must retain the mirror journal');
    assert.equal(document.jobs[job].concurrency?.group || document.concurrency?.group,
      workflow === 'publish-release' ? 'farming-publication-${{ inputs.release_version }}' : 'farming-publication-${{ needs.identify.outputs.version }}');
  }
});
