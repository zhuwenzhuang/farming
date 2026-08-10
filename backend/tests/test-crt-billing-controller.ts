const assert = require('assert');

// --- Fake environment ---

let nowMs = 1_000_000;
const timers = new Map();
let timerId = 1;
const intervals = new Map();
let intervalId = 1;
const rafCallbacks = new Map();
let rafId = 1;
type FakeFetchCall = { url: string; options: { signal?: { aborted: boolean; _listeners: Array<() => void> } }; index: number };
let fetchResponses: Array<Record<string, unknown>> = [];
let fetchCalls: FakeFetchCall[] = [];
const abortedSignals = new Set();

class FakeAbortController {
  signal: { aborted: boolean; _listeners: Array<() => void> };
  constructor() {
    this.signal = { aborted: false, _listeners: [] };
  }
  abort() {
    this.signal.aborted = true;
    abortedSignals.add(this);
    this.signal._listeners.forEach(fn => fn());
    this.signal._listeners = [];
  }
}

class FakeAbortError extends Error {
  constructor() { super('Aborted'); this.name = 'AbortError'; }
}

function fakeSetTimeout(fn: () => void, ms: number) {
  const id = timerId++;
  timers.set(id, { fn, fireAt: nowMs + ms });
  return id;
}
function fakeClearTimeout(id: number) { timers.delete(id); }
function fakeSetInterval(fn: () => void, ms: number) {
  const id = intervalId++;
  intervals.set(id, { fn, ms, nextFire: nowMs + ms });
  return id;
}
function fakeClearInterval(id: number) { intervals.delete(id); }
function fakeRequestAnimationFrame(fn: (now: number) => void) {
  const id = rafId++;
  rafCallbacks.set(id, fn);
  return id;
}
function fakeCancelAnimationFrame(id: number) { rafCallbacks.delete(id); }
function advanceTime(ms: number) {
  const target = nowMs + ms;
  while (true) {
    let earliest: number | null = null;
    let earliestId: number | null = null;
    let earliestType: string | null = null;
    for (const [id, t] of timers) {
      if (t.fireAt <= target && (earliest === null || t.fireAt < earliest)) {
        earliest = t.fireAt; earliestId = id; earliestType = 'timer';
      }
    }
    for (const [id, iv] of intervals) {
      if (iv.nextFire <= target && (earliest === null || iv.nextFire < earliest)) {
        earliest = iv.nextFire; earliestId = id; earliestType = 'interval';
      }
    }
    if (earliest === null) break;
    nowMs = earliest;
    if (earliestType === 'timer') {
      const t = timers.get(earliestId!);
      timers.delete(earliestId!);
      t!.fn();
    } else {
      const iv = intervals.get(earliestId!);
      iv!.nextFire += iv!.ms;
      iv!.fn();
    }
  }
  nowMs = target;
}
function flushRaf() {
  const cbs = [...rafCallbacks.values()];
  rafCallbacks.clear();
  cbs.forEach(fn => fn(nowMs));
}

const elements = new Map();
function fakeGetElementById(id: string) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      textContent: '',
      title: '',
      disabled: false,
      tabIndex: -1,
      dataset: {},
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      style: { setProperty() {}, width: '' },
      setAttribute() {},
      removeAttribute() {},
      getAttribute: () => null,
      replaceChildren() {},
      appendChild() {},
      append() {},
      querySelectorAll: () => [],
      children: [],
      offsetLeft: 0,
      offsetWidth: 10,
      focus() {},
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      getContext: () => null,
      width: 0,
      height: 0,
    });
  }
  return elements.get(id);
}

