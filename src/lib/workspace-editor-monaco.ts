import * as monaco from 'monaco-editor'
import {
  codeEditorFontSize,
  codeEditorLineHeight,
  readCodeContentFontSize,
} from '@/lib/content-font-size'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { APPEARANCE_THEMES, RESOLVED_APPEARANCES, appearanceTheme } from '../../shared/appearance-themes'
import {
  isWorkspaceEditorModelUri,
  languageForWorkspaceFile,
  shouldDisposeWorkspaceEditorModelUri,
  shouldKeepWorkspaceEditorViewState,
  workspaceEditorLanguageLabel as languageLabelForWorkspaceEditor,
  workspaceEditorLiveModelKeys,
  workspaceEditorLiveModelUriStrings,
  workspaceEditorModelUriParts,
  type WorkspaceEditorLanguageMetadata,
} from './workspace-editor-model'
import type { OpenWorkspaceFile } from './workspace-open-files'

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
  }
}

const NARROW_EDITOR_MEDIA = '(max-width: 980px)'
const WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS = [
  'typescript',
  'javascript',
  'json',
  'css',
  'html',
  'markdown',
  'python',
  'shell',
  'java',
  'cpp',
  'csharp',
  'go',
  'rust',
  'sql',
  'yaml',
] as const
const WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS = {
  noSemanticValidation: true,
  noSyntaxValidation: false,
  noSuggestionDiagnostics: true,
} as const
const WORKSPACE_EDITOR_CONTEXT_MENU_IGNORE_SELECTOR = [
  '.code-editor-context-menu',
  '.code-file-tab-context-menu',
  '.code-file-blame-detail',
  '.code-file-inline-blame',
  '.code-file-line-changes-panel',
  '.code-language-server-panel',
].join(', ')

let monacoEnvironmentConfigured = false
let monacoLanguageMetadata: WorkspaceEditorLanguageMetadata[] | null = null
let codexMonacoThemesDefined = false
const scheduledEditorLayouts = new WeakMap<object, { frame: number; timeout: number }>()
let workspaceEditorPreloadPromise: Promise<void> | null = null

export function configureWorkspaceEditorMonacoEnvironment() {
  if (monacoEnvironmentConfigured) return
  monacoEnvironmentConfigured = true
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions(WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS)
  monaco.typescript.javascriptDefaults.setDiagnosticsOptions(WORKSPACE_EDITOR_SYNTAX_ONLY_DIAGNOSTICS)
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new JsonWorker()
      if (label === 'css' || label === 'scss' || label === 'less') return new CssWorker()
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new HtmlWorker()
      if (label === 'typescript' || label === 'javascript') return new TsWorker()
      return new EditorWorker()
    },
  }
}

export function preloadWorkspaceEditorMonaco() {
  configureWorkspaceEditorMonacoEnvironment()
  if (!workspaceEditorPreloadPromise) {
    workspaceEditorPreloadPromise = Promise.allSettled(
      WORKSPACE_EDITOR_PRELOAD_LANGUAGE_IDS.map(languageId => (
        monaco.editor.colorize('', languageId, { tabSize: 2 })
      )),
    ).then(() => undefined)
  }
  return workspaceEditorPreloadPromise
}

