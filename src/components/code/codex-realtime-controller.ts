import type { AcpRealtimeEvent } from '@/types/messages'

export type CodexRealtimePhase =
  | 'idle'
  | 'requesting-permission'
  | 'connecting'
  | 'live'
  | 'stopping'
  | 'failed'
  | 'disposed'

export type CodexRealtimeStartDisposition = 'not-sent' | 'uncertain' | 'accepted' | 'rejected'

export interface CodexRealtimeSnapshot {
  phase: CodexRealtimePhase
  generation: number
  agentId: string | null
  operationId: string | null
  startDisposition: CodexRealtimeStartDisposition
  error: string
}

export class CodexRealtimeBackendError extends Error {
  readonly outcome: 'rejected' | 'uncertain'

  constructor(message: string, outcome: 'rejected' | 'uncertain') {
    super(message)
    this.name = 'CodexRealtimeBackendError'
    this.outcome = outcome
  }
}

export interface BackendStartRequest {
  agentId: string
  operationId: string
  sdp: string
}

export interface BackendStopRequest {
  agentId: string
  operationId: string
  keepalive: boolean
}

export interface CodexRealtimeControllerDependencies {
  getUserMedia: () => Promise<MediaStream>
  createPeerConnection: () => RTCPeerConnection
  createAudio: () => HTMLAudioElement
  createOperationId: () => string
  startBackend: (request: BackendStartRequest) => Promise<{ accepted: boolean }>
  stopBackend: (request: BackendStopRequest) => Promise<void>
  scheduleTimeout: (callback: () => void, delayMs: number) => number
  clearScheduledTimeout: (timerId: number) => void
  onSnapshot: (snapshot: CodexRealtimeSnapshot) => void
  onTranscript: (event: AcpRealtimeEvent) => void
  formatRealtimeError: (message: string) => string
  connectionTimeoutMs?: number
  iceGatheringTimeoutMs?: number
}

interface RealtimeOperation {
  generation: number
  agentId: string
  operationId: string
  startDisposition: CodexRealtimeStartDisposition
  cancelled: boolean
  stream: MediaStream | null
  peer: RTCPeerConnection | null
  audio: HTMLAudioElement | null
  connectionTimeout: number | null
  cancelIceWait: (() => void) | null
  runPromise: Promise<void> | null
  stopPromise: Promise<void> | null
  stopDisposition: CodexRealtimeStartDisposition | null
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000
const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 5_000

function initialSnapshot(): CodexRealtimeSnapshot {
  return {
    phase: 'idle',
    generation: 0,
    agentId: null,
    operationId: null,
    startDisposition: 'not-sent',
    error: '',
  }
}

export class CodexRealtimeController {
  private readonly dependencies: CodexRealtimeControllerDependencies
  private generation = 0
  private current: RealtimeOperation | null = null
  private disposed = false
  private snapshot = initialSnapshot()

  constructor(dependencies: CodexRealtimeControllerDependencies) {
    this.dependencies = dependencies
  }

  getSnapshot() {
    return this.snapshot
  }

  private publish(
    phase: CodexRealtimePhase,
    operation: RealtimeOperation | null,
    error = '',
  ) {
    this.snapshot = {
      phase,
      generation: operation?.generation ?? this.generation,
      agentId: operation?.agentId ?? null,
      operationId: operation?.operationId ?? null,
      startDisposition: operation?.startDisposition ?? 'not-sent',
      error,
    }
    if (!this.disposed) this.dependencies.onSnapshot(this.snapshot)
  }

  private isCurrent(operation: RealtimeOperation) {
    return !this.disposed
      && !operation.cancelled
      && this.current === operation
      && this.generation === operation.generation
  }

  private cleanupLocal(operation: RealtimeOperation) {
    operation.cancelIceWait?.()
    operation.cancelIceWait = null
    if (operation.connectionTimeout !== null) {
      this.dependencies.clearScheduledTimeout(operation.connectionTimeout)
      operation.connectionTimeout = null
    }
    if (operation.peer) {
      operation.peer.ontrack = null
      operation.peer.onconnectionstatechange = null
      operation.peer.close()
      operation.peer = null
    }
    operation.stream?.getTracks().forEach(track => track.stop())
    operation.stream = null
    if (operation.audio) {
      operation.audio.pause()
      operation.audio.srcObject = null
      operation.audio = null
    }
  }

