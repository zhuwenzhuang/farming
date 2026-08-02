import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { build, type Plugin } from 'esbuild'
import { TargetBindingRegistry } from '../extensions/language-server/frontend/target-binding-registry'

interface ProviderHarness {
  definitionProvider?: {
    provideDefinition(model: unknown, position: unknown): Promise<unknown>
  }
  editorOpener?: {
    openCodeEditor(source: unknown, resource: unknown, selection: unknown): boolean
  }
  request: () => Promise<unknown>
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
          return { contents: `export class LanguageServerError extends Error {}
            export function requestLanguageServer() {
              return globalThis.__farmingLanguageServerHarness.request()
            }` }
        }
        return { contents: `
          const harness = globalThis.__farmingLanguageServerHarness
          const disposable = { dispose() {} }
          export class Range {}
          export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2, Hint: 1 }
          export const editor = {
            onWillDisposeModel() { return disposable },
            registerEditorOpener(value) { harness.editorOpener = value; return disposable },
            getModel() { return null },
            setModelMarkers() {},
          }
          export const languages = {
            registerHoverProvider() { return disposable },
            registerDefinitionProvider(_selector, value) { harness.definitionProvider = value; return disposable },
            registerReferenceProvider() { return disposable },
            registerImplementationProvider() { return disposable },
            registerDocumentSymbolProvider() { return disposable },
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
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
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
