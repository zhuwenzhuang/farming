import type { WorkspaceFile, WorkspaceFileLineChanges } from './workspace-files'
import {
  shouldShowWorkspaceWorkingCopyOverwriteAction,
  shouldShowWorkspaceWorkingCopyReloadAction,
  shouldShowWorkspaceWorkingCopySaveAction,
  workspaceWorkingCopyState,
  workspaceWorkingCopyKey,
  workspaceFileResourceKey,
  type WorkspaceWorkingCopyReference,
} from './workspace-working-copy'

export const WORKSPACE_EDITOR_MODEL_URI_SCHEME = 'farming-file'
export const DEFAULT_BLAME_LABEL_WIDTH = 112
export const COMPACT_BLAME_LABEL_WIDTH = 84
export const MAX_BLAME_LABEL_WIDTH = 240
export const MAX_COMPACT_BLAME_LABEL_WIDTH = 110

const FALLBACK_LANGUAGE_ASSOCIATIONS = new Map([
  ['.c++', 'cpp'],
  ['.inl', 'cpp'],
  ['.ipp', 'cpp'],
  ['.jsonl', 'json'],
  ['.odpsql', 'sql'],
  ['.osql', 'sql'],
  ['.zsh', 'shell'],
])

const MARKDOWN_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const SVG_FILE_EXTENSIONS = new Set(['.svg'])

export interface WorkspaceEditorFileReference {
  agentId: string
  workspaceRoot?: string
  file: Pick<WorkspaceFile, 'path' | 'sha1' | 'size' | 'mtimeMs'>
}

export interface WorkspaceEditorLanguageMetadata {
  id: string
  filenames?: string[]
  extensions?: string[]
  filenamePatterns?: string[]
  firstLine?: string
}

export interface WorkspaceEditorTabReference {
  file: Pick<WorkspaceFile, 'path'>
  dirty?: boolean
  externalChanged?: boolean
}

export interface WorkspaceEditorFileModeReference {
  file: Pick<WorkspaceFile, 'preview'>
  diffOnly?: boolean
}

export interface WorkspaceEditorFileMode {
  preview: boolean
  visualPreview: boolean
  diffOnly: boolean
  readOnly: boolean
  canEditText: boolean
  canShowDiff: boolean
  canShowBlame: boolean
  canShowLineChanges: boolean
}

export interface WorkspaceEditorSurfaceStateOptions {
  diffOnly: boolean
  diffOpen: boolean
  markdownSplitOpen?: boolean
  markdownPreviewOpen?: boolean
  sourcePreviewOpen?: boolean
  visualPreview: boolean
}

export interface WorkspaceEditorSurfaceState {
  showDiffView: boolean
  showDiffOnlyPreview: boolean
  showMarkdownSplit: boolean
  showMarkdownPreview: boolean
  showSourcePreview: boolean
  showMonaco: boolean
  showEditorOverlays: boolean
}

export interface WorkspaceEditorActionState {
  showBar: boolean
  showStatus: boolean
  showSave: boolean
  showDiff: boolean
  showMarkdownPreview: boolean
  showSourcePreview: boolean
  showWordWrap: boolean
  showReload: boolean
  showOverwrite: boolean
}

export type WorkspaceEditorStatusKind = 'changedOnDisk'

export interface WorkspaceEditorLineChangesState {
  mode: WorkspaceFileLineChanges['mode']
  lineNumber: number
  loading: boolean
  error: string | null
  changes: WorkspaceFileLineChanges | null
}

export interface WorkspaceEditorCursorTarget {
  lineNumber: number
  column?: number
  endColumn?: number
}

export interface WorkspaceEditorCursorBounds {
  lineCount: number
  getLineMaxColumn: (lineNumber: number) => number
}

export interface WorkspaceEditorSelectionRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface WorkspaceBlameDisplayLine {
  author: string
  authorTime: number | null
}

export interface WorkspaceBlameOverlayLine {
  lineNumber: number
}

export interface WorkspaceEditorVisibleRange {
  startLineNumber: number
  endLineNumber: number
}

export interface WorkspaceEditorVisibleLineWindow {
  firstVisibleLine: number
  lastVisibleLine: number
}

export interface WorkspaceEditorBlameOverlayRow<T extends WorkspaceBlameOverlayLine> {
  line: T
  top: number
}

export function safeWorkspaceEditorDomIdPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'file'
}

export function workspaceEditorModelKey(file: Pick<WorkspaceEditorFileReference, 'agentId' | 'file' | 'workspaceRoot'>) {
  return workspaceWorkingCopyKey(file)
}

export function workspaceEditorModelContentVersion(file: WorkspaceEditorFileReference) {
  return `${workspaceEditorModelKey(file)}:${file.file.sha1 || ''}:${file.file.size ?? ''}:${file.file.mtimeMs ?? ''}`
}

