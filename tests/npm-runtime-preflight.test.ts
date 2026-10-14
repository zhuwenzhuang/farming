import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { publishRuntimePackages } from '../scripts/publish-npm-runtimes.mjs';
import readline from 'node:readline';
import test from 'node:test';

test('runtime preflight drains independent sockets and fails on transport errors within its deadline', { timeout: 15_000 }, async () => {
  // Exercise the actual CLI helper without entering its publication loop. HTTP
  // and HTTPS share agent:false ownership; the local fixture needs no credentials.
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/publish-npm-runtimes.mjs'), 'utf8');
  const start = source.indexOf('function readRegistryStatus(');
  const end = source.indexOf('const receiptTool');
  assert(start >= 0 && end > start);
  const connections: string[] = [];
  let completedBodies = 0;
  const transport = { get: (url: string, options: http.RequestOptions, respond: (response: http.IncomingMessage) => void) => {
    assert.equal(options.agent, false);
    return http.get(url, options, response => {
      connections.push(String(response.headers['x-connection']));
      response.once('end', () => { completedBodies += 1; });
      respond(response);
    });
  } };
  const readStatus = new Function('https', `${source.slice(start, end)}; return readRegistryStatus;`)(transport) as (url: string) => Promise<number>;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    let nextConnection = 0;
    const server = http.createServer((request, response) => {
      response.setHeader('x-connection', request.socket.connectionId);
      if (request.url === '/disconnect') { request.socket.destroy(); return; }
      if (request.url === '/stall') { response.write('{}'); return; }
      response.statusCode = request.url === '/missing' ? 404 : request.url === '/unavailable' ? 503 : 200;
      response.end('{}');
    });
    server.keepAliveTimeout = 50;
    server.keepAliveTimeoutBuffer = 0;
    server.on('connection', socket => { socket.connectionId = ++nextConnection; });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const lines = readline.createInterface({ input: child.stdout });
  try {
    const [port] = await once(lines, 'line', { signal: AbortSignal.timeout(5000) });
    for (const [index, suffix] of ['/present', '/missing', '/present'].entries()) {
      assert.equal(await readStatus(`http://127.0.0.1:${port}${suffix}`), suffix === '/missing' ? 404 : 200);
      assert.equal(completedBodies, index + 1, 'the body must be drained before the CLI wait starts');
      assert.equal(spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 150)']).status, 0);
    }
    assert.equal(new Set(connections).size, 3, 'no socket may cross the blocking publication boundary');
    assert.equal(await readStatus(`http://127.0.0.1:${port}/unavailable`), 503, 'preserve non-success status for the publication guard');
    await assert.rejects(readStatus(`http://127.0.0.1:${port}/disconnect`));
    await assert.rejects(readStatus(`http://127.0.0.1:${port}/stall`), { name: 'AbortError' });
  } finally {
    lines.close();
    child.kill('SIGKILL');
    await closed;
  }
});