function fakeFetch(url: string, options: { signal?: { aborted: boolean; _listeners: Array<() => void> } } = {}) {
  const call: FakeFetchCall = { url, options, index: fetchCalls.length };
  fetchCalls.push(call);
  const entry = fetchResponses.shift() || { status: 200, body: { usage: {} } };
  if (options.signal && options.signal.aborted) {
    return Promise.reject(new FakeAbortError());
  }
  if (entry.neverSettle) {
    return new Promise(() => {});
  }
  const makeJson = () => {
    if (entry.jsonNeverSettle) return new Promise(() => {});
    if (entry.jsonDelay) {
      return new Promise(resolve => {
        fakeSetTimeout(() => resolve(entry.body), entry.jsonDelay as number);
      });
    }
    return Promise.resolve(entry.body);
  };
  const makeResponse = () => ({
    ok: (entry.status as number) >= 200 && (entry.status as number) < 300,
    status: entry.status,
    json: makeJson,
  });
  if (entry.delay) {
    return new Promise((resolve, reject) => {
      let settled = false;
      if (options.signal) {
        options.signal._listeners.push(() => {
          if (!settled) { settled = true; reject(new FakeAbortError()); }
        });
      }
      fakeSetTimeout(() => {
        if (settled) return;
        if (options.signal && options.signal.aborted) {
          settled = true;
          reject(new FakeAbortError());
          return;
        }
        settled = true;
        resolve(makeResponse());
      }, entry.delay as number);
    });
  }
  return Promise.resolve(makeResponse());
}

// Install globals
(global as Record<string, unknown>).window = {
  AbortController: FakeAbortController,
  requestAnimationFrame: fakeRequestAnimationFrame,
  cancelAnimationFrame: fakeCancelAnimationFrame,
  performance: { now: () => nowMs },
  devicePixelRatio: 1,
  addEventListener() {},
};
(global as Record<string, unknown>).document = {
  getElementById: fakeGetElementById,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag: string) => ({
    tagName: tag, type: '', className: '', textContent: '', title: '',
    dataset: {}, style: { width: '', setProperty() {} },
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute() {}, removeAttribute() {}, appendChild() {}, append() {},
    addEventListener() {}, replaceChildren() {},
    tabIndex: -1, offsetLeft: 0, offsetWidth: 10,
    children: [], querySelectorAll: () => [],
  }),
  activeElement: null,
  visibilityState: 'visible',
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
};
(global as Record<string, unknown>).fetch = fakeFetch;
(global as Record<string, unknown>).setTimeout = fakeSetTimeout;
(global as Record<string, unknown>).clearTimeout = fakeClearTimeout;
(global as Record<string, unknown>).setInterval = fakeSetInterval;
(global as Record<string, unknown>).clearInterval = fakeClearInterval;
const RealDate = Date;
(global as Record<string, unknown>).Date = class extends RealDate {
  static now() { return nowMs; }
};

// --- Load controller ---
const controller = require('../../frontend/skins/crt/billing-controller');
const { CrtBilling, isBillingRetryableFailure, __getDayDetailCache } = controller;

const ports = {
  activeView: true,
  isActiveView() { return this.activeView; },
  setMainView() {},
  renderShellState() {},
  setNavigationSelection() {},
  clearNavigationSelection() {},
  apiPath: (path: string) => `/api${path}`,
  formatTokenRate: (v: string | number | null | undefined) => (v === null ? '--' : String(v)),
};
CrtBilling.init(ports);

async function flush() {
  for (let i = 0; i < 8; i += 1) {
    await new Promise(resolve => { fakeSetTimeout(resolve as () => void, 0); advanceTime(0); });
    await Promise.resolve();
    await Promise.resolve();
  }
}

function resetState() {
  fetchCalls = [];
  fetchResponses = [];
  timers.clear();
  intervals.clear();
  rafCallbacks.clear();
  CrtBilling.dispose();
  nowMs = 1_000_000;
}

function stopAllTimers() {
  intervals.clear();
}

// --- Tests ---

async function testModeRaceDaysPendingSwitchLive() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } }, delay: 5000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1, 'show triggers summary fetch');
  assert.ok(fetchCalls[0].url.includes('/usage?fresh=1'), 'fresh summary requested');

  fetchResponses = [
    { status: 200, body: { usage: { timeline: { windowMs: 3600000, totalTokens: 500, points: [] }, sampledAt: nowMs } }, delay: 0 },
  ];
  CrtBilling.selectMode('live');
  await flush();
  advanceTime(6000);
  await flush();

  const lateAborted = fetchCalls[0].options.signal!.aborted;
  assert.ok(lateAborted, 'pending Days summary is aborted when switching to Live');
  assert.strictEqual(CrtBilling.mode, 'live');
  console.log('  PASS: mode race Days->Live aborts pending and fences');
}

