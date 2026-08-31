/** Diagnostic observations only: never an input acknowledgement or mutation authority. */
export const PERFORMANCE_OPERATIONS = [
  'terminal.input', 'editor.input', 'file.open', 'file.save', 'agent.switch',
  'workspace.request', 'language-server.request', 'connection.probe', 'browser.long-task', 'runtime.sample',
] as const
export type PerformanceOperation = typeof PERFORMANCE_OPERATIONS[number]
export const PERFORMANCE_OUTCOMES = ['observed', 'completed', 'failed', 'cancelled', 'superseded', 'timeout', 'hidden', 'unobserved', 'uncertain'] as const
export type PerformanceOutcome = typeof PERFORMANCE_OUTCOMES[number]
export const PERFORMANCE_STAGES = ['handler', 'sent', 'received', 'dispatch', 'service', 'output', 'model', 'draft', 'renderer', 'frame'] as const
export type PerformanceStage = typeof PERFORMANCE_STAGES[number]
export const PERFORMANCE_METRICS = [
  'inputCount', 'inputUnits', 'contentUnits', 'outputUnits', 'queueMs', 'serviceMs',
  'socketBytes', 'pendingRequests', 'backgroundRunning', 'interactiveRunning',
  'eventLoopMaxMs', 'eventLoopMeanMs', 'longTaskMaxMs', 'longTaskCount',
  'outputBytes', 'outputChunks', 'activeAgents', 'connections', 'heapBytes', 'cpuMs', 'windowMs',
] as const
export type PerformanceMetrics = Partial<Record<typeof PERFORMANCE_METRICS[number], number>>
const REQUEST_KINDS = ['read-file', 'save-file', 'tree', 'search', 'tree-decorations', 'capability', 'request', 'notify', 'other'] as const
export function performanceRequestKind(value: unknown): typeof REQUEST_KINDS[number] {
  return REQUEST_KINDS.find(kind => kind === value) ?? 'other'
}
export interface InteractionPerformanceRecord {
  version: 1
  id: string
  source: 'browser' | 'server'
  operation: PerformanceOperation
  outcome: PerformanceOutcome
  startedAt: number
  durationMs: number
  slow: boolean
  stages: Partial<Record<PerformanceStage, number>>
  metrics: PerformanceMetrics
  target?: string
  requestId?: string
  requestKind?: typeof REQUEST_KINDS[number]
}
export const PERFORMANCE_LIMITS = { pending: 128, recent: 512, batch: 32, stages: 10 } as const
const idPattern = /^[a-zA-Z0-9:_-]{1,120}$/
export function validPerformanceId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value)
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15
}
function numbers<K extends string>(value: unknown, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const key of keys) {
    const n = (value as Record<string, unknown>)[key]
    if (finite(n)) result[key] = Math.round(n * 100) / 100
  }
  return result
}
/** Rebuild from a fixed allowlist; never persist arbitrary client strings or payloads. */
export function parsePerformanceRecord(value: unknown): InteractionPerformanceRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  if (r.version !== 1 || !validPerformanceId(r.id)
    || !PERFORMANCE_OPERATIONS.includes(r.operation as PerformanceOperation)
    || !PERFORMANCE_OUTCOMES.includes(r.outcome as PerformanceOutcome)
    || (r.source !== 'browser' && r.source !== 'server')
    || !finite(r.startedAt) || !finite(r.durationMs) || r.durationMs > 600_000) return null
  return {
    version: 1, id: r.id, source: r.source, operation: r.operation as PerformanceOperation,
    outcome: r.outcome as PerformanceOutcome, startedAt: r.startedAt,
    durationMs: Math.round(r.durationMs * 100) / 100, slow: r.slow === true,
    stages: numbers(r.stages, PERFORMANCE_STAGES), metrics: numbers(r.metrics, PERFORMANCE_METRICS),
    ...(typeof r.target === 'string' && /^t-[a-f0-9]{8}$/.test(r.target) ? { target: r.target } : {}),
    ...(validPerformanceId(r.requestId) ? { requestId: r.requestId } : {}),
    ...(r.requestKind !== undefined ? { requestKind: performanceRequestKind(r.requestKind) } : {}),
  }
}