const candidate = 'a'.repeat(40);
function runtimeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-runtime-publish-'));
  const evidence = path.join(directory, 'evidence');
  const prior = path.join(directory, 'prior');
  fs.mkdirSync(prior);
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value));
  const receipt = (version: string) => {
    const bytes = Buffer.from(`prepared:${version}`);
    const result = { schemaVersion: 1, packageName: 'farming-code', version, gitHead: candidate,
      filename: `farming-code-${version}.tgz`, bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      shasum: crypto.createHash('sha1').update(bytes).digest('hex'),
      integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
    fs.writeFileSync(path.join(directory, result.filename), bytes);
    return result;
  };
  const main = receipt('1.2.3');
  write('npm-smoke-receipt.json', main);
  const packages = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].map(platform => {
    const item = receipt(`1.2.3-runtime-${platform}`);
    write(`runtime-${platform}-receipt.json`, item);
    return { platform, version: item.version, filename: item.filename, integrity: item.integrity };
  });
  write('runtime-packages.json', packages);
  return { directory, evidence, prior, packages, write, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

test('six runtime upload and observation lanes overlap after complete validation; journals precede each upload', { timeout: 5000 }, async () => {
  const fixture = runtimeFixture();
  const uploads = deferred();
  const observations = deferred();
  let active = 0;
  let maximum = 0;
  let uploaded = 0;
  let observed = 0;
  const start = performance.now();
  try {
    const results = await publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
      readStatus: async () => 404,
      upload: async (_tarball: string, label: string) => {
        const intent = JSON.parse(fs.readFileSync(path.join(fixture.evidence, `${label}-upload-intent.json`), 'utf8'));
        assert.equal(intent.gitHead, candidate);
        assert.equal(intent.version, `1.2.3-${label}`);
        active += 1;
        maximum = Math.max(maximum, active);
        if (++uploaded === 6) uploads.resolve();
        await uploads.promise; // serial implementation cannot pass this barrier
        active -= 1;
        return 0;
      },
      observe: async (_receipt: string, _sha: string, _state: string, result: string | null) => {
        assert(result);
        assert.equal(JSON.parse(fs.readFileSync(result, 'utf8')).uploadExitCode, 0);
        if (++observed === 6) observations.resolve();
        await observations.promise; // waiting for public metadata also overlaps
        return 0;
      },
    });
    assert.equal(maximum, 6);
    assert.equal(results.length, 6);
    assert.equal(observed, 6);
    console.log(`Deterministic publication critical path: one upload barrier + one public-observation barrier, six lanes in ${(performance.now() - start).toFixed(1)} ms (serial path needs six of each).`);
  } finally { uploads.resolve(); observations.resolve(); fixture.cleanup(); }
});

test('every receipt and retained journal is validated before any runtime can upload', async () => {
  for (const invalid of ['last-tarball', 'main-tarball', 'last-receipt', 'duplicate', 'missing-platform', 'overflow', 'bad-result', 'conflicting-intent']) {
    const fixture = runtimeFixture();
    let calls = 0;
    const last = fixture.packages.at(-1)!;
    const label = `runtime-${last.platform}`;
    try {
      if (invalid === 'last-tarball') fs.appendFileSync(path.join(fixture.directory, last.filename), 'corrupt');
      if (invalid === 'main-tarball') fs.appendFileSync(path.join(fixture.directory, 'farming-code-1.2.3.tgz'), 'corrupt');
      if (invalid === 'last-receipt') fixture.write(`${label}-receipt.json`, {});
      if (invalid === 'duplicate') fixture.write('runtime-packages.json', [...fixture.packages.slice(0, -1), fixture.packages[0]]);
      if (invalid === 'missing-platform') fixture.write('runtime-packages.json', fixture.packages.slice(0, -1));
      if (invalid === 'overflow') fixture.write('runtime-packages.json', [...fixture.packages, fixture.packages[0]]);
      if (invalid === 'bad-result') fixture.write(`prior/${label}-upload-result.json`, { version: last.version, gitHead: candidate });
      if (invalid === 'conflicting-intent') fixture.write(`prior/${label}-upload-intent.json`, { version: last.version, gitHead: 'b'.repeat(40), integrity: last.integrity });
      await assert.rejects(publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
        readStatus: async () => { calls += 1; return 404; }, upload: async () => { calls += 1; return 0; }, observe: async () => 0,
      }));
      assert.equal(calls, 0, `${invalid} must fail before public reads or writes`);
    } finally { fixture.cleanup(); }
  }
});

