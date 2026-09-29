import { Worker } from 'node:worker_threads';
import path from 'node:path';
import type { AttachmentUploadStore } from './attachment-upload.cjs';

interface DocumentResponse {
  writableEnded: boolean;
  destroyed: boolean;
  headersSent: boolean;
  once(event: string, callback: () => void): void;
  off(event: string, callback: () => void): void;
  status(code: number): DocumentResponse;
  json(body: unknown): unknown;
}
let activeExtractions = 0;
export function extractDocumentInWorker(bytes: Buffer, name: string, signal: AbortSignal, timeoutMs = 20_000): Promise<{ text: string; type: string }> {
  if (signal.aborted) return Promise.reject(new Error('Document upload cancelled.'));
  if (activeExtractions >= 2) return Promise.reject(new Error('Document processor is busy. Try again after other attachments finish.'));
  activeExtractions++;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      const packaged = path.join(__dirname, 'document-extraction-worker.pkg.js');
      worker = new Worker((('pkg' in process && process.pkg) || process.env.FARMING_PACKAGED_RUNTIME === '1')
        ? packaged : path.join(__dirname, 'document-extraction-worker.cjs'), {
        workerData: { bytes, name }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
    } catch (error) { activeExtractions--; reject(error); return; }
    let settled = false;
    const finish = (error?: Error, result?: { text: string; type: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate().finally(() => {
        activeExtractions--;
        if (error) reject(error);
        else if (result) resolve(result);
      });
    };
    const abort = () => finish(new Error('Document upload cancelled.'));
    const timer = setTimeout(() => finish(new Error('Document extraction timed out. Split the document and try again.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
    worker.once('exit', () => finish(new Error('Document processor stopped before completion.')));
    worker.once('message', (message: { result?: { text: string; type: string }; error?: string }) => {
      if (message.result) finish(undefined, message.result);
      else finish(new Error(message.error || 'Document extraction failed.'));
    });
  });
}

export function createDocumentAttachmentHandler(store: AttachmentUploadStore) {
  return async (req: { query: Record<string, unknown>; body: unknown }, res: DocumentResponse) => {
    const name = typeof req.query.name === 'string' ? path.basename(req.query.name.replaceAll('\\', '/')) : '';
    if (!name || name.length > 500 || /[\x00-\x1f]/.test(name)) { res.status(400).json({ error: 'A valid document filename is required.' }); return; }
    if (!Buffer.isBuffer(req.body) || !req.body.length || req.body.length > 20 * 1024 * 1024) {
      res.status(413).json({ error: 'Attach a non-empty document smaller than 20 MB.' }); return;
    }
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    try {
      const extracted = await extractDocumentInWorker(req.body, name, controller.signal);
      if (controller.signal.aborted) return;
      const stored = await store.storeDocument(name, extracted.type, req.body);
      if (!res.destroyed) res.status(201).json({ ...stored, name, text: extracted.text });
      void store.cleanupExpired();
    } catch (error) {
      if (!res.destroyed && !res.headersSent) res.status(422).json({ error: error instanceof Error ? error.message : 'Document extraction failed.' });
    } finally { res.off('close', cancel); }
  };
}