export interface PerformanceTrace {
  id: string
  startTime: number
  mark(stage: PerformanceStage): void
  metric(values: PerformanceMetrics): void
  end(outcome: PerformanceOutcome, endedAt?: number): void
  active(): boolean
}
interface Pending {
  record: InteractionPerformanceRecord
  start: number
  deadline: number
  threshold: number
  expiry: PerformanceOutcome
}
export class InteractionPerformanceRecorder {
  private readonly pending = new Map<string, Pending>()
  private readonly recent: InteractionPerformanceRecord[] = []
  private sequence = 0
  dropped = 0
  private readonly options: {
    source: 'browser' | 'server'
    prefix: string
    now(): number
    wallNow(): number
    emit?(record: InteractionPerformanceRecord): void
  }
  constructor(options: InteractionPerformanceRecorder['options']) { this.options = options }
  begin(operation: PerformanceOperation, options: {
    started?: number; threshold?: number; timeout?: number; expiry?: PerformanceOutcome
    target?: string; requestId?: string; id?: string; requestKind?: typeof REQUEST_KINDS[number]
  } = {}): PerformanceTrace {
    if (this.pending.size >= PERFORMANCE_LIMITS.pending) {
      const oldest = this.pending.keys().next().value
      if (oldest) this.finish(oldest, 'unobserved')
      this.dropped += 1
    }
    const now = this.options.now()
    const start = Math.min(now, Math.max(now - 60_000, options.started ?? now))
    const id = options.id && validPerformanceId(options.id) ? options.id : `${this.options.prefix}:${++this.sequence}`
    if (this.pending.has(id)) this.finish(id, 'superseded')
    const record: InteractionPerformanceRecord = {
      version: 1, id, source: this.options.source, operation, outcome: 'unobserved',
      startedAt: this.options.wallNow() - (now - start), durationMs: 0, slow: false,
      stages: {}, metrics: {}, target: options.target, requestId: options.requestId, requestKind: options.requestKind,
    }
    const entry: Pending = { record, start, threshold: options.threshold ?? 200,
      deadline: now + (options.timeout ?? 30_000), expiry: options.expiry ?? 'timeout' }
    this.pending.set(id, entry)
    const active = () => this.pending.get(id) === entry
    return { id, startTime: start, active,
      mark: stage => { if (active() && record.stages[stage] === undefined) record.stages[stage] = this.options.now() - start },
      metric: values => { if (active()) Object.assign(record.metrics, numbers(values, PERFORMANCE_METRICS)) },
      end: (outcome, endedAt) => { if (active()) this.finish(id, outcome, endedAt) },
    }
  }
  private finish(id: string, outcome: PerformanceOutcome, endedAt = this.options.now()) {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    entry.record.outcome = outcome
    entry.record.durationMs = Math.max(0, Math.min(600_000, Math.min(endedAt, this.options.now()) - entry.start))
    entry.record.slow = (outcome === 'completed' || outcome === 'observed') && entry.record.durationMs >= entry.threshold
    const { received, dispatch, service } = entry.record.stages
    if (received !== undefined && dispatch !== undefined) entry.record.metrics.queueMs = Math.max(0, dispatch - received)
    if (dispatch !== undefined && service !== undefined) entry.record.metrics.serviceMs = Math.max(0, service - dispatch)
    const record = parsePerformanceRecord(entry.record)
    if (!record) { this.dropped += 1; return }
    if (this.recent.length >= PERFORMANCE_LIMITS.recent) this.recent.shift()
    this.recent.push(record)
    // Diagnostics must never throw into the product path.
    try { this.options.emit?.(record) } catch { this.dropped += 1 }
  }
  sweep() {
    const now = this.options.now()
    for (const [id, entry] of this.pending) if (now >= entry.deadline) this.finish(id, entry.expiry)
  }
  cancelAll(outcome: PerformanceOutcome = 'cancelled') {
    for (const id of this.pending.keys()) this.finish(id, outcome)
  }
  snapshot() { return { dropped: this.dropped, pending: this.pending.size, records: this.recent.map(r => ({ ...r, stages: { ...r.stages }, metrics: { ...r.metrics } })), summary: summarizePerformanceRecords(this.recent) } }
}

/** Descriptive recent-window statistics, not population percentiles from sampled uploads. */
export function summarizePerformanceRecords(records: readonly InteractionPerformanceRecord[]) {
  const groups = new Map<string, { source: string; operation: string; requestKind?: string;
    observed: number; slow: number; outcomes: Partial<Record<PerformanceOutcome, number>>; durations: number[] }>()
  for (const record of records) {
    if (record.operation === 'runtime.sample') continue
    const key = `${record.source}:${record.operation}:${record.requestKind || ''}`
    let group = groups.get(key)
    if (!group) {
      group = { source: record.source, operation: record.operation, requestKind: record.requestKind,
        observed: 0, slow: 0, outcomes: {}, durations: [] }
      groups.set(key, group)
    }
    group.observed += 1
    group.outcomes[record.outcome] = (group.outcomes[record.outcome] || 0) + 1
    if (record.slow) group.slow += 1
    if (record.outcome === 'observed' || record.outcome === 'completed') group.durations.push(record.durationMs)
  }
  return [...groups.values()].map(({ durations, ...group }) => {
    durations.sort((a, b) => a - b)
    const percentile = (p: number) => durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? null
    return { ...group, completed: durations.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1) }
  })
}
