import * as monaco from 'monaco-editor'
import { workspaceEditorModelUriForFile } from '@/lib/workspace-editor-monaco'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import { requestLanguageServer } from './client'
import type {
  LanguageServerDiagnostic,
  LanguageServerLocation,
  LanguageServerRange,
  LanguageServerSymbol,
} from './types'

interface ModelBinding {
  rootId: string
  filePath: string
  workspaceRoot?: string
  dirty: boolean
}

const bindings = new Map<string, ModelBinding>()
const targetBindings = new Map<string, ModelBinding>()
let providerDisposables: monaco.IDisposable[] | null = null
let editorOpener: ((binding: ModelBinding, selection?: monaco.IRange | monaco.IPosition) => Promise<void> | void) | null = null

function rangeValue(value: LanguageServerRange | null | undefined): monaco.Range {
  if (!value) return new monaco.Range(1, 1, 1, 1)
  return new monaco.Range(
    value.start.line + 1,
    value.start.character + 1,
    value.end.line + 1,
    value.end.character + 1,
  )
}

function bindingForModel(model: monaco.editor.ITextModel) {
  const binding = bindings.get(model.uri.toString())
  return binding && !binding.dirty ? binding : null
}

function targetUri(binding: ModelBinding, filePath: string) {
  const uri = workspaceEditorModelUriForFile({
    agentId: binding.rootId,
    workspaceRoot: binding.workspaceRoot,
    file: { path: filePath },
  } as Pick<OpenWorkspaceFile, 'agentId' | 'file' | 'workspaceRoot'>)
  targetBindings.set(uri.toString(), { ...binding, filePath })
  return uri
}

function locations(binding: ModelBinding, values: LanguageServerLocation[] | null | undefined): monaco.languages.Location[] {
  return (values || []).map(value => ({
    uri: targetUri(binding, value.path),
    range: rangeValue(value.selectionRange || value.range),
  }))
}

function documentSymbol(value: LanguageServerSymbol): monaco.languages.DocumentSymbol {
  return {
    name: value.name,
    detail: value.detail || '',
    kind: value.kind as monaco.languages.SymbolKind,
    tags: [],
    range: rangeValue(value.range),
    selectionRange: rangeValue(value.selectionRange || value.range),
    children: (value.children || []).map(documentSymbol),
  }
}

function positionValue(position: monaco.Position) {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

function requestAtPosition<T>(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  method: 'hover' | 'definition' | 'references' | 'implementation',
) {
  const binding = bindingForModel(model)
  if (!binding) return null
  return requestLanguageServer<T>({
    rootId: binding.rootId,
    filePath: binding.filePath,
    method,
    position: positionValue(position),
  })
}

function registerProviders() {
  if (providerDisposables) return
  providerDisposables = [
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const binding = targetBindings.get(resource.toString()) || bindings.get(resource.toString())
        if (!binding || !editorOpener) return false
        void editorOpener(binding, selectionOrPosition)
        return true
      },
    }),
    monaco.languages.registerHoverProvider('*', {
      async provideHover(model, position) {
        const values = await requestAtPosition<Array<{ contents: string[]; range?: LanguageServerRange }>>(model, position, 'hover')
        const hover = values?.[0]
        if (!hover) return null
        return {
          contents: hover.contents.map(value => ({ value })),
          ...(hover.range ? { range: rangeValue(hover.range) } : {}),
        }
      },
    }),
    monaco.languages.registerDefinitionProvider('*', {
      async provideDefinition(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'definition'))
      },
    }),
    monaco.languages.registerReferenceProvider('*', {
      async provideReferences(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'references'))
      },
    }),
    monaco.languages.registerImplementationProvider('*', {
      async provideImplementation(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'implementation'))
      },
    }),
    monaco.languages.registerDocumentSymbolProvider('*', {
      async provideDocumentSymbols(model) {
        const binding = bindingForModel(model)
        if (!binding) return []
        const values = await requestLanguageServer<LanguageServerSymbol[]>({
          rootId: binding.rootId,
          filePath: binding.filePath,
          method: 'documentSymbols',
        })
        return (values || []).map(documentSymbol)
      },
    }),
  ]
}

export function setLanguageServerEditorOpener(
  opener: ((binding: ModelBinding, selection?: monaco.IRange | monaco.IPosition) => Promise<void> | void) | null,
) {
  editorOpener = opener
}

export function bindLanguageServerModels(files: readonly OpenWorkspaceFile[]) {
  registerProviders()
  const live = new Set<string>()
  files.forEach(file => {
    const key = workspaceEditorModelUriForFile(file).toString()
    live.add(key)
    bindings.set(key, {
      rootId: file.agentId,
      filePath: file.file.path,
      workspaceRoot: file.workspaceRoot,
      dirty: file.dirty || file.externalChanged,
    })
  })
  for (const key of bindings.keys()) {
    if (!live.has(key)) bindings.delete(key)
  }
}

export async function refreshLanguageServerDiagnostics(file: OpenWorkspaceFile) {
  const model = monaco.editor.getModel(workspaceEditorModelUriForFile(file))
  if (!model || file.dirty || file.externalChanged) {
    if (model) monaco.editor.setModelMarkers(model, 'vscode-bridge', [])
    return
  }
  const values = await requestLanguageServer<LanguageServerDiagnostic[]>({
    rootId: file.agentId,
    filePath: file.file.path,
    method: 'diagnostics',
  })
  const severity = [
    monaco.MarkerSeverity.Error,
    monaco.MarkerSeverity.Warning,
    monaco.MarkerSeverity.Info,
    monaco.MarkerSeverity.Hint,
  ]
  monaco.editor.setModelMarkers(model, 'vscode-bridge', (values || []).map(diagnostic => ({
    ...rangeValue(diagnostic.range),
    message: diagnostic.message,
    severity: severity[diagnostic.severity] || monaco.MarkerSeverity.Info,
    source: diagnostic.source || 'VS Code',
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
  })))
}
