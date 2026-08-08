import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACP_TRANSCRIPT_REFRESH_COALESCE_MS,
  ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS,
  ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS,
  acpTranscriptFetchRetryDelayMs,
  acpTranscriptRefreshCoalesceDelayMs,
  acpTranscriptUnsettledRetryDelayMs,
} from '../src/lib/transcript-fetch-policy'

// Mirrors the ladder declared in AgentTranscriptPane, whose literal value is
// pinned by backend/tests/test-acp-transcript.ts.
const ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS = [250, 1000] as const

test('transcript retry policy constants keep the pinned schedule', () => {
  assert.deepEqual(
    [...ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS],
    [100, 250, 500, 1000, 2000, 3000, 5000, 5000, 5000, 5000],
  )
  assert.equal(ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS, 15_000)
  assert.equal(ACP_TRANSCRIPT_REFRESH_COALESCE_MS, 80)
})

test('fetch retries walk the bounded ladder and then give up', () => {
  assert.equal(acpTranscriptFetchRetryDelayMs(ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS, 0), 250)
  assert.equal(acpTranscriptFetchRetryDelayMs(ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS, 1), 1000)
  assert.equal(acpTranscriptFetchRetryDelayMs(ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS, 2), undefined)
  assert.equal(acpTranscriptFetchRetryDelayMs(ACP_TRANSCRIPT_FETCH_RETRY_DELAYS_MS, 5), undefined)
})

test('unsettled retries use the ladder before switching to a slow poll', () => {
  const ladder = [...ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS]
  for (let attempt = 0; attempt < ladder.length; attempt += 1) {
    assert.equal(acpTranscriptUnsettledRetryDelayMs(attempt, false), ladder[attempt])
    assert.equal(acpTranscriptUnsettledRetryDelayMs(attempt, true), ladder[attempt])
  }
})

test('unsettled retries stop after the ladder without authoritative turns', () => {
  const ladderLength = ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS.length
  assert.equal(acpTranscriptUnsettledRetryDelayMs(ladderLength, false), undefined)
  assert.equal(acpTranscriptUnsettledRetryDelayMs(ladderLength + 3, false), undefined)
})

test('unsettled retries keep polling slowly while authoritative turns exist', () => {
  const ladderLength = ACP_TRANSCRIPT_UNSETTLED_RETRY_DELAYS_MS.length
  assert.equal(acpTranscriptUnsettledRetryDelayMs(ladderLength, true), ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS)
  assert.equal(acpTranscriptUnsettledRetryDelayMs(ladderLength + 5, true), ACP_TRANSCRIPT_UNSETTLED_SLOW_RETRY_MS)
})

test('refresh coalesce leaves the remaining quiet window and never goes negative', () => {
  assert.equal(acpTranscriptRefreshCoalesceDelayMs(0), 80)
  assert.equal(acpTranscriptRefreshCoalesceDelayMs(30), 50)
  assert.equal(acpTranscriptRefreshCoalesceDelayMs(ACP_TRANSCRIPT_REFRESH_COALESCE_MS), 0)
  assert.equal(acpTranscriptRefreshCoalesceDelayMs(500), 0)
  // Before the first load the pane computes an infinite elapsed window, so the
  // very first refresh must run immediately.
  assert.equal(acpTranscriptRefreshCoalesceDelayMs(Number.POSITIVE_INFINITY), 0)
})
