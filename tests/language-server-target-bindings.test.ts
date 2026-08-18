import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { build, type Plugin } from 'esbuild'
import { TargetBindingRegistry } from '../extensions/language-server/frontend/target-binding-registry'

interface ProviderHarness {
  hoverProvider?: {
    provideHover(model: unknown, position: unknown, token: unknown): Promise<unknown>
  }
  definitionProvider?: {
    provideDefinition(model: unknown, position: unknown): Promise<unknown>
  }
  editorOpener?: {
    openCodeEditor(source: unknown, resource: unknown, selection: unknown): boolean
  }
  semanticTokensProvider?: {
    onDidChange(listener: () => void): { dispose(): void }
    provideDocumentSemanticTokens(model: unknown, lastResultId: unknown, token: unknown): Promise<{ data: Uint32Array }>
  }
  inlayHintsProvider?: {
    onDidChangeInlayHints(listener: () => void): { dispose(): void }
    provideInlayHints(model: unknown, range: unknown, token: unknown): Promise<{ hints: unknown[] }>
  }
  documentSymbolProvider?: {
    provideDocumentSymbols(model: unknown, token: unknown): Promise<unknown[]>
  }
  languageServerError?: new (message: string, status: number, code: string) => Error
  request: (options?: { signal?: AbortSignal }) => Promise<unknown>
}

let providerModuleSequence = 0

function controllableCancellationToken() {
  let cancelled = false
  const listeners = new Set<() => void>()
  return {
    token: {
      get isCancellationRequested() { return cancelled },
      onCancellationRequested(listener: () => void) {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      },
    },
    cancel() {
      if (cancelled) return
      cancelled = true
      for (const listener of listeners) listener()
    },
  }
}

function requestUntilAborted(options?: { signal?: AbortSignal }): Promise<unknown> {
  const signal = options?.signal
  if (!signal) return Promise.reject(new Error('Hover request did not receive an AbortSignal'))
  return new Promise((_, reject) => {
    const rejectAbort = () => reject(signal.reason || new Error('Hover request aborted'))
    if (signal.aborted) rejectAbort()
    else signal.addEventListener('abort', rejectAbort, { once: true })
  })
}

