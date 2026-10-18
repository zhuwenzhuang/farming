const assert = require('assert')
import {
  resolveStickyTurnPromptFromRects,
  shouldApplyTurnFocusRunway,
  turnStickyPromptImages,
  turnStickyPromptSummary,
  turnStickyPromptText,
} from '../../src/lib/transcript-sticky-turn'
import type { AgentTranscriptTurn } from '../../src/components/code/acp/acp-entry-projection'

function buildTurn(overrides: Partial<AgentTranscriptTurn> & { id: string }): AgentTranscriptTurn {
  return {
    id: overrides.id,
    userMessage: overrides.userMessage ?? '',
    finalMessage: overrides.finalMessage ?? '',
    startedAt: overrides.startedAt ?? 1000,
    completedAt: overrides.completedAt ?? 2000,
    durationMs: overrides.durationMs ?? 1000,
    status: overrides.status ?? 'completed',
    processItems: overrides.processItems ?? [],
    ...overrides,
  }
}

// 1. turnStickyPromptSummary normalizes human user prompts and attachment fallbacks,
//    while ignoring handoffContext and peer incoming turns.
assert.strictEqual(
  turnStickyPromptSummary(buildTurn({ id: 't1', userMessage: '  First   line\n\nSecond\tline  ' })),
  'First line Second line',
)
assert.strictEqual(
  turnStickyPromptSummary(buildTurn({
    id: 't2',
    userMessage: '',
    userImages: [{ id: 'img-1', url: '/a.png', alt: 'Screenshot A' }],
    userFiles: [{ id: 'file-1', name: 'report.md' }],
  })),
  'Screenshot A, report.md',
)
assert.strictEqual(
  turnStickyPromptText(buildTurn({
    id: 't2-image-only',
    userMessage: '',
    userImages: [{ id: 'img-1', url: '/a.png', alt: 'Screenshot A' }],
  })),
  '',
)
assert.deepStrictEqual(
  turnStickyPromptImages(buildTurn({
    id: 't2-image-only',
    userMessage: '',
    userImages: [{ id: 'img-1', url: '/a.png', alt: 'Screenshot A' }],
  })),
  [{ id: 'img-1', url: '/a.png', alt: 'Screenshot A' }],
)
assert.strictEqual(
  turnStickyPromptSummary(buildTurn({
    id: 't3',
    userMessage: 'Handoff note',
    handoffContext: {
      version: 1,
      sourceSessionKey: 'codex:default:session-1',
    },
  })),
  '',
)
assert.strictEqual(
  turnStickyPromptSummary(buildTurn({
    id: 't4',
    userMessage: 'Peer message',
    userSource: {
      version: 1,
      direction: 'incoming',
      senderAddress: 'agent://peer-1',
      senderName: 'Peer Agent',
    },
  })),
  '',
)

// 2. shouldApplyTurnFocusRunway applies only to the latest human turn in a multi-turn
//    transcript when stickyTurnPromptEnabled is true and there is no preceding boundary.
const singleTurn = [buildTurn({ id: 'turn-1', userMessage: 'Only turn' })]
assert.strictEqual(shouldApplyTurnFocusRunway(singleTurn, 0, true, false), false)

const twoTurns = [
  buildTurn({ id: 'turn-1', userMessage: 'First turn' }),
  buildTurn({ id: 'turn-2', userMessage: 'Second turn' }),
]
assert.strictEqual(shouldApplyTurnFocusRunway(twoTurns, 0, true, false), false)
assert.strictEqual(shouldApplyTurnFocusRunway(twoTurns, 1, true, false), true)
assert.strictEqual(shouldApplyTurnFocusRunway(twoTurns, 1, false, false), false)
assert.strictEqual(shouldApplyTurnFocusRunway(twoTurns, 1, true, true), false)

// 3. resolveStickyTurnPromptFromRects pins the turn currently occupying the top of the viewport
//    only after its inline user header has scrolled above the viewport top edge.
assert.strictEqual(
  resolveStickyTurnPromptFromRects(100, [
    {
      turnId: 'turn-1',
      summary: 'First turn',
      turnTop: 118,
      turnBottom: 520,
      headerBottom: 158,
    },
  ]),
  null,
  'inline user prompt still visible at top of viewport should not show sticky bar',
)

assert.deepStrictEqual(
  resolveStickyTurnPromptFromRects(100, [
    {
      turnId: 'turn-1',
      summary: 'First turn',
      turnTop: -240,
      turnBottom: 620,
      headerBottom: 92,
    },
    {
      turnId: 'turn-2',
      summary: 'Second turn',
      turnTop: 646,
      turnBottom: 1100,
      headerBottom: 686,
    },
  ]),
  {
    turnId: 'turn-1',
    summary: 'First turn',
  },
  'long turn whose user header scrolled above scrollerTop should pin sticky summary',
)

assert.strictEqual(
  resolveStickyTurnPromptFromRects(100, [
    {
      turnId: 'turn-1',
      summary: 'First turn',
      turnTop: -500,
      turnBottom: 130,
      headerBottom: -450,
    },
    {
      turnId: 'turn-2',
      summary: 'Second turn',
      turnTop: 156,
      turnBottom: 860,
      headerBottom: 196,
    },
  ]),
  null,
  'turn whose bottom is nearly scrolled out of viewport (< 56px remaining) should release sticky bar before next turn header arrives',
)

assert.deepStrictEqual(
  resolveStickyTurnPromptFromRects(100, [
    {
      turnId: 'turn-1',
      summary: 'First turn',
      turnTop: -800,
      turnBottom: -120,
      headerBottom: -760,
    },
    {
      turnId: 'turn-2',
      summary: 'Second turn',
      turnTop: -94,
      turnBottom: 680,
      headerBottom: 80,
    },
  ]),
  {
    turnId: 'turn-2',
    summary: 'Second turn',
  },
  'once turn 2 header scrolls above viewport top, sticky bar switches to turn 2',
)

console.log('test-transcript-sticky-turn passed')