  private async reconcileStop(
    operation: RealtimeOperation,
    options: { force?: boolean, keepalive?: boolean } = {},
  ) {
    if (
      operation.stopPromise
      && !options.force
      && operation.stopDisposition === operation.startDisposition
    ) {
      return operation.stopPromise
    }
    const previous = operation.stopPromise
    const stopDisposition = operation.startDisposition
    const stopPromise = (async () => {
      await previous?.catch(() => undefined)
      await this.dependencies.stopBackend({
        agentId: operation.agentId,
        operationId: operation.operationId,
        keepalive: options.keepalive === true || this.disposed,
      })
    })()
    operation.stopPromise = stopPromise
    operation.stopDisposition = stopDisposition
    return stopPromise
  }

  private waitForIceGathering(operation: RealtimeOperation, peer: RTCPeerConnection) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.dependencies.clearScheduledTimeout(timeout)
        peer.removeEventListener('icegatheringstatechange', handleStateChange)
        if (operation.cancelIceWait === finish) operation.cancelIceWait = null
        resolve()
      }
      const handleStateChange = () => {
        if (peer.iceGatheringState === 'complete') finish()
      }
      const timeout = this.dependencies.scheduleTimeout(
        finish,
        this.dependencies.iceGatheringTimeoutMs ?? DEFAULT_ICE_GATHERING_TIMEOUT_MS,
      )
      operation.cancelIceWait = finish
      peer.addEventListener('icegatheringstatechange', handleStateChange)
    })
  }

  private async failAndReconcile(operation: RealtimeOperation, message: string) {
    if (!this.isCurrent(operation)) return
    operation.cancelled = true
    this.generation += 1
    this.cleanupLocal(operation)
    this.publish('stopping', operation, message)
    try {
      if (operation.startDisposition === 'uncertain' || operation.startDisposition === 'accepted') {
        await this.reconcileStop(operation)
      }
    } catch (error) {
      const stopMessage = error instanceof Error ? error.message : 'Failed to stop Codex realtime voice'
      if (this.current === operation) this.publish('failed', operation, `${message} (${stopMessage})`)
      return
    }
    if (this.current === operation) {
      this.current = null
      this.publish('failed', null, message)
    }
  }

  private async runStart(operation: RealtimeOperation) {
    let peer: RTCPeerConnection | null = null
    try {
      const stream = await this.dependencies.getUserMedia()
      if (!this.isCurrent(operation)) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      operation.stream = stream
      peer = this.dependencies.createPeerConnection()
      operation.peer = peer
      const audio = this.dependencies.createAudio()
      audio.autoplay = true
      operation.audio = audio
      peer.ontrack = event => {
        if (!this.isCurrent(operation)) return
        audio.srcObject = event.streams[0] || new MediaStream([event.track])
        void audio.play().catch(() => {
          if (this.isCurrent(operation)) {
            this.publish(this.snapshot.phase, operation, 'The browser blocked voice playback. Click the microphone again to retry.')
          }
        })
      }
      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) throw new Error('The microphone did not provide an audio track')
      peer.addTrack(audioTrack, stream)
      peer.createDataChannel('oai-events')
      const offer = await peer.createOffer()
      if (!this.isCurrent(operation)) return
      await peer.setLocalDescription(offer)
      if (!this.isCurrent(operation)) return
      await this.waitForIceGathering(operation, peer)
      if (!this.isCurrent(operation)) return
      const sdp = peer.localDescription?.sdp || ''
      if (!sdp) throw new Error('The browser did not create a WebRTC offer')

      operation.connectionTimeout = this.dependencies.scheduleTimeout(() => {
        if (!this.isCurrent(operation) || operation.peer?.remoteDescription) return
        void this.failAndReconcile(operation, 'Codex realtime voice connection timed out')
      }, this.dependencies.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS)
      peer.onconnectionstatechange = () => {
        if (this.isCurrent(operation) && peer?.connectionState === 'failed') {
          void this.failAndReconcile(operation, 'Codex realtime voice connection failed')
        }
      }
      operation.startDisposition = 'uncertain'
      this.publish('connecting', operation)
      const result = await this.dependencies.startBackend({
        agentId: operation.agentId,
        operationId: operation.operationId,
        sdp,
      })
      operation.startDisposition = result.accepted ? 'accepted' : 'rejected'
      if (!this.isCurrent(operation)) {
        if (result.accepted) await this.reconcileStop(operation, { force: true })
        return
      }
      if (!result.accepted) {
        this.cleanupLocal(operation)
        this.current = null
        this.publish('failed', null, 'Codex realtime voice start was cancelled')
        return
      }
      this.publish(this.snapshot.phase === 'live' ? 'live' : 'connecting', operation, this.snapshot.error)
    } catch (error) {
      const backendError = error instanceof CodexRealtimeBackendError ? error : null
      operation.startDisposition = backendError?.outcome === 'rejected' ? 'rejected' : operation.startDisposition
      const message = error instanceof Error ? error.message : 'Failed to start Codex realtime voice'
      if (operation.startDisposition === 'uncertain' && this.isCurrent(operation)) {
        await this.failAndReconcile(operation, message)
        return
      }
      if (operation.startDisposition === 'uncertain') await this.reconcileStop(operation).catch(() => undefined)
      if (!this.isCurrent(operation)) {
        this.cleanupLocal(operation)
        return
      }
      this.cleanupLocal(operation)
      this.current = null
      this.publish('failed', null, message)
    }
  }

  async start(agentId: string) {
    if (this.disposed) return
    const current = this.current
    if (current) {
      if (!current.cancelled && current.agentId === agentId) return current.runPromise
      const stopped = await this.stop()
      if (!stopped) return
      if (this.disposed) return
    }

    const operation: RealtimeOperation = {
      generation: this.generation + 1,
      agentId,
      operationId: this.dependencies.createOperationId(),
      startDisposition: 'not-sent',
      cancelled: false,
      stream: null,
      peer: null,
      audio: null,
      connectionTimeout: null,
      cancelIceWait: null,
      runPromise: null,
      stopPromise: null,
      stopDisposition: null,
    }
    this.generation = operation.generation
    this.current = operation
    this.publish('requesting-permission', operation)
    operation.runPromise = this.runStart(operation)
    return operation.runPromise
  }

  async toggle(agentId: string) {
    if (this.current) return this.stop()
    return this.start(agentId)
  }

  async stop() {
    const operation = this.current
    if (!operation) {
      if (!this.disposed) this.publish('idle', null)
      return true
    }
    if (!operation.cancelled) {
      operation.cancelled = true
      this.generation += 1
      this.cleanupLocal(operation)
    }
    if (operation.startDisposition === 'not-sent' || operation.startDisposition === 'rejected') {
      if (this.current === operation) {
        this.current = null
        this.publish('idle', null)
      }
      return true
    }

    this.publish('stopping', operation)
    try {
      await this.reconcileStop(operation)
      if (this.current === operation) {
        this.current = null
        this.publish('idle', null)
      }
      return true
    } catch (error) {
      if (this.current === operation) {
        this.publish(
          'failed',
          operation,
          error instanceof Error ? error.message : 'Failed to stop Codex realtime voice',
        )
      }
      return false
    }
  }

  ownerChanged(agentId: string | null) {
    if (this.current && this.current.agentId !== agentId) void this.stop()
  }

  async handleEvent(event: AcpRealtimeEvent) {
    const operation = this.current
    if (
      !operation
      || operation.agentId !== event.agentId
      || operation.operationId !== event.operationId
      || operation.cancelled
    ) return
    if (event.method === 'thread/realtime/sdp') {
      const sdp = typeof event.params.sdp === 'string' ? event.params.sdp : ''
      if (!sdp || !operation.peer) return
      try {
        await operation.peer.setRemoteDescription({ type: 'answer', sdp })
        if (!this.isCurrent(operation)) return
        if (operation.connectionTimeout !== null) {
          this.dependencies.clearScheduledTimeout(operation.connectionTimeout)
          operation.connectionTimeout = null
        }
        this.publish('live', operation, this.snapshot.error)
      } catch (error) {
        await this.failAndReconcile(
          operation,
          error instanceof Error ? error.message : 'Failed to accept the Codex voice connection',
        )
      }
      return
    }
    if (event.method === 'thread/realtime/transcript/delta' || event.method === 'thread/realtime/transcript/done') {
      this.dependencies.onTranscript(event)
      return
    }
    if (event.method === 'thread/realtime/error') {
      const message = typeof event.params.message === 'string' ? event.params.message : 'Codex realtime voice failed'
      await this.failAndReconcile(operation, this.dependencies.formatRealtimeError(message))
      return
    }
    if (event.method === 'thread/realtime/closed') {
      operation.cancelled = true
      this.generation += 1
      this.cleanupLocal(operation)
      if (this.current === operation) {
        this.current = null
        this.publish('idle', null)
      }
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    const operation = this.current
    this.current = null
    this.snapshot = {
      phase: 'disposed',
      generation: this.generation,
      agentId: null,
      operationId: null,
      startDisposition: 'not-sent',
      error: '',
    }
    if (!operation) return
    operation.cancelled = true
    this.cleanupLocal(operation)
    if (operation.startDisposition === 'uncertain' || operation.startDisposition === 'accepted') {
      await this.reconcileStop(operation, { keepalive: true }).catch(() => undefined)
    }
  }
}