function defineCodexMonacoThemes() {
  if (codexMonacoThemesDefined) return
  codexMonacoThemesDefined = true
  for (const appearance of RESOLVED_APPEARANCES) {
    const { monaco: theme } = APPEARANCE_THEMES[appearance]
    const rules: monaco.editor.ITokenThemeRule[] = [
      ...['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'record']
        .map(token => ({ token, foreground: theme.semantic.type })),
      ...['function', 'method'].map(token => ({ token, foreground: theme.semantic.function })),
      ...['parameter', 'property', 'annotationMember', 'recordComponent']
        .map(token => ({ token, foreground: theme.semantic.variable })),
      { token: 'enumMember', foreground: theme.semantic.enumMember },
    ]
    monaco.editor.defineTheme(theme.id, {
      base: theme.base as monaco.editor.BuiltinTheme,
      inherit: true,
      rules,
      colors: theme.colors,
    })
  }
}

export function workspaceEditorMonacoThemeForAppearance() {
  return appearanceTheme(typeof document === 'undefined' ? 'light' : document.body.dataset.appearance).monaco.id
}

export function applyWorkspaceEditorMonacoTheme(editor?: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null) {
  defineCodexMonacoThemes()
  const theme = workspaceEditorMonacoThemeForAppearance()
  monaco.editor.setTheme(theme)
  editor?.updateOptions({ theme })
  if (editor && typeof window !== 'undefined') {
    cancelWorkspaceEditorScheduledLayout(editor)
    const frame = window.requestAnimationFrame(() => editor.layout())
    const timeout = window.setTimeout(() => {
      scheduledEditorLayouts.delete(editor)
      editor.layout()
    }, 80)
    scheduledEditorLayouts.set(editor, { frame, timeout })
  }
}

export function cancelWorkspaceEditorScheduledLayout(editor: object) {
  const scheduled = scheduledEditorLayouts.get(editor)
  if (!scheduled || typeof window === 'undefined') return
  window.cancelAnimationFrame(scheduled.frame)
  window.clearTimeout(scheduled.timeout)
  scheduledEditorLayouts.delete(editor)
}

export function isNarrowWorkspaceEditorViewport() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(NARROW_EDITOR_MEDIA).matches
}

export function workspaceEditorViewportMedia() {
  return window.matchMedia(NARROW_EDITOR_MEDIA)
}

export interface WorkspaceEditorCreateOptions {
  value: string
  language: string
  ariaLabel: string
  wordWrapEnabled?: boolean
}

function workspaceEditorWordWrapValue(wordWrapEnabled?: boolean) {
  return wordWrapEnabled === true || isNarrowWorkspaceEditorViewport() ? 'on' : 'off'
}

export function workspaceEditorFontOptions(): Pick<
  monaco.editor.IStandaloneEditorConstructionOptions,
  'fontSize' | 'lineHeight'
> {
  const contentFontSize = readCodeContentFontSize()
  return {
    fontSize: codeEditorFontSize(contentFontSize),
    lineHeight: codeEditorLineHeight(contentFontSize),
  }
}

export function updateWorkspaceEditorContentFontSize(
  editor: monaco.editor.ICodeEditor | monaco.editor.IStandaloneDiffEditor,
) {
  editor.updateOptions(workspaceEditorFontOptions())
  editor.layout()
}

export function workspaceEditorCreateOptions({
  value,
  language,
  ariaLabel,
  wordWrapEnabled,
}: WorkspaceEditorCreateOptions): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    value,
    language,
    theme: workspaceEditorMonacoThemeForAppearance(),
    automaticLayout: false,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    ...workspaceEditorFontOptions(),
    tabSize: 2,
    insertSpaces: true,
    wordWrap: workspaceEditorWordWrapValue(wordWrapEnabled),
    wrappingIndent: 'same',
    renderLineHighlight: 'line',
    overviewRulerBorder: false,
    fixedOverflowWidgets: true,
    editContext: false,
    contextmenu: false,
    occurrencesHighlight: 'singleFile',
    occurrencesHighlightDelay: 150,
    'semanticHighlighting.enabled': true,
    inlayHints: {
      enabled: 'on',
      padding: true,
      maximumLength: 80,
    },
    unicodeHighlight: {
      ambiguousCharacters: false,
      invisibleCharacters: true,
      nonBasicASCII: false,
    },
    glyphMargin: true,
    lineNumbersMinChars: 4,
    ariaLabel,
  }
}

export function updateWorkspaceEditorResponsiveOptions(editor: monaco.editor.IStandaloneCodeEditor, wordWrapEnabled?: boolean) {
  editor.updateOptions({
    wordWrap: workspaceEditorWordWrapValue(wordWrapEnabled),
    wrappingIndent: 'same',
  })
  editor.layout()
}

