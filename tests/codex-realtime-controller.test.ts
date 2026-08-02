import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CodexRealtimeController,
  type CodexRealtimeControllerDependencies,
  type CodexRealtimePhase,
  type CodexRealtimeSnapshot,
} from '../src/components/code/codex-realtime-controller'
import { createCodexRealtimeHttpClient } from '../src/components/code/codex-realtime-http'
import type { AcpRealtimeEvent } from '../src/types/messages'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class FakeTrack {
  stopped = false

  stop() {
    this.stopped = true
  }
}

class FakeStream {
  readonly track = new FakeTrack()

  getAudioTracks() {
    return [this.track]
  }

  getTracks() {
    return [this.track]
  }
}

class FakeAudio {
  autoplay = false
  paused = false
  srcObject: MediaProvider | null = null

  play() {
    return Promise.resolve()
  }

  pause() {
    this.paused = true
  }
}

class FakePeer {
  iceGatheringState: RTCIceGatheringState = 'complete'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: RTCSessionDescription | null = null
  remoteDescription: RTCSessionDescription | null = null
  ontrack: ((event: RTCTrackEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  closed = false
  remoteDescriptionError: Error | null = null
  private readonly listeners = new Set<() => void>()

  addTrack() {
    return {} as RTCRtpSender
  }

  createDataChannel() {
    return {} as RTCDataChannel
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'v=0\r\nfake-offer' } as RTCSessionDescriptionInit)
  }

  setLocalDescription(description: RTCLocalSessionDescriptionInit) {
    this.localDescription = { type: description.type || 'offer', sdp: description.sdp || '' } as RTCSessionDescription
    return Promise.resolve()
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.remoteDescriptionError) return Promise.reject(this.remoteDescriptionError)
    this.remoteDescription = { type: description.type, sdp: description.sdp || '' } as RTCSessionDescription
    return Promise.resolve()
  }

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener === 'function') this.listeners.add(listener as () => void)
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener === 'function') this.listeners.delete(listener as () => void)
  }

  close() {
    this.closed = true
  }
}

interface HarnessOptions {
  media?: ReturnType<typeof deferred<MediaStream>>
  start?: ReturnType<typeof deferred<{ accepted: boolean }>>
  startBackend?: CodexRealtimeControllerDependencies['startBackend']
  stopBackend?: CodexRealtimeControllerDependencies['stopBackend']
}

