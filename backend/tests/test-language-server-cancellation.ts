import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedLanguageServerClient, waitForLanguageServer } from '../../extensions/language-server/backend/managed-language-server-client.cjs';
import { ManagedLanguageServerManager } from '../../extensions/language-server/backend/managed-language-server-manager.cjs';
import { LanguageServerService } from '../../extensions/language-server/backend/language-server-service.cjs';
import { executeLanguageServerRequest } from '../../extensions/language-server/backend/language-server-router.cjs';

async function waitForMarker(marker: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (await fs.readFile(marker, 'utf8').catch(() => '') !== expected) {
    assert(Date.now() < deadline, `RPC peer must reach ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function run() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'farming-lsp-cancel-')));
  const marker = path.join(root, 'request-state');
  const filePath = path.join(root, 'example.fake');
  const manager = new ManagedLanguageServerManager({
    configDir: path.join(root, 'config'), definitions: [{
      id: 'fake', language: 'Fake', extensions: ['.fake'],
      command: [process.execPath, path.join(__dirname, 'fixtures/failing-language-server.mjs'), '--cancel-request', '--defer-cancel-response', marker],
    }],
  });
  const service = new LanguageServerService(manager);
  try {
    await fs.writeFile(filePath, 'example');
    const controller = new AbortController();
    const request = executeLanguageServerRequest(service, {
      resolve: () => ({ canonicalPath: root, kind: 'project', rootId: 'root' }),
    }, { rootId: 'root', filePath: 'example.fake', method: 'hover' }, controller.signal);
    let settled = false;
    void request.then(() => { settled = true; }, () => { settled = true; });
    const rejected = assert.rejects(request, { name: 'AbortError' });
    await waitForMarker(marker, 'waiting');
    controller.abort();
    await waitForMarker(marker, 'cancelled');
    assert.equal(settled, false, 'advisory cancellation must retain execution until the peer finishes');
    await fs.writeFile(marker, 'release');
    await rejected;
    assert.equal((await manager.capability()).connections.length, 1, 'request cancellation leaves the shared server alive');

    const diagnosticAbort = new AbortController();
    const diagnostics = manager.request({ workspace: pathToFileURL(root).toString(), uri: pathToFileURL(filePath).toString(), method: 'diagnostics' }, diagnosticAbort.signal);
    const diagnosticRejected = assert.rejects(diagnostics);
    setTimeout(() => diagnosticAbort.abort(), 20);
    await Promise.race([diagnosticRejected, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('diagnostic cancellation did not release its wait')), 500);
      diagnosticRejected.finally(() => clearTimeout(timer));
    })]);

    let release!: (value: number) => void;
    const startup = new Promise<number>(resolve => { release = resolve; });
    const cancelledWaiter = new AbortController();
    const first = waitForLanguageServer(startup, cancelledWaiter.signal);
    const second = waitForLanguageServer(startup);
    cancelledWaiter.abort();
    await assert.rejects(first);
    release(42);
    assert.equal(await second, 42, 'shared startup survives cancellation of another waiter');

    for (const method of ['hover', 'workspaceSymbols']) {
      const discoveryAbort = new AbortController();
      const cancelledManager = new ManagedLanguageServerManager({
        configDir: path.join(root, 'cancelled-config'), definitions: [{
          id: 'unsent', extensions: ['.fake'], command: [path.join(root, 'must-not-start')],
          async resolveRoot() { discoveryAbort.abort(); return root; },
        }],
      });
      try {
        await assert.rejects(cancelledManager.request({
          workspace: pathToFileURL(root).toString(), uri: pathToFileURL(filePath).toString(), method,
        }, discoveryAbort.signal), { name: 'AbortError' });
        assert.equal((await cancelledManager.capability()).connections.length, 0,
          'cancellation during discovery must not start a server');
      } finally {
        await cancelledManager.dispose();
      }
    }

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(ManagedLanguageServerClient.create({
      id: 'missing', command: path.join(root, 'absent'), args: [], root, workspaceRoot: root,
    }));
    await assert.rejects(manager.request({}, aborted.signal), { name: 'AbortError' });
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Language Server cancellation tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