async function testManualVsTimerRefresh() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.show();
  await flush();
  const initialCalls = fetchCalls.length;
  assert.ok(initialCalls >= 1, 'show triggers initial load');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  advanceTime(15000);
  await flush();
  assert.ok(fetchCalls.length > initialCalls, '15s timer triggers refresh');

  const before = fetchCalls.length;
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.refresh();
  await flush();
  assert.ok(fetchCalls.length > before, 'manual refresh triggers fetch');
  assert.ok(fetchCalls[fetchCalls.length - 1].url.includes('fresh=1'), 'manual refresh uses fresh=1');
  console.log('  PASS: manual vs timer refresh');
}

async function testSuspendResume() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.show();
  await flush();

  CrtBilling.suspend();
  const afterSuspend = fetchCalls.length;
  fetchResponses = [{ status: 200, body: { usage: {} } }];
  advanceTime(60000);
  await flush();
  assert.strictEqual(fetchCalls.length, afterSuspend, 'no fetches during suspend');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.resume(true);
  await flush();
  assert.ok(fetchCalls.length > afterSuspend, 'resume triggers fetch');
  assert.ok(fetchCalls[fetchCalls.length - 1].url.includes('fresh=1'), 'resume uses fresh=1');
  console.log('  PASS: suspend stops timers, resume restarts with fresh=1');
}

async function testHungDeadlineRecovery() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: {} }, delay: 30000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(!fetchCalls[0].options.signal!.aborted, 'not aborted before deadline');

  advanceTime(12001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'hung request aborted at deadline');
  assert.strictEqual(CrtBilling.isLoading, false, 'loading released after deadline');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  advanceTime(15000);
  await flush();
  assert.ok(fetchCalls.length >= 2, 'next poll progresses after deadline recovery');
  console.log('  PASS: hung request deadline aborts and later poll progresses');
}

async function testDayRetryClassification() {
  assert.strictEqual(isBillingRetryableFailure(new Error('network'), undefined), true, 'network error retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('timeout'), 408), true, '408 retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('rate limit'), 429), true, '429 retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('server'), 500), true, '500 retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('server'), 503), true, '503 retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('bad request'), 400), false, '400 not retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('not found'), 404), false, '404 not retryable');
  assert.strictEqual(isBillingRetryableFailure(new Error('validation'), 422), false, '422 not retryable');
  assert.strictEqual(isBillingRetryableFailure(new FakeAbortError(), undefined), false, 'abort not retryable');
  console.log('  PASS: day retry classification');
}

async function testNeverSettleSummaryReleasesOwner() {
  resetState();
  fetchResponses = [{ neverSettle: true }];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(CrtBilling.isLoading, true, 'loading while never-settle in flight');

  advanceTime(12001);
  await flush();
  assert.strictEqual(CrtBilling.isLoading, false, 'deadline releases owner even though fetch never settles');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  advanceTime(15000);
  await flush();
  assert.ok(fetchCalls.length >= 2, 'next poll proceeds after never-settle deadline release');
  console.log('  PASS: never-settle summary releases owner after deadline');
}

async function testNeverSettleDayReleasesOwner() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { neverSettle: true },
  ];
  CrtBilling.show();
  await flush();
  assert.ok(fetchCalls.length >= 2, 'summary + day detail triggered');
  const dayCallIndex = fetchCalls.findIndex(c => c.url.includes('/usage/day'));
  assert.ok(dayCallIndex >= 0, 'day detail requested');

  advanceTime(10001);
  await flush();
  assert.ok(fetchCalls[dayCallIndex].options.signal!.aborted, 'day deadline aborts');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } }];
  advanceTime(15000);
  await flush();
  assert.ok(fetchCalls.length > dayCallIndex + 1, 'next poll proceeds after never-settle day deadline');
  console.log('  PASS: never-settle day releases owner after deadline');
}