function createHarness(options: HarnessOptions = {}) {
  const fakeStream = new FakeStream()
  const media = options.media || deferred<MediaStream>()
  if (!options.media) media.resolve(fakeStream as unknown as MediaStream)
  const start = options.start || deferred<{ accepted: boolean }>()
  if (!options.start) start.resolve({ accepted: true })
  const peers: FakePeer[] = []
  const audio = new FakeAudio()
  const transcripts: AcpRealtimeEvent[] = []
  const snapshots: CodexRealtimeSnapshot[] = []
  const snapshotWaiters = new Set<{
    predicate: (snapshot: CodexRealtimeSnapshot) => boolean
    resolve: (snapshot: CodexRealtimeSnapshot) => void
  }>()
  const startRequests: Array<{ agentId: string, operationId: string, sdp: string }> = []
  const stopRequests: Array<{ agentId: string, operationId: string, keepalive: boolean }> = []
  const timers = new Map<number, () => void>()
  let timerId = 0
  let operationId = 0
  let mediaRequests = 0

  const onSnapshot = (snapshot: CodexRealtimeSnapshot) => {
    snapshots.push(snapshot)
    for (const waiter of snapshotWaiters) {
      if (!waiter.predicate(snapshot)) continue
      snapshotWaiters.delete(waiter)
      waiter.resolve(snapshot)
    }
  }
  const dependencies: CodexRealtimeControllerDependencies = {
    getUserMedia: () => {
      mediaRequests += 1
      return media.promise
    },
    createPeerConnection: () => {
      const peer = new FakePeer()
      peers.push(peer)
      return peer as unknown as RTCPeerConnection
    },
    createAudio: () => audio as unknown as HTMLAudioElement,
    createOperationId: () => `voice-op-${++operationId}`,
    startBackend: options.startBackend || (request => {
      startRequests.push(request)
      return start.promise
    }),
    stopBackend: options.stopBackend || (async request => {
      stopRequests.push(request)
    }),
    scheduleTimeout: callback => {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearScheduledTimeout: id => {
      timers.delete(id)
    },
    onSnapshot,
    onTranscript: event => {
      transcripts.push(event)
    },
    formatRealtimeError: message => message,
  }
  const controller = new CodexRealtimeController(dependencies)

  return {
    controller,
    fakeStream,
    media,
    peers,
    snapshots,
    start,
    startRequests,
    stopRequests,
    transcripts,
    timers,
    get peer() {
      const peer = peers.at(-1)
      assert.ok(peer)
      return peer
    },
    get mediaRequests() { return mediaRequests },
    waitForPhase(phase: CodexRealtimePhase) {
      const current = controller.getSnapshot()
      if (current.phase === phase) return Promise.resolve(current)
      return new Promise<CodexRealtimeSnapshot>(resolve => {
        snapshotWaiters.add({ predicate: snapshot => snapshot.phase === phase, resolve })
      })
    },
  }
}

function sdpEvent(agentId: string, operationId: string): AcpRealtimeEvent {
  return {
    agentId,
    sessionId: 'session-1',
    operationId,
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0\r\nfake-answer' },
  }
}

test('rapid double toggle cancels one permission request without starting a duplicate', async () => {
  const media = deferred<MediaStream>()
  const harness = createHarness({ media })
  const first = harness.controller.toggle('agent-a')

  assert.equal(harness.controller.getSnapshot().phase, 'requesting-permission')
  await harness.controller.toggle('agent-a')
  assert.equal(harness.controller.getSnapshot().phase, 'idle')
  assert.equal(harness.mediaRequests, 1)

  media.resolve(harness.fakeStream as unknown as MediaStream)
  await first
  assert.equal(harness.fakeStream.track.stopped, true)
  assert.equal(harness.startRequests.length, 0)
})

test('Agent switch invalidates a pending microphone continuation', async () => {
  const media = deferred<MediaStream>()
  const harness = createHarness({ media })
  const starting = harness.controller.start('agent-a')

  harness.controller.ownerChanged('agent-b')
  media.resolve(harness.fakeStream as unknown as MediaStream)
  await starting

  assert.equal(harness.controller.getSnapshot().phase, 'idle')
  assert.equal(harness.fakeStream.track.stopped, true)
  assert.equal(harness.startRequests.length, 0)
})

test('late accepted start after Agent switch is reconciled with the same operation ID', async () => {
  const start = deferred<{ accepted: boolean }>()
  const harness = createHarness({ start })
  const connecting = harness.waitForPhase('connecting')
  const starting = harness.controller.start('agent-a')
  await connecting
  const operationId = harness.startRequests[0]?.operationId
  assert.ok(operationId)

  harness.controller.ownerChanged('agent-b')
  await harness.waitForPhase('idle')
  assert.deepEqual(harness.stopRequests, [{ agentId: 'agent-a', operationId, keepalive: false }])

  start.resolve({ accepted: true })
  await starting
  assert.deepEqual(harness.stopRequests, [
    { agentId: 'agent-a', operationId, keepalive: false },
    { agentId: 'agent-a', operationId, keepalive: false },
  ])
})

test('remote SDP failure closes local media and reconciles an accepted start', async () => {
  const harness = createHarness()
  await harness.controller.start('agent-a')
  const operationId = harness.startRequests[0]?.operationId
  assert.ok(operationId)
  harness.peer.remoteDescriptionError = new Error('bad remote SDP')

  await harness.controller.handleEvent(sdpEvent('agent-a', operationId))

  assert.equal(harness.controller.getSnapshot().phase, 'failed')
  assert.equal(harness.controller.getSnapshot().agentId, 'agent-a')
  assert.equal(harness.controller.getSnapshot().operationId, operationId)
  assert.equal(harness.controller.getSnapshot().error, 'bad remote SDP')
  assert.equal(harness.peer.closed, true)
  assert.equal(harness.fakeStream.track.stopped, true)
  assert.equal(harness.stopRequests.length, 1)
})

test('connection timeout follows stop/reconcile without waiting for wall-clock time', async () => {
  const harness = createHarness()
  const failed = harness.waitForPhase('failed')
  await harness.controller.start('agent-a')
  assert.equal(harness.timers.size, 1)

  const timeout = harness.timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await failed

  assert.equal(harness.controller.getSnapshot().agentId, 'agent-a')
  assert.equal(harness.controller.getSnapshot().error, 'Codex realtime voice connection timed out')
  assert.equal(harness.stopRequests.length, 1)
  assert.equal(harness.fakeStream.track.stopped, true)
})

test('an owner-bearing failed snapshot can retry and dispose the replacement operation', async () => {
  const requests: Array<{ agentId: string, operationId: string }> = []
  const stops: Array<{ agentId: string, operationId: string, keepalive: boolean }> = []
  const harness = createHarness({
    startBackend: async request => {
      requests.push(request)
      return { accepted: requests.length > 1 }
    },
    stopBackend: async request => {
      stops.push(request)
    },
  })

  await harness.controller.start('agent-a')
  const failed = harness.controller.getSnapshot()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.agentId, 'agent-a')
  assert.equal(failed.operationId, requests[0]?.operationId)

  await harness.controller.toggle('agent-a')
  const replacement = harness.controller.getSnapshot()
  assert.equal(replacement.phase, 'connecting')
  assert.equal(replacement.agentId, 'agent-a')
  assert.notEqual(replacement.operationId, failed.operationId)

  await harness.controller.dispose()
  assert.deepEqual(stops, [{
    agentId: 'agent-a',
    operationId: replacement.operationId,
    keepalive: true,
  }])
})

