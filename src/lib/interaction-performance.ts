import {
  InteractionPerformanceRecorder, PERFORMANCE_LIMITS,
  type InteractionPerformanceRecord, type PerformanceOperation, type PerformanceOutcome,
  type PerformanceTrace,
} from '../../shared/interaction-performance'
import { appPath } from './base-path'

const pageId = `p-${Math.random().toString(36).slice(2)}`
const queue: InteractionPerformanceRecord[] = []
let discarded = 0
let sample = 0
let initialized = false
let sending = false
let disabled = false
const longTasks: Array<{ start: number; end: number; duration: number }> = []
const inputEvents = new WeakMap<Element, { time: number; captured: number }>()
const terminalInputs = new Map<string, Array<{ trace: PerformanceTrace; epoch: string; after: number; output?: number }>>()
const navigation = new Map<'file.open' | 'agent.switch', { key: string; trace: PerformanceTrace }>()
const frames = new Map<string, { trace: PerformanceTrace; cancel(): void }>()
const recorder = new InteractionPerformanceRecorder({
  source: 'browser', prefix: pageId, now: () => performance.now(), wallNow: Date.now,
  emit: record => {
    // Keep the complete recent ring locally, but ordinary persisted samples are 1/20.
    if (record.operation !== 'connection.probe' && !record.slow
      && (record.outcome === 'observed' || record.outcome === 'completed') && ++sample % 20 !== 0) return
    if (queue.length >= 128) { queue.shift(); discarded += 1 }
    queue.push(record)
  },
})