async function testNeverSettleTopbarReleasesOwner() {
  resetState();
  fetchResponses = [{ neverSettle: true }];
  CrtBilling.startTopBarRefresh({ immediate: true });
  await flush();
  assert.strictEqual(fetchCalls.length, 1, 'topbar fires immediate load');

  advanceTime(8001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'topbar deadline aborts');

  fetchResponses = [{ status: 200, body: { usage: { providers: [] } } }];
  advanceTime(60000);
  await flush();
  assert.ok(fetchCalls.length >= 2, 'next topbar poll proceeds after never-settle deadline');
  console.log('  PASS: never-settle topbar releases owner after deadline');
}

async function testSupersededSummaryCannotClearNewDeadline() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [], endDate: '' } } }, delay: 5000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1);

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [], endDate: '' } } }, delay: 15000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 2, 'second summary request issued');

  advanceTime(5001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'A aborted by B');

  advanceTime(12001);
  await flush();
  assert.ok(fetchCalls[1].options.signal!.aborted, 'B deadline fires (A finally did not clear it)');
  assert.strictEqual(CrtBilling.isLoading, false, 'B deadline releases owner');
  console.log('  PASS: superseded A finally cannot clear B deadline (summary)');
}

async function testSupersededDayCannotClearNewDeadline() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [], total: { totalTokens: 100 } } }, delay: 9000 },
  ];
  CrtBilling.show();
  await flush();
  const dayCallA = fetchCalls.findIndex(c => c.url.includes('/usage/day'));
  assert.ok(dayCallA >= 0, 'day A triggered by summary');

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [], total: { totalTokens: 100 } } }, delay: 15000 },
  ];
  CrtBilling.show();
  await flush();
  const dayCallB = fetchCalls.length - 1;
  assert.ok(dayCallB > dayCallA, 'second day request issued');
  assert.ok(fetchCalls[dayCallA].options.signal!.aborted, 'A aborted by B');

  advanceTime(10001);
  await flush();
  assert.ok(fetchCalls[dayCallB].options.signal!.aborted, 'B day deadline fires (A finally did not clear it)');
  console.log('  PASS: superseded A finally cannot clear B deadline (day)');
}

async function testSupersededTopbarCannotClearNewDeadline() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: {} }, delay: 15000 }];
  CrtBilling.startTopBarRefresh({ immediate: true });
  await flush();
  assert.strictEqual(fetchCalls.length, 1, 'topbar A in-flight');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.show();
  await flush();

  fetchResponses = [{ status: 200, body: { usage: {} }, delay: 15000 }];
  CrtBilling.startTopBarRefresh({ immediate: true });
  await flush();
  const topbarB = fetchCalls.length - 1;
  assert.ok(topbarB >= 2, 'topbar B issued after summary aborted A');

  advanceTime(8001);
  await flush();
  assert.ok(fetchCalls[topbarB].options.signal!.aborted, 'B topbar deadline fires (A stale deadline did not clear it)');
  console.log('  PASS: superseded A finally cannot clear B deadline (topbar)');
}

async function testLeaveKeepsTopbarRunning() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { providers: [{ tokenUsage: { tokensPerMinute: 42 } }] } } }];
  CrtBilling.startTopBarRefresh({ immediate: true });
  await flush();
  const topbarInitial = fetchCalls.length;
  assert.ok(topbarInitial >= 1, 'topbar fires initial load');

  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } }];
  CrtBilling.show();
  await flush();
  const afterShow = fetchCalls.length;
  assert.ok(afterShow > topbarInitial, 'show triggers billing fetch');

  CrtBilling.leave();
  const afterLeave = fetchCalls.length;

  fetchResponses = [{ status: 200, body: { usage: { providers: [{ tokenUsage: { tokensPerMinute: 55 } }] } } }];
  advanceTime(60000);
  await flush();
  assert.ok(fetchCalls.length > afterLeave, 'topbar 60s timer fires after leave');
  const lastUrl = fetchCalls[fetchCalls.length - 1].url;
  assert.ok(lastUrl.includes('/api/usage') && !lastUrl.includes('/usage/day'), 'post-leave fetch is topbar only');

  advanceTime(15000);
  await flush();
  const afterAnotherCycle = fetchCalls.length;
  advanceTime(15000);
  await flush();
  assert.strictEqual(fetchCalls.length, afterAnotherCycle, 'billing summary poll does NOT fire after leave');
  console.log('  PASS: leave stops billing reads but global topbar continues');
}