interface WorkspaceEditorCommandHandlers {
  getAgentId: () => string
  onFocusFilesSearch: (agentId: string) => void
  onSaveShortcut: () => void
}

function focusWorkspaceEditorFilesSearch(agentId: string, onFocusFilesSearch: (agentId: string) => void) {
  onFocusFilesSearch(agentId)
  window.requestAnimationFrame(() => onFocusFilesSearch(agentId))
  window.setTimeout(() => onFocusFilesSearch(agentId), 120)
}

export function registerWorkspaceEditorCommands(
  editor: monaco.editor.IStandaloneCodeEditor,
  handlers: WorkspaceEditorCommandHandlers,
) {
  const focusFilesSearch = () => {
    focusWorkspaceEditorFilesSearch(handlers.getAgentId(), handlers.onFocusFilesSearch)
  }

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, focusFilesSearch)
  editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyP, focusFilesSearch)
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, handlers.onSaveShortcut)
  editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyS, handlers.onSaveShortcut)
}

export function nativeWorkspaceEditorContextMenuEvent(
  editor: monaco.editor.IStandaloneCodeEditor,
  event: MouseEvent,
): monaco.editor.IEditorMouseEvent | null {
  const target = event.target
  if (target instanceof Element && target.closest(WORKSPACE_EDITOR_CONTEXT_MENU_IGNORE_SELECTOR)) return null

  const editorTarget = editor.getTargetAtClientPoint(event.clientX, event.clientY)
  if (!editorTarget) return null

  return {
    target: editorTarget,
    event: {
      browserEvent: event,
      leftButton: false,
      middleButton: false,
      rightButton: true,
      target: event.target,
      detail: event.detail,
      posx: event.clientX,
      posy: event.clientY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      timestamp: event.timeStamp,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    },
  } as monaco.editor.IEditorMouseEvent
}

function getMonacoLanguageMetadata() {
  if (!monacoLanguageMetadata) monacoLanguageMetadata = monaco.languages.getLanguages()
  return monacoLanguageMetadata
}

export function workspaceEditorLanguageForPath(filePath: string, content?: string) {
  return languageForWorkspaceFile(filePath, content, getMonacoLanguageMetadata())
}

export function workspaceEditorLanguageLabel(languageId: string) {
  return languageLabelForWorkspaceEditor(languageId, getMonacoLanguageMetadata())
}

export function workspaceEditorModelUriForFile(file: Pick<OpenWorkspaceFile, 'agentId' | 'file' | 'workspaceRoot'>) {
  return monaco.Uri.from(workspaceEditorModelUriParts(file))
}

export function workspaceEditorModelForOpenFile(file: OpenWorkspaceFile) {
  const uri = workspaceEditorModelUriForFile(file)
  const existingModel = monaco.editor.getModel(uri)
  const languageId = workspaceEditorLanguageForPath(file.file.path, file.draft)
  const model = existingModel || monaco.editor.createModel(file.draft, languageId, uri)
  if (existingModel && model.getLanguageId() !== languageId) {
    monaco.editor.setModelLanguage(model, languageId)
  }
  return model
}

export function pruneWorkspaceEditorModelState(
  liveFiles: readonly OpenWorkspaceFile[],
  editorViewStates: Map<string, monaco.editor.ICodeEditorViewState | null>,
) {
  const openModelKeys = workspaceEditorLiveModelKeys(liveFiles)
  editorViewStates.forEach((_viewState, key) => {
    if (!shouldKeepWorkspaceEditorViewState(key, openModelKeys)) editorViewStates.delete(key)
  })

  const openModelUris = workspaceEditorLiveModelUriStrings(liveFiles, file => workspaceEditorModelUriForFile(file).toString())
  monaco.editor.getModels().forEach(model => {
    if (shouldDisposeWorkspaceEditorModelUri(model.uri, openModelUris)) {
      model.dispose()
    }
  })
}

export function disposeWorkspaceEditorModels() {
  monaco.editor.getModels().forEach(model => {
    if (isWorkspaceEditorModelUri(model.uri)) model.dispose()
  })
}
