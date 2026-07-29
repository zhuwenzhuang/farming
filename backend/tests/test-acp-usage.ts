const assert = require('assert');
const { acpContextUsage } = require('../../src/components/code/acp/acp-usage.ts');

assert.deepStrictEqual(acpContextUsage({
  used: 53_000,
  size: 200_000,
  cost: { amount: 0.045, currency: 'usd' },
}), {
  usedTokens: 53_000,
  limitTokens: 200_000,
  percentUsed: 27,
  percentLeft: 73,
  costLabel: '0.045 USD',
  level: 'normal',
});
assert.deepStrictEqual(acpContextUsage({ used: 220_000, size: 200_000 }), {
  usedTokens: 220_000,
  limitTokens: 200_000,
  percentUsed: 100,
  percentLeft: 0,
  costLabel: '',
  level: 'critical',
});
assert.strictEqual(acpContextUsage({ used: 10, size: 0 }), null);
assert.strictEqual(acpContextUsage(null), null);

console.log('test-acp-usage passed');