async function testDisposeStopsTopbar() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { providers: [] } } }];
  CrtBilling.startTopBarRefresh({ immediate: true });
  await flush();

  CrtBilling.dispose();
  const afterDispose = fetchCalls.length;
  fetchResponses = [{ status: 200, body: { usage: {} } }];
  advanceTime(120000);
  await flush();
  assert.strictEqual(fetchCalls.length, afterDispose, 'no fetches after dispose');
  console.log('  PASS: dispose stops everything including topbar');
}

async function testEmptySummaryPrunesDayCache() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
  ];
  CrtBilling.show();
  await flush();

  fetchResponses = [
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 50 }], total: { totalTokens: 100 } } } },
  ];
  advanceTime(100);
  await flush();
  const dayFetchCount = fetchCalls.length;

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [], endDate: '' } } } },
  ];
  advanceTime(15000);
  await flush();

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 200 }], endDate: '2026-01-01' } } } },
  ];
  advanceTime(15000);
  await flush();

  fetchResponses = [
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 200 }], total: { totalTokens: 200 } } } },
  ];
  advanceTime(100);
  await flush();
  assert.ok(fetchCalls.length > dayFetchCount + 1, 'reintroduced day requires fresh read (cache was pruned by empty summary)');
  const lastDayFetch = fetchCalls[fetchCalls.length - 1];
  assert.ok(lastDayFetch.url.includes('/usage/day'), 'fresh day detail fetched after reintroduction');
  console.log('  PASS: empty summary prunes day cache, reintroduce requires fresh read');
}

async function testRafFenceOnDispose() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } }];
  CrtBilling.show();
  await flush();

  const rafCountBefore = rafCallbacks.size;
  assert.ok(rafCountBefore > 0, 'rAFs pending before dispose');
  CrtBilling.dispose();
  assert.strictEqual(rafCallbacks.size, 0, 'dispose cancels all tracked rAFs');
  flushRaf();
  assert.strictEqual(rafCallbacks.size, 0, 'no rAF rescheduled after dispose flush');
  console.log('  PASS: dispose cancels all rAFs, flush causes zero reschedule');
}

async function testRafFenceOnSuspend() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } }];
  CrtBilling.show();
  await flush();

  CrtBilling.suspend();
  assert.strictEqual(rafCallbacks.size, 0, 'suspend cancels all tracked rAFs');
  flushRaf();
  assert.strictEqual(rafCallbacks.size, 0, 'no rAF rescheduled after suspend flush');
  console.log('  PASS: suspend cancels all rAFs, flush causes zero reschedule');
}

async function testResumeFresh() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.show();
  await flush();

  CrtBilling.suspend();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [], endDate: '' } } } }];
  CrtBilling.resume(true);
  await flush();
  const lastCall = fetchCalls[fetchCalls.length - 1];
  assert.ok(lastCall.url.includes('fresh=1'), 'resume active billing uses fresh=1');
  console.log('  PASS: resume active billing uses fresh=1');
}

