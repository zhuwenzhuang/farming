#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { validateReceipt } from './npm-release-evidence.mjs';

const official = 'https://registry.npmjs.org';
const mirror = 'https://registry.npmmirror.com';
const name = 'farming-code';
class MirrorVerificationError extends Error {}

export async function syncNpmMirror(receipt, sha, file, options = {}) {
  validateReceipt(receipt, sha);
  const request = options.fetch || fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const pollMs = options.pollMs ?? 2_000;
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state && (state.packageName !== name || state.version !== receipt.version || state.gitHead !== sha)) {
    throw new Error('Mirror journal does not belong to this release.');
  }
  const retained = state || {};
  state = { packageName: name, version: receipt.version, gitHead: sha,
    selectedVersions: retained.selectedVersions, intentAt: retained.intentAt,
    taskId: retained.taskId, taskState: retained.taskState };
  if (typeof state.taskId === 'string' && state.taskId && state.taskId.length <= 128) {
    state.taskUrl = `${mirror}/-/package/${name}/syncs/${encodeURIComponent(state.taskId)}`;
  }
  async function save(status, reason) {
    Object.assign(state, { status, reason, observedAt: new Date().toISOString() });
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
    return state;
  }
  async function json(url, init = {}) {
    const response = await request(url, {
      ...init, signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))),
    });
    if (response.status === 404 && (!init.method || init.method === 'GET')) return null;
    if (!response.ok) throw new Error(`Mirror synchronization request returned HTTP ${response.status}.`);
    return response.json();
  }
  const sourceUrl = version => `${official}/${name}/${encodeURIComponent(version)}`;
  const mirrorUrl = version => `${mirror}/${name}/${encodeURIComponent(version)}`;
  const matches = (document, expected) => document?.version === expected.version
    && String(document.dist?.integrity || '').split(/\s+/).includes(expected.integrity)
    && document.dist?.shasum === expected.shasum;
  try {
    const source = await json(sourceUrl(receipt.version));
    const expectedMain = { version: receipt.version, integrity: receipt.integrity, shasum: receipt.shasum };
    if (source?.name !== name || source.gitHead !== sha || !matches(source, expectedMain)) {
      throw new MirrorVerificationError('Official npm source or digest does not match the smoke receipt.');
    }
    if ((await json(sourceUrl('latest')))?.version !== receipt.version) {
      return await save('not-latest', 'The official latest selects another version; no mirror mutation requested.');
    }
    const carriers = [...new Set(Object.values(source.optionalDependencies || {})
      .filter(value => typeof value === 'string' && value.startsWith(`npm:${name}@`))
      .map(value => value.slice(`npm:${name}@`.length)))];
    if (!carriers.length || carriers.some(version => !version.startsWith(`${receipt.version}-runtime-`))) {
      throw new MirrorVerificationError('The release must declare its own exact Farming runtime carrier versions.');
    }
    const expected = [expectedMain, ...await Promise.all(carriers.map(async version => {
      const document = await json(sourceUrl(version));
      const integrity = String(document?.dist?.integrity || '').split(/\s+/).find(token => /^sha512-[A-Za-z0-9+/]{86}==$/.test(token));
      if (document?.name !== name || document.version !== version || document.gitHead !== sha
        || !integrity || !/^[a-f0-9]{40}$/.test(document.dist?.shasum || '')) {
        throw new MirrorVerificationError('An official runtime carrier does not match the release source and digest contract.');
      }
      return { version, integrity, shasum: document.dist.shasum };
    }))];
    const versions = expected.map(entry => entry.version);
    if (state.selectedVersions && JSON.stringify(state.selectedVersions) !== JSON.stringify(versions)) {
      throw new MirrorVerificationError('Mirror journal selection differs from the verified release.');
    }
    state.selectedVersions = versions;
    async function observe() {
      if ((await json(sourceUrl('latest')))?.version !== receipt.version) return 'not-latest';
      const current = await json(mirrorUrl('latest'));
      if (current?.version !== receipt.version) return null;
      if (current.name !== name || !matches(current, expectedMain)) throw new MirrorVerificationError('Mirror main-package digest conflicts with official npm.');
      for (const target of expected.slice(1)) {
        const document = await json(mirrorUrl(target.version));
        if (!document) return null;
        if (document.name !== name || !matches(document, target)) throw new MirrorVerificationError('Mirror runtime carrier digest conflicts with official npm.');
      }
      const install = await json(`${mirror}/${name}`, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
      if (install?.['dist-tags']?.latest !== receipt.version) return null;
      for (const target of expected) {
        if (!install.versions?.[target.version]) return null;
        if (!matches(install.versions[target.version], target)) throw new MirrorVerificationError('npm-install metadata digest conflicts with official npm.');
      }
      return 'verified';
    }
    let observed = await observe();
    if (observed) return await save(observed, 'Authoritative latest and all selected mirror digests reconciled.');
    if (!state.taskId) {
      if (state.intentAt) return await save('uncertain', 'A prior sync request has no confirmed task ID; it will not be replayed.');
      if (Date.now() >= deadline) return await save('incomplete', 'Official preflight exhausted the observation window; no sync request was submitted.');
      state.intentAt = new Date().toISOString();
      await save('requesting', 'Requesting only this verified release and its exact runtime carriers.');
      const created = await json(`${mirror}/-/package/${name}/syncs`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skipDependencies: true, specificVersions: JSON.stringify(versions) }),
      });
      if (!created?.ok || typeof created.id !== 'string' || !created.id || created.id.length > 128) {
        return await save('uncertain', 'Mirror did not return a confirmed task ID; the request will not be replayed.');
      }
      state.taskId = created.id;
      state.taskUrl = `${mirror}/-/package/${name}/syncs/${encodeURIComponent(created.id)}`;
      await save('observing', 'The mirror task was accepted; public metadata still requires verification.');
    }
    if (typeof state.taskId !== 'string' || !state.taskId || state.taskId.length > 128) throw new MirrorVerificationError('Invalid retained mirror task ID.');
    state.taskUrl = `${mirror}/-/package/${name}/syncs/${encodeURIComponent(state.taskId)}`;
    while (Date.now() < deadline) {
      if (state.taskState !== 'success') {
        const task = await json(state.taskUrl);
        if (task?.id !== state.taskId || !['waiting', 'processing', 'success', 'fail', 'error', 'timeout'].includes(task.state)) {
          throw new Error('Mirror returned an invalid task identity or state.');
        }
        state.taskState = task.state;
        if (['fail', 'error', 'timeout'].includes(task.state)) return await save('failed', `Mirror task ended in ${task.state}; inspect its retained task URL.`);
      }
      observed = await observe();
      if (observed) return await save(observed, 'Authoritative latest and all selected mirror digests reconciled.');
      await sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
    }
    return await save(state.taskState === 'success' ? 'incomplete' : 'pending',
      'Observation ended before mirror metadata was verified; resume the retained task instead of submitting again.');
  } catch (error) {
    return await save(error instanceof MirrorVerificationError ? 'failed' : 'uncertain', error instanceof Error ? error.message : String(error));
  }
}

async function main() {
  const [receiptFile, sha, file] = process.argv.slice(2);
  try {
    if (!receiptFile || !sha || !file) throw new Error('Usage: sync-npm-mirror.mjs <smoke-receipt> <candidate-SHA> <journal>');
    const state = await syncNpmMirror(JSON.parse(await fs.readFile(receiptFile, 'utf8')), sha, file);
    const success = ['verified', 'not-latest'].includes(state.status);
    await fs.writeFile(`${file}.github-status.json`, JSON.stringify({
      state: success ? 'success' : state.status === 'pending' ? 'pending' : 'error',
      context: `farming/npm-mirror/${state.version}`,
      description: `China npm mirror: ${state.status}`,
      target_url: state.taskUrl || `${mirror}/${name}/${encodeURIComponent(state.version)}`,
    }));
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### China npm mirror: ${state.status}\n\n${state.reason}\n\n${state.taskUrl ? `[Task](${state.taskUrl})` : 'No mirror task submitted.'}\n`);
    console.log(JSON.stringify(state));
    process.exitCode = success ? 0 : state.status === 'pending' ? 3 : 2;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