test('dispose reconciles an in-flight accepted start with keepalive', async () => {
  const start = deferred<{ accepted: boolean }>()
  const harness = createHarness({ start })
  const connecting = harness.waitForPhase('connecting')
  const starting = harness.controller.start('agent-a')
  await connecting
  const operationId = harness.startRequests[0]?.operationId
  assert.ok(operationId)

  await harness.controller.dispose()
  assert.equal(harness.controller.getSnapshot().phase, 'disposed')
  assert.deepEqual(harness.stopRequests, [{ agentId: 'agent-a', operationId, keepalive: true }])

  start.resolve({ accepted: true })
  await starting
  assert.deepEqual(harness.stopRequests, [
    { agentId: 'agent-a', operationId, keepalive: true },
    { agentId: 'agent-a', operationId, keepalive: true },
  ])
  assert.equal(harness.peer.closed, true)
  assert.equal(harness.fakeStream.track.stopped, true)
})

test('events from stopped operation A cannot mutate replacement operation B', async () => {
  const harness = createHarness()
  await harness.controller.start('agent-a')
  const operationA = harness.startRequests[0]?.operationId
  assert.ok(operationA)
  await harness.controller.stop()

  await harness.controller.start('agent-a')
  const operationB = harness.startRequests[1]?.operationId
  assert.ok(operationB)
  const peerB = harness.peer
  const stopCount = harness.stopRequests.length

  await harness.controller.handleEvent(sdpEvent('agent-a', operationA))
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    operationId: operationA,
    method: 'thread/realtime/error',
    params: { message: 'old failure' },
  })
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    operationId: operationA,
    method: 'thread/realtime/closed',
    params: {},
  })
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    operationId: operationA,
    method: 'thread/realtime/transcript/done',
    params: { role: 'user', text: 'old transcript' },
  })

  assert.equal(harness.controller.getSnapshot().operationId, operationB)
  assert.equal(harness.controller.getSnapshot().phase, 'connecting')
  assert.equal(peerB.remoteDescription, null)
  assert.equal(peerB.closed, false)
  assert.equal(harness.stopRequests.length, stopCount)
  assert.equal(harness.transcripts.length, 0)
})

