import assert from 'node:assert';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  createLanguageServerRouter,
  sanitizeLanguageServerResult,
} = require('../../extensions/language-server/backend/language-server-router.cjs');
const {
  findNearestMarkerDirectory,
} = require('../../extensions/language-server/backend/language-server-registry.cjs');

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-language-server-'));
  try {
    const workspaceInput = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceInput, { recursive: true });
    const workspace = fs.realpathSync(workspaceInput);
    const sourceFile = path.join(workspace, 'src', 'main.ts');
    const dotDotNameSourceFile = path.join(workspace, '..foo', 'src', 'legal.ts');
    const outsideFile = path.join(tempDir, 'private.txt');
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.mkdirSync(path.dirname(dotDotNameSourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'export const value = 1;\n');
    fs.writeFileSync(dotDotNameSourceFile, 'export const legal = true;\n');
    fs.writeFileSync(path.join(workspace, '..foo', 'package.json'), '{}\n');
    fs.writeFileSync(outsideFile, 'private\n');
    const dotDotNameEscape = path.join(workspace, '..foo', 'escape.ts');
    fs.symlinkSync(outsideFile, dotDotNameEscape);

    assert.deepStrictEqual(sanitizeLanguageServerResult(workspace, {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { uri: pathToFileURL(sourceFile).toString(), selectionRange: null },
          { uri: pathToFileURL(dotDotNameSourceFile).toString(), selectionRange: null },
          { uri: pathToFileURL(dotDotNameEscape).toString(), selectionRange: null },
          { uri: pathToFileURL(outsideFile).toString(), selectionRange: null },
        ],
      },
    }), {
      selectionRange: null,
      nested: {
        value: null,
        items: [
          null,
          { path: 'src/main.ts', selectionRange: null },
          { path: '..foo/src/legal.ts', selectionRange: null },
        ],
      },
    });

    assert.deepStrictEqual(sanitizeLanguageServerResult(workspace, [{
      item: {
        uri: pathToFileURL(outsideFile).toString(),
        selectionRange: null,
      },
      ranges: [],
    }, {
      item: {
        uri: pathToFileURL(sourceFile).toString(),
        selectionRange: null,
      },
      ranges: [],
    }]), [{
      item: {
        path: 'src/main.ts',
        selectionRange: null,
      },
      ranges: [],
    }]);
    assert.strictEqual(
      findNearestMarkerDirectory(dotDotNameSourceFile, workspace, ['package.json']),
      path.join(workspace, '..foo'),
      'root discovery must traverse a legal ..foo Project directory',
    );

    let requestedPayload: Record<string, unknown> | null = null;
    const app = express();
    app.use('/language-server', createLanguageServerRouter({
      capability: async () => ({}),
      request: async (payload: Record<string, unknown>) => {
        requestedPayload = payload;
        return { result: null };
      },
    }, {
      resolve: () => ({ canonicalPath: workspace, kind: 'project', rootId: 'root-project' }),
    }));
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Language Server test did not bind a TCP port');
      const endpoint = `http://127.0.0.1:${address.port}/language-server/request`;
      const legalResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: 'root-project', method: 'definition', filePath: '..foo/src/legal.ts' }),
      });
      assert.strictEqual(legalResponse.status, 200);
      assert.strictEqual(requestedPayload?.uri, pathToFileURL(dotDotNameSourceFile).toString());

      const escapeResponse = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootId: 'root-project', method: 'definition', filePath: '..foo/escape.ts' }),
      });
      assert.strictEqual(escapeResponse.status, 403, 'a symlink through ..foo must not escape the Project');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  assert.strictEqual(fs.existsSync(tempDir), false, 'the test must remove its exact temporary directory');
  console.log('Language Server extension regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