async function testCachePrune() {
  resetState();
  const summaryWithDays = {
    usage: {
      daily: {
        points: [
          { date: '2026-01-01', totalTokens: 100 },
          { date: '2026-01-02', totalTokens: 200 },
        ],
        endDate: '2026-01-02',
      },
    },
  };
  fetchResponses = [
    { status: 200, body: summaryWithDays },
    { status: 200, body: { detail: { date: '2026-01-02', hours: [], total: { totalTokens: 200 } } } },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(CrtBilling.selectedDate, '2026-01-02', 'current day auto-selected');

  fetchResponses = [
    { status: 200, body: { detail: { date: '2026-01-01', hours: [], total: { totalTokens: 100 } } } },
  ];
  CrtBilling.selectDay('2026-01-01');
  await flush();

  let dates = __getDayDetailCache().map((entry: { date: string }) => entry.date).sort();
  assert.deepStrictEqual(dates, ['2026-01-01', '2026-01-02'], 'both selected days cached before prune');

  const prunedSummary = {
    usage: {
      daily: {
        points: [{ date: '2026-01-02', totalTokens: 200 }],
        endDate: '2026-01-02',
      },
    },
  };
  fetchResponses = [{ status: 200, body: prunedSummary }];
  advanceTime(15000);
  await flush();

  dates = __getDayDetailCache().map((entry: { date: string }) => entry.date).sort();
  assert.deepStrictEqual(dates, ['2026-01-02'], 'cache prunes to the authoritative date set');
  console.log('  PASS: cache prunes to authoritative dates');
}

async function testAnimationStaleFence() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } }];
  CrtBilling.show();
  await flush();

  const rafCountBefore = rafId;
  CrtBilling.dispose();
  flushRaf();
  const rafCountAfter = rafId;
  assert.strictEqual(rafCountBefore, rafCountAfter, 'no new rAF scheduled after dispose');
  console.log('  PASS: animation stale fence via generation');
}

async function testLeavePagehideStaleCompletion() {
  resetState();
  fetchResponses = [{ status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 999 }], endDate: '2026-01-01' } } }, delay: 3000 }];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1);

  CrtBilling.dispose();
  advanceTime(3001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'stale in-flight request aborted on leave');
  console.log('  PASS: leave/pagehide stale completion fenced');
}

async function testSummaryDeadlineThenLeaveLateFetchNoop() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 999 }], endDate: '2026-01-01' } } }, delay: 30000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1, 'summary fetch in flight');
  stopAllTimers();

  advanceTime(12001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'summary deadline aborts');
  assert.strictEqual(CrtBilling.isLoading, false, 'owner released at deadline');

  CrtBilling.leave();
  stopAllTimers();
  const rendersAfterLeave = controller.__getRenderCount();
  const summaryAfterLeave = controller.__getSummary();

  advanceTime(30000);
  await flush();
  assert.strictEqual(controller.__getSummary(), summaryAfterLeave, 'late fetch does not change summary');
  assert.strictEqual(controller.__getRenderCount(), rendersAfterLeave, 'late fetch renders nothing');
  assert.ok(!fetchCalls.some(c => c.url.includes('/usage/day')), 'late fetch starts no day request');
  console.log('  PASS: summary deadline then leave, late fetch is a no-op');
}

async function testSummaryDeadlineThenSuspendLateJsonNoop() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 999 }], endDate: '2026-01-01' } } }, jsonDelay: 30000 },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(fetchCalls.length, 1, 'summary fetch resolved, json pending');
  stopAllTimers();

  advanceTime(12001);
  await flush();
  assert.ok(fetchCalls[0].options.signal!.aborted, 'summary deadline aborts');
  assert.strictEqual(CrtBilling.isLoading, false, 'owner released at deadline');

  CrtBilling.suspend();
  stopAllTimers();
  const rendersAfterSuspend = controller.__getRenderCount();
  const summaryAfterSuspend = controller.__getSummary();

  advanceTime(30000);
  await flush();
  assert.strictEqual(controller.__getSummary(), summaryAfterSuspend, 'late json does not change summary');
  assert.strictEqual(controller.__getRenderCount(), rendersAfterSuspend, 'late json renders nothing');
  assert.ok(!fetchCalls.some(c => c.url.includes('/usage/day')), 'late json starts no day request');
  console.log('  PASS: summary deadline then suspend, late json is a no-op');
}

