import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import {
  isWorkspaceEditorModelUri,
  languageForWorkspaceFile,
  shouldDisposeWorkspaceEditorModelUri,
  shouldKeepWorkspaceEditorViewState,
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
const CODEX_LIGHT_MONACO_THEME = 'farming-code-light'
const CODEX_DARK_MONACO_THEME = 'farming-code-dark'
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
].join(', ')

let monacoEnvironmentConfigured = false
let monacoLanguageMetadata: WorkspaceEditorLanguageMetadata[] | null = null
let codexMonacoThemesDefined = false
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
  monaco.editor.defineTheme(CODEX_LIGHT_MONACO_THEME, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#24292f',
      'editorLineNumber.foreground': '#8c959f',
      'editorLineNumber.activeForeground': '#24292f',
      'editor.lineHighlightBackground': '#f6f8fa',
      'editor.selectionBackground': '#b6d7ff',
      'editor.inactiveSelectionBackground': '#dbeafe',
      'editorCursor.foreground': '#24292f',
      'editorWhitespace.foreground': '#d0d7de',
      'editorIndentGuide.background1': '#d8dee4',
      'editorIndentGuide.activeBackground1': '#8c959f',
      'editorGutter.background': '#ffffff',
    },
  })
  monaco.editor.defineTheme(CODEX_DARK_MONACO_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#e6edf3',
      'editorLineNumber.foreground': '#6e7681',
      'editorLineNumber.activeForeground': '#c9d1d9',
      'editor.lineHighlightBackground': '#161b22',
      'editor.selectionBackground': '#264f78',
      'editor.inactiveSelectionBackground': '#1f3a55',
      'editorCursor.foreground': '#e6edf3',
      'editorWhitespace.foreground': '#30363d',
      'editorIndentGuide.background1': '#21262d',
      'editorIndentGuide.activeBackground1': '#3b4655',
      'editorGutter.background': '#0d1117',
    },
  })
}

export function workspaceEditorMonacoThemeForAppearance() {
  return typeof document !== 'undefined' && document.body.dataset.appearance === 'dark'
    ? CODEX_DARK_MONACO_THEME
    : CODEX_LIGHT_MONACO_THEME
}

export function applyWorkspaceEditorMonacoTheme(editor?: monaco.editor.IStandaloneCodeEditor | monaco.editor.IStandaloneDiffEditor | null) {
  defineCodexMonacoThemes()
  const theme = workspaceEditorMonacoThemeForAppearance()
  monaco.editor.setTheme(theme)
  editor?.updateOptions({ theme })
  if (editor && typeof window !== 'undefined') {
    window.requestAnimationFrame(() => editor.layout())
    window.setTimeout(() => editor.layout(), 80)
  }
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
    fontSize: 13,
    lineHeight: 21,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: workspaceEditorWordWrapValue(wordWrapEnabled),
    wrappingIndent: 'same',
    renderLineHighlight: 'line',
    overviewRulerBorder: false,
    fixedOverflowWidgets: true,
    editContext: false,
    contextmenu: false,
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