export function workspaceEditorModelUriParts(file: Pick<WorkspaceEditorFileReference, 'agentId' | 'file' | 'workspaceRoot'>) {
  const resourceKey = workspaceFileResourceKey(file.file.path, file.workspaceRoot)
  return {
    scheme: WORKSPACE_EDITOR_MODEL_URI_SCHEME,
    path: resourceKey.startsWith('/') ? resourceKey : `/${resourceKey}`,
  }
}

export function isWorkspaceEditorModelUri(uri: { scheme: string }) {
  return uri.scheme === WORKSPACE_EDITOR_MODEL_URI_SCHEME
}

export function workspaceEditorLiveModelKeys<T extends Pick<WorkspaceEditorFileReference, 'agentId' | 'file'>>(files: readonly T[]) {
  return new Set(files.map(workspaceEditorModelKey))
}

export function workspaceEditorLiveModelUriStrings<T extends Pick<WorkspaceEditorFileReference, 'agentId' | 'file'>>(
  files: readonly T[],
  modelUriStringForFile: (file: T) => string
) {
  return new Set(files.map(modelUriStringForFile))
}

export function shouldKeepWorkspaceEditorViewState(key: string, liveModelKeys: ReadonlySet<string>) {
  return liveModelKeys.has(key)
}

export function shouldDisposeWorkspaceEditorModelUri(
  uri: { scheme: string; toString: () => string },
  liveModelUris: ReadonlySet<string>
) {
  return isWorkspaceEditorModelUri(uri) && !liveModelUris.has(uri.toString())
}

export function workspaceEditorTabDomId(file: Pick<WorkspaceEditorFileReference, 'agentId' | 'file' | 'workspaceRoot'>) {
  return `code-file-editor-tab-${safeWorkspaceEditorDomIdPart(workspaceEditorModelKey(file))}`
}