test('legacy events without an operation ID cannot mutate the active operation', async () => {
  const harness = createHarness()
  await harness.controller.start('agent-a')
  const operationId = harness.startRequests[0]?.operationId
  assert.ok(operationId)
  const peer = harness.peer
  const stopCount = harness.stopRequests.length

  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    method: 'thread/realtime/sdp',
    params: { sdp: 'v=0' },
  })
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    method: 'thread/realtime/error',
    params: { message: 'legacy failure' },
  })
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    method: 'thread/realtime/closed',
    params: {},
  })
  await harness.controller.handleEvent({
    agentId: 'agent-a',
    sessionId: 'session-1',
    method: 'thread/realtime/transcript/done',
    params: { role: 'user', text: 'legacy transcript' },
  })

  assert.equal(harness.controller.getSnapshot().operationId, operationId)
  assert.equal(harness.controller.getSnapshot().phase, 'connecting')
  assert.equal(peer.remoteDescription, null)
  assert.equal(peer.closed, false)
  assert.equal(harness.stopRequests.length, stopCount)
  assert.equal(harness.transcripts.length, 0)
})

function createHttpTimers() {
  const timers = new Map<number, () => void>()
  let timerId = 0
  return {
    timers,
    scheduleTimeout(callback: () => void) {
      const id = ++timerId
      timers.set(id, callback)
      return id
    },
    clearScheduledTimeout(id: number) {
      timers.delete(id)
    },
  }
}

test('a stalled start response body times out, reconciles, and leaves connecting', async () => {
  const httpTimers = createHttpTimers()
  const stalledBody = {
    ok: true,
    status: 200,
    json: () => new Promise<Record<string, unknown>>(() => {}),
  } as Response
  const http = createCodexRealtimeHttpClient({
    fetch: async (input, init) => {
      if (String(input).endsWith('/start')) return stalledBody
      const operationId = JSON.parse(String(init?.body)).operationId
      return Response.json({ reconciled: true, operationId })
    },
    buildPath: path => path,
    scheduleTimeout: httpTimers.scheduleTimeout,
    clearScheduledTimeout: httpTimers.clearScheduledTimeout,
  })
  const harness = createHarness({
    startBackend: http.startBackend,
    stopBackend: http.stopBackend,
  })
  const failed = harness.waitForPhase('failed')
  const starting = harness.controller.start('agent-a')
  await harness.waitForPhase('connecting')
  const timeout = httpTimers.timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  await starting
  await failed

  assert.equal(harness.controller.getSnapshot().phase, 'failed')
  assert.match(harness.controller.getSnapshot().error, /start request timed out/i)
})

test('a stalled stop response body leaves a visible poisoned fence that blocks replacement', async () => {
  const httpTimers = createHttpTimers()
  const stalledBody = {
    ok: true,
    status: 200,
    json: () => new Promise<Record<string, unknown>>(() => {}),
  } as Response
  let startCalls = 0
  const http = createCodexRealtimeHttpClient({
    fetch: async (input, init) => {
      const operationId = JSON.parse(String(init?.body)).operationId
      if (String(input).endsWith('/start')) {
        startCalls += 1
        return Response.json({ started: true, operationId })
      }
      return stalledBody
    },
    buildPath: path => path,
    scheduleTimeout: httpTimers.scheduleTimeout,
    clearScheduledTimeout: httpTimers.clearScheduledTimeout,
  })
  const harness = createHarness({
    startBackend: http.startBackend,
    stopBackend: http.stopBackend,
  })
  await harness.controller.start('agent-a')
  const operationId = harness.controller.getSnapshot().operationId
  assert.ok(operationId)

  const stopping = harness.controller.stop()
  await Promise.resolve()
  const timeout = httpTimers.timers.values().next().value
  assert.equal(typeof timeout, 'function')
  timeout?.()
  assert.equal(await stopping, false)
  assert.equal(harness.controller.getSnapshot().phase, 'failed')
  assert.equal(harness.controller.getSnapshot().operationId, operationId)

  await harness.controller.start('agent-a')
  assert.equal(startCalls, 1, 'replacement start must not cross a failed stop fence')
  assert.equal(harness.controller.getSnapshot().operationId, operationId)
})
