function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildQuotaForecast(limit, options = {}) {
  if (!limit || typeof limit !== 'object') return null;

  const now = numberOrNull(options.now) ?? Date.now();
  const usedPercentRaw = numberOrNull(limit.usedPercent);
  const windowMinutes = numberOrNull(limit.windowMinutes);
  const resetsAt = numberOrNull(limit.resetsAt);
  if (usedPercentRaw === null || windowMinutes === null || windowMinutes <= 0) return null;

  const usedPercent = clamp(usedPercentRaw, 0, 100);
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const windowMs = windowMinutes * 60_000;
  const resetInMs = resetsAt !== null && resetsAt > 0
    ? Math.max(0, resetsAt - now)
    : null;
  const elapsedMs = resetInMs === null
    ? windowMs / 2
    : clamp(windowMs - resetInMs, 0, windowMs);
  const elapsedMinutes = Math.max(1, elapsedMs / 60_000);
  const remainingMinutes = resetInMs === null ? null : Math.max(0, resetInMs / 60_000);
  const burnRatePercentPerMinute = usedPercent / elapsedMinutes;
  const etaMinutes = burnRatePercentPerMinute > 0
    ? remainingPercent / burnRatePercentPerMinute
    : null;
  const etaMs = etaMinutes === null ? null : Math.max(0, etaMinutes * 60_000);
  const projectedExhaustedAt = etaMs === null ? null : now + etaMs;
  const projectedEndPercent = remainingMinutes === null
    ? null
    : clamp(usedPercent + burnRatePercentPerMinute * remainingMinutes, 0, Number.MAX_SAFE_INTEGER);

  const totalTokens = numberOrNull(limit.totalTokens);
  const usedTokens = totalTokens !== null && totalTokens > 0
    ? Math.round(totalTokens * usedPercent / 100)
    : null;
  const remainingTokens = totalTokens !== null && totalTokens > 0
    ? Math.max(0, totalTokens - (usedTokens ?? 0))
    : null;

  return {
    source: 'quota-window-average',
    usedPercent,
    remainingPercent,
    burnRatePercentPerMinute,
    etaMs,
    projectedExhaustedAt,
    projectedEndPercent,
    resetInMs,
    windowElapsedMs: elapsedMs,
    totalTokens,
    usedTokens,
    remainingTokens,
  };
}

function attachQuotaForecast(limit, options = {}) {
  if (!limit || typeof limit !== 'object') return limit;
  return {
    ...limit,
    forecast: buildQuotaForecast(limit, options),
  };
}

function attachQuotaForecasts(quota, options = {}) {
  if (!quota || typeof quota !== 'object' || quota.available === false) return quota;
  return {
    ...quota,
    primary: attachQuotaForecast(quota.primary, options),
    secondary: attachQuotaForecast(quota.secondary, options),
  };
}

module.exports = {
  attachQuotaForecast,
  attachQuotaForecasts,
  buildQuotaForecast,
};
