const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '../..');
const scriptPath = path.join(projectRoot, 'scripts', 'reconcile-npm-registry-tarball.sh');
const VERSION = '9.9.9';
const PACKAGE_SPEC = `farming-code@${VERSION}`;
const SECRET_TOKEN = 'farming-secret-token-do-not-leak';

interface RecordedRequest {
  url: string;
  authorization: string;
}

interface FakeRegistryHandle {
  registry: string;
  setState(value: Record<string, unknown>): void;
  readRequests(): RecordedRequest[];
  close(): Promise<void>;
}

function sha1Hex(buffer: Buffer): string {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function sha512Integrity(buffer: Buffer): string {
  return `sha512-${crypto.createHash('sha512').update(buffer).digest('base64')}`;
}

function makeTarball(root: string, name: string, content: string): string {
  const sourceDir = path.join(root, `src-${name}`, 'farming-code');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(
    path.join(sourceDir, 'package.json'),
    `${JSON.stringify({ name: 'farming-code', version: VERSION }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(sourceDir, 'content.txt'), content);
  const tarball = path.join(root, `${name}.tgz`);
  const packed = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(sourceDir), 'farming-code'], { encoding: 'utf8' });
  assert.strictEqual(packed.status, 0, packed.stderr);
  return tarball;
}

/**
 * Starts one fake npm registry as a sibling process and records the exact URL
 * and Authorization header of every request. Some sandboxes block child->parent
 * loopback connections, so the registry cannot live inside the test process.
 */
function startFakeRegistry(temporaryRoot: string): Promise<FakeRegistryHandle> {
  const serverScript = path.join(temporaryRoot, 'fake-registry.js');
  const stateFile = path.join(temporaryRoot, 'registry-state.json');
  const readyFile = path.join(temporaryRoot, 'registry-ready');
  const requestLog = path.join(temporaryRoot, 'registry-requests.jsonl');
  const serverSource = [
    "const fs = require('fs');",
    "const http = require('http');",
    'const [, , stateFile, readyFile, requestLog] = process.argv;',
    'const server = http.createServer((req, res) => {',
    '  fs.appendFileSync(requestLog, JSON.stringify({',
    '    url: req.url,',
    "    authorization: String(req.headers.authorization || ''),",
    "  }) + '\\n');",
    '  let state = {};',
    '  try {',
    "    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));",
    '  } catch {',
    '    state = {};',
    '  }',
    '  const doc = state.versionDoc;',
    '  if (!doc) {',
    "    res.writeHead(404, { 'content-type': 'application/json' });",
    "    res.end('{}');",
    '    return;',
    '  }',
    "  res.writeHead(state.status || 200, { 'content-type': 'application/json' });",
    '  res.end(JSON.stringify(doc));',
    '});',
    "server.listen(0, '127.0.0.1', () => {",
    '  fs.writeFileSync(readyFile, String(server.address().port));',
    '});',
    '',
  ].join('\n');
  fs.writeFileSync(serverScript, serverSource);
  const child = spawn(process.execPath, [serverScript, stateFile, readyFile, requestLog], {
    stdio: 'ignore',
  });
  return new Promise<FakeRegistryHandle>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;
    const timer = setInterval(() => {
      if (fs.existsSync(readyFile)) {
        clearInterval(timer);
        if (settled) return;
        settled = true;
        const port = Number(fs.readFileSync(readyFile, 'utf8'));
        resolve({
          registry: `http://127.0.0.1:${port}/`,
          setState: (value: Record<string, unknown>) => fs.writeFileSync(stateFile, JSON.stringify(value)),
          readRequests: (): RecordedRequest[] => {
            if (!fs.existsSync(requestLog)) return [];
            return fs.readFileSync(requestLog, 'utf8')
              .split('\n')
              .filter(line => line.trim().length > 0)
              .map(line => JSON.parse(line) as RecordedRequest);
          },
          close: () => new Promise<void>((done) => {
            let finished = false;
            const finish = () => {
              if (!finished) {
                finished = true;
                done();
              }
            };
            child.once('exit', finish);
            child.kill('SIGKILL');
            setTimeout(finish, 1_000).unref();
          }),
        });
        return;
      }
      if (Date.now() - startedAt > 10_000) {
        clearInterval(timer);
        if (!settled) {
          settled = true;
          reject(new Error('fake registry did not start'));
        }
      }
    }, 50);
  });
}

