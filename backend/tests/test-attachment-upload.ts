const assert = require('assert');
const express = require('express');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const {
  AttachmentUploadStore,
  createAttachmentUploadHandler,
} = require('../attachment-upload.cjs') as typeof import('../attachment-upload.cjs');

async function listen(application: unknown): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = http.createServer(application);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

async function run(): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'farming-attachment-upload-'));
  const attachmentsDir = path.join(root, 'attachments');
  let releaseSlowWrite!: () => void;
  const slowWriteGate = new Promise<void>(resolve => { releaseSlowWrite = resolve; });
  let slowWriteStarted!: () => void;
  const slowWriteStart = new Promise<void>(resolve => { slowWriteStarted = resolve; });

  const store = new AttachmentUploadStore({ attachmentsDir });
  const slowStore = new AttachmentUploadStore({
    attachmentsDir,
    fileOperations: {
      ...fsp,
      async writeFile(filePath, body, options) {
        slowWriteStarted();
        await slowWriteGate;
        await fsp.writeFile(filePath, body, options);
      },
    },
  });
  const failingStore = new AttachmentUploadStore({
    attachmentsDir,
    randomHex: () => 'feedfacefeedface',
    fileOperations: {
      ...fsp,
      async writeFile(filePath, body) {
        await fsp.writeFile(filePath, body);
        const error = new Error('simulated partial write') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      },
    },
  });

  const app = express();
  app.get('/probe', (_req, res) => res.json({ ready: true }));
  app.post('/image', express.raw({ type: 'image/*', limit: '12mb' }), createAttachmentUploadHandler({
    kind: 'image',
    store,
    reportError: () => {},
  }));
  app.post('/slow', express.raw({ type: 'image/*', limit: '12mb' }), createAttachmentUploadHandler({
    kind: 'image',
    store: slowStore,
    reportError: () => {},
  }));
  app.post('/failure', express.raw({ type: 'audio/*', limit: '25mb' }), createAttachmentUploadHandler({
    kind: 'audio',
    store: failingStore,
    reportError: () => {},
  }));
  const server = await listen(app);

  try {
    const uploads = await Promise.all(Array.from({ length: 16 }, (_, index) => fetch(`${server.baseUrl}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from(`image-${index}`),
    })));
    assert(uploads.every(response => response.status === 201));
    const stored = await Promise.all(uploads.map(response => response.json())) as Array<{
      name: string;
      path: string;
      size: number;
      type: string;
    }>;
    assert.strictEqual(new Set(stored.map(item => item.name)).size, stored.length, 'concurrent uploads need unique names');
    assert(stored.every(item => item.type === 'image/png'));
    await Promise.all(stored.map(async (item, index) => {
      assert.strictEqual(await fsp.readFile(item.path, 'utf8'), `image-${index}`);
    }));

    const collidingPath = path.join(attachmentsDir, 'pasted-image-42-deadbeef.png');
    await fsp.writeFile(collidingPath, 'existing-winner');
    const collisionSlugs = ['deadbeef', 'cafebabe'];
    const collisionStore = new AttachmentUploadStore({
      attachmentsDir,
      now: () => 42,
      randomHex: () => collisionSlugs.shift() || 'feedface',
    });
    const collisionResult = await collisionStore.store('image', 'image/png', Buffer.from('new-upload'));
    assert.strictEqual(collisionResult.name, 'pasted-image-42-cafebabe.png');
    assert.strictEqual(await fsp.readFile(collidingPath, 'utf8'), 'existing-winner', 'EEXIST must never unlink another upload');
    assert.strictEqual(await fsp.readFile(collisionResult.path, 'utf8'), 'new-upload');

    const unsupported = await fetch(`${server.baseUrl}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg/>',
    });
    assert.strictEqual(unsupported.status, 415);
    assert.deepStrictEqual(await unsupported.json(), { error: 'unsupported image type' });

    const empty = await fetch(`${server.baseUrl}/image`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.alloc(0),
    });
    assert.strictEqual(empty.status, 400);
    assert.deepStrictEqual(await empty.json(), { error: 'empty image attachment' });

    const slowRequest = fetch(`${server.baseUrl}/slow`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('slow-image'),
    });
    await slowWriteStart;
    const probe = await fetch(`${server.baseUrl}/probe`);
    assert.strictEqual(probe.status, 200, 'an awaiting upload must not block unrelated Express requests');
    releaseSlowWrite();
    assert.strictEqual((await slowRequest).status, 201);

    const failed = await fetch(`${server.baseUrl}/failure`, {
      method: 'POST',
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.from('partial-audio'),
    });
    assert.strictEqual(failed.status, 500);
    assert.deepStrictEqual(await failed.json(), { error: 'failed to store audio attachment' });
    assert(!(await fsp.readdir(attachmentsDir)).some(name => name.includes('feedfacefeedface')), 'failed writes must unlink their exact partial file');

    const expiredName = 'pasted-image-1-deadbeef.png';
    const unrelatedName = 'keep-me.txt';
    await fsp.writeFile(path.join(attachmentsDir, expiredName), 'old');
    await fsp.writeFile(path.join(attachmentsDir, unrelatedName), 'old');
    const oldDate = new Date(1);
    await fsp.utimes(path.join(attachmentsDir, expiredName), oldDate, oldDate);
    await fsp.utimes(path.join(attachmentsDir, unrelatedName), oldDate, oldDate);
    await store.cleanupExpired({ force: true });
    await assert.rejects(fsp.stat(path.join(attachmentsDir, expiredName)), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
    assert.strictEqual(await fsp.readFile(path.join(attachmentsDir, unrelatedName), 'utf8'), 'old');
  } finally {
    releaseSlowWrite();
    await server.close();
    await fsp.rm(root, { recursive: true, force: true });
  }

  console.log('attachment upload async transport passed');
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