test('failed uploads and observers settle every lane and retain all journals; recovery never replays', { timeout: 5000 }, async () => {
  const fixture = runtimeFixture();
  const release = deferred();
  const entered = deferred();
  let observed = 0;
  let settled = false;
  try {
    const publication = publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
      readStatus: async () => 404,
      upload: async (_tarball: string, label: string) => label === 'runtime-darwin-arm64' ? 1 : 0,
      observe: async (_receipt: string, _sha: string, state: string, result: string | null) => {
        assert(result);
        const upload = JSON.parse(fs.readFileSync(result, 'utf8'));
        const failed = upload.uploadExitCode !== 0;
        fs.writeFileSync(state, JSON.stringify({ packageName: 'farming-code', version: upload.version, gitHead: candidate,
          uploadStatus: failed ? 'uncertain' : 'accepted', status: failed ? 'uncertain' : 'verified' }));
        if (++observed === 6) entered.resolve();
        if (failed) return 2;
        await release.promise;
        return 0;
      },
    }).then(() => { settled = true; throw new Error('Failure must block the main package'); }, (error: unknown) => { settled = true; return error; });
    await entered.promise;
    assert.equal(settled, false, 'a rejected lane must not end the campaign before other observers close');
    release.resolve();
    const error = await publication;
    assert(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(fs.readdirSync(fixture.evidence).length, 18, 'all six intent/result/state journals survive');
    for (const name of fs.readdirSync(fixture.evidence)) fs.copyFileSync(path.join(fixture.evidence, name), path.join(fixture.prior, name));
    fs.rmSync(fixture.evidence, { recursive: true });
    let replayed = 0;
    await publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
      readStatus: async () => 404,
      upload: async () => { replayed += 1; return 0; },
      observe: async () => 0,
    });
    assert.equal(replayed, 0, '404 after either failed or successful uploads never permits replay');
    assert.equal(fs.readdirSync(fixture.evidence).length, 18);
  } finally { release.resolve(); entered.resolve(); fixture.cleanup(); }
});

test('an intent without a result and an already-public version both use read-only reconciliation', async () => {
  const fixture = runtimeFixture();
  const first = fixture.packages[0];
  const firstLabel = `runtime-${first.platform}`;
  fixture.write(`prior/${firstLabel}-upload-intent.json`, { version: first.version, gitHead: candidate, integrity: first.integrity });
  let uploaded = 0;
  let observed = 0;
  try {
    await publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
      readStatus: async (url: string) => url.endsWith(first.version) ? 404 : 200,
      upload: async () => { uploaded += 1; return 0; },
      observe: async (receipt: string, _sha: string, state: string, result: string | null) => {
        assert.equal(result, null);
        const identity = JSON.parse(fs.readFileSync(receipt, 'utf8'));
        fs.writeFileSync(state, JSON.stringify({ packageName: identity.packageName, version: identity.version, gitHead: candidate,
          uploadStatus: 'uncertain', status: 'verified' }));
        observed += 1;
        return 0;
      },
    });
    assert.equal(uploaded, 0);
    assert.equal(observed, 6);
    const retained = new Map(fs.readdirSync(fixture.evidence).map(name => {
      const contents = fs.readFileSync(path.join(fixture.evidence, name), 'utf8');
      fs.writeFileSync(path.join(fixture.prior, name), contents);
      return [name, contents];
    }));
    fs.rmSync(fixture.evidence, { recursive: true });
    // A public read followed by 404 is uncertain availability, never fresh
    // permission to upload. Retained verified states fence all six versions.
    await publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
      readStatus: async () => 404, upload: async () => { uploaded += 1; return 0; }, observe: async () => 0,
    });
    assert.equal(uploaded, 0);
    for (const [name, contents] of retained) assert.equal(fs.readFileSync(path.join(fixture.evidence, name), 'utf8'), contents,
      'recovery must preserve every retained version observation and identity');
    for (const item of fixture.packages) {
      const state = JSON.parse(fs.readFileSync(path.join(fixture.evidence, `runtime-${item.platform}-publication-state.json`), 'utf8'));
      assert.equal(state.status, 'verified');
      assert.equal(state.gitHead, candidate);
    }
  } finally { fixture.cleanup(); }
});

test('public conflicts, uncertain transport and accepted-but-pending runtimes all block the main upload barrier', async () => {
  for (const outcome of [1, 2, 3]) {
    const fixture = runtimeFixture();
    let observed = 0;
    try {
      await assert.rejects(publishRuntimePackages(fixture.directory, fixture.evidence, fixture.prior, candidate, {
        readStatus: async () => 200,
        upload: async () => { throw new Error('Existing versions must not upload'); },
        observe: async () => { observed += 1; return outcome; },
      }), (error: unknown) => error instanceof AggregateError && error.errors.length === 6);
      assert.equal(observed, 6, 'one unverified version must not abandon independent observation');
    } finally { fixture.cleanup(); }
  }
});