interface ReconcileResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function reconcile(args: string[], registry: string, env: NodeJS.ProcessEnv = {}): ReconcileResult {
  const result = spawnSync('bash', [scriptPath, ...args, '--registry', registry], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function assertNoSecretLeak(result: ReconcileResult, label: string): void {
  assert.ok(!result.stdout.includes(SECRET_TOKEN), `${label}: token leaked into stdout`);
  assert.ok(!result.stderr.includes(SECRET_TOKEN), `${label}: token leaked into stderr`);
}

async function run(): Promise<void> {
  if (process.platform === 'win32') {
    console.log('✓ npm registry tarball reconciliation test requires bash (skipped)');
    return;
  }
  assert.ok(fs.existsSync(scriptPath), `missing script ${scriptPath}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-npm-reconcile-'));
  const fake = await startFakeRegistry(temporaryRoot);
  try {
    // The registry already published one tarball; the local build produced
    // different bytes for the same version.
    const registryTarball = makeTarball(temporaryRoot, 'published', 'registry published content A\n');
    const localTarball = makeTarball(temporaryRoot, 'local', 'local build content B\n');
    const registryBytes = fs.readFileSync(registryTarball);
    const localBytes = fs.readFileSync(localTarball);
    assert.notStrictEqual(sha512Integrity(registryBytes), sha512Integrity(localBytes));

    // 1. Identical digests: reuse is confirmed.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: { integrity: sha512Integrity(localBytes), shasum: sha1Hex(localBytes) },
      },
    });
    const identical = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(identical.status, 0, `identical digests must allow reuse: ${identical.stderr}`);
    assert.match(identical.stdout, /matches the local tarball/);

    // 2. Mismatching digests: the conflict is surfaced and reuse is refused.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: { integrity: sha512Integrity(registryBytes), shasum: sha1Hex(registryBytes) },
      },
    });
    const mismatch = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(mismatch.status, 1, `digest mismatch must refuse reuse: ${mismatch.stdout}`);
    assert.match(mismatch.stderr, /DIFFERENT bytes/);
    assert.match(mismatch.stderr, new RegExp(sha512Integrity(registryBytes).replace(/[+/=]/g, '\\$&')));
    assert.match(mismatch.stderr, new RegExp(sha512Integrity(localBytes).replace(/[+/=]/g, '\\$&')));

    // 3. An integrity match with a conflicting sha1 shasum is still a mismatch.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: { integrity: sha512Integrity(localBytes), shasum: sha1Hex(registryBytes) },
      },
    });
    const shasumMismatch = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(shasumMismatch.status, 1, `sha1 mismatch must refuse reuse: ${shasumMismatch.stdout}`);
    assert.match(shasumMismatch.stderr, /sha1 shasum/);

    // 4. SRI integrity may carry several tokens; one exact sha512 token is enough.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: {
          integrity: `sha256-${'a'.repeat(44)} ${sha512Integrity(localBytes)} sha1-${'b'.repeat(40)}`,
          shasum: sha1Hex(localBytes),
        },
      },
    });
    const multiToken = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(multiToken.status, 0, `multi-token SRI must match one sha512 token: ${multiToken.stderr}`);

    // 5. No sha512 integrity token is never a silent reuse, even with shasum.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: { integrity: `sha256-${'a'.repeat(44)}`, shasum: sha1Hex(localBytes) },
      },
    });
    const missingSha512 = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(missingSha512.status, 2, `sha512-less integrity must stay uncertain: ${missingSha512.stdout}`);
    assert.match(missingSha512.stderr, /no sha512 dist\.integrity/);

    // 6. A sha1-only registry document is never a silent reuse.
    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: VERSION,
        dist: { shasum: sha1Hex(localBytes) },
      },
    });
    const sha1Only = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(sha1Only.status, 2, `sha1-only metadata must stay uncertain: ${sha1Only.stdout}`);

    // 7. The registry must return exactly the requested package document.
    fake.setState({
      versionDoc: {
        name: 'some-other-package',
        version: VERSION,
        dist: { integrity: sha512Integrity(localBytes) },
      },
    });
    const wrongName = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(wrongName.status, 2, `wrong package name must stay uncertain: ${wrongName.stdout}`);
    assert.match(wrongName.stderr, /wrong document/);

    fake.setState({
      versionDoc: {
        name: 'farming-code',
        version: '0.0.1',
        dist: { integrity: sha512Integrity(localBytes) },
      },
    });
    const wrongVersion = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(wrongVersion.status, 2, `wrong version must stay uncertain: ${wrongVersion.stdout}`);
    assert.match(wrongVersion.stderr, /wrong document/);

    // 8. An absent version is not a reuse candidate.
    fake.setState({});
    const absent = reconcile([localTarball, PACKAGE_SPEC], fake.registry);
    assert.strictEqual(absent.status, 2, `absent version must not verify: ${absent.stdout}`);
    assert.match(absent.stderr, /not published/);

    // 9. Registry failures stay uncertain and never leak credentials; the exact
    //    failing request still carries the configured bearer token.
    fake.setState({
      status: 500,
      versionDoc: { name: 'farming-code', version: VERSION, dist: { integrity: sha512Integrity(localBytes) } },
    });
    const requestsBeforeError = fake.readRequests().length;
    const registryError = reconcile([localTarball, PACKAGE_SPEC], fake.registry, { NPM_TOKEN: SECRET_TOKEN });
    assert.strictEqual(registryError.status, 2, `registry errors must stay uncertain: ${registryError.stdout}`);
    assert.match(registryError.stderr, /HTTP 500/);
    assertNoSecretLeak(registryError, 'registry error');
    const errorRequests = fake.readRequests().slice(requestsBeforeError);
    assert.ok(
      errorRequests.some(request => request.authorization === `Bearer ${SECRET_TOKEN}`),
      `the failing registry request must carry the configured bearer token: ${JSON.stringify(errorRequests)}`,
    );

    // 10. Scoped package names reach the registry through the exact encoded path,
    //     and the configured bearer token is sent but never printed. One exact
    //     request must carry BOTH the encoded scoped URL and the bearer token.
    fake.setState({
      versionDoc: {
        name: '@farming/code',
        version: VERSION,
        dist: { integrity: sha512Integrity(localBytes), shasum: sha1Hex(localBytes) },
      },
    });
    const requestsBeforeScoped = fake.readRequests().length;
    const scoped = reconcile([localTarball, `@farming/code@${VERSION}`], fake.registry, { NPM_TOKEN: SECRET_TOKEN });
    assert.strictEqual(scoped.status, 0, `scoped reconciliation must work: ${scoped.stderr}`);
    assertNoSecretLeak(scoped, 'scoped success');
    const scopedRequests = fake.readRequests().slice(requestsBeforeScoped);
    assert.ok(
      scopedRequests.some(request => (
        request.url === `/${encodeURIComponent('@farming/code')}/${VERSION}`
        && request.authorization === `Bearer ${SECRET_TOKEN}`
      )),
      `one exact scoped request must carry the encoded path and the bearer token: ${JSON.stringify(scopedRequests)}`,
    );

    // 11. Registry URLs with embedded credentials are rejected without leaking them.
    const userInfoRegistry = fake.registry.replace('http://', 'http://leak-user:leak-pass@');
    const userInfo = reconcile([localTarball, PACKAGE_SPEC], userInfoRegistry);
    assert.strictEqual(userInfo.status, 2, `userinfo registry URL must be rejected: ${userInfo.stdout}`);
    assert.match(userInfo.stderr, /must not embed credentials/);
    assert.ok(!userInfo.stderr.includes('leak-pass'), 'rejected registry credentials must not be printed');
    assert.ok(!userInfo.stdout.includes('leak-pass'), 'rejected registry credentials must not be printed');

    // 12. Argument validation.
    const missingArgs = spawnSync('bash', [scriptPath], { cwd: projectRoot, encoding: 'utf8' });
    assert.strictEqual(missingArgs.status, 2);
    const missingTarball = reconcile([path.join(temporaryRoot, 'absent.tgz'), PACKAGE_SPEC], fake.registry);
    assert.strictEqual(missingTarball.status, 2);
    assert.match(missingTarball.stderr, /does not exist/);

    console.log('✓ existing npm versions reconcile registry tarball digests before reuse');
  } finally {
    await fake.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
