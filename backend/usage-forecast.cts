interface QuotaLimit extends Record<string, unknown> {
  resetsAt?: unknown;
  totalTokens?: unknown;
  usedPercent?: unknown;
  windowMinutes?: unknown;
}

interface QuotaForecastOptions {
  now?: unknown;
}

interface QuotaForecast {
  source: 'quota-window-average';
  usedPercent: number;
  remainingPercent: number;
  burnRatePercentPerMinute: number;
  etaMs: number | null;
  projectedExhaustedAt: number | null;
  projectedEndPercent: number | null;
  resetInMs: number | null;
  windowElapsedMs: number;
  totalTokens: number | null;
  usedTokens: number | null;
  remainingTokens: number | null;
}

interface Quota extends Record<string, unknown> {
  available?: boolean;
  primary?: unknown;
  secondary?: unknown;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function buildQuotaForecast(
  limit: unknown,
  options: QuotaForecastOptions = {},
): QuotaForecast | null {
  if (!limit || typeof limit !== 'object') return null;
  const source = limit as QuotaLimit;

  const now = numberOrNull(options.now) ?? Date.now();
  const usedPercentRaw = numberOrNull(source.usedPercent);
  const windowMinutes = numberOrNull(source.windowMinutes);
  const resetsAt = numberOrNull(source.resetsAt);
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

  const totalTokens = numberOrNull(source.totalTokens);
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

function attachQuotaForecast(
  limit: unknown,
  options: QuotaForecastOptions = {},
): unknown {
  if (!limit || typeof limit !== 'object') return limit;
  return {
    ...limit,
    forecast: buildQuotaForecast(limit, options),
  };
}

function attachQuotaForecasts(
  quota: unknown,
  options: QuotaForecastOptions = {},
): unknown {
  if (!quota || typeof quota !== 'object') return quota;
  const source = quota as Quota;
  if (source.available === false) return quota;
  return {
    ...source,
    primary: attachQuotaForecast(source.primary, options),
    secondary: attachQuotaForecast(source.secondary, options),
  };
}

export {
  attachQuotaForecast,
  attachQuotaForecasts,
  buildQuotaForecast,
};
