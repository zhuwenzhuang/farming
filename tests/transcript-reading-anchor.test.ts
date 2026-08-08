import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearReadingAnchor,
  readingAnchorAgentKey,
  readReadingAnchor,
  saveReadingAnchor,
  type ReadingAnchor,
} from '../src/lib/reading-anchor'
import {
  TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD,
  captureTranscriptReadingAnchor,
  isTranscriptNearBottom,
  persistTranscriptReadingAnchor,
  restoreTranscriptReadingAnchor,
  transcriptBottomDistance,
} from '../src/lib/transcript-reading-anchor'

// Node does not provide the platform CSS helper the module uses to build
// attribute selectors. Identity escaping is sufficient here because the fake
// DOM parses selectors lexically and every fixture id is plain text.
const globalForCss = globalThis as typeof globalThis & { CSS?: { escape(value: string): string } }
globalForCss.CSS = globalForCss.CSS ?? { escape: (value: string) => value }

function fakeRect(top: number, height: number) {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 320,
    width: 320,
    x: 0,
    y: top,
  }
}

interface FakeProcessItemOptions {
  processItemId: string
  top: number
  height: number
}

interface FakeTurnOptions {
  turnId: string
  top: number
  height: number
  processItems?: FakeProcessItemOptions[]
}

function makeTurn(options: FakeTurnOptions) {
  const rect = fakeRect(options.top, options.height)
  const items = (options.processItems || []).map(item => ({
    dataset: { processItemId: item.processItemId },
    getBoundingClientRect: () => fakeRect(item.top, item.height),
  }))
  return {
    dataset: { turnId: options.turnId },
    getBoundingClientRect: () => rect,
    querySelectorAll: () => items,
    querySelector: (selector: string) => {
      const match = /data-process-item-id="([^"]*)"/.exec(selector)
      return items.find(item => item.dataset.processItemId === match?.[1]) ?? null
    },
  }
}

interface FakeScrollerOptions {
  scrollTop?: number
  scrollHeight: number
  clientHeight: number
  top?: number
  turns?: ReturnType<typeof makeTurn>[]
}

function makeScroller(options: FakeScrollerOptions) {
  const scrollerTop = options.top ?? 0
  return {
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: options.scrollHeight,
    clientHeight: options.clientHeight,
    getBoundingClientRect: () => fakeRect(scrollerTop, options.clientHeight),
    querySelectorAll: (_selector: string) => options.turns ?? [],
    querySelector: (selector: string) => {
      const match = /data-turn-id="([^"]*)"/.exec(selector)
      return (options.turns ?? []).find(turn => turn.dataset.turnId === match?.[1]) ?? null
    },
  }
}

function asScroller(scroller: ReturnType<typeof makeScroller>) {
  return scroller as unknown as HTMLDivElement
}

interface InjectedRuntime {
  agentKey(agentId: string, surface: 'chat' | 'terminal'): string
  fileKey(workspace: string, path: string): string
  save(anchor: ReadingAnchor): ReadingAnchor | null
  read(key: string): ReadingAnchor | null
  remove(key: string): void
  fingerprint(parts: string[]): string
  encode(anchor: ReadingAnchor): string
  importEncoded(encoded: string): ReadingAnchor | null
}

type GlobalWithOptionalWindow = Omit<typeof globalThis, 'window'> & {
  window?: { FarmingReadingAnchors?: InjectedRuntime }
}

function withInjectedRuntime(runtime: InjectedRuntime, fn: () => void) {
  const globals = globalThis as GlobalWithOptionalWindow
  const previousWindow = globals.window
  globals.window = { FarmingReadingAnchors: runtime }
  try {
    fn()
  } finally {
    if (previousWindow === undefined) delete globals.window
    else globals.window = previousWindow
  }
}

test('bottom distance and near-bottom threshold keep the pinned geometry', () => {
  assert.equal(TRANSCRIPT_BOTTOM_FOLLOW_THRESHOLD, 96)
  const scroller = asScroller(makeScroller({
    scrollTop: 600,
    scrollHeight: 1000,
    clientHeight: 400,
  }))
  assert.equal(transcriptBottomDistance(scroller), 0)
  assert.equal(isTranscriptNearBottom(scroller), true)

  scroller.scrollTop = 504
  assert.equal(transcriptBottomDistance(scroller), 96)
  assert.equal(isTranscriptNearBottom(scroller), true)

  scroller.scrollTop = 503
  assert.equal(transcriptBottomDistance(scroller), 97)
  assert.equal(isTranscriptNearBottom(scroller), false)
})

