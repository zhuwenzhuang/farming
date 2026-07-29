import { parentPort, workerData } from 'worker_threads';

interface UsageWorkerMessage {
  requestId: unknown;
  request: unknown;
}

interface UsageWorkerData {
  request?: unknown;
  requestId?: unknown;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function errorCode(error: unknown): unknown {
  return recordValue(error)?.code;
}

async function collect(request: unknown): Promise<unknown> {
  const { collectUsage } = require('./usage-history-scanner.generated.js') as {
    collectUsage(request: unknown): unknown | Promise<unknown>;
  };
  return collectUsage(request);
}

let queue: Promise<void> = Promise.resolve();

function enqueue(message: UsageWorkerMessage): void {
  queue = queue.then(async () => {
    try {
      const result = await collect(message.request);
      parentPort?.postMessage({ requestId: message.requestId, result });
    } catch (error: unknown) {
      parentPort?.postMessage({
        requestId: message.requestId,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: errorCode(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  });
}

parentPort?.on('message', (message: unknown) => {
  const record = recordValue(message);
  enqueue({
    requestId: record?.requestId,
    request: record?.request,
  });
});

// Keep accepting the former one-shot shape for already-built artifacts during
// a controlled application update.
const initialData = recordValue(workerData) as UsageWorkerData | null;
if (initialData?.request) {
  enqueue({
    requestId: initialData.requestId || 'initial',
    request: initialData.request,
  });
}

export {};
