export const ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000, 3000, 5000, 5000, 5000, 5000] as const
export const ACP_TRANSCRIPT_UNSETTLED_RETRY_LADDER_LENGTH = ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS.length
export const ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS = 15_000
export const ACP_TRANSCRIPT_REFRESH_COALESCE_MS = 80

// The caller supplies the pinned fetch ladder because
// backend/tests/test-acp-transcript.ts asserts its literal declaration stays
// in AgentTranscriptPane.
export function acpTranscriptFetchRetryDelayMs(
  delays: readonly number[],
  attempt: number,
): number | undefined {
  return delays[attempt]
}

export function acpTranscriptUnsettledRetryDelayMs(
  attempt: number,
  hasAuthoritativeTurns: boolean,
): number | undefined {
  return ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS[attempt]
    ?? (hasAuthoritativeTurns ? ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS : undefined)
}

export function acpTranscriptRefreshCoalesceDelayMs(elapsedMs: number): number {
  return Math.max(0, ACP_TRANSCRIPT_REFRESH_COALESCE_MS - elapsedMs)
}
