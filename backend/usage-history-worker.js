const { parentPort, workerData } = require('worker_threads');

async function collect(request) {
  const { collectUsage } = require('./usage-history-scanner.generated');
  return collectUsage(request);
}

let queue = Promise.resolve();

function enqueue(message) {
  queue = queue.then(async () => {
    try {
      const result = await collect(message.request);
      parentPort.postMessage({ requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({
        requestId: message.requestId,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error && typeof error === 'object' ? error.code : undefined,
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  });
}

parentPort.on('message', enqueue);

// Keep accepting the former one-shot shape for already-built artifacts during
// a controlled application update.
if (workerData?.request) {
  enqueue({ requestId: workerData.requestId || 'initial', request: workerData.request });
}
