import { promises as fs } from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  InteractionPerformanceRecorder, parsePerformanceRecord, PERFORMANCE_LIMITS, summarizePerformanceRecords,
  type InteractionPerformanceRecord, type PerformanceMetrics,
} from '../shared/interaction-performance.js';

interface DiagnosticRequest { authAccessMode?: string; body?: unknown }
interface DiagnosticResponse {
  status(code: number): DiagnosticResponse;
  json(value: unknown): void;
  setHeader(name: string, value: string): void;
}
type DiagnosticHandler = (req: DiagnosticRequest, res: DiagnosticResponse, next: () => void) => void;
interface DiagnosticRouter {
  use(handler: DiagnosticHandler): void;
  get(path: string, handler: DiagnosticHandler): void;
  post(path: string, middleware: unknown, handler: DiagnosticHandler): void;
}
const express = require('express') as { Router(): DiagnosticRouter; json(options: { limit: string }): unknown };

/** Lossy, bounded diagnostics. Never awaited by a session or workspace operation. */
export class InteractionPerformanceJournal {
  readonly recorder: InteractionPerformanceRecorder;
  private readonly queue: string[] = [];
  private readonly recent: InteractionPerformanceRecord[] = [];
  private readonly bootId = randomUUID();
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: ReturnType<typeof setInterval>;
  private writing: Promise<void> | null = null;
  private bytes: number | null = null;
  private sample = 0;
  private lastSample = performance.now();
  private cpu = process.cpuUsage();
  private outputUnits = 0;
  private outputChunks = 0;
  private readonly agentOutput = new Map<string, { units: number; chunks: number }>();
  private allowance = 128;
  private allowanceAt = performance.now();
  discarded = 0;
  writeFailures = 0;
  context: PerformanceMetrics = {};

  private readonly directory: string;
  private readonly segmentBytes: number;
  constructor(directory: string, segmentBytes = 2 * 1024 * 1024) {
    this.directory = directory; this.segmentBytes = segmentBytes;
    this.recorder = new InteractionPerformanceRecorder({
      source: 'server', prefix: `s-${this.bootId}`, now: () => performance.now(), wallNow: Date.now,
      emit: record => {
        const persist = record.slow || !['observed', 'completed'].includes(record.outcome) || ++this.sample % 20 === 0;
        this.retain(record, persist);
      },
    });
    this.lag.enable();
    this.timer = setInterval(() => { this.tick(); void this.flush(); }, 1000);
    this.timer.unref();
  }

  noteOutput(agentId: string, units: number): void {
    this.outputUnits += units; this.outputChunks += 1;
    const current = this.agentOutput.get(agentId);
    if (current) { current.units += units; current.chunks += 1; }
    else if (this.agentOutput.size < 128) this.agentOutput.set(agentId, { units, chunks: 1 });
  }

  target(agentId: string): string {
    return `t-${createHash('sha256').update(this.bootId).update(agentId).digest('hex').slice(0, 8)}`;
  }

  /** Browser data remains explicitly untrusted and cannot masquerade as server observations. */
  ingest(values: unknown[]): number {
    const now = performance.now();
    if (now - this.allowanceAt >= 1000) { this.allowance = 128; this.allowanceAt = now; }
    let accepted = 0;
    for (const value of values.slice(0, PERFORMANCE_LIMITS.batch)) {
      const record = parsePerformanceRecord(value);
      if (!record || record.source !== 'browser' || this.allowance <= 0) { this.discarded += 1; continue; }
      this.allowance -= 1;
      // A slow browser observation can need a fast server span excluded by sampling.
      const server = this.recent.findLast(candidate => candidate.source === 'server'
        && (candidate.id === record.id || (record.requestId && candidate.requestId === record.requestId)));
      if (server) this.enqueue(server);
      this.retain(record);
      accepted += 1;
    }
    return accepted;
  }

