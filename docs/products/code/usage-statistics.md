# Usage Statistics

> Chinese version: [usage-statistics.zh_cn.md](usage-statistics.zh_cn.md)

The backend owns usage snapshots. Local token activity and account quota are
separate measurements: logs describe work on configured Agent Homes, including
cached tokens; they never prove an account's remaining allowance or bill.

## State And Ownership

A summary read captures the configured Homes and one timestamp, collects one
local history snapshot, then derives rates, timelines and daily totals from that
snapshot. Cache identity includes Homes and the backend's local calendar date.
Partial scans and failed providers remain explicit; missing observations are not
zero usage. The daily chart and hourly detail use the backend time zone. The 1d
activity curve is a rolling 24-hour window, not today's calendar total.
Parsed source caches retain records independently of observation time; each read
applies its own time window so clock skew cannot permanently discard usage.

Account reads belong to a Provider and exact Home. Supported adapters read the
signed-in account's authoritative quota; custom inference routes and session
rate-limit events cannot substitute for it. Each Home retains its own result,
source and observation time; percentages are never added across accounts.
Unsupported, unauthenticated, malformed and timed-out reads show unavailable.
Codex uses account/read followed by account/rateLimits/read, preferring the codex
bucket in rateLimitsByLimitId. It never starts a turn or consumes a reset.

Reads transition from pending to a bounded success or explicit failure. Concurrent
summary reads share the instance cache. Home changes and invalidation fence older
results. Temporary quota processes have an output limit and deadline and are killed
on every terminal path. Failure does not restore an old quota or retry a mutation.
Today's open detail refreshes periodically; navigation cancels the prior request,
and a late response cannot overwrite the new date. Errors and incomplete history
remain visible, and an explicit read can recover after the source becomes healthy.

## Verification

Verify proxy-log/account mismatch, separate Homes, missing versus zero values,
timeouts and process cleanup, scan failure and recovery, cache invalidation while
pending, local midnight, current-day refresh, fork/copy deduplication, and agreement
between summary, day detail and provider totals. Exercise the composed UI in Light,
Dark and Paper with deterministic providers.
