const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  acknowledgeTerminalResizeDelivery,
  expireTerminalResizeDelivery,
  queueTerminalResizeDelivery,
  resetTerminalResizeDeliveryTracker,
  shouldDebounceTerminalResize,
} = require('../../src/lib/terminal-resize.ts');

function createTracker() {
  return {
    resizeRequestInFlight: null,
    pendingResizeRequest: null,
  };
}

function run() {
  const terminalPoolSource = fs.readFileSync(
    path.join(__dirname, '../../src/lib/terminal-session-pool.ts'),
    'utf8',
  );
  const tracker = createTracker();
  const sent = [];
  const send = (cols, rows) => {
    sent.push({ cols, rows });
    return true;
  };

  assert.strictEqual(
    shouldDebounceTerminalResize(
      { cols: 120, rows: 35 },
      { cols: 118, rows: 35 },
    ),
    true,
    'browser-driven horizontal geometry changes should be coalesced',
  );
  assert.strictEqual(
    shouldDebounceTerminalResize(
      { cols: 120, rows: 35 },
      { cols: 120, rows: 35 },
    ),
    false,
    'unchanged geometry should not schedule resize work',
  );
  assert.strictEqual(
    shouldDebounceTerminalResize(
      { cols: 120, rows: 35 },
      { cols: 120, rows: 34 },
    ),
    true,
    'vertical changes from the same window drag must use the same coalescing path',
  );
  assert.strictEqual(
    shouldDebounceTerminalResize(
      { cols: 120, rows: 35 },
      { cols: 118, rows: 35 },
      { force: true },
    ),
    false,
    'explicit recovery and attach fits must remain immediate',
  );

  assert.strictEqual(queueTerminalResizeDelivery(tracker, 120, 35, send), true);
  assert.deepStrictEqual(sent, [{ cols: 120, rows: 35 }]);
  assert.deepStrictEqual(tracker.resizeRequestInFlight, { cols: 120, rows: 35 });
  assert.strictEqual(tracker.pendingResizeRequest, null);

  assert.strictEqual(queueTerminalResizeDelivery(tracker, 112, 35, send), true);
  assert.strictEqual(queueTerminalResizeDelivery(tracker, 104, 35, send), true);
  assert.deepStrictEqual(sent, [{ cols: 120, rows: 35 }], 'only one resize may be in flight');
  assert.deepStrictEqual(
    tracker.pendingResizeRequest,
    { cols: 104, rows: 35 },
    'dragging should retain only the latest pending geometry',
  );

  const staleEcho = acknowledgeTerminalResizeDelivery(tracker, 120, 35);
  assert.deepStrictEqual(staleEcho, {
    matched: true,
    preserveLocalGeometry: true,
    next: { cols: 104, rows: 35 },
  });
  assert.strictEqual(tracker.resizeRequestInFlight, null);
  assert.strictEqual(tracker.pendingResizeRequest, null);

  assert.strictEqual(
    queueTerminalResizeDelivery(tracker, staleEcho.next.cols, staleEcho.next.rows, send),
    true,
  );
  assert.deepStrictEqual(sent, [
    { cols: 120, rows: 35 },
    { cols: 104, rows: 35 },
  ]);

  const currentEcho = acknowledgeTerminalResizeDelivery(tracker, 104, 35);
  assert.deepStrictEqual(currentEcho, {
    matched: true,
    preserveLocalGeometry: false,
    next: null,
  });

  assert.strictEqual(queueTerminalResizeDelivery(tracker, 100, 32, send), true);
  assert.strictEqual(queueTerminalResizeDelivery(tracker, 100, 32, send), true);
  const duplicatePending = acknowledgeTerminalResizeDelivery(tracker, 100, 32);
  assert.deepStrictEqual(duplicatePending, {
    matched: true,
    preserveLocalGeometry: false,
    next: null,
  }, 'a pending duplicate should collapse into the acknowledged resize');

  assert.strictEqual(queueTerminalResizeDelivery(tracker, 96, 30, send), true);
  assert.strictEqual(queueTerminalResizeDelivery(tracker, 92, 28, send), true);
  const unrelatedResize = acknowledgeTerminalResizeDelivery(tracker, 90, 28);
  assert.deepStrictEqual(unrelatedResize, {
    matched: false,
    preserveLocalGeometry: true,
    next: null,
  });
  assert.deepStrictEqual(
    tracker.resizeRequestInFlight,
    { cols: 96, rows: 30 },
    'an unrelated viewer resize must not acknowledge the local request',
  );

  assert.deepStrictEqual(expireTerminalResizeDelivery(tracker), { cols: 92, rows: 28 });
  assert.strictEqual(tracker.resizeRequestInFlight, null);
  assert.strictEqual(tracker.pendingResizeRequest, null);
  assert.strictEqual(
    expireTerminalResizeDelivery(tracker),
    null,
    'an acknowledgement timeout without a newer geometry should end without retrying',
  );

  resetTerminalResizeDeliveryTracker(tracker);
  assert.strictEqual(tracker.resizeRequestInFlight, null);
  assert.strictEqual(tracker.pendingResizeRequest, null);

  const rejected = createTracker();
  assert.strictEqual(queueTerminalResizeDelivery(rejected, 80, 24, () => false), false);
  assert.strictEqual(rejected.resizeRequestInFlight, null);
  assert.strictEqual(rejected.pendingResizeRequest, null);

  assert(
    terminalPoolSource.includes('function deliverTerminalResize') &&
      terminalPoolSource.includes('const delivery = acknowledgeTerminalResizeDelivery(record, nextCols, nextRows)') &&
      terminalPoolSource.includes('!delivery.preserveLocalGeometry') &&
      terminalPoolSource.includes('record.terminal.cols !== nextCols || record.terminal.rows !== nextRows') &&
      terminalPoolSource.includes('deliverTerminalResize(record, delivery.next.cols, delivery.next.rows)') &&
      terminalPoolSource.includes('TERMINAL_RESIZE_DELIVERY_TIMEOUT_MS = 1500') &&
      terminalPoolSource.includes('const next = expireTerminalResizeDelivery(record)') &&
      terminalPoolSource.indexOf('TERMINAL_REPLAY.commitTransition(record.replayState, event)') >
        terminalPoolSource.indexOf('!delivery.preserveLocalGeometry'),
    'the terminal pool must preserve newer local geometry while still committing the ordered resize transition',
  );

  console.log('✓ terminal resize delivery keeps one request in flight and preserves newer local geometry');
}

run();
