import { normalizeReviewGitRevision, type ReviewDiffSnapshotRequest, type WorkingCopyReviewScope } from './snapshot'
import type { ReviewPreferences } from './state'

export type ReviewRouteTarget = {
  error?: string
  request: ReviewDiffSnapshotRequest | null
}

export type AcpReviewCaptureRoute = {
  agentId: string
  itemIds: string[]
}

export function acpReviewCaptureRequestFromSearch(search: string | URLSearchParams): AcpReviewCaptureRoute | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const agentId = params.get('agentId')?.trim() || ''
  const itemIds = [...new Set(params.getAll('acpItem').map(value => value.trim()).filter(Boolean))]
  if (!agentId || itemIds.length === 0 || itemIds.length > 256) return null
  return { agentId, itemIds }
}

function parseIntegerOption(params: URLSearchParams, key: string, minimum: number) {
  const value = params.get(key)
  if (value === null || value.trim() === '') return undefined
  if (!/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : undefined
}

function parseIgnoreWhitespaceOption(params: URLSearchParams): ReviewPreferences['ignoreWhitespace'] | undefined {
  const value = params.get('ignoreWhitespace')
  if (value === 'ALL' || value === 'IGNORE_ALL') return 'ALL'
  if (value === 'TRAILING' || value === 'IGNORE_TRAILING') return 'TRAILING'
  if (value === 'LEADING_AND_TRAILING' || value === 'IGNORE_LEADING_AND_TRAILING') return 'LEADING_AND_TRAILING'
  return undefined
}

function parseMetadataOnlyOption(params: URLSearchParams) {
  const value = params.get('metadataOnly')
  return value === '1' || value === 'true' ? true : undefined
}

function parseWorkingCopyScope(params: URLSearchParams): WorkingCopyReviewScope | undefined {
  const value = params.get('scope')
  return value === 'tracked' || value === 'untracked' ? value : undefined
}

function reviewSnapshotRequestOptions(params: URLSearchParams) {
  const context = parseIntegerOption(params, 'context', 0)
  const ignoreWhitespace = parseIgnoreWhitespaceOption(params)
  const limit = parseIntegerOption(params, 'limit', 1)
  const metadataOnly = parseMetadataOnlyOption(params)
  const modifiedWithinDays = parseIntegerOption(params, 'modifiedWithinDays', 1)
  const scope = parseWorkingCopyScope(params)
  const paths = params.getAll('path').map(value => value.trim()).filter(Boolean)
  return {
    ...(context !== undefined ? { context } : {}),
    ...(ignoreWhitespace ? { ignoreWhitespace } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(metadataOnly === true ? { metadataOnly } : {}),
    ...(scope ? { scope } : {}),
    ...(paths.length > 0 ? { paths } : {}),
    ...(scope === 'untracked' && modifiedWithinDays !== undefined ? { modifiedWithinDays } : {}),
  }
}

export function reviewSnapshotRequestFromSearch(search: string | URLSearchParams): ReviewRouteTarget {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const agentId = params.get('agentId')?.trim() || ''
  const root = params.get('root')?.trim() || ''
  if (agentId && root) return { error: 'only one review workspace target is allowed', request: null }
  if (!agentId && !root) return { request: null }
  const target = agentId ? { agentId } : { root }
  const options = reviewSnapshotRequestOptions(params)
  const reviewId = params.get('reviewId')?.trim() || ''

  const rawBase = params.get('base')
  const rawHead = params.get('head')
  const hasRangeParameter = rawBase !== null || rawHead !== null
  if (!hasRangeParameter) return { request: { ...target, ...options, source: 'working-copy' } }

  const base = normalizeReviewGitRevision(rawBase || '')
  const head = normalizeReviewGitRevision(rawHead || '')
  if (!base || !head) return { error: 'base and head revisions are invalid', request: null }
  return { request: { ...target, base, head, ...options, ...(reviewId ? { reviewId } : {}), source: 'git-range' } }
}

export function reviewSnapshotRequestFromLocation(location: Pick<Location, 'search'> | null | undefined): ReviewRouteTarget {
  return reviewSnapshotRequestFromSearch(location?.search ?? '')
}
