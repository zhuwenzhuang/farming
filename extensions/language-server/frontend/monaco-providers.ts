import * as monaco from 'monaco-editor'
import { workspaceEditorModelUriForFile } from '@/lib/workspace-editor-monaco'
import type { OpenWorkspaceFile } from '@/lib/workspace-open-files'
import type { LanguageServerRefreshMessage } from '@/types/messages'
import { LanguageServerError, requestLanguageServer } from './client'
import { TargetBindingRegistry } from './target-binding-registry'
import type {
  LanguageServerDiagnostic,
  LanguageServerDocumentHighlight,
  LanguageServerInlayHint,
  LanguageServerLocation,
  LanguageServerRange,
  LanguageServerSemanticTokens,
  LanguageServerSymbol,
} from './types'

interface ModelBinding {
  rootId: string
  filePath: string
  workspaceRoot?: string
  dirty: boolean
}

const bindings = new Map<string, ModelBinding>()
const targetBindings = new TargetBindingRegistry<ModelBinding>()
const diagnosticRequestGenerations = new Map<string, number>()
const documentHighlightsChanged = new monaco.Emitter<void>()
const semanticTokensChanged = new monaco.Emitter<void>()
const inlayHintsChanged = new monaco.Emitter<void>()
const languageServerRefreshRevisions = new Map<string, number>()
const languageServerPendingRefreshes = new Map<string, ProviderRefreshEvent>()
const semanticTokenTypes = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
  'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp',
  'operator', 'decorator', 'annotationMember', 'record', 'recordComponent',
]
const semanticTokenModifiers = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
]
const semanticTokensLegend: monaco.languages.SemanticTokensLegend = {
  tokenTypes: semanticTokenTypes,
  tokenModifiers: semanticTokenModifiers,
}
const HOVER_REQUEST_BUDGET_MS = 500
let providerDisposables: monaco.IDisposable[] | null = null
let editorOpener: ((binding: ModelBinding, selection?: monaco.IRange | monaco.IPosition) => Promise<void> | void) | null = null
let languageServerRefreshEpoch = ''

type ProviderRefreshEvent = Pick<
  LanguageServerRefreshMessage,
  'serverEpoch' | 'rootId' | 'workspace' | 'kind' | 'revision'
>

function normalizedWorkspace(value: string | undefined) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function providerRefreshKey(event: ProviderRefreshEvent) {
  return `${event.rootId}\0${normalizedWorkspace(event.workspace)}\0${event.kind}`
}

function hasCleanModelForRefresh(event: ProviderRefreshEvent) {
  const workspace = normalizedWorkspace(event.workspace)
  return [...bindings.values()].some(binding => (
    !binding.dirty
    && binding.rootId === event.rootId
    && normalizedWorkspace(binding.workspaceRoot) === workspace
  ))
}

function fireProviderRefresh(kind: ProviderRefreshEvent['kind']) {
  if (kind === 'semanticTokens') semanticTokensChanged.fire()
  else inlayHintsChanged.fire()
}

function consumePendingProviderRefreshes() {
  const kinds = new Set<ProviderRefreshEvent['kind']>()
  for (const [key, event] of languageServerPendingRefreshes) {
    if (!hasCleanModelForRefresh(event)) continue
    languageServerPendingRefreshes.delete(key)
    if ((languageServerRefreshRevisions.get(key) || 0) >= event.revision) continue
    languageServerRefreshRevisions.set(key, event.revision)
    kinds.add(event.kind)
  }
  return kinds
}

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

function targetUri(sourceModel: monaco.editor.ITextModel, binding: ModelBinding, filePath: string) {
  const uri = workspaceEditorModelUriForFile({
    agentId: binding.rootId,
    workspaceRoot: binding.workspaceRoot,
    file: { path: filePath },
  } as Pick<OpenWorkspaceFile, 'agentId' | 'file' | 'workspaceRoot'>)
  targetBindings.set(sourceModel.uri.toString(), uri.toString(), { ...binding, filePath })
  return uri
}

