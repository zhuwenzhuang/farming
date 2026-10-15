import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { StreamMessageWriter } from 'vscode-jsonrpc/node';
import type { ManagedLanguageServerClient as Client } from '../../extensions/language-server/backend/managed-language-server-client.cjs';

const { ManagedLanguageServerClient } = require('../../extensions/language-server/backend/managed-language-server-client.cjs') as {
  ManagedLanguageServerClient: typeof Client;
};
const execFileAsync = promisify(execFile);

async function scenario(method: string): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'farming-lsp-failure-'));
  const filePath = path.join(root, 'example.fake');
  let client: Client | undefined;
  let exits = 0;
  let injected = false;
  const original = StreamMessageWriter.prototype.write;
  StreamMessageWriter.prototype.write = function (message) {
    if ('method' in message && message.method === method) {
      injected = true;
      return Promise.reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    }
    return original.call(this, message);
  };
  const options = {
    id: 'fake', command: process.execPath,
    args: [path.join(__dirname, 'fixtures', 'fake-language-server.mjs')],
    root, workspaceRoot: root, onExit: () => { exits += 1; },
  };
  try {
    await fs.writeFile(filePath, 'first');
    if (method === 'close-input' || method === 'exit-request') {
      const failingOptions = { ...options, args: [path.join(__dirname, 'fixtures', 'failing-language-server.mjs'), `--${method}`] };
      if (method === 'close-input') {
        await assert.rejects(async () => {
          client = await ManagedLanguageServerClient.create(failingOptions);
          await client.execute({ method: 'hover', filePath });
        }, /EPIPE|not running|disposed|closed/i);
      } else {
        client = await ManagedLanguageServerClient.create(failingOptions);
        await assert.rejects(client.execute({ method: 'hover', filePath }), /not running/);
      }
    } else if (method === 'initialized') {
      await assert.rejects(ManagedLanguageServerClient.create(options), /EPIPE/);
    } else if (method === 'spawn-error') {
      await assert.rejects(ManagedLanguageServerClient.create({ ...options, command: path.join(root, 'missing-server') }), /failed to start/);
    } else {
      client = await ManagedLanguageServerClient.create(options);
      if (method === 'textDocument/didChange') {
        await client.execute({ method: 'hover', filePath });
        await fs.writeFile(filePath, 'changed document');
      }
      await assert.rejects(client.execute({ method: 'hover', filePath }), /EPIPE/);
      await assert.rejects(client.execute({ method: 'hover', filePath }), /not running/);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(exits, 1, 'failed connection is removed exactly once');
    if (['initialized', 'textDocument/didOpen', 'textDocument/didChange'].includes(method)) assert.equal(injected, true);
    // Another connection still works after the failure; no global rejection handler.
    StreamMessageWriter.prototype.write = original;
    const healthy = await ManagedLanguageServerClient.create({ ...options, onExit: undefined });
    try {
      const notifications: string[] = [];
      StreamMessageWriter.prototype.write = function (message) {
        if ('method' in message && typeof message.method === 'string' && message.method.startsWith('textDocument/did')) notifications.push(message.method);
        return original.call(this, message);
      };
      const results = await Promise.all(Array.from({ length: 8 }, () => healthy.execute({ method: 'hover', filePath })));
      assert(results.every(result => result.supported));
      assert.deepEqual(notifications, ['textDocument/didOpen']);
      await fs.writeFile(filePath, 'another saved version');
      await Promise.all(Array.from({ length: 8 }, () => healthy.execute({ method: 'hover', filePath })));
      assert.deepEqual(notifications, ['textDocument/didOpen', 'textDocument/didChange']);
    } finally {
      await healthy.dispose();
    }
  } finally {
    StreamMessageWriter.prototype.write = original;
    await client?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function run(): Promise<void> {
  const child = process.argv.indexOf('--scenario');
  if (child >= 0) return scenario(process.argv[child + 1]);
  for (const method of ['initialized', 'textDocument/didOpen', 'textDocument/didChange', 'spawn-error', 'close-input', 'exit-request']) {
    await execFileAsync(process.execPath, ['--unhandled-rejections=strict', '--import', 'tsx', __filename, '--scenario', method], {
      timeout: 15_000,
    });
    console.log(`✓ isolated Language Server failure: ${method}`);
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