async function testDayDeadlineThenLeaveLateFetchNoop() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 50 }], total: { totalTokens: 100 } } }, delay: 30000 },
  ];
  CrtBilling.show();
  await flush();
  const dayCall = fetchCalls.findIndex(c => c.url.includes('/usage/day'));
  assert.ok(dayCall >= 0, 'day detail requested');
  stopAllTimers();

  advanceTime(10001);
  await flush();
  assert.ok(fetchCalls[dayCall].options.signal!.aborted, 'day deadline aborts');

  CrtBilling.leave();
  stopAllTimers();
  const cacheAfterLeave = __getDayDetailCache().length;
  const rendersAfterLeave = controller.__getRenderCount();

  advanceTime(30000);
  await flush();
  assert.strictEqual(__getDayDetailCache().length, cacheAfterLeave, 'late day fetch writes no cache');
  assert.strictEqual(controller.__getRenderCount(), rendersAfterLeave, 'late day fetch renders nothing');
  assert.strictEqual(fetchCalls.filter(c => c.url.includes('/usage/day')).length, 1, 'no additional day request');
  console.log('  PASS: day deadline then leave, late fetch is a no-op');
}

async function testDayDeadlineThenSuspendLateJsonNoop() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 50 }], total: { totalTokens: 100 } } }, jsonDelay: 30000 },
  ];
  CrtBilling.show();
  await flush();
  const dayCall = fetchCalls.findIndex(c => c.url.includes('/usage/day'));
  assert.ok(dayCall >= 0, 'day detail requested');
  stopAllTimers();

  advanceTime(10001);
  await flush();
  assert.ok(fetchCalls[dayCall].options.signal!.aborted, 'day deadline aborts');

  CrtBilling.suspend();
  stopAllTimers();
  const cacheAfterSuspend = __getDayDetailCache().length;
  const rendersAfterSuspend = controller.__getRenderCount();

  advanceTime(30000);
  await flush();
  assert.strictEqual(__getDayDetailCache().length, cacheAfterSuspend, 'late day json writes no cache');
  assert.strictEqual(controller.__getRenderCount(), rendersAfterSuspend, 'late day json renders nothing');
  assert.strictEqual(fetchCalls.filter(c => c.url.includes('/usage/day')).length, 1, 'no additional day request');
  console.log('  PASS: day deadline then suspend, late json is a no-op');
}

async function testDayDeadlinePruneThenLateDetailCannotRepopulate() {
  resetState();
  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 50 }], total: { totalTokens: 100 } } }, jsonDelay: 25000 },
  ];
  CrtBilling.show();
  await flush();
  assert.ok(fetchCalls.some(c => c.url.includes('/usage/day')), 'day detail requested');

  advanceTime(10001);
  await flush();
  stopAllTimers();

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [], endDate: '' } } } },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(__getDayDetailCache().length, 0, 'empty summary prunes cache');

  const dayFetchesBeforeLate = fetchCalls.filter(c => c.url.includes('/usage/day')).length;
  advanceTime(25000);
  await flush();
  assert.strictEqual(__getDayDetailCache().length, 0, 'late day detail cannot repopulate pruned cache');
  assert.strictEqual(controller.__getDayDetail(), null, 'late day detail is not adopted');
  assert.strictEqual(fetchCalls.filter(c => c.url.includes('/usage/day')).length, dayFetchesBeforeLate, 'late detail starts no new request');

  fetchResponses = [
    { status: 200, body: { usage: { daily: { points: [{ date: '2026-01-01', totalTokens: 100 }], endDate: '2026-01-01' } } } },
    { status: 200, body: { detail: { date: '2026-01-01', hours: [{ hour: 0, totalTokens: 700 }], total: { totalTokens: 700 } } } },
  ];
  CrtBilling.show();
  await flush();
  const cached = __getDayDetailCache();
  assert.strictEqual(cached.length, 1, 'reintroduced date cached');
  assert.strictEqual(cached[0].date, '2026-01-01', 'reintroduced date is the cached key');
  assert.strictEqual(controller.__getDayDetail() && controller.__getDayDetail().total.totalTokens, 700, 'fresh day detail adopted');
  assert.ok(fetchCalls.filter(c => c.url.includes('/usage/day')).length > dayFetchesBeforeLate, 'reintroduced date performs a fresh day request');
  console.log('  PASS: day deadline prune blocks late detail; reintroduce fetches fresh and adopts');
}