function locations(
  sourceModel: monaco.editor.ITextModel,
  binding: ModelBinding,
  values: LanguageServerLocation[] | null | undefined,
): monaco.languages.Location[] {
  if (sourceModel.isDisposed()) return []
  return (values || []).map(value => ({
    uri: targetUri(sourceModel, binding, value.path),
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

function requestRangeValue(range: monaco.Range): LanguageServerRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  }
}

function isLanguageServerUnavailable(error: unknown): boolean {
  return error instanceof LanguageServerError && error.unavailable
}

function isLanguageServerFeatureUnavailable(error: unknown): boolean {
  return isLanguageServerUnavailable(error)
    || (error instanceof LanguageServerError && error.code === 'LANGUAGE_SERVER_METHOD_UNSUPPORTED')
}

function isLanguageServerProviderNotReady(error: unknown): boolean {
  return isLanguageServerFeatureUnavailable(error)
    || (error instanceof LanguageServerError && error.code === 'LANGUAGE_SERVER_REQUEST_TIMEOUT')
}

function modelRequestIsCurrent(model: monaco.editor.ITextModel, key: string, version: number) {
  const binding = bindings.get(key)
  return !model.isDisposed()
    && model.getVersionId() === version
    && Boolean(binding && !binding.dirty)
}

function remapSemanticTokens(value: LanguageServerSemanticTokens | null | undefined): Uint32Array {
  const data = value?.data
  if (!Array.isArray(data) || data.length % 5 !== 0) return new Uint32Array()
  const sourceTypes = value?.legend?.tokenTypes || []
  const sourceModifiers = value?.legend?.tokenModifiers || []
  const fallbackType = semanticTokenTypes.indexOf('variable')
  const result = new Uint32Array(data.length)
  for (let index = 0; index < data.length; index += 5) {
    result[index] = Number(data[index]) >>> 0
    result[index + 1] = Number(data[index + 1]) >>> 0
    result[index + 2] = Number(data[index + 2]) >>> 0
    const sourceType = sourceTypes[Number(data[index + 3])]
    const targetType = typeof sourceType === 'string' ? semanticTokenTypes.indexOf(sourceType) : -1
    result[index + 3] = targetType >= 0 ? targetType : fallbackType
    const sourceBits = Number(data[index + 4]) >>> 0
    let targetBits = 0
    for (let modifierIndex = 0; modifierIndex < Math.min(sourceModifiers.length, 32); modifierIndex += 1) {
      if ((sourceBits & (1 << modifierIndex)) === 0) continue
      const sourceModifier = sourceModifiers[modifierIndex]
      const targetModifier = typeof sourceModifier === 'string'
        ? semanticTokenModifiers.indexOf(sourceModifier)
        : -1
      if (targetModifier >= 0) targetBits = (targetBits | (1 << targetModifier)) >>> 0
    }
    result[index + 4] = targetBits
  }
  return result
}

function markdownTooltip(value: LanguageServerInlayHint['tooltip'] | undefined): string | monaco.IMarkdownString | undefined {
  if (typeof value === 'string') return value
  return typeof value?.value === 'string' ? { value: value.value } : undefined
}

function inlayHint(value: LanguageServerInlayHint): monaco.languages.InlayHint {
  return {
    position: {
      lineNumber: value.position.line + 1,
      column: value.position.character + 1,
    },
    label: typeof value.label === 'string'
      ? value.label
      : value.label.map(part => ({
          label: part.value,
          tooltip: markdownTooltip(part.tooltip),
        })),
    ...(value.kind === 1 || value.kind === 2 ? { kind: value.kind as monaco.languages.InlayHintKind } : {}),
    tooltip: markdownTooltip(value.tooltip),
    paddingLeft: value.paddingLeft,
    paddingRight: value.paddingRight,
  }
}

function documentHighlightDecoration(value: LanguageServerDocumentHighlight): monaco.editor.IModelDeltaDecoration {
  const className = value.kind === 3
    ? 'wordHighlightStrong'
    : value.kind === 2 ? 'wordHighlight' : 'wordHighlightText'
  return {
    range: rangeValue(value.range),
    options: {
      className,
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }
}

function invalidateDiagnostics(model: monaco.editor.ITextModel) {
  const key = model.uri.toString()
  diagnosticRequestGenerations.set(key, (diagnosticRequestGenerations.get(key) || 0) + 1)
  monaco.editor.setModelMarkers(model, 'farming-language-server', [])
}

function requestAtPosition<T>(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  method: 'hover' | 'definition' | 'references' | 'implementation',
  signal?: AbortSignal,
) {
  const binding = bindingForModel(model)
  if (!binding) return null
  return requestLanguageServer<T>({
    rootId: binding.rootId,
    filePath: binding.filePath,
    method,
    position: positionValue(position),
  }, { signal }).catch((error: unknown) => {
    if (isLanguageServerUnavailable(error)) return null
    throw error
  })
}

function registerProviders() {
  if (providerDisposables) return
  providerDisposables = [
    monaco.editor.onWillDisposeModel(model => {
      const key = model.uri.toString()
      bindings.delete(key)
      targetBindings.deleteSource(key)
      diagnosticRequestGenerations.delete(key)
    }),
    monaco.editor.registerEditorOpener({
      openCodeEditor(_source, resource, selectionOrPosition) {
        const binding = targetBindings.get(resource.toString()) || bindings.get(resource.toString())
        if (!binding || !editorOpener) return false
        void editorOpener(binding, selectionOrPosition)
        return true
      },
    }),
    monaco.languages.registerHoverProvider('*', {
      async provideHover(model, position, token) {
        if (token.isCancellationRequested) return null
        const controller = new AbortController()
        const cancellation = token.onCancellationRequested(() => controller.abort())
        const timeoutId = globalThis.setTimeout(() => controller.abort(), HOVER_REQUEST_BUDGET_MS)
        try {
          const values = await requestAtPosition<Array<{ contents: string[]; range?: LanguageServerRange }>>(
            model,
            position,
            'hover',
            controller.signal,
          )
          if (controller.signal.aborted || token.isCancellationRequested) return null
          const hover = values?.[0]
          if (!hover?.contents.length) return null
          return {
            contents: hover.contents.map(value => ({ value })),
            ...(hover.range ? { range: rangeValue(hover.range) } : {}),
          }
        } catch {
          return null
        } finally {
          globalThis.clearTimeout(timeoutId)
          cancellation.dispose()
        }
      },
    }),
    monaco.languages.registerDefinitionProvider('*', {
      async provideDefinition(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(model, binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'definition'))
      },
    }),
    monaco.languages.registerReferenceProvider('*', {
      async provideReferences(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(model, binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'references'))
      },
    }),
    monaco.languages.registerImplementationProvider('*', {
      async provideImplementation(model, position) {
        const binding = bindingForModel(model)
        if (!binding) return null
        return locations(model, binding, await requestAtPosition<LanguageServerLocation[]>(model, position, 'implementation'))
      },
    }),
    monaco.languages.registerDocumentSemanticTokensProvider('*', {
      onDidChange: semanticTokensChanged.event,
      getLegend() {
        return semanticTokensLegend
      },
      async provideDocumentSemanticTokens(model, _lastResultId, token) {
        const binding = bindingForModel(model)
        if (!binding) return { data: new Uint32Array() }
        const key = model.uri.toString()
        const version = model.getVersionId()
        try {
          const value = await requestLanguageServer<LanguageServerSemanticTokens>({
            rootId: binding.rootId,
            filePath: binding.filePath,
            method: 'semanticTokens',
          })
          if (token.isCancellationRequested || !modelRequestIsCurrent(model, key, version)) {
            return { data: new Uint32Array() }
          }
          return {
            data: remapSemanticTokens(value),
            ...(value?.resultId ? { resultId: value.resultId } : {}),
          }
        } catch (error) {
          if (isLanguageServerFeatureUnavailable(error)) return { data: new Uint32Array() }
          throw error
        }
      },
      releaseDocumentSemanticTokens() {},
    }),
    monaco.languages.registerInlayHintsProvider('*', {
      displayName: 'Language Server',
      onDidChangeInlayHints: inlayHintsChanged.event,
      async provideInlayHints(model, range, token) {
        const binding = bindingForModel(model)
        if (!binding) return { hints: [], dispose() {} }
        const key = model.uri.toString()
        const version = model.getVersionId()
        try {
          const values = await requestLanguageServer<LanguageServerInlayHint[]>({
            rootId: binding.rootId,
            filePath: binding.filePath,
            method: 'inlayHints',
            range: requestRangeValue(range),
          })
          if (token.isCancellationRequested || !modelRequestIsCurrent(model, key, version)) {
            return { hints: [], dispose() {} }
          }
          return {
            hints: (values || []).map(inlayHint),
            dispose() {},
          }
        } catch (error) {
          if (isLanguageServerProviderNotReady(error)) return { hints: [], dispose() {} }
          throw error
        }
      },
    }),
    monaco.languages.registerDocumentSymbolProvider('*', {
      async provideDocumentSymbols(model) {
        const binding = bindingForModel(model)
        if (!binding) return []
        try {
          const values = await requestLanguageServer<LanguageServerSymbol[]>({
            rootId: binding.rootId,
            filePath: binding.filePath,
            method: 'documentSymbols',
          })
          return (values || []).map(documentSymbol)
        } catch (error) {
          if (isLanguageServerUnavailable(error)) return []
          throw error
        }
      },
    }),
  ]
}

export function setLanguageServerEditorOpener(
  opener: ((binding: ModelBinding, selection?: monaco.IRange | monaco.IPosition) => Promise<void> | void) | null,
) {
  editorOpener = opener
}

export function refreshLanguageServerProviders(
  event: ProviderRefreshEvent,
) {
  if (event.serverEpoch !== languageServerRefreshEpoch) {
    languageServerRefreshEpoch = event.serverEpoch
    languageServerRefreshRevisions.clear()
    languageServerPendingRefreshes.clear()
  }
  const normalizedEvent = { ...event, workspace: normalizedWorkspace(event.workspace) }
  const key = providerRefreshKey(normalizedEvent)
  const knownRevision = Math.max(
    languageServerRefreshRevisions.get(key) || 0,
    languageServerPendingRefreshes.get(key)?.revision || 0,
  )
  if (knownRevision >= event.revision) return false
  if (!hasCleanModelForRefresh(normalizedEvent)) {
    languageServerPendingRefreshes.set(key, normalizedEvent)
    return false
  }
  languageServerRefreshRevisions.set(key, event.revision)
  fireProviderRefresh(event.kind)
  return true
}

export function markLanguageServerModelDirty(model: monaco.editor.ITextModel) {
  const key = model.uri.toString()
  const binding = bindings.get(key)
  if (!binding || binding.dirty) return
  bindings.set(key, { ...binding, dirty: true })
  invalidateDiagnostics(model)
  documentHighlightsChanged.fire()
  semanticTokensChanged.fire()
  inlayHintsChanged.fire()
}

export function attachLanguageServerDocumentHighlights(editor: monaco.editor.IStandaloneCodeEditor): monaco.IDisposable {
  const decorations = editor.createDecorationsCollection()
  let requestGeneration = 0
  let scheduledRefresh: number | null = null

  const clear = () => {
    requestGeneration += 1
    decorations.clear()
  }
  const refresh = async () => {
    scheduledRefresh = null
    const model = editor.getModel()
    const position = editor.getPosition()
    const selection = editor.getSelection()
    const binding = model ? bindingForModel(model) : null
    if (!model || !position || !binding || !selection || !selection.isEmpty()) {
      clear()
      return
    }
    const key = model.uri.toString()
    const version = model.getVersionId()
    const generation = requestGeneration += 1
    try {
      const values = await requestLanguageServer<LanguageServerDocumentHighlight[]>({
        rootId: binding.rootId,
        filePath: binding.filePath,
        method: 'documentHighlights',
        position: positionValue(position),
      })
      if (
        requestGeneration !== generation
        || editor.getModel() !== model
        || !modelRequestIsCurrent(model, key, version)
      ) return
      decorations.set((values || []).map(documentHighlightDecoration))
    } catch {
      if (requestGeneration === generation) decorations.clear()
    }
  }
  const schedule = () => {
    if (scheduledRefresh !== null) window.clearTimeout(scheduledRefresh)
    scheduledRefresh = window.setTimeout(() => void refresh(), 150)
  }
  const disposables = [
    editor.onDidChangeCursorPosition(schedule),
    editor.onDidFocusEditorText(schedule),
    editor.onDidChangeModel(() => {
      clear()
      schedule()
    }),
    editor.onDidChangeModelContent(clear),
    documentHighlightsChanged.event(() => {
      clear()
      if (editor.hasTextFocus()) schedule()
    }),
  ]
  schedule()
  return {
    dispose() {
      if (scheduledRefresh !== null) window.clearTimeout(scheduledRefresh)
      clear()
      decorations.clear()
      disposables.forEach(disposable => disposable.dispose())
    },
  }
}

export function bindLanguageServerModels(files: readonly OpenWorkspaceFile[]) {
  registerProviders()
  const live = new Set<string>()
  let semanticStateChanged = false
  files.forEach(file => {
    const key = workspaceEditorModelUriForFile(file).toString()
    live.add(key)
    const binding = {
      rootId: file.agentId,
      filePath: file.file.path,
      workspaceRoot: file.workspaceRoot,
      dirty: file.dirty || file.externalChanged,
    }
    const previous = bindings.get(key)
    bindings.set(key, binding)
    if (
      !previous
      || previous.rootId !== binding.rootId
      || previous.filePath !== binding.filePath
      || previous.workspaceRoot !== binding.workspaceRoot
      || previous.dirty !== binding.dirty
    ) semanticStateChanged = true
    if (binding.dirty) {
      const model = monaco.editor.getModel(workspaceEditorModelUriForFile(file))
      if (model) invalidateDiagnostics(model)
    }
  })
  for (const key of bindings.keys()) {
    if (!live.has(key)) {
      bindings.delete(key)
      targetBindings.deleteSource(key)
      semanticStateChanged = true
    }
  }
  const pendingRefreshKinds = consumePendingProviderRefreshes()
  if (semanticStateChanged) {
    documentHighlightsChanged.fire()
    semanticTokensChanged.fire()
    inlayHintsChanged.fire()
  } else {
    pendingRefreshKinds.forEach(fireProviderRefresh)
  }
}

export async function refreshLanguageServerDiagnostics(file: OpenWorkspaceFile) {
  const model = monaco.editor.getModel(workspaceEditorModelUriForFile(file))
  if (!model || file.dirty || file.externalChanged) {
    if (model) invalidateDiagnostics(model)
    return
  }
  const key = model.uri.toString()
  const generation = (diagnosticRequestGenerations.get(key) || 0) + 1
  diagnosticRequestGenerations.set(key, generation)
  const modelVersion = model.getVersionId()
  const values = await requestLanguageServer<LanguageServerDiagnostic[]>({
    rootId: file.agentId,
    filePath: file.file.path,
    method: 'diagnostics',
  })
  const currentBinding = bindings.get(key)
  if (
    model.isDisposed()
    || diagnosticRequestGenerations.get(key) !== generation
    || !currentBinding
    || currentBinding.dirty
    || model.getVersionId() !== modelVersion
  ) return
  const severity = [
    monaco.MarkerSeverity.Error,
    monaco.MarkerSeverity.Warning,
    monaco.MarkerSeverity.Info,
    monaco.MarkerSeverity.Hint,
  ]
  monaco.editor.setModelMarkers(model, 'farming-language-server', (values || []).map(diagnostic => ({
    ...rangeValue(diagnostic.range),
    message: diagnostic.message,
    severity: severity[diagnostic.severity] || monaco.MarkerSeverity.Info,
    source: diagnostic.source || 'Language Server',
    code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
  })))
}
