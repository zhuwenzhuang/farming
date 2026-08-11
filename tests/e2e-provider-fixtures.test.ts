import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const fixtureDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures');

test('provider fixtures answer one-shot usage probes without entering interactive mode', async () => {
  const [codex, claude, openCodeList, openCodeExport] = await Promise.all([
    execFileAsync(path.join(fixtureDir, 'fake-codex'), ['login', 'status'], { timeout: 1_000 }),
    execFileAsync(path.join(fixtureDir, 'claude'), ['auth', 'status', '--json'], { timeout: 1_000 }),
    execFileAsync(path.join(fixtureDir, 'opencode'), [
      'session', 'list', '--format', 'json', '--max-count', '5000',
    ], { timeout: 1_000 }),
    execFileAsync(path.join(fixtureDir, 'opencode'), [
      'export', 'fixture-session', '--pure', '--sanitize',
    ], { timeout: 1_000 }),
  ]);

  assert.match(codex.stdout, /Logged in/);
  assert.equal(JSON.parse(claude.stdout).loggedIn, true);
  assert.deepEqual(JSON.parse(openCodeList.stdout), []);
  assert.deepEqual(JSON.parse(openCodeExport.stdout), {});
});
