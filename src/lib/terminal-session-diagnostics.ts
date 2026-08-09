import type { FarmingTerminal } from '@/lib/terminal-engine'
import { isTerminalHostAttached } from '@/lib/terminal-attachment'
import type { TerminalAttachmentCoordinator } from '@/lib/terminal-attachment-coordinator'
import type { TerminalResizeEffectController } from '@/lib/terminal-resize-effect-controller'
import type { TerminalResizeDimensions } from '@/lib/terminal-resize'
import {
  getTerminalScrollbackLength,
  getTerminalViewportY,
  getTerminalVisibleBufferBase,
} from '@/lib/terminal-viewport'

type TerminalBuffer = NonNullable<NonNullable<FarmingTerminal['buffer']>['active']>

export interface TerminalSessionDiagnosticsSource {
  agentId: string
  hostEl: HTMLDivElement
  attachedMount: HTMLElement | null
  disposed: boolean
  terminal: FarmingTerminal
  attachment: TerminalAttachmentCoordinator
  resizeEffects: TerminalResizeEffectController
  terminalWriteBatchCount: number
  checkpointRequestInFlight: boolean
  checkpointRequestCount: number
  bootstrapRefreshSeq: number
  replayInProgress: boolean
  bootstrappingSnapshot: boolean
  pendingSnapshotReplay: boolean
  fixtureOverrideActive: boolean
  pageOutputSuspended: boolean
  suppressOutputUntil: number
  needsReconnectOutputSync: boolean
}

export interface TerminalSessionDiagnostics {
  engine?: string
  renderer?: 'pending' | 'webgl' | 'failed'
  cols: number
  rows: number
  viewportY: number
  scrollbackLength: number
  visibleBufferBase: number
  bufferViewportY?: number
  bufferBaseY?: number
  bufferLength?: number
  queuedTransitions: number
  queuedBytes: number
  terminalWriteBatchCount: number
  replayTargetEpoch: string
  replayTargetRevision: number | null
  checkpointHalted: boolean
  checkpointFailureCount: number
  checkpointRequestInFlight: boolean
  replayInProgress: boolean
  bootstrappingSnapshot: boolean
  pendingSnapshotReplay: boolean
  runtimeEpoch: string
  stateRevision: number | null
  lastOutputSeq: number | null
  reconnectSnapshotSeq: number
  checkpointRequestCount: number
  bootstrapRefreshSeq: number
  attachGeneration: number
  currentAttachment: boolean
  attachedMount: boolean
  fixtureOverrideActive: boolean
  pageOutputSuspended: boolean
  suppressOutputForMs: number
  needsReconnectOutputSync: boolean
  lastNotifiedResize: TerminalResizeDimensions | null
  resizeNotificationCount: number
  resizeRequestInFlight: TerminalResizeDimensions | null
  pendingResizeRequest: TerminalResizeDimensions | null
  pendingFitResize: TerminalResizeDimensions | null
  fitResizeTimerPending: boolean
  resizeRedrawTimerPending: boolean
  resizeDeliveryTimeoutPending: boolean
}

export interface TerminalHostDiagnostics {
  agentId: string
  paneAgentId: string
  inParkingLot: boolean
  recordAttached: boolean
  attachedMountMatchesParent: boolean
  visible: boolean
  hostCountInMount: number
}

export interface TerminalDiagnosticsTestBridge {
  getBufferDiagnostics: (agentId: string) => TerminalSessionDiagnostics | null
  getHostDiagnostics: () => TerminalHostDiagnostics[]
}

export interface TerminalSessionDiagnosticsPorts {
  get: (
    agentId: string,
  ) => TerminalSessionDiagnosticsSource | Promise<TerminalSessionDiagnosticsSource> | undefined
  values: () => Iterable<TerminalSessionDiagnosticsSource | Promise<TerminalSessionDiagnosticsSource>>
  now?: () => number
}

/**
 * Owns the terminal diagnostics bridge contract and its lazy read-only
 * projection. Exact identity stays in the injected Session registry ports;
 * mutable runtime state stays in its production owners and is read only when
 * an explicit diagnostics request is made.
 */
export class TerminalSessionDiagnosticsProjection {
  readonly #ports: TerminalSessionDiagnosticsPorts
  readonly #now: () => number

  constructor(ports: TerminalSessionDiagnosticsPorts) {
    this.#ports = ports
    this.#now = ports.now ?? Date.now
  }

