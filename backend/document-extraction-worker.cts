import { parentPort, workerData } from 'node:worker_threads';
import { extractDocument } from './document-extraction.cjs';
const { bytes, name } = workerData as { bytes: Uint8Array; name: string };
void extractDocument(Buffer.from(bytes), name).then(
  result => parentPort?.postMessage({ result }),
  error => parentPort?.postMessage({ error: error instanceof Error ? error.message : 'Document extraction failed.' }),
);