async function loadMonacoProviders(harness: ProviderHarness) {
  const globalHarness = globalThis as typeof globalThis & { __farmingLanguageServerHarness?: ProviderHarness }
  globalHarness.__farmingLanguageServerHarness = harness
  const stubs: Plugin = {
    name: 'language-server-provider-stubs',
    setup(builder) {
      builder.onResolve({ filter: /^monaco-editor$/ }, () => ({ path: 'monaco', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^@\/lib\/workspace-editor-monaco$/ }, () => ({ path: 'workspace', namespace: 'test-stub' }))
      builder.onResolve({ filter: /^\.\/client$/ }, () => ({ path: 'client', namespace: 'test-stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, ({ path: stubPath }) => {
        if (stubPath === 'workspace') {
          return { contents: `export function workspaceEditorModelUriForFile(file) {
            return { toString: () => file.file.path }
          }` }
        }
        if (stubPath === 'client') {
          return { contents: `export class LanguageServerError extends Error {
              constructor(message, status, code) {
                super(message)
                this.status = status
                this.code = code
              }
              get unavailable() {
                return this.status === 503
                  || this.code === 'LANGUAGE_SERVER_UNAVAILABLE'
                  || this.code === 'LANGUAGE_SERVER_WORKSPACE_UNAVAILABLE'
              }
            }
            globalThis.__farmingLanguageServerHarness.languageServerError = LanguageServerError
            export function requestLanguageServer(_request, options) {
              return globalThis.__farmingLanguageServerHarness.request(options)
            }` }
        }
        return { contents: `
          const harness = globalThis.__farmingLanguageServerHarness
          const disposable = { dispose() {} }
          export class Emitter {
            listeners = new Set()
            event = listener => {
              this.listeners.add(listener)
              return { dispose: () => this.listeners.delete(listener) }
            }
            fire() { this.listeners.forEach(listener => listener()) }
          }
          export class Range {}
          export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2, Hint: 1 }
          export const TrackedRangeStickiness = { NeverGrowsWhenTypingAtEdges: 1 }
          export const editor = {
            TrackedRangeStickiness,
            onWillDisposeModel() { return disposable },
            registerEditorOpener(value) { harness.editorOpener = value; return disposable },
            getModel() { return null },
            setModelMarkers() {},
          }
          export const languages = {
            registerHoverProvider(_selector, value) { harness.hoverProvider = value; return disposable },
            registerDefinitionProvider(_selector, value) { harness.definitionProvider = value; return disposable },
            registerReferenceProvider() { return disposable },
            registerImplementationProvider() { return disposable },
            registerDocumentSemanticTokensProvider(_selector, value) { harness.semanticTokensProvider = value; return disposable },
            registerInlayHintsProvider(_selector, value) { harness.inlayHintsProvider = value; return disposable },
            registerDocumentSymbolProvider(_selector, value) { harness.documentSymbolProvider = value; return disposable },
          }
        ` }
      })
    },
  }
  const result = await build({
    absWorkingDir: path.join(import.meta.dirname, '..'),
    entryPoints: ['extensions/language-server/frontend/monaco-providers.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [stubs],
    write: false,
  })
  const source = result.outputFiles[0]?.text || ''
  providerModuleSequence += 1
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${providerModuleSequence}`)
}

test('target bindings are released with their source model', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-a', { rootId: 'agent-a' })
  registry.set('model-a', 'target-shared', { rootId: 'agent-a' })
  assert.equal(registry.size, 2)

  registry.deleteSource('model-a')

  assert.equal(registry.size, 0)
  assert.equal(registry.get('target-a'), undefined)
  assert.equal(registry.get('target-shared'), undefined)
})

test('Language Server hover renders only a completed semantic result', async () => {
  const harness: ProviderHarness = {
    request: async () => [{ contents: ['```cpp\nRowVectorPtr\n```'] }],
  }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-cpp',
    file: { path: 'CompactRow.cpp' },
    workspaceRoot: '/workspace-cpp',
    dirty: false,
    externalChanged: false,
  }])
  const cancellation = controllableCancellationToken()

  const hover = await harness.hoverProvider?.provideHover({
    uri: { toString: () => 'CompactRow.cpp' },
  }, { lineNumber: 12, column: 8 }, cancellation.token)

  assert.deepEqual(hover, {
    contents: [{ value: '```cpp\nRowVectorPtr\n```' }],
  })
})

test('empty or already cancelled Language Server hover creates no popup', async () => {
  let requestCount = 0
  const harness: ProviderHarness = {
    request: async () => {
      requestCount += 1
      return [{ contents: [] }]
    },
  }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-cpp',
    file: { path: 'CompactRow.cpp' },
    workspaceRoot: '/workspace-cpp',
    dirty: false,
    externalChanged: false,
  }])
  const model = { uri: { toString: () => 'CompactRow.cpp' } }
  const position = { lineNumber: 12, column: 8 }
  const active = controllableCancellationToken()

  assert.equal(await harness.hoverProvider?.provideHover(model, position, active.token), null)
  assert.equal(requestCount, 1)

  const cancelled = controllableCancellationToken()
  cancelled.cancel()
  assert.equal(await harness.hoverProvider?.provideHover(model, position, cancelled.token), null)
  assert.equal(requestCount, 1, 'an already cancelled hover must not start a request')
})

test('slow Language Server hover settles empty before Monaco can show Loading', async () => {
  let requestSignal: AbortSignal | undefined
  const harness: ProviderHarness = {
    request: options => {
      requestSignal = options?.signal
      return requestUntilAborted(options)
    },
  }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-cpp',
    file: { path: 'CompactRow.cpp' },
    workspaceRoot: '/workspace-cpp',
    dirty: false,
    externalChanged: false,
  }])
  const cancellation = controllableCancellationToken()
  const startedAt = Date.now()

  const hover = await harness.hoverProvider?.provideHover({
    uri: { toString: () => 'CompactRow.cpp' },
  }, { lineNumber: 12, column: 8 }, cancellation.token)

  assert.equal(hover, null)
  assert.equal(requestSignal?.aborted, true, 'the slow HTTP request must be aborted')
  assert.ok(
    Date.now() - startedAt < 850,
    'the provider must settle before Monaco adds its Loading message at roughly 900ms',
  )
})

test('leaving a Language Server hover cancels its request immediately', async () => {
  let requestSignal: AbortSignal | undefined
  const harness: ProviderHarness = {
    request: options => {
      requestSignal = options?.signal
      return requestUntilAborted(options)
    },
  }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-cpp',
    file: { path: 'CompactRow.cpp' },
    workspaceRoot: '/workspace-cpp',
    dirty: false,
    externalChanged: false,
  }])
  const cancellation = controllableCancellationToken()
  const hoverPromise = harness.hoverProvider?.provideHover({
    uri: { toString: () => 'CompactRow.cpp' },
  }, { lineNumber: 12, column: 8 }, cancellation.token)
  await new Promise(resolve => setImmediate(resolve))
  cancellation.cancel()

  const completion = await Promise.race([
    hoverPromise,
    new Promise(resolve => setTimeout(() => resolve('still-pending'), 300)),
  ])
  assert.equal(completion, null)
  assert.equal(requestSignal?.aborted, true)
})

test('switching files aborts automatic Language Server providers immediately', async () => {
  const requestSignals: AbortSignal[] = []
  const harness: ProviderHarness = {
    request: options => {
      if (options?.signal) requestSignals.push(options.signal)
      return requestUntilAborted(options)
    },
  }
  const providers = await loadMonacoProviders(harness)
  const files = Array.from({ length: 4 }, (_, index) => ({
    agentId: 'agent-cpp',
    file: { path: `RapidSwitch${index}.cpp` },
    workspaceRoot: '/workspace-cpp',
    dirty: false,
    externalChanged: false,
  }))
  providers.bindLanguageServerModels(files)
  for (const file of files) {
    const model = {
      uri: { toString: () => file.file.path },
      isDisposed: () => false,
      getVersionId: () => 1,
    }
    const semanticCancellation = controllableCancellationToken()
    const symbolsCancellation = controllableCancellationToken()
    const semanticPromise = harness.semanticTokensProvider?.provideDocumentSemanticTokens(
      model,
      null,
      semanticCancellation.token,
    )
    const symbolsPromise = harness.documentSymbolProvider?.provideDocumentSymbols(model, symbolsCancellation.token)
    await new Promise(resolve => setImmediate(resolve))
    semanticCancellation.cancel()
    symbolsCancellation.cancel()
    assert.deepEqual(await semanticPromise, { data: new Uint32Array() })
    assert.deepEqual(await symbolsPromise, [])
  }
  assert.equal(requestSignals.length, 8, 'the fixture must exceed the usual six per-origin connections')
  assert.ok(requestSignals.every(signal => signal.aborted), 'stale provider fetches must release browser connections')
})

test('disposing an old source cannot delete a target rebound by a live model', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-shared', { rootId: 'agent-a' })
  registry.set('model-b', 'target-shared', { rootId: 'agent-b' })

  registry.deleteSource('model-a')
  assert.deepEqual(registry.get('target-shared'), { rootId: 'agent-b' })
  assert.equal(registry.size, 1)

  registry.deleteSource('model-b')
  assert.equal(registry.size, 0)
})

test('disposing the newer source keeps the target alive for the original source', () => {
  const registry = new TargetBindingRegistry<{ rootId: string }>()
  registry.set('model-a', 'target-b', { rootId: 'agent-a' })
  registry.set('model-b', 'target-b', { rootId: 'agent-b' })

  // model-b is disposed first; target-b must survive for model-a's opener.
  registry.deleteSource('model-b')
  assert.deepEqual(registry.get('target-b'), { rootId: 'agent-a' })
  assert.equal(registry.size, 1)

  registry.deleteSource('model-a')
  assert.equal(registry.get('target-b'), undefined)
  assert.equal(registry.size, 0)
})

test('bindLanguageServerModels live inventory falls back from removed Agent B to Agent A', async () => {
  const harness: ProviderHarness = {
    request: async () => [{
      path: 'shared-target.ts',
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    }],
  }
  const providers = await loadMonacoProviders(harness)
  const fileA = {
    agentId: 'agent-a',
    file: { path: 'source-a.ts' },
    workspaceRoot: '/workspace',
    dirty: false,
    externalChanged: false,
  }
  const fileB = { ...fileA, agentId: 'agent-b', file: { path: 'source-b.ts' } }
  const model = (filePath: string) => ({
    uri: { toString: () => filePath },
    isDisposed: () => false,
  })

  providers.bindLanguageServerModels([fileA, fileB])
  await harness.definitionProvider?.provideDefinition(model(fileA.file.path), { lineNumber: 1, column: 1 })
  await harness.definitionProvider?.provideDefinition(model(fileB.file.path), { lineNumber: 1, column: 1 })
  providers.bindLanguageServerModels([fileA])

  let openedRootId = ''
  providers.setLanguageServerEditorOpener((binding: { rootId: string }) => {
    openedRootId = binding.rootId
  })
  assert.equal(harness.editorOpener?.openCodeEditor(
    null,
    { toString: () => 'shared-target.ts' },
    null,
  ), true)
  assert.equal(openedRootId, 'agent-a')
})

test('Language Server refresh events are ordered and scoped to clean Project models', async () => {
  const harness: ProviderHarness = { request: async () => [] }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-a',
    file: { path: 'clean.java' },
    workspaceRoot: '/workspace-a/',
    dirty: false,
    externalChanged: false,
  }, {
    agentId: 'agent-b',
    file: { path: 'dirty.java' },
    workspaceRoot: '/workspace-b',
    dirty: true,
    externalChanged: false,
  }])
  let semanticRefreshes = 0
  let inlayRefreshes = 0
  harness.semanticTokensProvider?.onDidChange(() => { semanticRefreshes += 1 })
  harness.inlayHintsProvider?.onDidChangeInlayHints(() => { inlayRefreshes += 1 })

  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-1', rootId: 'agent-a', workspace: '/workspace-a', kind: 'semanticTokens', revision: 1,
  }), true)
  assert.equal(semanticRefreshes, 1)
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-1', rootId: 'agent-a', workspace: '/workspace-a', kind: 'semanticTokens', revision: 1,
  }), false, 'a duplicate revision must not refresh providers again')
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-1', rootId: 'agent-a', workspace: '/workspace-a', kind: 'semanticTokens', revision: 0,
  }), false, 'an older revision must not refresh providers')
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-1', rootId: 'agent-b', workspace: '/workspace-b', kind: 'inlayHints', revision: 1,
  }), false, 'a dirty model must not consume saved-file semantic results')
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-1', rootId: 'agent-c', workspace: '/workspace-c', kind: 'inlayHints', revision: 1,
  }), false, 'an unrelated Project must not refresh providers')
  assert.equal(inlayRefreshes, 0)
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-2', rootId: 'agent-a', workspace: '/workspace-a', kind: 'semanticTokens', revision: 1,
  }), true, 'a backend restart begins a new revision epoch')
  assert.equal(semanticRefreshes, 2)
})

test('a cold-start Inlay Hints timeout stays refreshable after the Language Server becomes ready', async () => {
  let requestCount = 0
  const harness: ProviderHarness = {
    request: async () => {
      requestCount += 1
      if (requestCount === 1) {
        throw new harness.languageServerError!(
          'jdtls request timed out',
          504,
          'LANGUAGE_SERVER_REQUEST_TIMEOUT',
        )
      }
      return [{
        position: { line: 0, character: 10 },
        label: 'defaultValue:',
        kind: 2,
      }]
    },
  }
  const providers = await loadMonacoProviders(harness)
  providers.bindLanguageServerModels([{
    agentId: 'agent-java',
    file: { path: 'ColdStart.java' },
    workspaceRoot: '/workspace-java',
    dirty: false,
    externalChanged: false,
  }])
  const model = {
    uri: { toString: () => 'ColdStart.java' },
    isDisposed: () => false,
    getVersionId: () => 1,
  }
  const range = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 20,
  }
  const token = controllableCancellationToken().token

  const initial = await harness.inlayHintsProvider?.provideInlayHints(model, range, token)
  assert.deepEqual(initial?.hints, [], 'a transient startup timeout must not reject Monaco\'s provider')

  let refreshes = 0
  harness.inlayHintsProvider?.onDidChangeInlayHints(() => { refreshes += 1 })
  assert.equal(providers.refreshLanguageServerProviders({
    serverEpoch: 'server-java',
    rootId: 'agent-java',
    workspace: '/workspace-java',
    kind: 'inlayHints',
    revision: 1,
  }), true)
  assert.equal(refreshes, 1)

  const ready = await harness.inlayHintsProvider?.provideInlayHints(model, range, token)
  assert.equal(ready?.hints.length, 1)
  assert.deepEqual(ready?.hints[0], {
    position: { lineNumber: 1, column: 11 },
    label: 'defaultValue:',
    kind: 2,
    tooltip: undefined,
    paddingLeft: undefined,
    paddingRight: undefined,
  })
})

test('a refresh snapshot received before its Project model is bound is consumed after binding', async () => {
  const harness: ProviderHarness = { request: async () => [] }
  const providers = await loadMonacoProviders(harness)
  const unrelated = {
    agentId: 'agent-other',
    file: { path: 'Other.java' },
    workspaceRoot: '/workspace-other',
    dirty: false,
    externalChanged: false,
  }
  providers.bindLanguageServerModels([unrelated])
  let inlayRefreshes = 0
  harness.inlayHintsProvider?.onDidChangeInlayHints(() => { inlayRefreshes += 1 })
  const snapshot = {
    serverEpoch: 'server-reconnect',
    rootId: 'agent-java',
    workspace: '/workspace-java',
    kind: 'inlayHints' as const,
    revision: 3,
  }

  assert.equal(providers.refreshLanguageServerProviders(snapshot), false)
  assert.equal(inlayRefreshes, 0, 'an unbound Project must not request saved-file hints yet')

  providers.bindLanguageServerModels([unrelated, {
    agentId: 'agent-java',
    file: { path: 'Ready.java' },
    workspaceRoot: '/workspace-java/',
    dirty: false,
    externalChanged: false,
  }])
  assert.equal(inlayRefreshes, 1)
  assert.equal(
    providers.refreshLanguageServerProviders(snapshot),
    false,
    'binding the Project must consume the pending revision so a replay stays idempotent',
  )
})