test('capture clears the anchor while following the latest output', () => {
  const scroller = asScroller(makeScroller({
    scrollTop: 600,
    scrollHeight: 1000,
    clientHeight: 400,
    top: 0,
    turns: [makeTurn({ turnId: 'turn-a', top: 100, height: 200 })],
  }))
  assert.equal(captureTranscriptReadingAnchor('agent-a', scroller), null)
})

test('capture reports undefined when no turn intersects the visible top', () => {
  const scroller = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 0,
    turns: [makeTurn({ turnId: 'turn-a', top: -500, height: 200 })],
  }))
  assert.equal(captureTranscriptReadingAnchor('agent-a', scroller), undefined)
})

test('capture anchors the first visible turn with its viewport fraction', () => {
  const scroller = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 100,
    turns: [
      makeTurn({ turnId: 'turn-hidden', top: -500, height: 200 }),
      makeTurn({ turnId: 'turn-visible', top: 80, height: 200 }),
    ],
  }))
  assert.deepEqual(captureTranscriptReadingAnchor('agent-a', scroller), {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: 'agent-a' },
    locator: { kind: 'message', id: 'turn-visible' },
    position: { unit: 'fraction', value: 0.1 },
  })
})

test('capture anchors the visible process item inside a turn when present', () => {
  const scroller = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 100,
    turns: [makeTurn({
      turnId: 'turn-a',
      top: 80,
      height: 500,
      processItems: [
        { processItemId: 'item-above', top: -300, height: 100 },
        { processItemId: 'item-visible', top: 50, height: 200 },
      ],
    })],
  }))
  assert.deepEqual(captureTranscriptReadingAnchor('agent-a', scroller), {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: 'agent-a' },
    locator: { kind: 'message', id: 'turn-a', childId: 'item-visible' },
    position: { unit: 'fraction', value: 0.25 },
  })
})

test('capture clamps fractions to the visible viewport and handles zero-height targets', () => {
  const belowScroller = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 100,
    turns: [makeTurn({ turnId: 'turn-a', top: 200, height: 300 })],
  }))
  const below = captureTranscriptReadingAnchor('agent-a', belowScroller)
  assert.equal(below && below.position.value, 0)

  const nearEdge = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 100,
    turns: [makeTurn({ turnId: 'turn-a', top: -900, height: 1001 })],
  }))
  const almostFull = captureTranscriptReadingAnchor('agent-a', nearEdge)
  // A visible turn's bottom edge always stays below the viewport top, so the
  // fraction can approach but never exceed 1.
  assert.equal(almostFull && almostFull.position.value, 1000 / 1001)

  const zeroHeight = asScroller(makeScroller({
    scrollTop: 100,
    scrollHeight: 2000,
    clientHeight: 400,
    top: 100,
    turns: [makeTurn({ turnId: 'turn-a', top: 150, height: 0 })],
  }))
  const flat = captureTranscriptReadingAnchor('agent-a', zeroHeight)
  assert.equal(flat && flat.position.value, 0)
})

test('persist saves chat anchors and clears them on null', () => {
  const agentId = 'agent-persist'
  const key = readingAnchorAgentKey(agentId, 'chat')
  const anchor: ReadingAnchor = {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: { kind: 'message', id: 'turn-a' },
    position: { unit: 'fraction', value: 0.5 },
  }
  try {
    persistTranscriptReadingAnchor(agentId, anchor)
    assert.deepEqual(readReadingAnchor(key), anchor)
    persistTranscriptReadingAnchor(agentId, null)
    assert.equal(readReadingAnchor(key), null)
  } finally {
    clearReadingAnchor(key)
  }
})

test('restore reports none when nothing was persisted', () => {
  const scroller = asScroller(makeScroller({
    scrollTop: 42,
    scrollHeight: 2000,
    clientHeight: 400,
    turns: [makeTurn({ turnId: 'turn-a', top: 0, height: 200 })],
  }))
  assert.equal(restoreTranscriptReadingAnchor('agent-empty', scroller), 'none')
  assert.equal(scroller.scrollTop, 42)
})

