import { terminalTargetFilePath } from '@/components/code/workspace-file-view'
import { decodeFileUrlPath } from './file-url-path'
import { normalizeGlobalWorkspaceFilePath } from './global-workspace-files'
import { collectTerminalPathLinkMatches } from './terminal-links'

export const TRANSCRIPT_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
  'go',
  'java',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'jsonl',
  'csv',
  'tsv',
  'py',
  'rb',
  'rs',
  'sh',
  'bash',
  'zsh',
  'sql',
  'md',
  'mdx',
  'pdf',
  'txt',
  'xml',
  'html',
  'css',
  'scss',
  'less',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'gradle',
  'kt',
  'kts',
  'scala',
  'proto',
  'swift',
  'vue',
  'svelte',
  'svg',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

export const TRANSCRIPT_SPECIAL_FILENAMES = new Set([
  'BUILD',
  'BUCK',
  'Dockerfile',
  'Makefile',
  'WORKSPACE',
])

export function isExternalTranscriptHref(href: string) {
  const trimmed = href.trim()
  if (trimmed.startsWith('//')) return true
  if (/^[a-z]:[\\/]/i.test(trimmed) || /^file:\/\/\//i.test(trimmed)) return false
  if (isTranscriptFileLineHref(trimmed)) return false
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed)
    || isBareDomainTranscriptHref(trimmed)
}

export function isTranscriptFileLineHref(href: string) {
  return Boolean(exactTranscriptPathTarget(href)?.lineNumber)
}

export function isBareDomainTranscriptHref(href: string) {
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#].*$/i.test(href.trim())
}

export function normalizeTranscriptHref(href: string) {
  const trimmed = href.trim()
  return isBareDomainTranscriptHref(trimmed) ? `https://${trimmed}` : href
}

export function stripCandidateLocationSuffix(text: string) {
  return exactTranscriptPathTarget(text)?.path ?? text.replace(/:(\d+)(?::(\d+)(?:-(\d+))?)?$/, '')
}

function transcriptFileBasenameLooksValid(pathText: string) {
  const basename = pathText.split(/[\\/]/).filter(Boolean).pop() || pathText
  if (TRANSCRIPT_SPECIAL_FILENAMES.has(basename)) return true
  const extensionMatch = basename.match(/\.([A-Za-z0-9+_-]+)$/)
  if (!extensionMatch) return false
  return TRANSCRIPT_FILE_EXTENSIONS.has((extensionMatch[1] || '').toLowerCase())
}

function exactTranscriptPathTarget(text: string, requireKnownFileType = true) {
  // Markdown hrefs encode spaces, while inline-code literals may keep them.
  // Preserve the whole structured value through lexical path parsing, then
  // decode exactly once before resolving it against the filesystem.
  const encoded = text.trim().replace(/ /g, '%20')
  const matches = collectTerminalPathLinkMatches(encoded)
  const exact = matches.find(match => (
    match.startIndex === 0
    && match.length === encoded.length
    && match.pathTarget
  ))
  if (!exact?.pathTarget) return null
  const decodedPath = decodeFileUrlPath(exact.pathTarget.path)
  if (requireKnownFileType && !transcriptFileBasenameLooksValid(decodedPath)) return null
  return { ...exact.pathTarget, path: decodedPath }
}

function resolveTranscriptFileTarget(text: string, workspaceRoot: string | undefined, requireKnownFileType: boolean) {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('#') || isBareDomainTranscriptHref(trimmed)) return null
  const pathTarget = exactTranscriptPathTarget(trimmed, requireKnownFileType)
  if (!pathTarget) return null
  const filePath = terminalTargetFilePath(pathTarget.path, workspaceRoot || '')
  if (!filePath && !pathTarget.path.startsWith('/')) return null
  const globalFilePath = !filePath && pathTarget.path.startsWith('/')
    ? normalizeGlobalWorkspaceFilePath(pathTarget.path)
    : ''
  if (!filePath && !globalFilePath) return null
  return {
    filePath: filePath || globalFilePath,
    target: {
      ...(pathTarget.lineNumber
        ? {
            lineNumber: pathTarget.lineNumber,
            column: pathTarget.column,
            endColumn: pathTarget.endColumn,
          }
        : {}),
      ...(!filePath && globalFilePath ? { globalRoot: true } : {}),
    },
  }
}

/** Resolve an explicit Markdown href whose structure already establishes file identity. */
export function transcriptFileTargetFromHref(href: string, workspaceRoot?: string) {
  if (isExternalTranscriptHref(href)) return null
  return resolveTranscriptFileTarget(href, workspaceRoot, false)
}

/** Resolve one bounded inline-code literal while avoiding speculative file links. */
export function transcriptFileTargetFromText(text: string, workspaceRoot?: string) {
  return resolveTranscriptFileTarget(text, workspaceRoot, true)
}

export function transcriptImageFilePath(filePath: string) {
  return /\.(?:gif|jpe?g|png|webp)$/i.test(filePath)
}

export function hasQualifiedTranscriptFileReference(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return false
  const pathTarget = exactTranscriptPathTarget(trimmed)
  if (!pathTarget) return false
  const withoutLocation = pathTarget.path
  return (
    withoutLocation.startsWith('/')
    || withoutLocation.startsWith('~/')
    || withoutLocation.startsWith('./')
    || withoutLocation.startsWith('../')
    || withoutLocation.includes('/')
    || Boolean(pathTarget.lineNumber)
  )
}

export function fileReferenceDisplayText(filePath: string, lineNumber?: number) {
  const basename = stripCandidateLocationSuffix(filePath.trim()).split(/[\\/]/).filter(Boolean).pop() || filePath.trim()
  return lineNumber && lineNumber > 1 ? `${basename}:${lineNumber}` : basename
}
