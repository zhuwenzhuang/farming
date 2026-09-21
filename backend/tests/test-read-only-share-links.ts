import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { ReadOnlyShareStore } from '../read-only-share-store.cjs';
import { atomicWriteJsonAsync } from '../atomic-json-store.cjs';
import { TokenAuth, bearerAuthorizationHeader } from '../auth.cjs';
import { QrShareTicketStore } from '../qr-share-tickets.cjs';
import { createQrShareRouter, createReadOnlyShareEntryRouter } from '../qr-share-router.cjs';

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-readonly-links-'));
  const originalEnv = { FARMING_CONFIG_DIR: process.env.FARMING_CONFIG_DIR, FARMING_DISABLE_AUTH: process.env.FARMING_DISABLE_AUTH, FARMING_TOKEN: process.env.FARMING_TOKEN };
  const servers: Server[] = [];
  process.env.FARMING_CONFIG_DIR = root;
  delete process.env.FARMING_DISABLE_AUTH;
  delete process.env.FARMING_TOKEN;
  try {
    const now = Date.now();
    let failWrite = false;
    const store = new ReadOnlyShareStore(root, {
      maxLinks: 10,
      writeJson: async (...args) => {
        if (failWrite) throw new Error('disk unavailable');
        return atomicWriteJsonAsync(...args);
      },
    });
    const shares = await Promise.all(Array.from({ length: 10 }, (_, index) => store.create('read-only-test-token', {
      targetQuery: `ftarget=agent&agent=test-${index}`, expiresAt: now + 30_000, now,
    })));
    assert.equal(new Set(shares.map(s => s.code)).size, 10, 'parallel creations must retain every unique link');
    const restarted = new ReadOnlyShareStore(root);
    for (const [index, share] of shares.entries()) {
      assert.match(share.code, /^[A-Za-z0-9_-]{22}$/);
      assert.equal((await restarted.resolve(share.code, now))?.targetQuery, `ftarget=agent&agent=test-${index}`);
    }
    const persisted = await fs.readFile(path.join(root, 'read-only-shares.json'), 'utf8');
    assert(!shares.some(s => persisted.includes(s.code)), 'storage must use hashes instead of bearer codes');
    assert.equal((await fs.stat(path.join(root, 'read-only-shares.json'))).mode & 0o777, 0o600);
    await assert.rejects(store.create('token', { targetQuery: '', expiresAt: now + 30_000, now }), /capacity reached/);
    assert(await store.resolve(shares[0].code, now), 'capacity pressure must not evict an existing link');
    assert.equal(await store.resolve(shares[0].code, now + 30_000), null);
    failWrite = true;
    await assert.rejects(store.create('token', { targetQuery: '', expiresAt: now + 90_000, now: now + 30_001 }), /disk unavailable/);
    assert.equal(await fs.readFile(path.join(root, 'read-only-shares.json'), 'utf8'), persisted);
    failWrite = false;
    const afterExpiry = await store.create('token', { targetQuery: '', expiresAt: now + 90_000, now: now + 30_001 });
    assert(await store.resolve(afterExpiry.code, now + 30_001));
    assert.equal(await store.resolve('../escape', now), null);

    // Real auth + route composition, including a fresh store and auth after restart.
    const authRoot = path.join(root, 'http');
    process.env.FARMING_CONFIG_DIR = authRoot;
    const auth = new TokenAuth({ basePath: '/farm' });
    const owner = { Authorization: bearerAuthorizationHeader(auth.getToken()) };
    let rotateDuringCommit = false;
    let failCommit = false;
    const liveStore = new ReadOnlyShareStore(authRoot, { writeJson: async (...args) => {
      if (failCommit) throw new Error('read-only storage unavailable');
      const committed = await atomicWriteJsonAsync(...args);
      if (rotateDuringCommit) auth.rotateToken();
      return committed;
    } });
    const mount = async (links: ReadOnlyShareStore, authority: TokenAuth) => {
      const tickets = new QrShareTicketStore();
      const app = express();
      app.use('/farm/s', createReadOnlyShareEntryRouter(links, authority, '/farm'));
      app.use(authority.middleware());
      app.use('/farm/api/share/qr-ticket', createQrShareRouter(authority, tickets, {
        authEnabled: true, basePath: '/farm', fallbackPort: 0, readOnlyLinks: links,
      }));
      app.post('/farm/api/mutate', (_req, res) => res.json({ mutated: true }));
      const server = await new Promise<Server>(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      servers.push(server);
      const address = server.address();
      assert(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}`;
    };
    const origin = await mount(liveStore, auth);
    const create = async (headers: Record<string, string>, target = { kind: 'file', absolutePath: '/workspace/项目/分享.md', lineNumber: 12 }) => fetch(origin + '/farm/api/share/qr-ticket', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
    });
    const result = await create(owner);
    assert.equal(result.status, 200);
    const share = await result.json();
    assert.equal(share.readOnlyUrl, share.longUrl);
    assert(share.readOnlyExpiresAt > Date.now() + 23 * 60 * 60 * 1000);
    assert(share.expiresAt <= Date.now() + 5 * 60 * 1000);
    const persistedLink = await liveStore.resolve(new URL(share.readOnlyUrl).pathname.split('/').at(-1)!, share.expiresAt + 1);
    assert(persistedLink, 'read-only link remains valid after QR expiry');
    assert.equal(persistedLink.expiresAt, share.readOnlyExpiresAt);
    const url = new URL(share.readOnlyUrl);
    assert.match(url.pathname, /^\/farm\/s\/[A-Za-z0-9_-]{22}$/);
    assert.equal(url.search, '');
    assert.equal(share.shortUrlAccessMode, 'owner');
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 204);
    assert.equal(head.headers.get('set-cookie'), null);
    const opened = await Promise.all(Array.from({ length: 3 }, () => fetch(url, { redirect: 'manual' })));
    for (const response of opened) {
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const location = new URL(response.headers.get('location')!, origin);
      assert.equal(location.searchParams.get('path'), '/workspace/项目/分享.md');
      assert.equal(location.searchParams.get('line'), '12');
      assert.equal(location.searchParams.has('token'), false);
      assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    }
    const cookie = opened[0].headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(origin + '/farm/api/mutate', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
    assert.equal((await fetch(origin + '/farm/api/mutate', { method: 'POST', headers: owner })).status, 200);
    await fetch(origin + `/farm/api/share/qr-ticket/${share.code}`, { method: 'DELETE', headers: owner });
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 302, 'closing QR must not revoke the copied link');
    const delegatedResponse = await create({ Cookie: cookie });
    assert.equal(delegatedResponse.status, 200);
    const delegated = await delegatedResponse.json();
    assert(delegated.readOnlyExpiresAt <= share.readOnlyExpiresAt);
    assert.equal(delegated.tokenLabel, '');
    assert.equal(delegated.fullAccessUrl, undefined);
    assert.equal(delegated.shortUrlAccessMode, 'read-only');
    const restartedOrigin = await mount(new ReadOnlyShareStore(authRoot), new TokenAuth({ basePath: '/farm' }));
    assert.equal((await fetch(restartedOrigin + url.pathname, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(origin + url.pathname + 'x')).status, 410);
    const tokenRecord = await liveStore.resolve(url.pathname.split('/').at(-1)!);
    assert(tokenRecord);
    assert.equal(await liveStore.resolve(url.pathname.split('/').at(-1)!, share.readOnlyExpiresAt), null);

    failCommit = true;
    assert.equal((await create(owner)).status, 500, 'failed persistence must never return a link');
    failCommit = false;
    rotateDuringCommit = true;
    assert.equal((await create(owner)).status, 410, 'rotation during persistence must not publish a stale capability');
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 410);
    assert.equal((await fetch(delegated.readOnlyUrl, { redirect: 'manual' })).status, 410);
    const invalidStore = new ReadOnlyShareStore(path.join(root, 'invalid'));
    const ownerLink = await invalidStore.create(auth.getToken(), { targetQuery: '', expiresAt: Date.now() + 30_000 });
    const invalidOrigin = await mount(invalidStore, auth);
    assert.equal((await fetch(invalidOrigin + '/farm/s/' + ownerLink.code)).status, 410, 'short read-only entry must never admit an owner credential');
    await fs.writeFile(path.join(authRoot, 'read-only-shares.json'), '{broken');
    const brokenOrigin = await mount(new ReadOnlyShareStore(authRoot), auth);
    assert.equal((await fetch(brokenOrigin + url.pathname)).status, 503, 'corruption must fail explicitly');
    assert.equal(await fs.readFile(path.join(authRoot, 'read-only-shares.json'), 'utf8'), '{broken');
    console.log('read-only short share persistence, auth, concurrency and recovery passed');
  } finally {
    await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
