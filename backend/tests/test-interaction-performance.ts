import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { InteractionPerformanceJournal, createInteractionPerformanceRouter } from '../interaction-performance.cjs';

const express = require('express');

async function run() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-interaction-test-'));
  const journal = new InteractionPerformanceJournal(path.join(directory, 'logs'), 4096);
  let server: Server | undefined;
  try {
    const serverTrace = journal.recorder.begin('terminal.input', { id: 'browser:1' });
    serverTrace.mark('received'); serverTrace.mark('dispatch'); serverTrace.end('completed');
    const browser = { version: 1, source: 'browser', id: 'browser:1', operation: 'terminal.input', outcome: 'observed',
      startedAt: Date.now(), durationMs: 201, slow: true, stages: { frame: 201 }, metrics: { inputUnits: 1 }, input: 'PRIVATE_TYPED_VALUE' };
    assert.equal(journal.ingest([browser, { ...browser, source: 'server' }]), 1);
    await journal.flush();
    const file = path.join(directory, 'logs', 'interactions.jsonl');
    let contents = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(contents, /PRIVATE_TYPED_VALUE/);
    assert.match(contents, /"source":"server"/, 'slow browser observation backfills the fast matching server span');
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 30; j++) journal.recorder.begin('file.save').end('failed');
      await journal.flush();
    }
    const files = await fs.readdir(path.join(directory, 'logs'));
    assert.equal(files.length, 4, 'only current segment and three rotated segments');
    assert.equal(journal.snapshot().queued, 0);
    const app = express();
    app.use((req: { authAccessMode?: string; headers: Record<string, string> }, _res: unknown, next: () => void) => {
      req.authAccessMode = req.headers['x-test-access']; next();
    });
    app.use('/performance', createInteractionPerformanceRouter(journal));
    server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/performance`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { 'x-test-access': 'read-only' } })).status, 403);
    const response = await fetch(url, { headers: { 'x-test-access': 'owner' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-access': 'owner' },
      body: JSON.stringify({ records: Array(33).fill(browser) }) })).status, 400);
    // A file where a directory should be makes persistence fail without touching a product call.
    const brokenPath = path.join(directory, 'blocked');
    await fs.writeFile(brokenPath, 'fixture');
    const broken = new InteractionPerformanceJournal(brokenPath);
    try {
      broken.recorder.begin('file.save').end('failed'); await broken.flush();
      assert.equal(broken.writeFailures, 1); assert.equal(broken.snapshot().queued, 0);
    } finally { broken.dispose(); }
    contents = JSON.stringify(journal.snapshot());
    assert.doesNotMatch(contents, /PRIVATE_TYPED_VALUE/);
    console.log('Interaction journal: privacy, correlation, rotation, owner-only access, write failure passed');
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    journal.dispose(); await journal.flush();
    await fs.rm(directory, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