  testBridge(root: Document = document): TerminalDiagnosticsTestBridge {
    return {
      getBufferDiagnostics: agentId => this.snapshot(agentId),
      getHostDiagnostics: () => this.hostSnapshots(root),
    }
  }

  snapshot(agentId: string): TerminalSessionDiagnostics | null {
    const current = this.#ports.get(agentId)
    if (!current || current instanceof Promise || current.disposed) return null

    const buffer = current.terminal.buffer?.active as (TerminalBuffer & {
      viewportY?: number
      baseY?: number
    }) | undefined
    const resize = current.resizeEffects.diagnostics()
    const attachment = current.attachment.snapshot()
    const generation = current.attachment.generation

    return {
      engine: current.terminal.__farmingTerminalEngine,
      renderer: current.terminal.getRendererType?.(),
      cols: current.terminal.cols || 0,
      rows: current.terminal.rows || 0,
      viewportY: getTerminalViewportY(current.terminal),
      scrollbackLength: getTerminalScrollbackLength(current.terminal),
      visibleBufferBase: getTerminalVisibleBufferBase(current.terminal),
      bufferViewportY: typeof buffer?.viewportY === 'number' ? buffer.viewportY : undefined,
      bufferBaseY: typeof buffer?.baseY === 'number' ? buffer.baseY : undefined,
      bufferLength: typeof buffer?.length === 'number' ? buffer.length : undefined,
      queuedTransitions: attachment.queuedTransitions,
      queuedBytes: attachment.queuedBytes,
      terminalWriteBatchCount: current.terminalWriteBatchCount,
      replayTargetEpoch: attachment.replayTargetEpoch,
      replayTargetRevision: attachment.replayTargetRevision,
      checkpointHalted: attachment.halted,
      checkpointFailureCount: attachment.failureCount,
      checkpointRequestInFlight: current.checkpointRequestInFlight,
      replayInProgress: current.replayInProgress,
      bootstrappingSnapshot: current.bootstrappingSnapshot,
      pendingSnapshotReplay: current.pendingSnapshotReplay,
      runtimeEpoch: attachment.runtimeEpoch,
      stateRevision: attachment.stateRevision,
      lastOutputSeq: attachment.outputSeq,
      reconnectSnapshotSeq: attachment.revision,
      checkpointRequestCount: current.checkpointRequestCount,
      bootstrapRefreshSeq: current.bootstrapRefreshSeq,
      attachGeneration: generation,
      currentAttachment: current.attachment.isCurrentGeneration(generation)
        && isTerminalHostAttached(current),
      attachedMount: current.attachedMount !== null,
      fixtureOverrideActive: current.fixtureOverrideActive,
      pageOutputSuspended: current.pageOutputSuspended,
      suppressOutputForMs: Math.max(0, current.suppressOutputUntil - this.#now()),
      needsReconnectOutputSync: current.needsReconnectOutputSync,
      ...resize,
    }
  }

  hostSnapshots(root: Document = document): TerminalHostDiagnostics[] {
    const view = root.defaultView
    return Array.from(root.querySelectorAll('.terminal-session-host')).map(host => {
      const hostEl = host as HTMLDivElement
      const record = this.#findByHost(hostEl)
      const rect = hostEl.getBoundingClientRect()
      const parent = hostEl.parentElement
      const mount = parent?.classList.contains('terminal-container') ? parent : null
      return {
        agentId: hostEl.dataset.agentId || '',
        paneAgentId: hostEl.closest('[data-testid="code-terminal-pane"]')?.getAttribute('data-agent-id') || '',
        inParkingLot: hostEl.closest('#terminal-session-parking-lot') !== null,
        recordAttached: record ? isTerminalHostAttached(record) : false,
        attachedMountMatchesParent: record
          ? record.attachedMount !== null && record.hostEl.parentElement === record.attachedMount
          : false,
        visible: Boolean(
          view
          && rect.width > 0
          && rect.height > 0
          && view.getComputedStyle(hostEl).display !== 'none',
        ),
        hostCountInMount: mount ? mount.querySelectorAll('.terminal-session-host').length : 0,
      }
    })
  }

  #findByHost(hostEl: HTMLDivElement) {
    for (const record of this.#ports.values()) {
      if (record instanceof Promise || record.disposed) continue
      if (record.hostEl === hostEl) return record
    }
    return null
  }
}
