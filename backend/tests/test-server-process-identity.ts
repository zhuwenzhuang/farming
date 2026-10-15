import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mock } from 'node:test';
const { readServerProcessIdentity, readLiveServerProcessIdentity } = require('../server-process-identity.cjs');

assert.equal(readServerProcessIdentity(process.pid)?.pid, process.pid);
try {
  for (const state of ['S', 'R+', 'Z', 'Zs', 'X']) {
    mock.method(childProcess, 'execFileSync', () => `731 731 Thu Oct 15 10:00:00 2026 ${state}\n`);
    const identity = readLiveServerProcessIdentity(731);
    assert.equal(readServerProcessIdentity(731)?.pid, 731, "retain exited leader identity for descendant cleanup");
    if (/^[ZX]/.test(state)) assert.equal(identity, null, `${state} cannot execute or receive a useful signal`);
    else assert.deepEqual(identity, { pid: 731, processGroupId: 731, startedAt: 'Thu Oct 15 10:00:00 2026', format: 'ps-lstart-c-utc-v1' });
  }
  mock.method(childProcess, 'execFileSync', () => { throw Object.assign(new Error('missing ps'), { code: 'ENOENT' }); });
  assert.throws(() => readServerProcessIdentity(731), /Install procps.*procps-ng/);
  mock.method(childProcess, 'execFileSync', () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }); });
  assert.throws(() => readServerProcessIdentity(731), /permission denied/);
} finally {
  mock.restoreAll();
}
console.log('Server identity distinguishes live and zombie processes and fails visibly on unknown ownership');