test('restore expires anchors from another surface and clears them', () => {
  const removedKeys: string[] = []
  const terminalAnchor: ReadingAnchor = {
    version: 1,
    surface: 'terminal',
    resource: { kind: 'agent', id: 'agent-expired' },
    locator: { kind: 'terminal-lines', id: 'terminal-1', lineCount: 10 },
    position: { unit: 'row', value: 3 },
  }
  const runtime: InjectedRuntime = {
    agentKey: (agentId, surface) => `agent:${agentId}:${surface}`,
    fileKey: (workspace, path) => `file:${workspace}:${path}`,
    save: anchor => anchor,
    read: () => terminalAnchor,
    remove: key => removedKeys.push(key),
    fingerprint: () => '',
    encode: () => '',
    importEncoded: () => null,
  }
  withInjectedRuntime(runtime, () => {
    const scroller = asScroller(makeScroller({
      scrollTop: 42,
      scrollHeight: 2000,
      clientHeight: 400,
      turns: [makeTurn({ turnId: 'turn-a', top: 0, height: 200 })],
    }))
    assert.equal(restoreTranscriptReadingAnchor('agent-expired', scroller), 'expired')
    assert.equal(scroller.scrollTop, 42)
    assert.deepEqual(removedKeys, ['agent:agent-expired:chat'])
  })
})

test('restore reports missing when the anchored turn is not rendered', () => {
  const agentId = 'agent-missing'
  const key = readingAnchorAgentKey(agentId, 'chat')
  const anchor: ReadingAnchor = {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: { kind: 'message', id: 'turn-gone' },
    position: { unit: 'fraction', value: 0.4 },
  }
  try {
    saveReadingAnchor(anchor)
    const scroller = asScroller(makeScroller({
      scrollTop: 42,
      scrollHeight: 2000,
      clientHeight: 400,
      turns: [makeTurn({ turnId: 'turn-a', top: 0, height: 200 })],
    }))
    assert.equal(restoreTranscriptReadingAnchor(agentId, scroller), 'missing')
    assert.equal(scroller.scrollTop, 42)
  } finally {
    clearReadingAnchor(key)
  }
})

test('restore scrolls the anchored turn fraction back into view', () => {
  const agentId = 'agent-restore'
  const key = readingAnchorAgentKey(agentId, 'chat')
  const anchor: ReadingAnchor = {
    version: 1,
    surface: 'chat',
    resource: { kind: 'agent', id: agentId },
    locator: { kind: 'message', id: 'turn-a', childId: 'item-a' },
    position: { unit: 'fraction', value: 0.25 },
  }
  try {
    saveReadingAnchor(anchor)
    const scroller = asScroller(makeScroller({
      scrollTop: 500,
      scrollHeight: 2000,
      clientHeight: 400,
      top: 100,
      turns: [makeTurn({
        turnId: 'turn-a',
        top: 200,
        height: 1000,
        processItems: [{ processItemId: 'item-a', top: 250, height: 200 }],
      })],
    }))
    assert.equal(restoreTranscriptReadingAnchor(agentId, scroller), 'restored')
    assert.equal(scroller.scrollTop, 500 + (250 + 200 * 0.25 - 100))
  } finally {
    clearReadingAnchor(key)
  }
})

test('capture and restore round-trip returns the scrolled-away viewport', () => {
  const agentId = 'agent-roundtrip'
  const key = readingAnchorAgentKey(agentId, 'chat')
  try {
    const atCapture = makeScroller({
      scrollTop: 620,
      scrollHeight: 2000,
      clientHeight: 400,
      top: 100,
      turns: [makeTurn({ turnId: 'turn-a', top: 30, height: 320 })],
    })
    const anchor = captureTranscriptReadingAnchor(agentId, asScroller(atCapture))
    assert.notEqual(anchor, undefined)
    assert.notEqual(anchor, null)
    if (!anchor) return
    assert.equal(anchor.position.value, 0.21875)
    persistTranscriptReadingAnchor(agentId, anchor)

    // The user scrolls 150px down before the next render: every turn moves up
    // by the same amount while the scroller viewport stays put.
    const afterScroll = makeScroller({
      scrollTop: 770,
      scrollHeight: 2000,
      clientHeight: 400,
      top: 100,
      turns: [makeTurn({ turnId: 'turn-a', top: -120, height: 320 })],
    })
    const restored = asScroller(afterScroll)
    assert.equal(restoreTranscriptReadingAnchor(agentId, restored), 'restored')
    assert.equal(restored.scrollTop, 620)
  } finally {
    clearReadingAnchor(key)
  }
})
