import { Worker } from 'node:worker_threads';
import path from 'node:path';

interface Request {
  operation: 'capture' | 'page' | 'release' | 'cancel'; id: string;
  target?: string; root?: string; allowedRoots?: string[]; hiddenNames?: string[]; offset?: number; limit?: number;
}
export class WorkspaceTreeIndexError extends Error { readonly status: number; constructor(message: string, status: number) { super(message); this.status = status; } }

interface Result { names?: string[]; total?: number }

// One bounded worker owns lightweight names. No directory-sized metadata array
// or sort runs on the Server thread, and only one page crosses the worker port.
export class WorkspaceTreeIndex {
  private readonly maxNameBytes?: number;
  constructor(maxNameBytes?: number) { this.maxNameBytes = maxNameBytes; }
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, { finish(error?: Error, result?: Result): void }>();
  request(request: Request, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted();
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, 'workspace-tree-index-worker.cjs'), { workerData: { maxNameBytes: this.maxNameBytes }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      this.worker = worker;
      worker.on('message', (message: { requestId: number; result?: Result; error?: string; status?: number }) => {
        this.pending.get(message.requestId)?.finish(message.error ? new WorkspaceTreeIndexError(message.error, message.status || 503) : undefined, message.result);
      });
      const failed = (error: Error) => {
        if (this.worker !== worker) return;
        this.worker = null;
        for (const pending of [...this.pending.values()]) pending.finish(error);
      };
      worker.on('error', failed);
      worker.on('exit', () => failed(new Error('Directory listing worker stopped. Refresh the directory.')));
    }
    const worker = this.worker;
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: Result) => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result || {});
      };
      const abort = () => {
        worker.postMessage({ operation: 'cancel', id: request.id, requestId: ++this.sequence });
        finish(new Error('Directory listing cancelled'));
      };
      const timeout = setTimeout(abort, 30_000);
      this.pending.set(requestId, { finish });
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ ...request, requestId });
    });
  }
  release(id: string) {
    this.worker?.postMessage({ operation: 'release', id, requestId: ++this.sequence });
  }
  async dispose() {
    const worker = this.worker;
    this.worker = null;
    for (const pending of [...this.pending.values()]) pending.finish(new Error('Directory service stopped'));
    await worker?.terminate();
  }
}
