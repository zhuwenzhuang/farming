const assert = require('assert');
const {
  attachQuotaForecasts,
  buildQuotaForecast,
} = require('../usage-forecast');

function run() {
  const now = Date.parse('2026-07-09T12:00:00.000Z');
  const forecast = buildQuotaForecast({
    usedPercent: 50,
    windowMinutes: 300,
    resetsAt: now + 2 * 60 * 60 * 1000,
  }, { now });

  assert.strictEqual(forecast.remainingPercent, 50);
  assert.strictEqual(forecast.resetInMs, 2 * 60 * 60 * 1000);
  assert.strictEqual(forecast.windowElapsedMs, 3 * 60 * 60 * 1000);
  assert(Math.abs(forecast.burnRatePercentPerMinute - (50 / 180)) < 0.0001);
  assert(Math.abs(forecast.etaMs - 3 * 60 * 60 * 1000) < 1);
  assert.strictEqual(Math.round(forecast.projectedEndPercent), 83);

  const tokenForecast = buildQuotaForecast({
    usedPercent: 25,
    windowMinutes: 300,
    resetsAt: now + 4 * 60 * 60 * 1000,
    totalTokens: 1_000_000,
  }, { now });
  assert.strictEqual(tokenForecast.usedTokens, 250_000);
  assert.strictEqual(tokenForecast.remainingTokens, 750_000);

  const quota = attachQuotaForecasts({
    available: true,
    source: 'test',
    primary: { usedPercent: 10, windowMinutes: 300, resetsAt: now + 60_000 },
    secondary: null,
  }, { now });
  assert.strictEqual(quota.primary.forecast.remainingPercent, 90);
  assert.strictEqual(quota.secondary, null);

  console.log('✓ Usage forecast estimates quota headroom and exhaustion time');
}

run();