export function workspaceEditorBasename(filePath: string) {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

export function workspaceEditorExtension(filePath: string) {
  const basename = workspaceEditorBasename(filePath).toLowerCase()
  const dotIndex = basename.lastIndexOf('.')
  return dotIndex > 0 ? basename.slice(dotIndex) : ''
}

export function isWorkspaceMarkdownFile(filePath: string) {
  return MARKDOWN_FILE_EXTENSIONS.has(workspaceEditorExtension(filePath))
}

export function isWorkspaceSvgFile(filePath: string) {
  return SVG_FILE_EXTENSIONS.has(workspaceEditorExtension(filePath))
}

export function workspaceEditorPathSegments(filePath: string) {
  return filePath.split('/').filter(Boolean)
}

export function workspaceEditorPathToSegment(segments: readonly string[], index: number) {
  return segments.slice(0, index + 1).join('/')
}

export function workspaceEditorTabLabel(file: WorkspaceEditorTabReference) {
  const status = file.externalChanged
    ? ', changed on disk'
    : file.dirty
      ? ', unsaved changes'
      : ''
  return `${workspaceEditorBasename(file.file.path)}, ${file.file.path}${status}`
}

export function workspaceEditorFileMode(file: WorkspaceEditorFileModeReference): WorkspaceEditorFileMode {
  const preview = Boolean(file.file.preview)
  const visualPreview = file.file.preview?.kind === 'image' || file.file.preview?.kind === 'binary'
  const diffOnly = file.diffOnly === true
  const readOnly = preview || diffOnly
  const canShowSourceHistory = !preview && !diffOnly
  return {
    preview,
    visualPreview,
    diffOnly,
    readOnly,
    canEditText: !readOnly,
    canShowDiff: !preview,
    canShowBlame: canShowSourceHistory,
    canShowLineChanges: canShowSourceHistory,
  }
}

export function workspaceEditorSurfaceState(options: WorkspaceEditorSurfaceStateOptions): WorkspaceEditorSurfaceState {
  const showDiffView = options.diffOpen && !options.visualPreview
  const showDiffOnlyPreview = options.diffOnly && !showDiffView
  const showMarkdownSurface = !showDiffView && !showDiffOnlyPreview && !options.visualPreview
  const showMarkdownSplit = Boolean(options.markdownSplitOpen) && showMarkdownSurface
  const showMarkdownPreview = Boolean(options.markdownPreviewOpen) && showMarkdownSurface && !showMarkdownSplit
  const showSourcePreview = Boolean(options.sourcePreviewOpen) && showMarkdownSurface && !showMarkdownPreview && !showMarkdownSplit
  const showMonaco = !options.visualPreview && !showDiffView && !showDiffOnlyPreview && !showMarkdownPreview && !showSourcePreview && !showMarkdownSplit
  return {
    showDiffView,
    showDiffOnlyPreview,
    showMarkdownSplit,
    showMarkdownPreview,
    showSourcePreview,
    showMonaco,
    showEditorOverlays: showMonaco || showMarkdownSplit,
  }
}

export function workspaceEditorActionState(
  file: WorkspaceWorkingCopyReference,
  mode: WorkspaceEditorFileMode,
  options: { canPreviewMarkdown?: boolean; canPreviewSource?: boolean; statusText: string | null; showBreadcrumbs: boolean }
): WorkspaceEditorActionState {
  const showStatus = Boolean(options.statusText)
  const showSave = mode.canEditText && shouldShowWorkspaceWorkingCopySaveAction(file)
  const showDiff = mode.canShowDiff
  const showMarkdownPreview = Boolean(options.canPreviewMarkdown)
  const showSourcePreview = Boolean(options.canPreviewSource)
  const showWordWrap = !mode.visualPreview && !mode.diffOnly
  const showReload = !mode.diffOnly && shouldShowWorkspaceWorkingCopyReloadAction(file)
  const showOverwrite = mode.canEditText && shouldShowWorkspaceWorkingCopyOverwriteAction(file)
  return {
    showBar: options.showBreadcrumbs || showStatus || showSave || showDiff || showMarkdownPreview || showSourcePreview || showWordWrap || showReload || showOverwrite,
    showStatus,
    showSave,
    showDiff,
    showMarkdownPreview,
    showSourcePreview,
    showWordWrap,
    showReload,
    showOverwrite,
  }
}

export function workspaceEditorStatusKind(file: WorkspaceWorkingCopyReference): WorkspaceEditorStatusKind | null {
  return file.externalChanged || workspaceWorkingCopyState(file) === 'conflict'
    ? 'changedOnDisk'
    : null
}

export function workspaceEditorLineChangesLoadingState(
  mode: WorkspaceFileLineChanges['mode'],
  lineNumber: number
): WorkspaceEditorLineChangesState {
  return {
    mode,
    lineNumber,
    loading: true,
    error: null,
    changes: null,
  }
}

export function workspaceEditorLineChangesLoadedState(
  mode: WorkspaceFileLineChanges['mode'],
  lineNumber: number,
  changes: WorkspaceFileLineChanges
): WorkspaceEditorLineChangesState {
  return {
    mode,
    lineNumber,
    loading: false,
    error: null,
    changes,
  }
}

export function workspaceEditorLineChangesErrorState(
  mode: WorkspaceFileLineChanges['mode'],
  lineNumber: number,
  error: unknown
): WorkspaceEditorLineChangesState {
  return {
    mode,
    lineNumber,
    loading: false,
    error: error instanceof Error ? error.message : 'Failed to load line changes',
    changes: null,
  }
}

export function workspaceEditorLineChangesPatchLineClassName(line: string) {
  if (line.startsWith('@@')) return 'meta'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'deleted'
  return 'context'
}

function basenameLower(filePath: string) {
  return workspaceEditorBasename(filePath).toLowerCase()
}

export function workspaceEditorLanguageLookupPath(filePath: string) {
  return filePath.replace(/~+$/, '')
}

function extensionMatches(filePath: string, extension: string) {
  return filePath.toLowerCase().endsWith(extension.toLowerCase())
}

function filenamePatternMatches(pattern: string, fileName: string) {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${expression}$`, 'i').test(fileName)
}

function firstLineLanguageId(content: string | undefined, languages: readonly WorkspaceEditorLanguageMetadata[]) {
  const firstLine = content?.split(/\r?\n/, 1)[0]
  if (!firstLine) return null
  for (const language of languages) {
    if (!language.firstLine) continue
    try {
      if (new RegExp(language.firstLine).test(firstLine)) return language.id
    } catch {
      // Ignore invalid third-party language metadata.
    }
  }
  return null
}

export function languageForWorkspaceFile(
  filePath: string,
  content: string | undefined,
  languages: readonly WorkspaceEditorLanguageMetadata[]
) {
  const lookupPath = workspaceEditorLanguageLookupPath(filePath)
  const lowerPath = lookupPath.toLowerCase()
  const fileName = basenameLower(lookupPath)
  const exactFilenameLanguage = languages.find(language => (
    language.filenames?.some(filename => filename.toLowerCase() === fileName)
  ))
  if (exactFilenameLanguage) return exactFilenameLanguage.id

  const extensionLanguage = languages
    .flatMap(language => (language.extensions ?? []).map(extension => ({ language, extension })))
    .sort((left, right) => right.extension.length - left.extension.length)
    .find(({ extension }) => extensionMatches(lowerPath, extension))
  if (extensionLanguage) return extensionLanguage.language.id

  const filenamePatternLanguage = languages.find(language => (
    language.filenamePatterns?.some(pattern => filenamePatternMatches(pattern, fileName))
  ))
  if (filenamePatternLanguage) return filenamePatternLanguage.id

  const shebangLanguageId = firstLineLanguageId(content, languages)
  if (shebangLanguageId) return shebangLanguageId

  const fallbackLanguage = Array.from(FALLBACK_LANGUAGE_ASSOCIATIONS.entries())
    .sort((left, right) => right[0].length - left[0].length)
    .find(([extension]) => extensionMatches(lowerPath, extension))?.[1]
  if (fallbackLanguage) return fallbackLanguage

  return 'plaintext'
}

export function formatWorkspaceBlameTime(authorTime: number | null) {
  if (!authorTime) return ''
  return new Date(authorTime * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function workspaceBlameInlineLabel(line: WorkspaceBlameDisplayLine) {
  const time = formatWorkspaceBlameTime(line.authorTime)
  const author = line.author || 'Unknown'
  return time ? `${time}   ${author}` : author
}

export function estimateWorkspaceBlameLabelWidth(lines: readonly WorkspaceBlameDisplayLine[], compact: boolean) {
  const minimum = compact ? COMPACT_BLAME_LABEL_WIDTH : DEFAULT_BLAME_LABEL_WIDTH
  const maximum = compact ? MAX_COMPACT_BLAME_LABEL_WIDTH : MAX_BLAME_LABEL_WIDTH
  const longestLabel = lines.reduce((longest, line) => Math.max(longest, workspaceBlameInlineLabel(line).length), 0)
  if (longestLabel <= 0) return minimum
  return Math.min(maximum, Math.max(minimum, Math.ceil(longestLabel * 7.2) + 18))
}

export function workspaceEditorVisibleLineWindow(options: {
  visibleRanges: readonly WorkspaceEditorVisibleRange[]
  scrollTop: number
  hostHeight: number
  lineHeight: number
}): WorkspaceEditorVisibleLineWindow {
  const lineHeight = Math.max(1, options.lineHeight)
  if (options.visibleRanges.length > 0) {
    return {
      firstVisibleLine: Math.max(1, Math.min(...options.visibleRanges.map(range => range.startLineNumber)) - 1),
      lastVisibleLine: Math.max(1, Math.max(...options.visibleRanges.map(range => range.endLineNumber)) + 1),
    }
  }
  return {
    firstVisibleLine: Math.max(1, Math.floor(options.scrollTop / lineHeight)),
    lastVisibleLine: Math.ceil((options.scrollTop + options.hostHeight) / lineHeight) + 1,
  }
}

export function workspaceEditorBlameOverlayRows<T extends WorkspaceBlameOverlayLine>(
  lines: readonly T[],
  options: WorkspaceEditorVisibleLineWindow & {
    hostTop: number
    scrollTop: number
    hostHeight: number
    lineHeight: number
    getTopForLineNumber: (lineNumber: number) => number
  }
): Array<WorkspaceEditorBlameOverlayRow<T>> {
  const firstVisibleLine = Math.max(1, options.firstVisibleLine)
  const lastVisibleLine = Math.max(firstVisibleLine, options.lastVisibleLine)
  const lineHeight = Math.max(1, options.lineHeight)
  const topLimit = options.hostTop - lineHeight
  const bottomLimit = options.hostTop + options.hostHeight + lineHeight

  return lines
    .slice(firstVisibleLine - 1, Math.min(lines.length, lastVisibleLine))
    .filter(line => line.lineNumber >= firstVisibleLine && line.lineNumber <= lastVisibleLine)
    .map(line => ({
      line,
      top: options.hostTop + options.getTopForLineNumber(line.lineNumber) - options.scrollTop,
    }))
    .filter(row => row.top >= topLimit && row.top <= bottomLimit)
}

export function workspaceBlameAuthorProfileUrl(author: string, urlTemplate: string) {
  const value = author.trim()
  if (!value || value === 'Unknown') return ''
  if (!urlTemplate || !urlTemplate.includes('{author}')) return ''
  return urlTemplate.replace(/\{author\}/g, encodeURIComponent(value))
}

export function isPermanentWorkspaceBlameFailureStatus(status: number) {
  return [400, 404, 409, 413, 415, 501].includes(status)
}

export function workspaceEditorCursorSelection(
  cursor: WorkspaceEditorCursorTarget,
  bounds: WorkspaceEditorCursorBounds
): WorkspaceEditorSelectionRange {
  const lineCount = Math.max(1, bounds.lineCount)
  const lineNumber = Math.max(1, Math.min(cursor.lineNumber, lineCount))
  const lineMaxColumn = Math.max(1, bounds.getLineMaxColumn(lineNumber))
  const column = Math.max(1, Math.min(cursor.column ?? 1, lineMaxColumn))
  const endColumn = cursor.endColumn
    ? Math.max(column, Math.min(cursor.endColumn, lineMaxColumn))
    : column

  return {
    startLineNumber: lineNumber,
    startColumn: column,
    endLineNumber: lineNumber,
    endColumn,
  }
}
