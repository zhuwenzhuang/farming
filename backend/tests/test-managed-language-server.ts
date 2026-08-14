import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const {
  ManagedLanguageServerManager,
  downloadFile,
  resolveLatestClangdArtifact,
  resolveLatestJdtlsArtifact,
} = require('../../extensions/language-server/backend/managed-language-server-manager.cjs');
const {
  resolveLanguageServer,
} = require('../../extensions/language-server/backend/language-server-registry.cjs');

async function run() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'farming-managed-lsp-'));
  const refreshEvents: Array<{ kind: string; workspaceRoot: string; revision: number }> = [];
  let enabled = true;
  const manager = new ManagedLanguageServerManager({
    configDir: path.join(tempDir, 'config'),
    definitions: [
      {
        id: 'fake',
        language: 'Fake',
        extensions: ['.fake'],
        command: [process.execPath, path.join(__dirname, 'fixtures', 'fake-language-server.mjs')],
        rootMarkers: ['project.marker'],
      },
      {
        id: 'clangd',
        language: 'C / C++',
        extensions: ['.cpp'],
        command: ['clangd'],
      },
      {
        id: 'missing-zeta',
        language: 'Zeta',
        extensions: ['.zeta'],
        command: ['missing-zeta-language-server'],
      },
      {
        id: 'missing-alpha',
        language: 'Alpha',
        extensions: ['.alpha'],
        command: ['missing-alpha-language-server'],
      },
    ],
    env: { ...process.env, PATH: '' },
    isEnabled: () => enabled,
    onRefresh: event => refreshEvents.push(event),
  });
  try {
    const clangdDigest = 'a'.repeat(64);
    const clangdFetch: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/releases/latest')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://github.com/clangd/clangd/releases/tag/23.1.2' },
        });
      }
      if (url.endsWith('/releases/expanded_assets/23.1.2')) {
        return new Response(`/clangd/clangd/releases/download/23.1.2/clangd-linux-23.1.2.zip sha256:${clangdDigest}`);
      }
      throw new Error(`Unexpected clangd metadata request: ${url}`);
    };
    assert.deepStrictEqual(await resolveLatestClangdArtifact(clangdFetch, 'linux'), {
      name: 'clangd-linux-23.1.2.zip',
      sha256: clangdDigest,
      url: 'https://github.com/clangd/clangd/releases/download/23.1.2/clangd-linux-23.1.2.zip',
      version: '23.1.2',
    });

    const jdtlsDigest = 'b'.repeat(64);
    const jdtlsFetch: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/milestones/')) {
        return new Response("<a href='/jdtls/milestones/1.9.0'>1.9.0</a><a href='/jdtls/milestones/1.60.0'>1.60.0</a>");
      }
      if (url.endsWith('/1.60.0/latest.txt')) {
        return new Response('jdt-language-server-1.60.0-202606262232.tar.gz\n');
      }
      if (url.endsWith('/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz.sha256')) {
        return new Response(`${jdtlsDigest}\n`);
      }
      throw new Error(`Unexpected JDTLS metadata request: ${url}`);
    };
    assert.deepStrictEqual(await resolveLatestJdtlsArtifact(jdtlsFetch), {
      name: 'jdt-language-server-1.60.0-202606262232.tar.gz',
      sha256: jdtlsDigest,
      url: 'https://download.eclipse.org/jdtls/milestones/1.60.0/jdt-language-server-1.60.0-202606262232.tar.gz',
      version: '1.60.0',
    });

    const downloadPayload = Buffer.from('verified language server archive');
    const expectedSha256 = crypto.createHash('sha256').update(downloadPayload).digest('hex');
    const verifiedDownload = path.join(tempDir, 'verified-download');
    await downloadFile('https://example.test/server.zip', verifiedDownload, expectedSha256, {
      fetchImpl: async () => new Response(downloadPayload),
    });
    assert.deepStrictEqual(fs.readFileSync(verifiedDownload), downloadPayload);
    const rejectedDownload = path.join(tempDir, 'rejected-download');
    await assert.rejects(
      downloadFile('https://example.test/server.zip', rejectedDownload, '0'.repeat(64), {
        fetchImpl: async () => new Response(downloadPayload),
      }),
      (error: { code?: string }) => error.code === 'LANGUAGE_SERVER_INTEGRITY_FAILED',
    );
    assert.strictEqual(fs.existsSync(rejectedDownload), false);

    const cppRoot = path.join(tempDir, 'cpp');
    const cppFile = path.join(cppRoot, 'src', 'main.cpp');
    fs.mkdirSync(path.dirname(cppFile), { recursive: true });
    fs.writeFileSync(cppFile, 'int main() { return 0; }\n');
    fs.writeFileSync(path.join(cppRoot, 'compile_commands.json'), '[]\n');
    const cpp = await resolveLanguageServer(cppFile, cppRoot);
    assert.strictEqual(cpp?.definition.id, 'clangd');
    assert.strictEqual(cpp?.root, cppRoot);

    const cachedConfigDir = path.join(tempDir, 'cached-config');
    const cachedClangd = path.join(
      cachedConfigDir,
      'language-servers',
      'clangd',
      'clangd_23.1.2',
      'bin',
      process.platform === 'win32' ? 'clangd.exe' : 'clangd',
    );
    fs.mkdirSync(path.dirname(cachedClangd), { recursive: true });
    fs.writeFileSync(cachedClangd, 'cached clangd');
    let launchedCommand = '';
    const cachedFetch: typeof fetch = async () => { throw new Error('offline'); };
    const cachedManager = new ManagedLanguageServerManager({
      configDir: cachedConfigDir,
      definitions: [{
        id: 'clangd',
        extensions: ['.cpp'],
        command: ['clangd'],
        rootMarkers: ['compile_commands.json'],
      }],
      env: { ...process.env, PATH: '' },
      fetchImpl: cachedFetch,
      clientFactory: async (value: { id: string; command: string; root: string; workspaceRoot: string }) => {
        launchedCommand = value.command;
        return {
          id: value.id,
          root: value.root,
          workspaceRoot: value.workspaceRoot,
          execute: async () => ({ result: [], supported: true }),
          ownsHierarchyHandle: () => false,
          dispose: async () => undefined,
        };
      },
    });
    const originalWarn = console.warn;
    let updateWarning = '';
    console.warn = (...values: unknown[]) => { updateWarning = values.map(String).join(' '); };
    try {
      await cachedManager.request({
        workspace: pathToFileURL(cppRoot).toString(),
        uri: pathToFileURL(cppFile).toString(),
        method: 'definition',
        position: { line: 0, character: 0 },
      });
      assert.strictEqual(launchedCommand, cachedClangd, 'a cached runtime should start without waiting for its update check');
      for (let attempt = 0; attempt < 10 && !updateWarning; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.match(updateWarning, /continuing with the cached version/);
    } finally {
      console.warn = originalWarn;
      await cachedManager.dispose();
    }

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

    const idleCapability = await manager.capability();
    assert.strictEqual(idleCapability.enabled, true);
    assert.strictEqual(idleCapability.source, 'managed');
    assert.strictEqual(idleCapability.status, 'ready');
    assert.deepStrictEqual(idleCapability.workspaces, []);
    assert.deepStrictEqual(idleCapability.connections, []);
    assert.deepStrictEqual(idleCapability.languages, [{
      id: 'fake',
      language: 'Fake',
      server: process.execPath,
      status: 'available',
      projects: [],
    }, {
      id: 'clangd',
      language: 'C / C++',
      server: 'clangd',
      status: 'installable',
      projects: [],
    }, {
      id: 'missing-alpha',
      language: 'Alpha',
      server: 'missing-alpha-language-server',
      status: 'missing',
      projects: [],
    }, {
      id: 'missing-zeta',
      language: 'Zeta',
      server: 'missing-zeta-language-server',
      status: 'missing',
      projects: [],
    }], 'available and installable runtimes should sort before missing languages, with language names alphabetical inside each state');
    const initialSymbols = await manager.request({
      ...base,
      method: 'workspaceSymbols',
      query: 'main',
    });
    assert.deepStrictEqual(initialSymbols.result, [{
      name: 'main',
      detail: '',
      kind: 12,
      uri: pathToFileURL(file).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    }], 'workspace symbol search should start the active file server and normalize nested locations');
    const definition = await manager.request({ ...base, method: 'definition' });
    assert.strictEqual(definition.supported, true);
    assert.deepStrictEqual(definition.result, [{
      uri: pathToFileURL(file).toString(),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
    }]);
    for (let attempt = 0; attempt < 20 && refreshEvents.length < 7; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepStrictEqual(refreshEvents, [{
      kind: 'semanticTokens',
      workspaceRoot: workspace,
      revision: 1,
    }, {
      kind: 'inlayHints',
      workspaceRoot: workspace,
      revision: 1,
    }, {
      kind: 'semanticTokens',
      workspaceRoot: workspace,
      revision: 2,
    }, {
      kind: 'semanticTokens',
      workspaceRoot: workspace,
      revision: 3,
    }, {
      kind: 'inlayHints',
      workspaceRoot: workspace,
      revision: 2,
    }, {
      kind: 'semanticTokens',
      workspaceRoot: workspace,
      revision: 4,
    }, {
      kind: 'inlayHints',
      workspaceRoot: workspace,
      revision: 3,
    }], 'server refresh requests should become ordered Project-scoped events');
    assert.deepStrictEqual(manager.refreshSnapshot(), [{
      kind: 'inlayHints',
      workspaceRoot: workspace,
      revision: 3,
    }, {
      kind: 'semanticTokens',
      workspaceRoot: workspace,
      revision: 4,
    }], 'a reconnecting page should receive the latest active Project refresh revisions');

    const activeCapability = await manager.capability();
    assert.strictEqual(activeCapability.status, 'connected');
    assert.deepStrictEqual(activeCapability.workspaces, [pathToFileURL(workspace).toString()]);
    assert.deepStrictEqual(activeCapability.connections, [{
      id: 'fake',
      root: pathToFileURL(workspace).toString(),
      workspace: pathToFileURL(workspace).toString(),
    }]);
    assert.deepStrictEqual(activeCapability.languages[0], {
      id: 'fake',
      language: 'Fake',
      server: process.execPath,
      status: 'running',
      projects: [pathToFileURL(workspace).toString()],
    }, 'an active connection should promote its language to the first running state');

    const hover = await manager.request({ ...base, method: 'hover' });
    assert.deepStrictEqual(hover.result, [{ contents: ['**fake hover**'] }]);

    const documentHighlights = await manager.request({ ...base, method: 'documentHighlights' });
    assert.deepStrictEqual(documentHighlights.result, [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      kind: 2,
    }, {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
      kind: 3,
    }]);

    const semanticTokens = await manager.request({ ...base, method: 'semanticTokens' });
    assert.deepStrictEqual(semanticTokens.result, {
      data: [0, 0, 4, 1, 1],
      resultId: 'fake-semantic-1',
      legend: {
        tokenTypes: ['variable', 'function'],
        tokenModifiers: ['declaration'],
      },
    });

    const inlayHints = await manager.request({
      ...base,
      method: 'inlayHints',
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
    });
    assert.deepStrictEqual(inlayHints.result, [{
      position: { line: 0, character: 4 },
      label: [{ value: ': number', tooltip: { kind: 'markdown', value: '**inferred type**' } }],
      kind: 1,
      tooltip: 'fake inlay hint',
      paddingLeft: true,
    }]);

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

    enabled = false;
    await manager.dispose();
    const disabledCapability = await manager.capability();
    assert.strictEqual(disabledCapability.enabled, false);
    assert.strictEqual(disabledCapability.status, 'ready');
    assert.match(disabledCapability.detail, /Language Server is disabled/);
    assert.deepStrictEqual(disabledCapability.connections, []);
    assert.deepStrictEqual(manager.refreshSnapshot(), []);
    await assert.rejects(
      manager.request({ ...base, method: 'definition' }),
      (error: { code?: string; status?: number }) => (
        error.code === 'LANGUAGE_SERVER_DISABLED' && error.status === 503
      ),
      'a disabled manager must reject requests before resolving or starting a runtime',
    );

    enabled = true;
    const resumed = await manager.request({ ...base, method: 'definition' });
    assert.strictEqual(resumed.supported, true, 're-enabling should restore on-demand startup');

    let gatedEnabled = true;
    let releaseClientFactory = () => {};
    let markClientFactoryStarted = () => {};
    let disposedStaleClient = 0;
    const clientFactoryStarted = new Promise<void>(resolve => { markClientFactoryStarted = resolve; });
    const clientFactoryRelease = new Promise<void>(resolve => { releaseClientFactory = resolve; });
    const gatedManager = new ManagedLanguageServerManager({
      configDir: path.join(tempDir, 'gated-config'),
      definitions: [{
        id: 'gated',
        language: 'Gated',
        extensions: ['.fake'],
        command: [process.execPath],
      }],
      env: { ...process.env, PATH: '' },
      isEnabled: () => gatedEnabled,
      clientFactory: async (value: { id: string; root: string; workspaceRoot: string }) => {
        markClientFactoryStarted();
        await clientFactoryRelease;
        return {
          id: value.id,
          root: value.root,
          workspaceRoot: value.workspaceRoot,
          execute: async () => ({ result: [], supported: true }),
          ownsHierarchyHandle: () => false,
          dispose: async () => { disposedStaleClient += 1; },
        };
      },
    });
    try {
      const pendingRequest = gatedManager.request({ ...base, method: 'definition' });
      await clientFactoryStarted;
      gatedEnabled = false;
      await gatedManager.dispose();
      releaseClientFactory();
      await assert.rejects(
        pendingRequest,
        (error: { code?: string }) => error.code === 'LANGUAGE_SERVER_DISABLED',
        'disabling during startup must fence the stale client before it becomes active',
      );
      assert.strictEqual(disposedStaleClient, 1);
      assert.deepStrictEqual((await gatedManager.capability()).connections, []);
    } finally {
      releaseClientFactory();
      await gatedManager.dispose();
    }

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
