// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InteractionPerformanceRecorder = exports.PERFORMANCE_LIMITS = exports.PERFORMANCE_METRICS = exports.PERFORMANCE_STAGES = exports.PERFORMANCE_OUTCOMES = exports.PERFORMANCE_OPERATIONS = void 0;
exports.performanceRequestKind = performanceRequestKind;
exports.validPerformanceId = validPerformanceId;
exports.parsePerformanceRecord = parsePerformanceRecord;
exports.summarizePerformanceRecords = summarizePerformanceRecords;
/** Diagnostic observations only: never an input acknowledgement or mutation authority. */
exports.PERFORMANCE_OPERATIONS = [
    'terminal.input', 'editor.input', 'file.open', 'file.save', 'agent.switch',
    'workspace.request', 'language-server.request', 'connection.probe', 'browser.long-task', 'runtime.sample',
];
exports.PERFORMANCE_OUTCOMES = ['observed', 'completed', 'failed', 'cancelled', 'superseded', 'timeout', 'hidden', 'unobserved', 'uncertain'];
exports.PERFORMANCE_STAGES = ['handler', 'sent', 'received', 'dispatch', 'service', 'output', 'model', 'draft', 'renderer', 'frame'];
exports.PERFORMANCE_METRICS = [
    'inputCount', 'inputUnits', 'contentUnits', 'outputUnits', 'queueMs', 'serviceMs',
    'socketBytes', 'pendingRequests', 'backgroundRunning', 'interactiveRunning',
    'eventLoopMaxMs', 'eventLoopMeanMs', 'longTaskMaxMs', 'longTaskCount',
    'outputBytes', 'outputChunks', 'activeAgents', 'connections', 'heapBytes', 'cpuMs', 'windowMs',
];
const REQUEST_KINDS = ['read-file', 'save-file', 'tree', 'search', 'tree-decorations', 'capability', 'request', 'notify', 'other'];
function performanceRequestKind(value) {
    return REQUEST_KINDS.find(kind => kind === value) ?? 'other';
}
exports.PERFORMANCE_LIMITS = { pending: 128, recent: 512, batch: 32, stages: 10 };
const idPattern = /^[a-zA-Z0-9:_-]{1,120}$/;
function validPerformanceId(value) {
    return typeof value === 'string' && idPattern.test(value);
}
function finite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15;
}
function numbers(value, keys) {
    const result = {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return result;
    for (const key of keys) {
        const n = value[key];
        if (finite(n))
            result[key] = Math.round(n * 100) / 100;
    }
    return result;
}
/** Rebuild from a fixed allowlist; never persist arbitrary client strings or payloads. */
function parsePerformanceRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const r = value;
    if (r.version !== 1 || !validPerformanceId(r.id)
        || !exports.PERFORMANCE_OPERATIONS.includes(r.operation)
        || !exports.PERFORMANCE_OUTCOMES.includes(r.outcome)
        || (r.source !== 'browser' && r.source !== 'server')
        || !finite(r.startedAt) || !finite(r.durationMs) || r.durationMs > 600_000)
        return null;
    return {
        version: 1, id: r.id, source: r.source, operation: r.operation,
        outcome: r.outcome, startedAt: r.startedAt,
        durationMs: Math.round(r.durationMs * 100) / 100, slow: r.slow === true,
        stages: numbers(r.stages, exports.PERFORMANCE_STAGES), metrics: numbers(r.metrics, exports.PERFORMANCE_METRICS),
        ...(typeof r.target === 'string' && /^t-[a-f0-9]{8}$/.test(r.target) ? { target: r.target } : {}),
        ...(validPerformanceId(r.requestId) ? { requestId: r.requestId } : {}),
        ...(r.requestKind !== undefined ? { requestKind: performanceRequestKind(r.requestKind) } : {}),
    };
}
class InteractionPerformanceRecorder {
    pending = new Map();
    recent = [];
    sequence = 0;
    dropped = 0;
    options;
    constructor(options) { this.options = options; }
    begin(operation, options = {}) {
        if (this.pending.size >= exports.PERFORMANCE_LIMITS.pending) {
            const oldest = this.pending.keys().next().value;
            if (oldest)
                this.finish(oldest, 'unobserved');
            this.dropped += 1;
        }
        const now = this.options.now();
        const start = Math.min(now, Math.max(now - 60_000, options.started ?? now));
        const id = options.id && validPerformanceId(options.id) ? options.id : `${this.options.prefix}:${++this.sequence}`;
        if (this.pending.has(id))
            this.finish(id, 'superseded');
        const record = {
            version: 1, id, source: this.options.source, operation, outcome: 'unobserved',
            startedAt: this.options.wallNow() - (now - start), durationMs: 0, slow: false,
            stages: {}, metrics: {}, target: options.target, requestId: options.requestId, requestKind: options.requestKind,
        };
        const entry = { record, start, threshold: options.threshold ?? 200,
            deadline: now + (options.timeout ?? 30_000), expiry: options.expiry ?? 'timeout' };
        this.pending.set(id, entry);
        const active = () => this.pending.get(id) === entry;
        return { id, startTime: start, active,
            mark: stage => { if (active() && record.stages[stage] === undefined)
                record.stages[stage] = this.options.now() - start; },
            metric: values => { if (active())
                Object.assign(record.metrics, numbers(values, exports.PERFORMANCE_METRICS)); },
            end: (outcome, endedAt) => { if (active())
                this.finish(id, outcome, endedAt); },
        };
    }
    finish(id, outcome, endedAt = this.options.now()) {
        const entry = this.pending.get(id);
        if (!entry)
            return;
        this.pending.delete(id);
        entry.record.outcome = outcome;
        entry.record.durationMs = Math.max(0, Math.min(600_000, Math.min(endedAt, this.options.now()) - entry.start));
        entry.record.slow = (outcome === 'completed' || outcome === 'observed') && entry.record.durationMs >= entry.threshold;
        const { received, dispatch, service } = entry.record.stages;
        if (received !== undefined && dispatch !== undefined)
            entry.record.metrics.queueMs = Math.max(0, dispatch - received);
        if (dispatch !== undefined && service !== undefined)
            entry.record.metrics.serviceMs = Math.max(0, service - dispatch);
        const record = parsePerformanceRecord(entry.record);
        if (!record) {
            this.dropped += 1;
            return;
        }
        if (this.recent.length >= exports.PERFORMANCE_LIMITS.recent)
            this.recent.shift();
        this.recent.push(record);
        // Diagnostics must never throw into the product path.
        try {
            this.options.emit?.(record);
        }
        catch {
            this.dropped += 1;
        }
    }
    sweep() {
        const now = this.options.now();
        for (const [id, entry] of this.pending)
            if (now >= entry.deadline)
                this.finish(id, entry.expiry);
    }
    cancelAll(outcome = 'cancelled') {
        for (const id of this.pending.keys())
            this.finish(id, outcome);
    }
    snapshot() { return { dropped: this.dropped, pending: this.pending.size, records: this.recent.map(r => ({ ...r, stages: { ...r.stages }, metrics: { ...r.metrics } })), summary: summarizePerformanceRecords(this.recent) }; }
}
exports.InteractionPerformanceRecorder = InteractionPerformanceRecorder;
/** Descriptive recent-window statistics, not population percentiles from sampled uploads. */
function summarizePerformanceRecords(records) {
    const groups = new Map();
    for (const record of records) {
        if (record.operation === 'runtime.sample')
            continue;
        const key = `${record.source}:${record.operation}:${record.requestKind || ''}`;
        let group = groups.get(key);
        if (!group) {
            group = { source: record.source, operation: record.operation, requestKind: record.requestKind,
                observed: 0, slow: 0, outcomes: {}, durations: [] };
            groups.set(key, group);
        }
        group.observed += 1;
        group.outcomes[record.outcome] = (group.outcomes[record.outcome] || 0) + 1;
        if (record.slow)
            group.slow += 1;
        if (record.outcome === 'observed' || record.outcome === 'completed')
            group.durations.push(record.durationMs);
    }
    return [...groups.values()].map(({ durations, ...group }) => {
        durations.sort((a, b) => a - b);
        const percentile = (p) => durations[Math.max(0, Math.ceil(durations.length * p) - 1)] ?? null;
        return { ...group, completed: durations.length, p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: percentile(1) };
    });
}
