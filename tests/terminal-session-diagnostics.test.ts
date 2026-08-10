import assert from 'node:assert/strict'
import test from 'node:test'
import type { FarmingTerminal } from '../src/lib/terminal-engine'
import type { TerminalAttachmentCoordinator } from '../src/lib/terminal-attachment-coordinator'
import type { TerminalResizeEffectController } from '../src/lib/terminal-resize-effect-controller'
import type { TerminalReplicationState } from '../src/lib/terminal-session-replication'
import {
  TerminalSessionDiagnosticsProjection,
  type TerminalSessionDiagnosticsSource,
} from '../src/lib/terminal-session-diagnostics'

function diagnosticsSource(agentId = 'agent-one'): TerminalSessionDiagnosticsSource {
  const mount = {} as HTMLElement
  const host = { parentElement: mount } as unknown as HTMLDivElement
  const attachmentState = {
    generation: 4,
    revision: 9,
    runtimeEpoch: 'runtime-one',
    outputSeq: 12,
    stateRevision: 14,
    replayTargetEpoch: 'runtime-two',
    replayTargetRevision: 18,
    queuedTransitions: 2,
    queuedBytes: 64,
    recovering: true,
    halted: false,
    failureCount: 1,
  }
  const attachment = {
    generation: 4,
    isCurrentGeneration: (generation: number) => generation === 4,
    snapshot: () => ({ ...attachmentState }),
  } as unknown as TerminalAttachmentCoordinator
  const terminal = {
    __farmingTerminalEngine: 'xterm',
    getRendererType: () => 'webgl' as const,
    cols: 120,
    rows: 35,
    viewportY: 7,
    getScrollbackLength: () => 240,
    getVisibleBufferBase: () => 247,
    buffer: {
      active: {
        viewportY: 17,
        baseY: 220,
        length: 275,
      },
    },
  } as unknown as FarmingTerminal
  const resizeEffects = {
    diagnostics: () => ({
      lastNotifiedResize: { cols: 118, rows: 33 },
      resizeNotificationCount: 5,
      resizeRequestInFlight: { cols: 117, rows: 32 },
      pendingResizeRequest: { cols: 116, rows: 31 },
      pendingFitResize: { cols: 119, rows: 34 },
      fitResizeTimerPending: true,
      resizeRedrawTimerPending: false,
      resizeDeliveryTimeoutPending: true,
    }),
  } as unknown as TerminalResizeEffectController
  const replication: TerminalReplicationState = {
    snapshotOutput: '',
    snapshotRuntimeEpoch: '',
    snapshotOutputSeq: null,
    snapshotStateRevision: null,
    snapshotCols: null,
    snapshotRows: null,
    replayInProgress: true,
    liveWriteInProgress: false,
    liveTransitionFlushScheduled: false,
    terminalWriteQueue: Promise.resolve(),
    terminalWriteResolvers: new Set(),
    terminalWriteBatchCount: 6,
    holdCheckpointInstallCompletionForTest: false,
    heldCheckpointInstallCompletionForTest: null,
    bootstrapRefreshSeq: 3,
    checkpointRequestCount: 8,
    checkpointRequestInFlight: true,
    checkpointRetryTimer: null,
    bootstrapRequestControllers: new Set(),
    needsReconnectOutputSync: true,
    pageOutputSuspended: true,
    pendingSnapshotReplay: true,
    bootstrappingSnapshot: false,
    fixtureOverrideActive: false,
    suppressOutputUntil: 1_250,
  }

  return {
    agentId,
    hostEl: host,
    attachedMount: mount,
    disposed: false,
    terminal,
    attachment,
    resizeEffects,
    replication,
  }
}

test('projects one current authoritative terminal cut only when diagnostics are read', () => {
  const source = diagnosticsSource()
  const projection = new TerminalSessionDiagnosticsProjection({
    get: agentId => agentId === source.agentId ? source : undefined,
    values: () => [source],
    now: () => 1_000,
  })

  assert.deepEqual(projection.snapshot(source.agentId), {
    engine: 'xterm',
    renderer: 'webgl',
    cols: 120,
    rows: 35,
    viewportY: 7,
    scrollbackLength: 240,
    visibleBufferBase: 247,
    bufferViewportY: 17,
    bufferBaseY: 220,
    bufferLength: 275,
    queuedTransitions: 2,
    queuedBytes: 64,
    terminalWriteBatchCount: 6,
    replayTargetEpoch: 'runtime-two',
    replayTargetRevision: 18,
    checkpointHalted: false,
    checkpointFailureCount: 1,
    checkpointRequestInFlight: true,
    replayInProgress: true,
    bootstrappingSnapshot: false,
    pendingSnapshotReplay: true,
    runtimeEpoch: 'runtime-one',
    stateRevision: 14,
    lastOutputSeq: 12,
    reconnectSnapshotSeq: 9,
    checkpointRequestCount: 8,
    bootstrapRefreshSeq: 3,
    attachGeneration: 4,
    currentAttachment: true,
    attachedMount: true,
    fixtureOverrideActive: false,
    pageOutputSuspended: true,
    suppressOutputForMs: 250,
    needsReconnectOutputSync: true,
    lastNotifiedResize: { cols: 118, rows: 33 },
    resizeNotificationCount: 5,
    resizeRequestInFlight: { cols: 117, rows: 32 },
    pendingResizeRequest: { cols: 116, rows: 31 },
    pendingFitResize: { cols: 119, rows: 34 },
    fitResizeTimerPending: true,
    resizeRedrawTimerPending: false,
    resizeDeliveryTimeoutPending: true,
  })

  source.replication.checkpointRequestCount = 11
  source.replication.terminalWriteBatchCount = 10
  assert.equal(projection.snapshot(source.agentId)?.checkpointRequestCount, 11)
  assert.equal(projection.snapshot(source.agentId)?.terminalWriteBatchCount, 10)
})

