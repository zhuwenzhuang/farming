const assert = require('assert');
const {
  crtBillingCurrentRate,
  crtBillingDayArrowTargetIndex,
  crtBillingTimelineLabels,
  formatCrtUsageValue,
  formatStructuredUsage,
  structuredContextUsage,
  updateStructuredUsageDisplay,
} = require('../../frontend/skins/crt/app');

const calendarPoints = [
  '2026-06-24',
  '2026-06-25',
  '2026-06-26',
  '2026-06-27',
  '2026-06-28',
  '2026-06-29',
  '2026-06-30',
  '2026-07-01',
  '2026-07-02',
  '2026-07-03',
  '2026-07-04',
  '2026-07-05',
].map(date => ({ date }));
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 7, 'ArrowUp'), 6);
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 7, 'ArrowDown'), 8);
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 7, 'ArrowLeft'), 0);
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 0, 'ArrowRight'), 7);
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 5, 'ArrowUp'), -1, 'Monday must not wrap to the prior Sunday');
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 4, 'ArrowDown'), -1, 'Sunday must not wrap to the next Monday');
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 0, 'ArrowLeft'), -1, 'leading spacer cells are not selectable');
assert.strictEqual(crtBillingDayArrowTargetIndex(calendarPoints, 7, 'ArrowRight'), -1, 'trailing spacer cells are not selectable');

const timelineLabels = crtBillingTimelineLabels({ windowMs: 24 * 60 * 60 * 1000 });
assert.deepStrictEqual(timelineLabels, {
  integral: 'TOKENS · 1D',
  peak: 'TOK/MIN · 1D',
  title: 'TOKEN BURN // 1D',
  ariaLabel: 'Token burn rate over the last 1D',
  start: '-1D',
  midpoint: '-12H',
});
assert.deepStrictEqual(crtBillingTimelineLabels({ windowMs: 90 * 60 * 1000 }), {
  integral: 'TOKENS · 90M',
  peak: 'TOK/MIN · 90M',
  title: 'TOKEN BURN // 90M',
  ariaLabel: 'Token burn rate over the last 90M',
  start: '-90M',
  midpoint: '-45M',
});
assert.deepStrictEqual(crtBillingTimelineLabels(null), {
  integral: 'TOKENS · WINDOW',
  peak: 'TOK/MIN · WINDOW',
  title: 'TOKEN BURN // WINDOW',
  ariaLabel: 'Token burn rate over the last WINDOW',
  start: '-WINDOW',
  midpoint: '-WINDOW',
});
assert.strictEqual(crtBillingCurrentRate(null), null);
assert.strictEqual(crtBillingCurrentRate({ providers: [] }), null);
assert.strictEqual(crtBillingCurrentRate({
  providers: [
    { tokenUsage: { available: false, tokensPerMinute: 12 } },
    { tokenUsage: { available: true, tokensPerMinute: null } },
  ],
}), null);
assert.strictEqual(crtBillingCurrentRate({
  providers: [
    { tokenUsage: { available: true, tokensPerMinute: 12.5 } },
    { tokenUsage: { available: true, tokensPerMinute: 0 } },
  ],
}), 12.5);
assert.strictEqual(formatCrtUsageValue(null), '--');
assert.strictEqual(formatCrtUsageValue(undefined), '--');
assert.strictEqual(formatCrtUsageValue(''), '--');

assert.deepStrictEqual(structuredContextUsage({
  usage: { used: 53_000, size: 200_000 },
}), {
  usedTokens: 53_000,
  limitTokens: 200_000,
  percentUsed: 27,
  percentLeft: 73,
});
assert.strictEqual(
  formatStructuredUsage({ usage: { used: 53_000, size: 200_000 } }),
  '53K / 200K TOK',
);
assert.strictEqual(
  formatStructuredUsage({ usage: { totalTokens: 53_000 } }),
  '',
  'CRT must not interpret the obsolete totalTokens field as ACP context usage',
);
assert.strictEqual(formatStructuredUsage({ usage: { used: 10, size: 0 } }), '');
assert.strictEqual(formatStructuredUsage({ usage: { used: null, size: 200_000 } }), '');
assert.strictEqual(formatStructuredUsage({ usage: { used: '', size: 200_000 } }), '');
assert.strictEqual(formatStructuredUsage({ usage: { used: false, size: 200_000 } }), '');
assert.strictEqual(formatStructuredUsage(null), '');

const attributes = new Map([
  ['title', 'stale title'],
  ['aria-label', 'stale label'],
]);
const usageElement = {
  textContent: 'stale usage',
  title: 'stale title',
  setAttribute(name, value) {
    attributes.set(name, value);
  },
  removeAttribute(name) {
    attributes.delete(name);
    if (name === 'title') this.title = '';
  },
};
updateStructuredUsageDisplay(usageElement, null);
assert.strictEqual(usageElement.textContent, '');
assert.strictEqual(attributes.has('title'), false);
assert.strictEqual(attributes.has('aria-label'), false);
updateStructuredUsageDisplay(usageElement, { usage: { used: 53_000, size: 200_000 } });
assert.strictEqual(usageElement.textContent, '53K / 200K TOK');
assert.strictEqual(usageElement.title, 'Context window: 27% used (73% left)');
assert.strictEqual(attributes.get('aria-label'), 'Context window: 27% used (73% left)');

console.log('test-crt-token-displays passed');
