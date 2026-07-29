const assert = require('assert');
const { importTsModule } = require('./helpers/import-ts-module');

function deferred() {
  let resolve;
  const promise = new Promise(next => {
    resolve = next;
  });
  return { promise, resolve };
}

async function run() {
  const { LatestRequestFence } = importTsModule('src/components/code/latest-request-fence.ts');
  const fence = new LatestRequestFence();
  const committed = [];
  const firstResponse = deferred();
  const secondResponse = deferred();

  const firstLease = fence.begin();
  const first = firstResponse.promise.then(value => {
    if (firstLease.isCurrent()) committed.push(value);
  });
  const secondLease = fence.begin();
  const second = secondResponse.promise.then(value => {
    if (secondLease.isCurrent()) committed.push(value);
  });

  secondResponse.resolve('new response');
  await second;
  firstResponse.resolve('stale response');
  await first;
  assert.deepStrictEqual(
    committed,
    ['new response'],
    'an older response arriving last must not replace the newest UI state',
  );

  const navigatedAwayLease = fence.begin();
  fence.invalidate();
  assert.strictEqual(
    navigatedAwayLease.isCurrent(),
    false,
    'navigation must revoke an in-flight request even without a replacement request',
  );

  console.log('latest UI request fence tests passed');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
