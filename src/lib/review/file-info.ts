import type { ReviewFile, ReviewFileStatusCode } from './state'
import { validReviewPath } from './state'

export type GerritFileInfo = {
  binary?: unknown
  diffs_too_expensive_to_compute?: unknown
  lines_deleted?: unknown
  lines_inserted?: unknown
  new_mode?: unknown
  new_sha?: unknown
  old_mode?: unknown
  old_path?: unknown
  old_sha?: unknown
  size?: unknown
  size_delta?: unknown
  status?: unknown
}

export type GerritFileInfoMap = Record<string, GerritFileInfo>

export type NormalizedGerritFileInfo = Omit<GerritFileInfo, 'lines_deleted' | 'lines_inserted' | 'new_mode' | 'new_sha' | 'old_mode' | 'old_path' | 'old_sha' | 'size' | 'size_delta'> & {
  lines_deleted: number
  lines_inserted: number
  new_mode?: string
  new_sha?: string
  old_mode?: string
  old_path?: string
  old_sha?: string
  path: string
  size: number
  size_delta: number
}

const SPECIAL_FILE_ORDER = new Map<string, number>([
  ['/COMMIT_MSG', 0],
  ['/MERGE_LIST', 1],
])

function integerOrZero(value: unknown) {
  return Number.isInteger(value) ? value as number : 0
}

function nonNegativeIntegerOrZero(value: unknown) {
  const number = integerOrZero(value)
  return number < 0 ? 0 : number
}

function fileMode(value: unknown) {
  if (typeof value === 'string' && /^[0-7]{6}$/.test(value)) return value
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 777777) {
    const mode = String(value).padStart(6, '0')
    if (/^[0-7]{6}$/.test(mode)) return mode
  }
  return undefined
}

function nonEmptyString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

export function compareReviewFilePaths(left: string, right: string) {
  const leftSpecial = SPECIAL_FILE_ORDER.get(left)
  const rightSpecial = SPECIAL_FILE_ORDER.get(right)
  if (leftSpecial !== undefined || rightSpecial !== undefined) {
    return (leftSpecial ?? Number.MAX_SAFE_INTEGER) - (rightSpecial ?? Number.MAX_SAFE_INTEGER)
  }
  return left.localeCompare(right)
}

export function normalizeGerritFileInfo(file: unknown = {}, path: string): NormalizedGerritFileInfo {
  if (!validReviewPath(path)) throw new TypeError(`invalid review file path: ${path}`)
  const source = objectRecord(file)
  if (!source) throw new TypeError(`invalid Gerrit FileInfo for path: ${path}`)
  if (source.old_path !== undefined && !validReviewPath(source.old_path)) {
    throw new TypeError(`invalid previous review file path: ${source.old_path}`)
  }
  const { new_mode: newMode, new_sha: newSha, old_mode: oldMode, old_path: oldPath, old_sha: oldSha, ...rest } = source
  const normalizedNewMode = fileMode(newMode)
  const normalizedOldMode = fileMode(oldMode)
  const normalizedNewSha = nonEmptyString(newSha)
  const normalizedOldPath = nonEmptyString(oldPath)
  const normalizedOldSha = nonEmptyString(oldSha)
  return {
    ...rest,
    lines_deleted: nonNegativeIntegerOrZero(source.lines_deleted),
    lines_inserted: nonNegativeIntegerOrZero(source.lines_inserted),
    ...(normalizedNewMode ? { new_mode: normalizedNewMode } : {}),
    ...(normalizedNewSha ? { new_sha: normalizedNewSha } : {}),
    ...(normalizedOldMode ? { old_mode: normalizedOldMode } : {}),
    ...(normalizedOldPath ? { old_path: normalizedOldPath } : {}),
    ...(normalizedOldSha ? { old_sha: normalizedOldSha } : {}),
    path,
    size: nonNegativeIntegerOrZero(source.size),
    size_delta: integerOrZero(source.size_delta),
  }
}

export function reviewKindFromGerritStatus(status: ReviewFileStatusCode | undefined): ReviewFile['kind'] {
  if (status === 'A') return 'added'
  if (status === 'C') return 'copied'
  if (status === 'D') return 'deleted'
  if (status === 'R') return 'renamed'
  if (status === 'U') return 'unmodified'
  if (status === 'W') return 'rewritten'
  if (status === 'X') return 'reverted'
  return 'modified'
}

export function isGerritReviewFileStatus(status: unknown): status is ReviewFileStatusCode {
  return status === 'A' || status === 'C' || status === 'D' || status === 'M' || status === 'R' || status === 'U' || status === 'W' || status === 'X'
}

function reviewStatusFromGerritStatus(status: unknown): ReviewFileStatusCode {
  if (isGerritReviewFileStatus(status)) return status
  return 'M'
}

export function reviewFileFromGerritFileInfo(path: string, file: unknown = {}): ReviewFile {
  const normalized = normalizeGerritFileInfo(file, path)
  const status = reviewStatusFromGerritStatus(normalized.status)
  return {
    added: normalized.lines_inserted,
    ...(normalized.binary === true ? { binary: true } : {}),
    diff: { hunks: [], ...(normalized.diffs_too_expensive_to_compute === true ? { truncated: true } : {}) },
    diffLoaded: false,
    ...(normalized.diffs_too_expensive_to_compute === true ? { diffTooExpensive: true } : {}),
    kind: reviewKindFromGerritStatus(status),
    ...(normalized.new_mode ? { newMode: normalized.new_mode } : {}),
    ...(normalized.new_sha ? { newSha: normalized.new_sha } : {}),
    ...(normalized.old_mode ? { oldMode: normalized.old_mode } : {}),
    ...(normalized.old_sha ? { oldSha: normalized.old_sha } : {}),
    path,
    ...(normalized.old_path ? { previousPath: normalized.old_path } : {}),
    removed: normalized.lines_deleted,
    ...(normalized.size ? { size: normalized.size } : {}),
    ...(normalized.size_delta ? { sizeDelta: normalized.size_delta } : {}),
    status,
  }
}

export function reviewFilesFromGerritFileInfoMap(files: unknown = {}): ReviewFile[] {
  const map = objectRecord(files)
  if (!map) throw new TypeError('invalid Gerrit FileInfo map')
  return Object.entries(map)
    .sort(([left], [right]) => compareReviewFilePaths(left, right))
    .map(([path, file]) => reviewFileFromGerritFileInfo(path, file))
}