async function testIncompleteHourlyAfterPreviousDetailRetries() {
  resetState();
  nowMs = Date.parse('2026-01-01T12:00:00Z');
  const currentDate = new Date(nowMs);
  const date = [
    currentDate.getFullYear(),
    String(currentDate.getMonth() + 1).padStart(2, '0'),
    String(currentDate.getDate()).padStart(2, '0'),
  ].join('-');
  const summary = { usage: { daily: { points: [{ date, totalTokens: 100 }], endDate: date } } };
  const firstDetail = { detail: { date, hours: [{ hour: 8, totalTokens: 100 }], total: { totalTokens: 100 } } };
  const incompleteDetail = { detail: { date, hours: [], total: { totalTokens: 200 } } };
  const completeDetail = { detail: { date, hours: [{ hour: 8, totalTokens: 200 }], total: { totalTokens: 200 } } };

  fetchResponses = [
    { status: 200, body: summary },
    { status: 200, body: firstDetail },
  ];
  CrtBilling.show();
  await flush();
  assert.strictEqual(controller.__getDayDetail()?.total.totalTokens, 100, 'initial complete hourly detail adopted');
  assert.strictEqual(__getDayDetailCache()[0].detail.hours.length, 1, 'initial hourly bins cached');

  fetchResponses = [
    { status: 200, body: summary },
    { status: 200, body: incompleteDetail },
    { status: 200, body: completeDetail },
  ];
  const dayFetchesBeforeRefresh = fetchCalls.filter(c => c.url.includes('/usage/day')).length;
  CrtBilling.refresh();
  await flush();
  assert.strictEqual(
    fetchCalls.filter(c => c.url.includes('/usage/day')).length,
    dayFetchesBeforeRefresh + 1,
    'incomplete 200 response attempted exactly one day read before retry timer',
  );
  assert.strictEqual(controller.__getDayDetail()?.total.totalTokens, 100, 'previous detail remains visible while retry is pending');
  assert.notStrictEqual(fakeGetElementById('billing-day-insight-state').textContent, 'DAY SIGNAL LOST', 'pending retry does not surface DAY SIGNAL LOST');

  advanceTime(751);
  await flush();
  assert.strictEqual(
    fetchCalls.filter(c => c.url.includes('/usage/day')).length,
    dayFetchesBeforeRefresh + 2,
    'bounded retry reads the selected day again',
  );
  assert.strictEqual(controller.__getDayDetail()?.total.totalTokens, 200, 'retry complete detail adopted');
  assert.strictEqual(__getDayDetailCache()[0].detail.hours.length, 1, 'retry complete hourly bins cached');
  assert.notStrictEqual(fakeGetElementById('billing-day-insight-state').textContent, 'DAY SIGNAL LOST', 'complete retry never leaves DAY SIGNAL LOST');
  console.log('  PASS: incomplete hourly 200 after previous detail retries and adopts complete detail');
}

async function main() {
  console.log('test-crt-billing-controller:');
  await testModeRaceDaysPendingSwitchLive();
  await testManualVsTimerRefresh();
  await testSuspendResume();
  await testHungDeadlineRecovery();
  await testDayRetryClassification();
  await testNeverSettleSummaryReleasesOwner();
  await testNeverSettleDayReleasesOwner();
  await testNeverSettleTopbarReleasesOwner();
  await testSupersededSummaryCannotClearNewDeadline();
  await testSupersededDayCannotClearNewDeadline();
  await testSupersededTopbarCannotClearNewDeadline();
  await testLeaveKeepsTopbarRunning();
  await testDisposeStopsTopbar();
  await testEmptySummaryPrunesDayCache();
  await testRafFenceOnDispose();
  await testRafFenceOnSuspend();
  await testResumeFresh();
  await testCachePrune();
  await testAnimationStaleFence();
  await testLeavePagehideStaleCompletion();
  await testSummaryDeadlineThenLeaveLateFetchNoop();
  await testSummaryDeadlineThenSuspendLateJsonNoop();
  await testDayDeadlineThenLeaveLateFetchNoop();
  await testDayDeadlineThenSuspendLateJsonNoop();
  await testDayDeadlinePruneThenLateDetailCannotRepopulate();
  await testIncompleteHourlyAfterPreviousDetailRetries();
  console.log('test-crt-billing-controller passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
