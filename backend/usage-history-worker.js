const { parentPort, workerData } = require('worker_threads');

async function main() {
  const { collectUsage } = require('./usage-history-scanner.generated');
  const result = await collectUsage(workerData.request);
  parentPort.postMessage({ result });
}

main().catch((error) => {
  parentPort.postMessage({
    error: {
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' ? error.code : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
});