  private retain(record: InteractionPerformanceRecord, persist = true): void {
    if (this.recent.length >= PERFORMANCE_LIMITS.recent) this.recent.shift();
    this.recent.push(record);
    if (persist) this.enqueue(record);
  }

  private enqueue(record: InteractionPerformanceRecord): void {
    if (this.queue.length >= 256) { this.discarded += 1; return; }
    this.queue.push(JSON.stringify({ bootId: this.bootId, recordedAt: Date.now(), ...record }) + '\n');
  }

  private tick(): void {
    this.recorder.sweep();
    const now = performance.now();
    if (now - this.lastSample < 5000) return;
    const cpu = process.cpuUsage();
    const trace = this.recorder.begin('runtime.sample', { threshold: 0 });
    trace.metric({ ...this.context, windowMs: now - this.lastSample,
      cpuMs: (cpu.user - this.cpu.user + cpu.system - this.cpu.system) / 1000,
      eventLoopMaxMs: this.lag.max / 1e6, eventLoopMeanMs: this.lag.mean / 1e6,
      outputUnits: this.outputUnits, outputChunks: this.outputChunks, heapBytes: process.memoryUsage().heapUsed });
    trace.end('observed');
    for (const [agentId, output] of this.agentOutput) {
      const target = this.target(agentId);
      const activity = this.recorder.begin('runtime.sample', { threshold: 0, target });
      activity.metric({ windowMs: now - this.lastSample, outputUnits: output.units, outputChunks: output.chunks });
      activity.end('observed');
    }
    this.agentOutput.clear();
    this.cpu = cpu; this.lastSample = now; this.outputUnits = 0; this.outputChunks = 0;
    this.lag.reset();
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.queue.length) return Promise.resolve();
    const batch = this.queue.splice(0, 256);
    this.writing = this.write(batch.join('')).catch(() => {
      this.writeFailures += 1; this.discarded += batch.length;
    }).finally(() => { this.writing = null; });
    return this.writing;
  }

  private async write(body: string): Promise<void> {
    const file = path.join(this.directory, 'interactions.jsonl');
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.bytes === null) this.bytes = await fs.stat(file).then(s => s.size, () => 0);
    const size = Buffer.byteLength(body);
    if (this.bytes + size > this.segmentBytes) {
      // Only the journal's exact three previous segments are replaced.
      for (let index = 2; index >= 0; index -= 1) {
        const from = index === 0 ? file : `${file}.${index}`;
        await fs.rename(from, `${file}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      this.bytes = 0;
    }
    await fs.appendFile(file, body, { encoding: 'utf8', mode: 0o600 });
    this.bytes += size;
  }

  snapshot() {
    return { version: 1, bootId: this.bootId, discarded: this.discarded, writeFailures: this.writeFailures,
      traceDropped: this.recorder.dropped,
      queued: this.queue.length, pending: this.recorder.snapshot().pending,
      records: this.recent.map(r => ({ ...r, stages: { ...r.stages }, metrics: { ...r.metrics } })),
      summary: summarizePerformanceRecords(this.recent) };
  }
  dispose(): void { clearInterval(this.timer); this.lag.disable(); this.recorder.cancelAll(); }
}

export function createInteractionPerformanceRouter(journal: InteractionPerformanceJournal, authEnabled = true) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (authEnabled && req.authAccessMode !== 'owner') {
      res.status(403).json({ error: 'Owner access required' }); return;
    }
    next();
  });
  router.get('/', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(journal.snapshot()); });
  router.post('/', express.json({ limit: '64kb' }), (req, res) => {
    const body: unknown = req.body;
    const records = body && typeof body === 'object' && 'records' in body ? body.records : null;
    if (!Array.isArray(records) || records.length > PERFORMANCE_LIMITS.batch) {
      res.status(400).json({ error: 'Expected at most 32 performance records' }); return;
    }
    res.json({ accepted: journal.ingest(records) });
  });
  return router;
}