/** Salted labels group one page's targets without retaining paths or typed text. */
function targetLabel(key: string) {
  let hash = 2166136261
  for (const char of `${pageId}:${key}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `t-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
export function beginInteraction(operation: PerformanceOperation, options: {
  started?: number; target?: string; requestId?: string; timeout?: number; expiry?: PerformanceOutcome; requestKind?: InteractionPerformanceRecord['requestKind']
} = {}) {
  return recorder.begin(operation, { ...options, target: options.target ? targetLabel(options.target) : undefined,
    threshold: operation.endsWith('.input') ? 100 : operation === 'browser.long-task' ? 50 : 500 })
}
function inputStart(host: Element | null) {
  const input = host ? inputEvents.get(host) : undefined
  if (host) inputEvents.delete(host)
  return input && performance.now() - input.captured < 5000 ? input.time : undefined
}
export function afterInteractionFrame(trace: PerformanceTrace, host: HTMLElement | null, outcome: PerformanceOutcome = 'observed') {
  if (!trace.active() || frames.has(trace.id)) return
  if (frames.size >= PERFORMANCE_LIMITS.pending) {
    const first = frames.entries().next().value
    if (first) { first[1].cancel(); first[1].trace.end('unobserved'); frames.delete(first[0]) }
  }
  let frame = requestAnimationFrame(() => {
    // The second frame is an opportunity after the owner's commit, not proof of GPU presentation.
    frame = requestAnimationFrame(() => {
      frames.delete(trace.id)
      if (!trace.active()) return
      if (document.visibilityState === 'hidden' || !host?.isConnected || host.getClientRects().length === 0) {
        trace.end('hidden'); return
      }
      trace.mark('frame')
      const overlapping = longTasks.filter(task => task.end >= trace.startTime)
      trace.metric({ longTaskCount: overlapping.length, longTaskMaxMs: Math.max(0, ...overlapping.map(task => task.duration)) })
      trace.end(outcome)
    })
  })
  frames.set(trace.id, { trace, cancel: () => cancelAnimationFrame(frame) })
}
export function beginTerminalInputPerformance(agentId: string, host: HTMLElement, epoch: string, outputSeq: number | null, inputUnits: number) {
  const trace = beginInteraction('terminal.input', { started: inputStart(host), target: agentId, timeout: 3000, expiry: 'unobserved' })
  trace.mark('handler')
  trace.metric({ inputUnits, inputCount: 1 })
  const pending = (terminalInputs.get(agentId) || []).filter(entry => entry.trace.active())
  pending.push({ trace, epoch, after: outputSeq ?? -1 })
  if (terminalInputs.size >= PERFORMANCE_LIMITS.pending && !terminalInputs.has(agentId)) {
    const first = terminalInputs.keys().next().value
    if (first) { terminalInputs.get(first)?.forEach(e => e.trace.end('unobserved')); terminalInputs.delete(first) }
  }
  terminalInputs.set(agentId, pending)
  return trace
}
export function observeTerminalPerformanceOutput(agentId: string, epoch: string | null | undefined, seq: number | null | undefined) {
  for (const entry of terminalInputs.get(agentId) || []) {
    if (!entry.trace.active()) continue
    if (entry.epoch !== epoch) { entry.trace.end('superseded'); continue }
    if (entry.output === undefined && typeof seq === 'number' && seq > entry.after) {
      entry.output = seq
      entry.trace.mark('output')
    }
  }
}
export function terminalPerformanceRendered(agentId: string, epoch: string | undefined, seq: number | null | undefined, host: HTMLElement) {
  const entries = terminalInputs.get(agentId) || []
  const remaining = entries.filter(entry => {
    if (!entry.trace.active()) return false
    if (entry.epoch !== epoch) { entry.trace.end('superseded'); return false }
    if (entry.output !== undefined && typeof seq === 'number' && entry.output <= seq) {
      entry.trace.mark('renderer')
      afterInteractionFrame(entry.trace, host)
      return false
    }
    return true
  })
  if (remaining.length) terminalInputs.set(agentId, remaining)
  else terminalInputs.delete(agentId)
}
export function editorInputPerformance(host: HTMLElement | null): PerformanceTrace | null {
  const element = host?.querySelector('.monaco-editor') || host
  const started = inputStart(element)
  if (started === undefined) return null // Programmatic model replacement is not typing.
  const trace = beginInteraction('editor.input', { started, timeout: 3000 })
  trace.mark('model')
  return trace
}
export function beginNavigationPerformance(kind: 'file.open' | 'agent.switch', key: string) {
  const current = navigation.get(kind)
  current?.trace.end('superseded')
  const trace = beginInteraction(kind, { target: key, expiry: 'unobserved' })
  navigation.set(kind, { key, trace })
  return trace
}
export function navigationPerformanceReady(kind: 'file.open' | 'agent.switch', key: string, host: HTMLElement | null) {
  const pending = navigation.get(kind)
  if (pending?.key !== key) return
  pending.trace.mark('renderer')
  afterInteractionFrame(pending.trace, host)
  navigation.delete(kind)
}
export function filePerformanceKey(agentId: string, path: string) { return `${agentId}\0${path}` }

async function flush() {
  if (sending || disabled || queue.length === 0 || document.visibilityState === 'hidden') return
  sending = true
  const records = queue.splice(0, PERFORMANCE_LIMITS.batch)
  try {
    const response = await fetch(appPath('/api/diagnostics/performance'), {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records, discarded }), signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      discarded += records.length
      // Read-only viewers and older servers do not receive a retry storm.
      if ([401, 403, 404].includes(response.status)) disabled = true
    }
  } catch { discarded += records.length } finally { sending = false }
}
export function installInteractionPerformance() {
  if (initialized) return () => {}
  initialized = true
  const capture = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null
    const host = target?.closest('.terminal-session-host, .monaco-editor')
    if (!host) return
    const now = performance.now()
    const time = event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now
    // Keep keydown's earlier timestamp when beforeinput follows in the same operation.
    const previous = inputEvents.get(host)
    inputEvents.set(host, event.type === 'beforeinput' && previous && now - previous.captured < 100
      ? previous : { time, captured: now })
  }
  const visibility = () => {
    if (document.visibilityState !== 'hidden') return
    recorder.cancelAll('hidden')
    frames.forEach(frame => frame.cancel()); frames.clear()
    terminalInputs.clear(); navigation.clear()
  }
  for (const type of ['keydown', 'beforeinput', 'compositionend']) document.addEventListener(type, capture, true)
  document.addEventListener('visibilitychange', visibility)
  let observer: PerformanceObserver | undefined
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (document.visibilityState === 'hidden') continue
        if (longTasks.length >= 128) longTasks.shift()
        longTasks.push({ start: entry.startTime, end: entry.startTime + entry.duration, duration: entry.duration })
        const trace = beginInteraction('browser.long-task', { started: entry.startTime })
        trace.metric({ longTaskMaxMs: entry.duration }); trace.end('observed', entry.startTime + entry.duration)
      }
    })
    try { observer.observe({ type: 'longtask' }) } catch { observer.disconnect(); observer = undefined }
  }
  const interval = setInterval(() => {
    recorder.sweep()
    for (const [id, frame] of frames) {
      // Frames are normally removed in two turns; hiding is handled above.
      if (!frame.trace.active() || document.visibilityState === 'hidden') { frame.cancel(); frames.delete(id) }
    }
    while (longTasks[0] && longTasks[0].end < performance.now() - 5000) longTasks.shift()
    void flush()
  }, 1000)
  window.farmingPerformance = { snapshot: () => ({ ...recorder.snapshot(), discarded, queued: queue.length }) }
  return () => {
    clearInterval(interval); observer?.disconnect()
    for (const type of ['keydown', 'beforeinput', 'compositionend']) document.removeEventListener(type, capture, true)
    document.removeEventListener('visibilitychange', visibility)
    recorder.cancelAll(); frames.forEach(frame => frame.cancel()); frames.clear(); terminalInputs.clear(); navigation.clear()
    delete window.farmingPerformance; initialized = false
  }
}
declare global {
  interface Window {
    farmingPerformance?: { snapshot(): ReturnType<InteractionPerformanceRecorder['snapshot']> & { discarded: number; queued: number } }
  }
}