test('always follows canonical lookup identity across pending ABA replacement', async () => {
  const oldSource = diagnosticsSource('same-agent')
  let resolveOld!: (source: TerminalSessionDiagnosticsSource) => void
  const oldBootstrap = new Promise<TerminalSessionDiagnosticsSource>(resolve => {
    resolveOld = resolve
  })
  let canonical: TerminalSessionDiagnosticsSource | Promise<TerminalSessionDiagnosticsSource> | undefined = oldBootstrap
  const projection = new TerminalSessionDiagnosticsProjection({
    get: () => canonical,
    values: () => canonical ? [canonical] : [],
  })
  assert.equal(projection.snapshot('same-agent'), null)

  canonical = undefined
  assert.equal(projection.snapshot('same-agent'), null)
  const newSource = diagnosticsSource('same-agent')
  newSource.replication.checkpointRequestCount = 22
  canonical = newSource
  resolveOld(oldSource)
  await oldBootstrap
  oldSource.disposed = true

  assert.equal(projection.snapshot('same-agent')?.checkpointRequestCount, 22)
})

test('never exposes a pending bootstrap or disposed source', () => {
  const source = diagnosticsSource()
  let canonical: TerminalSessionDiagnosticsSource | Promise<TerminalSessionDiagnosticsSource> = Promise.resolve(source)
  const projection = new TerminalSessionDiagnosticsProjection({
    get: () => canonical,
    values: () => [canonical],
  })
  assert.equal(projection.snapshot(source.agentId), null)

  canonical = source
  source.disposed = true
  assert.equal(projection.snapshot(source.agentId), null)
})

test('owns the stable E2E bridge mapping without copying runtime state', () => {
  const source = diagnosticsSource()
  const projection = new TerminalSessionDiagnosticsProjection({
    get: () => source,
    values: () => [source],
  })
  const root = {} as Document
  const bridge = projection.testBridge(root)

  source.replication.checkpointRequestCount = 31
  assert.equal(bridge.getBufferDiagnostics(source.agentId)?.checkpointRequestCount, 31)
  assert.equal(typeof bridge.getHostDiagnostics, 'function')
})

test('host diagnostics associate DOM hosts only with settled canonical records', () => {
  const settled = diagnosticsSource('settled')
  const pending = diagnosticsSource('pending')
  const mount = {
    classList: { contains: (name: string) => name === 'terminal-container' },
    querySelectorAll: () => [settled.hostEl],
  } as unknown as HTMLElement
  const createHost = (agentId: string, parentElement: HTMLElement) => ({
    dataset: { agentId },
    parentElement,
    getBoundingClientRect: () => ({ width: 640, height: 320 }),
    closest: (selector: string) => {
      if (selector === '[data-testid="code-terminal-pane"]') {
        return { getAttribute: () => agentId }
      }
      return null
    },
  }) as unknown as HTMLDivElement
  settled.hostEl = createHost('settled', mount)
  settled.attachedMount = mount
  pending.hostEl = createHost('pending', mount)
  pending.attachedMount = mount
  const pendingBootstrap = Promise.resolve(pending)
  const projection = new TerminalSessionDiagnosticsProjection({
    get: agentId => agentId === settled.agentId ? settled : pendingBootstrap,
    values: () => [settled, pendingBootstrap],
  })
  const root = {
    defaultView: { getComputedStyle: () => ({ display: 'block' }) },
    querySelectorAll: () => [settled.hostEl, pending.hostEl],
  } as unknown as Document

  assert.deepEqual(projection.hostSnapshots(root), [
    {
      agentId: 'settled',
      paneAgentId: 'settled',
      inParkingLot: false,
      recordAttached: true,
      attachedMountMatchesParent: true,
      visible: true,
      hostCountInMount: 1,
    },
    {
      agentId: 'pending',
      paneAgentId: 'pending',
      inParkingLot: false,
      recordAttached: false,
      attachedMountMatchesParent: false,
      visible: true,
      hostCountInMount: 1,
    },
  ])
})
