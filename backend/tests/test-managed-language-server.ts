import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  ManagedLanguageServerManager,
} = require('../../extensions/language-server/backend/managed-language-server-manager.cjs');
const {
  resolveLanguageServer,
} = require('../../extensions/language-server/backend/language-server-registry.cjs');

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-lsp-'));
  const manager = new ManagedLanguageServerManager({
    configDir: path.join(tempDir, 'config'),
    definitions: [{
      id: 'fake',
      extensions: ['.fake'],
      command: [process.execPath, path.join(__dirname, 'fixtures', 'fake-language-server.mjs')],
      rootMarkers: ['project.marker'],
    }],
  });
  try {
    const cppRoot = path.join(tempDir, 'cpp');
    const cppFile = path.join(cppRoot, 'src', 'main.cpp');
    fs.mkdirSync(path.dirname(cppFile), { recursive: true });
    fs.writeFileSync(cppFile, 'int main() { return 0; }\n');
    fs.writeFileSync(path.join(cppRoot, 'compile_commands.json'), '[]\n');
    const cpp = await resolveLanguageServer(cppFile, cppRoot);
    assert.strictEqual(cpp?.definition.id, 'clangd');
    assert.strictEqual(cpp?.root, cppRoot);

    const javaRoot = path.join(tempDir, 'java');
    const javaModule = path.join(javaRoot, 'module');
    const javaFile = path.join(javaModule, 'src', 'Main.java');
    fs.mkdirSync(path.dirname(javaFile), { recursive: true });
    fs.writeFileSync(path.join(javaRoot, 'pom.xml'), '<project><modules><module>module</module></modules></project>');
    fs.writeFileSync(path.join(javaModule, 'pom.xml'), '<project/>');
    fs.writeFileSync(javaFile, 'class Main {}\n');
    const java = await resolveLanguageServer(javaFile, javaRoot);
    assert.strictEqual(java?.definition.id, 'jdtls');
    assert.strictEqual(java?.root, javaRoot);

    const gradleRoot = path.join(tempDir, 'gradle');
    const gradleFile = path.join(gradleRoot, 'module', 'src', 'Main.java');
    fs.mkdirSync(path.dirname(gradleFile), { recursive: true });
    fs.writeFileSync(path.join(gradleRoot, 'settings.gradle'), "include 'module'\n");
    fs.writeFileSync(path.join(gradleRoot, 'module', 'build.gradle'), 'plugins { id "java" }\n');
    fs.writeFileSync(gradleFile, 'class Main {}\n');
    const gradle = await resolveLanguageServer(gradleFile, gradleRoot);
    assert.strictEqual(gradle?.definition.id, 'jdtls');
    assert.strictEqual(gradle?.root, gradleRoot);

    const workspaceInput = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceInput, { recursive: true });
    fs.writeFileSync(path.join(workspaceInput, 'project.marker'), '');
    fs.writeFileSync(path.join(workspaceInput, 'main.fake'), 'main\n');
    const workspace = fs.realpathSync(workspaceInput);
    const file = path.join(workspace, 'main.fake');
    const base = {
      workspace: pathToFileURL(workspace).toString(),
      uri: pathToFileURL(file).toString(),
      position: { line: 0, character: 1 },
    };

    const idleCapability = manager.capability();
    assert.strictEqual(idleCapability.source, 'managed');
    assert.strictEqual(idleCapability.status, 'ready');
    assert.deepStrictEqual(idleCapability.workspaces, []);
    assert.deepStrictEqual(idleCapability.connections, []);
    const definition = await manager.request({ ...base, method: 'definition' });
    assert.strictEqual(definition.supported, true);
    assert.deepStrictEqual(definition.result, [{
      uri: pathToFileURL(file).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    }]);

    const activeCapability = manager.capability();
    assert.strictEqual(activeCapability.status, 'connected');
    assert.deepStrictEqual(activeCapability.workspaces, [pathToFileURL(workspace).toString()]);
    assert.deepStrictEqual(activeCapability.connections, [{
      id: 'fake',
      root: pathToFileURL(workspace).toString(),
      workspace: pathToFileURL(workspace).toString(),
    }]);

    const hover = await manager.request({ ...base, method: 'hover' });
    assert.deepStrictEqual(hover.result, [{ contents: ['**fake hover**'] }]);

    const diagnostics = await manager.request({ ...base, method: 'diagnostics' });
    assert.deepStrictEqual(diagnostics.result, [{
      message: 'fake diagnostic',
      severity: 1,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      source: 'fake-lsp',
    }]);

    const prepared = await manager.request({ ...base, method: 'prepareCallHierarchy' });
    const preparedItems = prepared.result as Array<{ id: string }>;
    assert.strictEqual(preparedItems.length, 1);
    assert.ok(preparedItems[0].id);
    const incoming = await manager.request({
      workspace: base.workspace,
      method: 'incomingCalls',
      itemId: preparedItems[0].id,
    });
    assert.strictEqual((incoming.result as Array<{ item: { name: string } }>)[0].item.name, 'caller');

    const symbols = await manager.request({
      workspace: base.workspace,
      method: 'workspaceSymbols',
      query: 'main',
    });
    assert.strictEqual((symbols.result as Array<{ name: string }>)[0].name, 'main');

  } finally {
    await manager.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('Managed Language Server regression test passed.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
