import { parentPort } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isSameOrDescendantPath } from './path-containment.cjs';

const MAX_NAME_BYTES = 128 * 1024 * 1024;
interface Snapshot { directories: string[]; files: string[]; bytes: number }
interface Request {
  requestId: number; operation: 'capture' | 'page' | 'release' | 'cancel'; id: string;
  target?: string; root?: string; allowedRoots?: string[]; hiddenNames?: string[]; offset?: number; limit?: number;
}
const snapshots = new Map<string, Snapshot>();
const captures = new Map<string, AbortController>();
let allocatedBytes = 0;

function release(id: string) {
  captures.get(id)?.abort();
  const snapshot = snapshots.get(id);
  if (snapshot) allocatedBytes -= snapshot.bytes;
  snapshots.delete(id);
}

async function execute(request: Request) {
  if (request.operation === 'cancel' || request.operation === 'release') { release(request.id); return {}; }
  if (request.operation === 'capture') {
    const controller = new AbortController();
    captures.set(request.id, controller);
    const snapshot: Snapshot = { directories: [], files: [], bytes: 0 };
    const hidden = new Set(request.hiddenNames);
    try {
      const directory = await fs.opendir(request.target!, { bufferSize: 1024 });
      for await (const entry of directory) {
        controller.signal.throwIfAborted();
        if (hidden.has(entry.name)) continue;
        const bytes = entry.name.length * 2 + 40;
        if (allocatedBytes + bytes > MAX_NAME_BYTES) throw new Error('Directory names exceed the listing memory budget. Close other directories and refresh.');
        allocatedBytes += bytes;
        snapshot.bytes += bytes;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            const target = await fs.realpath(path.join(request.target!, entry.name));
            if ([request.root!, ...(request.allowedRoots || [])].some(root => isSameOrDescendantPath(root, target))) {
              isDirectory = (await fs.stat(target)).isDirectory();
            }
          } catch { /* Broken or inaccessible links sort with files. */ }
        }
        (isDirectory ? snapshot.directories : snapshot.files).push(entry.name);
      }
      controller.signal.throwIfAborted();
      snapshot.directories.sort((a, b) => a.localeCompare(b));
      snapshot.files.sort((a, b) => a.localeCompare(b));
      controller.signal.throwIfAborted();
      snapshots.set(request.id, snapshot);
      return { total: snapshot.directories.length + snapshot.files.length };
    } catch (error) {
      allocatedBytes -= snapshot.bytes;
      throw error;
    } finally { captures.delete(request.id); }
  }
  const snapshot = snapshots.get(request.id);
  if (!snapshot) throw new Error('Directory listing expired. Refresh the directory.');
  const total = snapshot.directories.length + snapshot.files.length;
  const start = request.offset || 0;
  const end = Math.min(total, start + (request.limit || 256));
  const names: string[] = [];
  for (let i = start; i < end; i++) names.push(i < snapshot.directories.length
    ? snapshot.directories[i] : snapshot.files[i - snapshot.directories.length]);
  return { names, total };
}
parentPort!.on('message', (request: Request) => {
  void execute(request).then(result => parentPort!.postMessage({ requestId: request.requestId, result }), error => {
    parentPort!.postMessage({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
  });
});
