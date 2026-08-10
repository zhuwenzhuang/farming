// Generated from TypeScript. Do not edit.
"use strict";
/// <reference path="./app.types.d.ts" />
// --- Constants ---
const CRT_BILLING_REFRESH_MS = 15_000;
const CRT_BILLING_LIVE_DAY_REFRESH_MS = 5_000;
const CRT_TOKEN_RATE_REFRESH_MS = 60_000;
const CRT_TOKEN_RATE_FIRST_LOAD_MS = 1_500;
const CRT_BILLING_DAY_DETAIL_CACHE_MS = 30_000;
const CRT_BILLING_TOTAL_ANIMATION_MS = 900;
const CRT_BILLING_DAY_DETAIL_RETRY_MS = 750;
const CRT_BILLING_DAY_DETAIL_MAX_RETRIES = 4;
const CRT_BILLING_SUMMARY_DEADLINE_MS = 12_000;
const CRT_BILLING_DAY_DEADLINE_MS = 10_000;
const CRT_BILLING_TOPBAR_DEADLINE_MS = 8_000;
const CRT_BILLING_OVERRANGE_BASE = 1_000_000_000;
// --- Mutable state (owned exclusively by this controller) ---
let billingGeneration = 0;
let billingSummary = null;
let billingLoading = false;
let billingError = '';
let billingRequestSequence = 0;
let billingAbortController = null;
let billingRefreshTimer = null;
let billingLiveDayRefreshTimer = null;
let crtTokenRateRefreshTimer = null;
let crtTokenRateFirstLoadTimer = null;
let crtTokenRateAbortController = null;
let billingCanvasFrame = null;
let billingMode = 'days';
let billingSelectedDate = '';
let billingSelectedHour = null;
let billingDailyRenderSignature = '';
let billingDayDetail = null;
let billingDayDetailLoading = false;
let billingDayDetailError = '';
let billingDayDetailRequestSequence = 0;
let billingDayDetailAbortController = null;
let billingDayDetailRetryTimer = null;
let billingDisplayedTotalDate = '';
let billingDisplayedTotalValue = null;
let billingTotalAnimationFrame = null;
let billingTotalAnimationTarget = null;
const billingAnimatedMetrics = new Map();
const billingDayDetailCache = new Map();
let billingRenderCount = 0;
let billingPorts = null;
// --- Pure formatting utilities ---
function formatCrtUsageValue(value) {
    if (value === null || value === undefined || value === '')
        return '--';
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0)
        return '--';
    if (numberValue >= 1_000_000_000) {
        const compact = numberValue / 1_000_000_000;
        return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}B`;
    }
    if (numberValue >= 1_000_000) {
        const compact = numberValue / 1_000_000;
        return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}M`;
    }
    if (numberValue >= 1_000) {
        const compact = numberValue / 1_000;
        return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}K`;
    }
    return String(numberValue < 10 ? Math.round(numberValue * 10) / 10 : Math.round(numberValue));
}
function formatCrtExactUsageValue(value) {
    if (value === null || value === undefined || value === '')
        return '--';
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0)
        return '--';
    return Math.round(numberValue).toLocaleString('en-US');
}
function formatCrtCompactTotalValue(value) {
    if (value === null || value === undefined || value === '')
        return '--';
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue) || numberValue < 0)
        return '--';
    const units = [
        [1_000_000_000, 'B'],
        [1_000_000, 'M'],
        [1_000, 'K'],
    ];
    const unit = units.find(([threshold]) => numberValue >= threshold);
    if (!unit)
        return String(Math.round(numberValue));
    const compact = numberValue / unit[0];
    const precision = compact >= 100 ? 0 : compact >= 10 ? 1 : 2;
    return `${Number(compact.toFixed(precision))}${unit[1]}`;
}
function parseCrtBillingDate(dateValue) {
    const parts = String(dateValue || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(part => !Number.isFinite(part)))
        return null;
    return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}
function crtBillingDayLabel(dateValue) {
    const date = parseCrtBillingDate(dateValue);
    if (!date)
        return String(dateValue || 'SELECT A DAY');
    const weekday = date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    return `${dateValue} · ${weekday}`;
}
// --- Pure query helpers (exported for testing) ---
function crtBillingDayPoint(dateValue = billingSelectedDate) {
    const points = billingSummary && billingSummary.daily && Array.isArray(billingSummary.daily.points)
        ? billingSummary.daily.points
        : [];
    return points.find((point) => point && point.date === dateValue) || null;
}
function crtBillingSelectedDayIsCurrent(point = crtBillingDayPoint()) {
    const daily = billingSummary && billingSummary.daily;
    return Boolean(daily && point && point.date === daily.endDate);
}
function crtBillingTimeline(summary = billingSummary) {
    return summary && summary.liveTimeline || summary && summary.timeline || null;
}
function crtBillingCurrentRate(summary = billingSummary) {
    const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
    let total = 0;
    let hasRate = false;
    providers.forEach((provider) => {
        const tokenUsage = provider && provider.tokenUsage;
        const rate = tokenUsage && tokenUsage.tokensPerMinute;
        if (tokenUsage
            && tokenUsage.available !== false
            && typeof rate === 'number'
            && Number.isFinite(rate)
            && rate >= 0) {
            total += rate;
            hasRate = true;
        }
    });
    return hasRate ? total : null;
}
function crtBillingDayArrowTargetIndex(points, index, key) {
    if (!Array.isArray(points) || index < 0 || index >= points.length)
        return -1;
    const firstDate = parseCrtBillingDate(points[0] && points[0].date);
    const leadingDays = firstDate ? (firstDate.getDay() + 6) % 7 : 0;
    const position = leadingDays + index;
    const weekdayRow = position % 7;
    let targetPosition = position;
    if (key === 'ArrowUp') {
        if (weekdayRow === 0)
            return -1;
        targetPosition -= 1;
    }
    else if (key === 'ArrowDown') {
        if (weekdayRow === 6)
            return -1;
        targetPosition += 1;
    }
    else if (key === 'ArrowLeft') {
        targetPosition -= 7;
    }
    else if (key === 'ArrowRight') {
        targetPosition += 7;
    }
    else {
        return -1;
    }
    const targetIndex = targetPosition - leadingDays;
    return targetIndex >= 0 && targetIndex < points.length ? targetIndex : -1;
}
function crtBillingTimelineLabels(timeline) {
    const windowMinutes = Number(timeline && timeline.windowMs) / 60_000;
    const windowLabel = formatCrtBillingWindow(windowMinutes);
    const midpointLabel = formatCrtBillingWindow(windowMinutes / 2);
    return {
        integral: `TOKENS · ${windowLabel}`,
        peak: `TOK/MIN · ${windowLabel}`,
        title: `TOKEN BURN // ${windowLabel}`,
        ariaLabel: `Token burn rate over the last ${windowLabel}`,
        start: `-${windowLabel}`,
        midpoint: `-${midpointLabel}`,
    };
}
function formatCrtBillingWindow(windowMinutes) {
    const minutes = Number(windowMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0)
        return 'WINDOW';
    if (minutes % (7 * 24 * 60) === 0)
        return `${minutes / (7 * 24 * 60)}W`;
    if (minutes % (24 * 60) === 0)
        return `${minutes / (24 * 60)}D`;
    if (minutes % 60 === 0)
        return `${minutes / 60}H`;
    return `${Math.round(minutes)}M`;
}
function crtBillingOverrangeTier(value) {
    const total = Math.max(0, Number(value) || 0);
    if (total < CRT_BILLING_OVERRANGE_BASE)
        return 0;
    return Math.min(4, Math.floor(Math.log2(total / CRT_BILLING_OVERRANGE_BASE)) + 1);
}
function crtBillingOverrangeLabel(tier) {
    return tier > 0 ? `${2 ** (tier - 1)}B+ OVERRANGE` : '';
}
function crtBillingHeatThresholds(values) {
    const activeValues = (Array.isArray(values) ? values : [])
        .map(value => Math.max(0, Number(value) || 0))
        .filter(value => value > 0 && value < CRT_BILLING_OVERRANGE_BASE)
        .sort((left, right) => left - right);
    if (activeValues.length === 0)
        return [];
    return [0.2, 0.4, 0.6, 0.8].map(quantile => (activeValues[Math.min(activeValues.length - 1, Math.ceil(activeValues.length * quantile) - 1)]));
}
function crtBillingHeatLevel(value, thresholds) {
    const total = Math.max(0, Number(value) || 0);
    if (total <= 0)
        return 0;
    const bands = Array.isArray(thresholds) ? thresholds : [];
    return Math.max(1, Math.min(5, 1 + bands.filter(threshold => total > threshold).length));
}
function crtBillingDayDetailHasHourlyActivity(detail) {
    return Boolean(detail && Array.isArray(detail.hours) && detail.hours.some((hour) => (Math.max(0, Number(hour && hour.totalTokens) || 0) > 0)));
}
function crtBillingHourlyPath(hours, valueForHour, maximum) {
    const width = 600;
    const height = 120;
    const points = Array.isArray(hours) ? hours : [];
    if (points.length === 0 || maximum <= 0)
        return '';
    return points.map((hour, index) => {
        const startX = index / points.length * width;
        const endX = (index + 1) / points.length * width;
        const value = Math.max(0, Number(valueForHour(hour)) || 0);
        const y = height - Math.min(1, value / maximum) * height;
        return `${index === 0 ? 'M' : 'L'}${startX.toFixed(1)} ${y.toFixed(1)} L${endX.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
}
function formatCrtBillingReset(resetsAt, now = Date.now()) {
    const timestamp = Number(resetsAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0)
        return 'RESET --';
    const remainingMinutes = Math.max(0, Math.round((timestamp - now) / 60_000));
    if (remainingMinutes >= 24 * 60)
        return `RESET ${Math.floor(remainingMinutes / (24 * 60))}D ${Math.floor((remainingMinutes % (24 * 60)) / 60)}H`;
    if (remainingMinutes >= 60)
        return `RESET ${Math.floor(remainingMinutes / 60)}H ${remainingMinutes % 60}M`;
    return `RESET ${remainingMinutes}M`;
}
function crtBillingStatusText(summary = billingSummary) {
    if (billingMode === 'days')
        return 'HISTORY READY';
    const sampledAt = Number(summary && summary.sampledAt);
    if (!Number.isFinite(sampledAt) || sampledAt <= 0)
        return 'LIVE';
    const sampled = new Date(sampledAt);
    const time = [sampled.getHours(), sampled.getMinutes(), sampled.getSeconds()]
        .map(value => String(value).padStart(2, '0'))
        .join(':');
    return `LIVE ${time}`;
}
// --- Retry classification ---
class BillingTransientIncompleteHourlyDetailError extends Error {
    constructor() {
        super('Usage day response omitted previously available hourly bins');
        this.name = 'BillingTransientIncompleteHourlyDetailError';
    }
}
function isBillingTransientIncompleteHourlyDetail(error) {
    return error instanceof BillingTransientIncompleteHourlyDetailError;
}
function isBillingRetryableFailure(error, status) {
    if (error instanceof Error && error.name === 'AbortError')
        return false;
    if (isBillingTransientIncompleteHourlyDetail(error))
        return true;
    if (typeof status === 'number') {
        if (status === 408 || status === 429)
            return true;
        if (status >= 500)
            return true;
        return false;
    }
    return true;
}
let billingDeadlineHandleSequence = 0;
function armBillingDeadline(slot, controller, ms, operation, releaseOwner) {
    if (slot.timer !== null)
        clearTimeout(slot.timer);
    const handle = ++billingDeadlineHandleSequence;
    slot.handle = handle;
    slot.timer = setTimeout(() => {
        slot.timer = null;
        if (slot.handle !== handle || operation.generation !== billingGeneration)
            return;
        operation.valid = false;
        controller.abort();
        releaseOwner();
    }, ms);
    return handle;
}
function clearBillingDeadline(slot, handle) {
    if (slot.handle === handle && slot.timer !== null) {
        clearTimeout(slot.timer);
        slot.timer = null;
    }
}
// --- Tracked rAF registry ---
const billingTrackedFrames = new Set();
function trackBillingFrame(callback) {
    const generation = billingGeneration;
    const guarded = (now) => {
        billingTrackedFrames.delete(frameId);
        if (generation !== billingGeneration)
            return;
        callback(now);
    };
    const frameId = window.requestAnimationFrame(guarded);
    billingTrackedFrames.add(frameId);
    return frameId;
}
function cancelBillingTrackedFrames() {
    billingTrackedFrames.forEach((id) => window.cancelAnimationFrame(id));
    billingTrackedFrames.clear();
}
// --- Animation ---
function cancelCrtBillingTotalAnimation() {
    if (billingTotalAnimationFrame !== null) {
        window.cancelAnimationFrame(billingTotalAnimationFrame);
        billingTotalAnimationFrame = null;
    }
    billingTotalAnimationTarget = null;
}
function cancelCrtBillingMetricAnimations() {
    billingAnimatedMetrics.forEach((metric) => {
        if (metric.frame !== null)
            window.cancelAnimationFrame(metric.frame);
    });
    billingAnimatedMetrics.clear();
}
function updateCrtBillingAnimatedMetric(key, value, { date = '', live = false, write, } = {}) {
    const target = Number(value);
    const existing = billingAnimatedMetrics.get(key);
    if (!Number.isFinite(target) || target < 0 || typeof write !== 'function') {
        if (existing && existing.frame !== null)
            window.cancelAnimationFrame(existing.frame);
        billingAnimatedMetrics.delete(key);
        write?.(null, null);
        return;
    }
    const roundedTarget = Math.round(target);
    if (existing && existing.frame !== null && existing.target === roundedTarget && existing.date === date) {
        existing.write = write;
        return;
    }
    if (existing && existing.frame !== null)
        window.cancelAnimationFrame(existing.frame);
    const shouldSnap = !live
        || !existing
        || existing.date !== date
        || !Number.isFinite(existing.value)
        || roundedTarget <= existing.value;
    if (shouldSnap) {
        const metric = { date, value: roundedTarget, target: roundedTarget, frame: null, write };
        billingAnimatedMetrics.set(key, metric);
        write(roundedTarget, roundedTarget);
        return;
    }
    const metric = {
        date,
        value: existing.value,
        target: roundedTarget,
        frame: null,
        write,
    };
    billingAnimatedMetrics.set(key, metric);
    const startValue = existing.value;
    const startedAt = window.performance.now();
    const generation = billingGeneration;
    const step = (now) => {
        if (generation !== billingGeneration)
            return;
        const current = billingAnimatedMetrics.get(key);
        if (current !== metric)
            return;
        const progress = Math.min(1, Math.max(0, (now - startedAt) / CRT_BILLING_TOTAL_ANIMATION_MS));
        const steppedProgress = Math.min(1, Math.floor(progress * 18) / 18);
        const easedProgress = 1 - ((1 - steppedProgress) ** 3);
        metric.value = Math.round(startValue + (roundedTarget - startValue) * easedProgress);
        metric.write(metric.value, roundedTarget);
        if (progress < 1) {
            metric.frame = window.requestAnimationFrame(step);
            return;
        }
        metric.value = roundedTarget;
        metric.frame = null;
        metric.write(roundedTarget, roundedTarget);
    };
    metric.frame = window.requestAnimationFrame(step);
}
function updateCrtBillingExactMetric(id, value, { date = '', live = false } = {}) {
    const element = document.getElementById(id);
    if (!element)
        return;
    updateCrtBillingAnimatedMetric(id, value, {
        date,
        live,
        write: (displayed, target) => {
            element.textContent = formatCrtExactUsageValue(displayed);
            element.dataset.displayedValue = displayed === null ? '' : String(displayed);
            element.dataset.targetValue = target === null ? '' : String(target);
        },
    });
}
function writeCrtBillingTotalDisplay(value, target, { live = false } = {}) {
    const total = document.getElementById('billing-day-total');
    const compact = document.getElementById('billing-day-total-compact');
    const meter = document.getElementById('billing-day-total-meter');
    const numericValue = Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;
    const numericTarget = Number.isFinite(Number(target)) ? Math.max(0, Math.round(Number(target))) : null;
    if (total)
        total.textContent = formatCrtExactUsageValue(numericValue);
    if (compact)
        compact.textContent = formatCrtCompactTotalValue(numericValue);
    if (meter) {
        meter.classList.toggle('is-live', live);
        meter.dataset.displayedTotal = numericValue === null ? '' : String(numericValue);
        meter.dataset.targetTotal = numericTarget === null ? '' : String(numericTarget);
        meter.setAttribute('aria-label', numericTarget === null
            ? 'Total tokens unavailable'
            : `${formatCrtExactUsageValue(numericTarget)} total tokens${live ? ', live refresh every 5 seconds' : ''}`);
    }
}
function updateCrtBillingTotalDisplay(value, { date = '', live = false } = {}) {
    const target = Number(value);
    if (!Number.isFinite(target) || target < 0) {
        cancelCrtBillingTotalAnimation();
        billingDisplayedTotalDate = date;
        billingDisplayedTotalValue = null;
        writeCrtBillingTotalDisplay(null, null, { live });
        return;
    }
    const roundedTarget = Math.round(target);
    const shouldSnap = !live
        || billingDisplayedTotalDate !== date
        || billingDisplayedTotalValue === null
        || !Number.isFinite(billingDisplayedTotalValue)
        || roundedTarget <= billingDisplayedTotalValue;
    if (shouldSnap) {
        cancelCrtBillingTotalAnimation();
        billingDisplayedTotalDate = date;
        billingDisplayedTotalValue = roundedTarget;
        writeCrtBillingTotalDisplay(roundedTarget, roundedTarget, { live });
        return;
    }
    if (billingTotalAnimationFrame !== null && billingTotalAnimationTarget === roundedTarget)
        return;
    cancelCrtBillingTotalAnimation();
    const startValue = billingDisplayedTotalValue;
    if (startValue === null)
        return;
    const startedAt = window.performance.now();
    billingTotalAnimationTarget = roundedTarget;
    const generation = billingGeneration;
    const step = (now) => {
        if (generation !== billingGeneration)
            return;
        const progress = Math.min(1, Math.max(0, (now - startedAt) / CRT_BILLING_TOTAL_ANIMATION_MS));
        const steppedProgress = Math.min(1, Math.floor(progress * 18) / 18);
        const easedProgress = 1 - ((1 - steppedProgress) ** 3);
        billingDisplayedTotalValue = Math.round(startValue + (roundedTarget - startValue) * easedProgress);
        writeCrtBillingTotalDisplay(billingDisplayedTotalValue, roundedTarget, { live: true });
        if (progress < 1) {
            billingTotalAnimationFrame = window.requestAnimationFrame(step);
            return;
        }
        billingDisplayedTotalValue = roundedTarget;
        billingTotalAnimationFrame = null;
        billingTotalAnimationTarget = null;
        writeCrtBillingTotalDisplay(roundedTarget, roundedTarget, { live: true });
    };
    billingTotalAnimationFrame = window.requestAnimationFrame(step);
}
// --- Rendering ---
function renderCrtBillingDayInsight() {
    const cachedEntry = billingDayDetailCache.get(billingSelectedDate);
    const selectedDetail = billingDayDetail && billingDayDetail.date === billingSelectedDate
        ? billingDayDetail
        : cachedEntry && cachedEntry.detail || null;
    const point = crtBillingDayPoint();
    const hours = selectedDetail && Array.isArray(selectedDetail.hours) ? selectedDetail.hours : [];
    const state = document.getElementById('billing-day-insight-state');
    const totalPath = document.getElementById('billing-day-total-path');
    const cachePath = document.getElementById('billing-day-cache-path');
    const scale = document.getElementById('billing-day-curve-scale');
    const maximumLabel = document.getElementById('billing-day-curve-max');
    const hourStrip = document.getElementById('billing-day-hour-strip');
    const hourReadout = document.getElementById('billing-day-hour-readout');
    const shares = document.getElementById('billing-day-provider-shares');
    const maximum = Math.max(0, ...hours.map((hour) => Math.max(0, Number(hour && hour.totalTokens) || 0)));
    if (totalPath)
        totalPath.setAttribute('d', crtBillingHourlyPath(hours, (hour) => Number(hour.totalTokens) || 0, maximum));
    if (cachePath)
        cachePath.setAttribute('d', crtBillingHourlyPath(hours, (hour) => (Number(hour.cacheReadTokens) || 0) + (Number(hour.cacheWriteTokens) || 0), maximum));
    const isToday = crtBillingSelectedDayIsCurrent(point);
    updateCrtBillingAnimatedMetric('billing-day-curve-scale', maximum > 0 ? maximum : null, {
        date: point && point.date || '',
        live: isToday,
        write: (displayed) => {
            if (scale)
                scale.textContent = displayed === null ? '-- TOK/H PEAK' : `${formatCrtUsageValue(displayed)} TOK/H PEAK`;
        },
    });
    updateCrtBillingAnimatedMetric('billing-day-curve-max', maximum > 0 ? maximum : null, {
        date: point && point.date || '',
        live: isToday,
        write: (displayed) => {
            if (maximumLabel)
                maximumLabel.textContent = displayed === null ? '--' : formatCrtUsageValue(displayed);
        },
    });
    if (hourStrip) {
        hourStrip.replaceChildren();
        if (hours.length > 0) {
            const heatThresholds = crtBillingHeatThresholds(hours.map((hour) => hour && hour.totalTokens));
            if (billingSelectedHour === null || !Number.isInteger(billingSelectedHour) || billingSelectedHour < 0 || billingSelectedHour >= hours.length) {
                billingSelectedHour = hours.reduce((peakIndex, hour, index) => (Number(hour && hour.totalTokens) > Number(hours[peakIndex] && hours[peakIndex].totalTokens) ? index : peakIndex), 0);
            }
            const selectHour = (index, { focus = false } = {}) => {
                billingSelectedHour = index;
                hourStrip.querySelectorAll('.billing-day-hour-cell').forEach((cell, cellIndex) => {
                    const selected = cellIndex === index;
                    cell.classList.toggle('selected', selected);
                    cell.setAttribute('aria-selected', selected ? 'true' : 'false');
                    cell.tabIndex = selected ? 0 : -1;
                });
                const hour = hours[index] || {};
                const hourValue = Number.isFinite(Number(hour.hour)) ? Number(hour.hour) : index;
                const total = Math.max(0, Number(hour.totalTokens) || 0);
                const cache = Math.max(0, (Number(hour.cacheReadTokens) || 0) + (Number(hour.cacheWriteTokens) || 0));
                if (hourReadout) {
                    const endHour = hourValue + 1;
                    const cacheShare = total > 0 ? `${(cache / total * 100).toFixed(1)}% CACHE` : 'NO ACTIVITY';
                    hourReadout.textContent = `[${String(hourValue).padStart(2, '0')}:00—${String(endHour).padStart(2, '0')}:00]  TOTAL ${formatCrtUsageValue(total)}  //  CACHE ${formatCrtUsageValue(cache)}  //  ${cacheShare}`;
                    hourReadout.title = `${String(hourValue).padStart(2, '0')}:00—${String(endHour).padStart(2, '0')}:00 · ${formatCrtExactUsageValue(total)} total tokens · ${formatCrtExactUsageValue(cache)} cache tokens`;
                }
                if (focus)
                    hourStrip.children[index]?.focus();
            };
            hours.forEach((hour, index) => {
                const total = Math.max(0, Number(hour && hour.totalTokens) || 0);
                const cache = Math.max(0, (Number(hour && hour.cacheReadTokens) || 0) + (Number(hour && hour.cacheWriteTokens) || 0));
                const hourValue = Number.isFinite(Number(hour && hour.hour)) ? Number(hour.hour) : index;
                const overrangeTier = crtBillingOverrangeTier(total);
                const cell = document.createElement('button');
                cell.type = 'button';
                cell.className = 'billing-day-hour-cell';
                cell.dataset.level = overrangeTier ? 'overrange' : String(crtBillingHeatLevel(total, heatThresholds));
                if (overrangeTier)
                    cell.dataset.overrange = String(overrangeTier);
                cell.dataset.hour = String(hourValue);
                cell.setAttribute('role', 'gridcell');
                cell.setAttribute('aria-label', `${String(hourValue).padStart(2, '0')}:00 to ${String(hourValue + 1).padStart(2, '0')}:00, ${formatCrtExactUsageValue(total)} total tokens, ${formatCrtExactUsageValue(cache)} cache tokens`);
                cell.tabIndex = index === billingSelectedHour ? 0 : -1;
                cell.addEventListener('click', () => selectHour(index));
                cell.addEventListener('mouseenter', () => selectHour(index));
                cell.addEventListener('focus', () => selectHour(index));
                cell.addEventListener('keydown', (event) => {
                    if (!['ArrowLeft', 'ArrowRight'].includes(event.key))
                        return;
                    event.preventDefault();
                    event.stopPropagation();
                    selectHour(Math.max(0, Math.min(hours.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1))), { focus: true });
                });
                hourStrip.appendChild(cell);
            });
            selectHour(billingSelectedHour);
        }
        else if (hourReadout) {
            hourReadout.textContent = billingDayDetailLoading ? 'READING HOURLY COORDINATES' : 'NO HOURLY ACTIVITY';
            hourReadout.removeAttribute('title');
        }
    }
    if (state) {
        state.classList.toggle('is-error', Boolean(billingDayDetailError && !selectedDetail));
        state.textContent = billingDayDetailError && selectedDetail
            ? '24 HOURLY BINS READY · STALE'
            : billingDayDetailError
                ? 'DAY SIGNAL LOST'
                : billingDayDetailLoading && !selectedDetail
                    ? 'READING 24 HOURLY BINS'
                    : selectedDetail && maximum > 0
                        ? '24 HOURLY BINS READY'
                        : selectedDetail
                            ? 'NO HOURLY ACTIVITY'
                            : 'SELECTED DAY DETAIL';
    }
    if (!shares)
        return;
    shares.replaceChildren();
    const providerUsage = selectedDetail && selectedDetail.providers
        ? selectedDetail.providers
        : point && point.providers || {};
    const providerRows = Object.entries(providerUsage)
        .map(([provider, usage]) => ({ provider, total: Math.max(0, Number(usage && usage.totalTokens) || 0) }))
        .filter(row => row.total > 0)
        .sort((left, right) => right.total - left.total);
    const providerTotal = providerRows.reduce((total, row) => total + row.total, 0);
    if (providerRows.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'billing-day-share-empty';
        empty.textContent = billingDayDetailLoading ? 'READING AGENT TYPES' : 'NO ATTRIBUTED TOKEN DATA';
        shares.appendChild(empty);
        return;
    }
    providerRows.forEach(({ provider, total }) => {
        const percentage = providerTotal > 0 ? total / providerTotal * 100 : 0;
        const row = document.createElement('div');
        row.className = 'billing-day-share-row';
        const copy = document.createElement('div');
        copy.className = 'billing-day-share-copy';
        const name = document.createElement('span');
        name.textContent = provider.toUpperCase();
        const value = document.createElement('strong');
        value.textContent = `${percentage.toFixed(1)}% · ${formatCrtExactUsageValue(total)}`;
        copy.append(name, value);
        const track = document.createElement('div');
        track.className = 'billing-day-share-track';
        track.setAttribute('aria-hidden', 'true');
        const fill = document.createElement('span');
        fill.style.width = `${percentage.toFixed(2)}%`;
        track.appendChild(fill);
        row.append(copy, track);
        row.setAttribute('aria-label', `${provider}: ${percentage.toFixed(1)} percent, ${formatCrtExactUsageValue(total)} tokens`);
        shares.appendChild(row);
    });
}
function renderCrtBillingSelectedDay({ preferSummary = false } = {}) {
    const daily = billingSummary && billingSummary.daily;
    const point = crtBillingDayPoint();
    const cachedEntry = billingDayDetailCache.get(billingSelectedDate);
    const selectedDetail = billingDayDetail && billingDayDetail.date === billingSelectedDate
        ? billingDayDetail
        : cachedEntry && cachedEntry.detail || null;
    const displayDetail = preferSummary ? null : selectedDetail;
    const displayPoint = displayDetail && displayDetail.total || point;
    const displayProviders = displayDetail && displayDetail.providers || point && point.providers;
    const isToday = crtBillingSelectedDayIsCurrent(point);
    const date = document.getElementById('billing-day-date');
    const stateLabel = document.getElementById('billing-day-state');
    const providers = document.getElementById('billing-day-providers');
    if (date)
        date.textContent = crtBillingDayLabel(point && point.date);
    updateCrtBillingTotalDisplay(displayPoint && displayPoint.totalTokens, {
        date: point && point.date || '',
        live: isToday,
    });
    const selectedDate = point && point.date || '';
    updateCrtBillingExactMetric('billing-day-input', displayPoint && displayPoint.inputTokens, { date: selectedDate, live: isToday });
    updateCrtBillingExactMetric('billing-day-output', displayPoint && displayPoint.outputTokens, { date: selectedDate, live: isToday });
    updateCrtBillingExactMetric('billing-day-cache-read', displayPoint && displayPoint.cacheReadTokens, { date: selectedDate, live: isToday });
    updateCrtBillingExactMetric('billing-day-cache-write', displayPoint && displayPoint.cacheWriteTokens, { date: selectedDate, live: isToday });
    if (providers) {
        const providerTotals = displayProviders
            ? Object.entries(displayProviders).filter(([, usage]) => (Math.max(0, Number(usage && usage.totalTokens) || 0) > 0))
            : [];
        providers.textContent = providerTotals.length > 0
            ? `${providerTotals.length} ${providerTotals.length === 1 ? 'SOURCE' : 'SOURCES'}`
            : '--';
        providers.title = providerTotals
            .map(([provider, usage]) => `${provider.toUpperCase()} ${formatCrtExactUsageValue(usage && usage.totalTokens)}`)
            .join(' · ') || '--';
    }
    if (stateLabel) {
        const notes = isToday ? ['LIVE 5S', 'PARTIAL DAY', 'INCL CACHE'] : ['COMPLETE DAY', 'INCL CACHE'];
        if (daily && daily.partial)
            notes.push('PARTIAL SOURCE');
        if (point && Number(point.unattributedTokens) > 0) {
            notes.push(`${formatCrtUsageValue(point.unattributedTokens)} UNCLASSIFIED`);
        }
        stateLabel.textContent = point ? notes.join(' · ') : 'LOCAL HISTORY';
    }
    document.querySelectorAll('#billing-calendar-grid .billing-calendar-day').forEach((cell) => {
        const selected = cell.dataset.date === billingSelectedDate;
        cell.classList.toggle('selected', selected);
        cell.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    renderCrtBillingDayInsight();
}
function scrollCrtBillingSelectedDayIntoView() {
    const scroll = document.getElementById('billing-daily-scroll');
    const cell = billingSelectedDate
        ? document.querySelector(`#billing-calendar-grid .billing-calendar-day[data-date="${billingSelectedDate}"]`)
        : null;
    if (!scroll || !cell)
        return;
    const left = cell.offsetLeft;
    const right = left + cell.offsetWidth;
    if (left < scroll.scrollLeft)
        scroll.scrollLeft = left;
    else if (right > scroll.scrollLeft + scroll.clientWidth)
        scroll.scrollLeft = right - scroll.clientWidth;
}
function renderCrtBillingDaily(summary = billingSummary) {
    const daily = summary && summary.daily;
    const points = daily && Array.isArray(daily.points) ? daily.points : [];
    const totals = daily && daily.summary || {};
    const setValue = (id, value) => {
        const element = document.getElementById(id);
        if (element)
            element.textContent = formatCrtUsageValue(value);
    };
    const todayDetail = daily?.endDate ? billingDayDetailCache.get(daily.endDate)?.detail : undefined;
    const todayTokens = todayDetail && todayDetail.total ? todayDetail.total.totalTokens : totals.todayTokens;
    updateCrtBillingAnimatedMetric('billing-today-total', todayTokens, {
        date: daily && daily.endDate || '',
        live: true,
        write: (displayed, target) => {
            const element = document.getElementById('billing-today-total');
            if (!element)
                return;
            element.textContent = formatCrtUsageValue(displayed);
            element.dataset.displayedValue = displayed === null ? '' : String(displayed);
            element.dataset.targetValue = target === null ? '' : String(target);
        },
    });
    setValue('billing-7d-total', totals.sevenDayTokens);
    setValue('billing-30d-total', totals.thirtyDayTokens);
    setValue('billing-period-total', totals.periodTokens);
    const activeDays = points.filter((point) => Number(point && point.totalTokens) > 0).length;
    const billionDays = points.filter((point) => Number(point && point.totalTokens) >= 1_000_000_000).length;
    setValue('billing-active-days', activeDays);
    setValue('billing-billion-days', billionDays);
    const peak = document.getElementById('billing-peak-day');
    if (peak)
        peak.textContent = totals.peakDate
            ? `PEAK ${totals.peakDate.slice(5)} · ${formatCrtUsageValue(totals.peakTokens)}`
            : 'PEAK --';
    const range = document.getElementById('billing-daily-range');
    if (range) {
        const coverage = daily && Array.isArray(daily.coverage) ? daily.coverage : [];
        const availableSources = coverage.filter((source) => source && source.available !== false).length;
        range.textContent = daily
            ? `${daily.startDate} — ${daily.endDate} · ${String(daily.timeZone || 'LOCAL').toUpperCase()}${coverage.length ? ` · ${availableSources}/${coverage.length} SOURCES` : ''}`
            : 'LOCAL TIME';
    }
    const calendar = document.getElementById('billing-calendar-grid');
    const months = document.getElementById('billing-calendar-months');
    if (!calendar || !months)
        return;
    const signature = points.map((point) => [
        point.date,
        point.totalTokens,
        point.cacheReadTokens,
        point.cacheWriteTokens,
    ].join(':')).join('|');
    if (signature !== billingDailyRenderSignature) {
        billingDailyRenderSignature = signature;
        calendar.replaceChildren();
        months.replaceChildren();
        const chartPoints = points.slice(-(52 * 7));
        const heatThresholds = crtBillingHeatThresholds(chartPoints.map((point) => point && point.totalTokens));
        const firstDate = parseCrtBillingDate(chartPoints[0] && chartPoints[0].date);
        const leadingDays = firstDate ? (firstDate.getDay() + 6) % 7 : 0;
        const weekCount = Math.max(1, Math.ceil((leadingDays + chartPoints.length) / 7));
        calendar.style.setProperty('--billing-calendar-weeks', String(weekCount));
        months.style.setProperty('--billing-calendar-weeks', String(weekCount));
        Array.from({ length: leadingDays }).forEach(() => {
            const spacer = document.createElement('span');
            spacer.className = 'billing-calendar-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            calendar.appendChild(spacer);
        });
        const monthLabels = Array.from({ length: weekCount }, () => '');
        chartPoints.forEach((point, index) => {
            const pointDate = parseCrtBillingDate(point.date);
            const weekIndex = Math.floor((leadingDays + index) / 7);
            if (pointDate && (index === 0 || pointDate.getDate() === 1) && !monthLabels[weekIndex]) {
                monthLabels[weekIndex] = pointDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
            }
            const total = Math.max(0, Number(point.totalTokens) || 0);
            const cache = Math.min(total, Math.max(0, Number(point.cacheReadTokens) || 0)
                + Math.max(0, Number(point.cacheWriteTokens) || 0));
            const overrangeTier = crtBillingOverrangeTier(total);
            const overrangeLabel = crtBillingOverrangeLabel(overrangeTier);
            const day = document.createElement('button');
            day.type = 'button';
            day.className = 'billing-calendar-day';
            day.dataset.date = point.date;
            day.dataset.level = overrangeTier ? 'overrange' : String(crtBillingHeatLevel(total, heatThresholds));
            if (overrangeTier)
                day.dataset.overrange = String(overrangeTier);
            day.setAttribute('role', 'gridcell');
            day.setAttribute('aria-label', `${point.date}: ${formatCrtExactUsageValue(total)} tokens, ${formatCrtExactUsageValue(cache)} cache tokens${overrangeLabel ? `, ${overrangeLabel}` : ''}`);
            day.setAttribute('aria-selected', 'false');
            day.tabIndex = -1;
            day.title = `${point.date} · ${formatCrtExactUsageValue(total)} total · ${formatCrtExactUsageValue(cache)} cache${overrangeLabel ? ` · ${overrangeLabel}` : ''}`;
            day.addEventListener('click', () => selectCrtBillingDay(point.date));
            calendar.appendChild(day);
        });
        const trailingDays = weekCount * 7 - leadingDays - chartPoints.length;
        Array.from({ length: trailingDays }).forEach(() => {
            const spacer = document.createElement('span');
            spacer.className = 'billing-calendar-spacer';
            spacer.setAttribute('aria-hidden', 'true');
            calendar.appendChild(spacer);
        });
        monthLabels.forEach((label) => {
            const month = document.createElement('span');
            month.textContent = label;
            months.appendChild(month);
        });
        calendar.setAttribute('aria-label', `${chartPoints.length}-day token activity: ${activeDays} active days, ${billionDays} days at or above one billion tokens`);
        if (!billingSelectedDate || !points.some((point) => point.date === billingSelectedDate)) {
            billingSelectedDate = daily && daily.endDate || points.at(-1)?.date || '';
        }
        trackBillingFrame(() => {
            scrollCrtBillingSelectedDayIntoView();
        });
    }
    renderCrtBillingSelectedDay();
}
function appendCrtBillingMessage(container, text, isError = false) {
    const message = document.createElement('div');
    message.className = `billing-message${isError ? ' is-error' : ''}`;
    message.textContent = text;
    container.appendChild(message);
}
function renderCrtBillingQuota(summary = billingSummary) {
    const container = document.getElementById('billing-quota-list');
    if (!container)
        return;
    container.replaceChildren();
    const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
    let rowCount = 0;
    providers.forEach((provider) => {
        const quota = provider && provider.quota;
        if (!quota || quota.available === false)
            return;
        [quota.primary, quota.secondary].filter((limit) => Boolean(limit)).forEach((limit) => {
            const usedPercent = Math.max(0, Math.min(100, Number(limit.usedPercent) || 0));
            const remainingPercent = Math.max(0, 100 - usedPercent);
            const row = document.createElement('div');
            row.className = `billing-quota-row${remainingPercent <= 25 ? ' is-warning' : ''}`;
            const copy = document.createElement('div');
            copy.className = 'billing-quota-copy';
            const label = document.createElement('strong');
            label.textContent = `${String(provider.providerName || provider.provider || 'PROVIDER').toUpperCase()} ${formatCrtBillingWindow(Number(limit.windowMinutes) || 0)}`;
            const reset = document.createElement('small');
            reset.textContent = formatCrtBillingReset(limit.resetsAt);
            copy.append(label, reset);
            const track = document.createElement('div');
            track.className = 'billing-quota-track';
            track.setAttribute('role', 'meter');
            track.setAttribute('aria-label', `${label.textContent} remaining`);
            track.setAttribute('aria-valuemin', '0');
            track.setAttribute('aria-valuemax', '100');
            track.setAttribute('aria-valuenow', String(Math.round(remainingPercent)));
            const fill = document.createElement('span');
            fill.className = 'billing-quota-fill';
            fill.style.width = `${remainingPercent}%`;
            fill.title = `${Math.round(remainingPercent)}% remaining`;
            track.appendChild(fill);
            row.append(copy, track);
            container.appendChild(row);
            rowCount += 1;
        });
    });
    if (rowCount === 0)
        appendCrtBillingMessage(container, 'NO QUOTA TELEMETRY. LOCAL TOKEN SIGNAL REMAINS AVAILABLE.');
}
function renderCrtBillingProviders(summary = billingSummary) {
    const container = document.getElementById('billing-provider-list');
    if (!container)
        return;
    container.replaceChildren();
    const providers = summary && Array.isArray(summary.providers) ? summary.providers : [];
    if (providers.length === 0) {
        appendCrtBillingMessage(container, 'NO PROVIDER CHANNELS.');
        return;
    }
    providers.forEach((provider) => {
        const row = document.createElement('div');
        row.className = 'billing-provider-row';
        const copy = document.createElement('div');
        copy.className = 'billing-provider-copy';
        const name = document.createElement('strong');
        name.textContent = String(provider.providerName || provider.provider || 'PROVIDER').toUpperCase();
        const source = document.createElement('small');
        const usageAvailable = provider.tokenUsage && provider.tokenUsage.available !== false;
        const authStatus = usageAvailable
            ? (provider.auth && provider.auth.available ? provider.auth.status : 'LOCAL TELEMETRY')
            : (provider.tokenUsage && provider.tokenUsage.reason || 'NO TOKEN TELEMETRY');
        source.textContent = String(authStatus || 'AVAILABLE').toUpperCase();
        source.title = provider.tokenUsage && provider.tokenUsage.source || '';
        copy.append(name, source);
        const rate = document.createElement('strong');
        rate.className = 'billing-provider-rate';
        rate.textContent = usageAvailable
            ? `${formatCrtUsageValue(provider.tokenUsage && provider.tokenUsage.tokensPerMinute)} TOK/MIN`
            : 'NO TOKEN DATA';
        row.append(copy, rate);
        container.appendChild(row);
    });
}
function drawCrtBillingScope(summary = billingSummary) {
    const canvas = document.getElementById('billing-scope');
    if (!canvas || !billingPorts || !billingPorts.isActiveView())
        return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0)
        return;
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(rect.width * pixelRatio));
    const height = Math.max(1, Math.floor(rect.height * pixelRatio));
    if (canvas.width !== width)
        canvas.width = width;
    if (canvas.height !== height)
        canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context)
        return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    const timeline = crtBillingTimeline(summary);
    const points = timeline && Array.isArray(timeline.points) ? timeline.points : [];
    const values = points.map((point) => Math.max(0, Number(point.tokensPerMinute) || 0));
    const providerNames = points.length > 0 ? Object.keys(points[0].providers || {}) : [];
    const peak = Math.max(1, Number(timeline && timeline.peakTokensPerMinute) || 0, ...values);
    const paddingX = 9;
    const paddingY = 11;
    const graphWidth = Math.max(1, rect.width - paddingX * 2);
    const graphHeight = Math.max(1, rect.height - paddingY * 2);
    const bucketMinutes = Math.max(1 / 60, Number(timeline && timeline.bucketMs) / 60_000 || 1);
    const xAt = (index) => paddingX + (points.length <= 1 ? graphWidth : index / (points.length - 1) * graphWidth);
    const yAt = (value) => paddingY + graphHeight - Math.max(0, Math.min(1, value / peak)) * graphHeight;
    const strokeSeries = (series, color, lineWidth, dash = []) => {
        if (!series.length)
            return;
        context.save();
        context.beginPath();
        series.forEach((value, index) => {
            const x = xAt(index);
            const y = yAt(value);
            if (index === 0)
                context.moveTo(x, y);
            else
                context.lineTo(x, y);
        });
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.setLineDash(dash);
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.stroke();
        context.restore();
    };
    providerNames.forEach((provider, providerIndex) => {
        const series = points.map((point) => Math.max(0, Number(point.providers && point.providers[provider]) || 0) / bucketMinutes);
        strokeSeries(series, providerIndex % 2 === 0 ? 'rgba(61, 190, 108, 0.46)' : 'rgba(129, 255, 168, 0.3)', 1, providerIndex % 2 === 0 ? [5, 4] : [2, 4]);
    });
    if (values.length > 0) {
        context.save();
        context.beginPath();
        values.forEach((value, index) => {
            const x = xAt(index);
            const y = yAt(value);
            if (index === 0)
                context.moveTo(x, y);
            else
                context.lineTo(x, y);
        });
        context.lineTo(xAt(values.length - 1), paddingY + graphHeight);
        context.lineTo(xAt(0), paddingY + graphHeight);
        context.closePath();
        const fill = context.createLinearGradient(0, paddingY, 0, paddingY + graphHeight);
        fill.addColorStop(0, 'rgba(82, 255, 142, 0.17)');
        fill.addColorStop(1, 'rgba(12, 204, 104, 0.01)');
        context.fillStyle = fill;
        context.fill();
        context.restore();
        context.save();
        context.shadowColor = 'rgba(96, 255, 151, 0.92)';
        context.shadowBlur = 9;
        strokeSeries(values, 'rgba(116, 255, 167, 0.98)', 1.6);
        context.restore();
        const lastIndex = values.length - 1;
        context.save();
        context.beginPath();
        context.arc(xAt(lastIndex), yAt(values[lastIndex]), 2.4, 0, Math.PI * 2);
        context.fillStyle = 'rgba(175, 255, 202, 1)';
        context.shadowColor = 'rgba(96, 255, 151, 1)';
        context.shadowBlur = 12;
        context.fill();
        context.restore();
    }
}
function setCrtBillingMode(mode) {
    billingMode = mode === 'live' ? 'live' : 'days';
    const daysView = document.getElementById('billing-days-view');
    const liveView = document.getElementById('billing-live-view');
    const daysTab = document.getElementById('billing-days-tab');
    const liveTab = document.getElementById('billing-live-tab');
    if (daysView)
        daysView.classList.toggle('hidden', billingMode !== 'days');
    if (liveView)
        liveView.classList.toggle('hidden', billingMode !== 'live');
    if (daysTab) {
        daysTab.classList.toggle('active', billingMode === 'days');
        daysTab.setAttribute('aria-selected', billingMode === 'days' ? 'true' : 'false');
    }
    if (liveTab) {
        liveTab.classList.toggle('active', billingMode === 'live');
        liveTab.setAttribute('aria-selected', billingMode === 'live' ? 'true' : 'false');
    }
    const status = document.getElementById('billing-status');
    if (status && billingSummary && !billingLoading && !billingError) {
        status.textContent = crtBillingStatusText();
    }
    if (billingMode === 'live') {
        trackBillingFrame(() => {
            drawCrtBillingScope();
        });
    }
}
function renderCrtTopBarTokenRate(summary = billingSummary) {
    const tokensPerMinute = document.getElementById('tokens-per-minute');
    if (tokensPerMinute && billingPorts) {
        tokensPerMinute.textContent = billingPorts.formatTokenRate(crtBillingCurrentRate(summary));
    }
}
function renderCrtBilling() {
    billingRenderCount += 1;
    const status = document.getElementById('billing-status');
    const refresh = document.getElementById('billing-refresh');
    const empty = document.getElementById('billing-scope-empty');
    const timeline = crtBillingTimeline();
    const hasSignal = Boolean(timeline && Number(timeline.totalTokens) > 0);
    if (status) {
        status.classList.toggle('is-busy', billingLoading);
        status.classList.toggle('is-error', Boolean(billingError));
        status.textContent = billingError
            ? 'TELEMETRY ERROR'
            : billingLoading
                ? (billingSummary ? 'REFRESHING' : 'SCANNING LOGS')
                : billingSummary
                    ? crtBillingStatusText()
                    : 'STANDBY';
    }
    if (refresh)
        refresh.disabled = billingLoading;
    const currentRate = document.getElementById('billing-current-rate');
    const windowTotal = document.getElementById('billing-window-total');
    const peakRate = document.getElementById('billing-peak-rate');
    const dutyCycle = document.getElementById('billing-duty-cycle');
    const scopeScale = document.getElementById('billing-scope-scale');
    const windowLabel = document.getElementById('billing-window-label');
    const peakLabel = document.getElementById('billing-peak-label');
    const scopeTitle = document.getElementById('billing-scope-title');
    const scope = document.getElementById('billing-scope');
    const scopeStart = document.getElementById('billing-scope-start');
    const scopeMidpoint = document.getElementById('billing-scope-midpoint');
    const timelineLabels = crtBillingTimelineLabels(timeline);
    if (currentRate)
        currentRate.textContent = formatCrtUsageValue(crtBillingCurrentRate());
    if (windowTotal)
        windowTotal.textContent = formatCrtUsageValue(timeline && timeline.totalTokens);
    if (peakRate)
        peakRate.textContent = formatCrtUsageValue(timeline && timeline.peakTokensPerMinute);
    if (dutyCycle)
        dutyCycle.textContent = timeline ? `${timeline.activeBucketCount}/${timeline.bucketCount}` : '--';
    if (scopeScale)
        scopeScale.textContent = `${formatCrtUsageValue(timeline && timeline.peakTokensPerMinute)} TOK/MIN PEAK`;
    if (windowLabel)
        windowLabel.textContent = timelineLabels.integral;
    if (peakLabel)
        peakLabel.textContent = timelineLabels.peak;
    if (scopeTitle)
        scopeTitle.textContent = timelineLabels.title;
    if (scope)
        scope.setAttribute('aria-label', timelineLabels.ariaLabel);
    if (scopeStart)
        scopeStart.textContent = timelineLabels.start;
    if (scopeMidpoint)
        scopeMidpoint.textContent = timelineLabels.midpoint;
    if (empty) {
        empty.classList.toggle('hidden', hasSignal);
        empty.textContent = billingError ? 'SIGNAL LOST' : billingLoading ? 'ACQUIRING SIGNAL' : 'NO TOKEN SIGNAL';
    }
    setCrtBillingMode(billingMode);
    renderCrtBillingDaily();
    renderCrtBillingQuota();
    renderCrtBillingProviders();
    if (billingCanvasFrame !== null)
        window.cancelAnimationFrame(billingCanvasFrame);
    billingCanvasFrame = window.requestAnimationFrame(() => {
        billingCanvasFrame = null;
        drawCrtBillingScope();
    });
}
// --- Cache pruning ---
function pruneBillingDayDetailCache() {
    const daily = billingSummary && billingSummary.daily;
    if (!daily)
        return;
    const authoritativeDates = new Set(Array.isArray(daily.points) ? daily.points.map(point => point.date) : []);
    for (const cachedDate of billingDayDetailCache.keys()) {
        if (!authoritativeDates.has(cachedDate))
            billingDayDetailCache.delete(cachedDate);
    }
}
// --- Data loading ---
function selectCrtBillingDay(dateValue, { focus = false } = {}) {
    if (!crtBillingDayPoint(dateValue))
        return false;
    if (!dateValue)
        return false;
    cancelCrtBillingDayDetailRetry();
    billingSelectedDate = dateValue;
    billingSelectedHour = null;
    const isToday = crtBillingSelectedDayIsCurrent(crtBillingDayPoint(dateValue));
    billingDayDetail = billingDayDetailCache.get(dateValue)?.detail || null;
    billingDayDetailError = '';
    renderCrtBillingSelectedDay({ preferSummary: isToday });
    void loadCrtBillingDayDetail(dateValue, { force: isToday, live: isToday });
    if (focus) {
        const cell = document.querySelector(`#billing-calendar-grid .billing-calendar-day[data-date="${dateValue}"]`);
        if (cell) {
            cell.focus({ preventScroll: true });
            scrollCrtBillingSelectedDayIntoView();
        }
    }
    return true;
}
function selectCrtBillingDayByArrow(key) {
    if (!billingPorts || !billingPorts.isActiveView() || billingMode !== 'days')
        return false;
    const points = billingSummary && billingSummary.daily && Array.isArray(billingSummary.daily.points)
        ? billingSummary.daily.points
        : [];
    if (points.length === 0)
        return false;
    let index = points.findIndex((point) => point.date === billingSelectedDate);
    if (index < 0)
        index = points.length - 1;
    const nextIndex = crtBillingDayArrowTargetIndex(points, index, key);
    if (nextIndex < 0)
        return false;
    return selectCrtBillingDay(points[nextIndex].date, { focus: true });
}
function cancelCrtBillingDayDetailRetry() {
    if (billingDayDetailRetryTimer !== null) {
        clearTimeout(billingDayDetailRetryTimer);
        billingDayDetailRetryTimer = null;
    }
}
const billingSummaryDeadlineSlot = { timer: null, handle: 0 };
const billingDayDeadlineSlot = { timer: null, handle: 0 };
const billingTopbarDeadlineSlot = { timer: null, handle: 0 };
async function loadCrtBilling({ fresh = false } = {}) {
    billingRequestSequence += 1;
    const requestSequence = billingRequestSequence;
    const generation = billingGeneration;
    if (billingAbortController)
        billingAbortController.abort();
    if (crtTokenRateAbortController) {
        crtTokenRateAbortController.abort();
        crtTokenRateAbortController = null;
    }
    const controller = new window.AbortController();
    billingAbortController = controller;
    billingLoading = true;
    billingError = '';
    renderCrtBilling();
    const token = { valid: true, generation };
    const deadlineHandle = armBillingDeadline(billingSummaryDeadlineSlot, controller, CRT_BILLING_SUMMARY_DEADLINE_MS, token, () => { billingLoading = false; billingAbortController = null; renderCrtBilling(); });
    try {
        const query = fresh ? '?fresh=1' : billingMode === 'live' ? '?live=1' : '';
        const response = await fetch(billingPorts.apiPath(`/usage${query}`), {
            signal: controller.signal,
            cache: 'no-store',
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || !data.usage)
            throw new Error(data && data.error ? data.error : `Usage request failed (${response.status})`);
        if (!token.valid || generation !== billingGeneration || requestSequence !== billingRequestSequence)
            return;
        billingSummary = data.usage;
        pruneBillingDayDetailCache();
        renderCrtTopBarTokenRate();
    }
    catch (error) {
        if (!token.valid || controller.signal.aborted || generation !== billingGeneration || requestSequence !== billingRequestSequence)
            return;
        billingError = error instanceof Error ? error.message : 'Failed to load token telemetry';
    }
    finally {
        clearBillingDeadline(billingSummaryDeadlineSlot, deadlineHandle);
        if (token.valid && generation === billingGeneration && requestSequence === billingRequestSequence) {
            billingLoading = false;
            billingAbortController = null;
            renderCrtBilling();
            if (!billingError && billingSelectedDate) {
                void loadCrtBillingDayDetail(billingSelectedDate, {
                    force: fresh,
                    live: crtBillingSelectedDayIsCurrent(),
                });
            }
        }
    }
}
async function loadCrtBillingDayDetail(dateValue, { force = false, live = false, retryCount = 0 } = {}) {
    const date = String(dateValue || '').trim();
    if (!crtBillingDayPoint(date))
        return;
    if (retryCount === 0)
        cancelCrtBillingDayDetailRetry();
    const cachedEntry = billingDayDetailCache.get(date);
    const cached = cachedEntry && cachedEntry.detail;
    const cacheMaxAge = live ? CRT_BILLING_LIVE_DAY_REFRESH_MS : CRT_BILLING_DAY_DETAIL_CACHE_MS;
    const cacheFresh = cachedEntry && Date.now() - cachedEntry.fetchedAt <= cacheMaxAge;
    if (cached && cacheFresh && !force) {
        if (billingSelectedDate === date) {
            billingDayDetail = cached;
            billingDayDetailLoading = false;
            billingDayDetailError = '';
            renderCrtBillingSelectedDay();
        }
        return;
    }
    billingDayDetailRequestSequence += 1;
    const requestSequence = billingDayDetailRequestSequence;
    const generation = billingGeneration;
    if (billingDayDetailAbortController)
        billingDayDetailAbortController.abort();
    const controller = new window.AbortController();
    billingDayDetailAbortController = controller;
    billingDayDetailLoading = true;
    billingDayDetailError = '';
    if (billingSelectedDate === date) {
        if (!cached)
            billingDayDetail = null;
        renderCrtBillingDayInsight();
    }
    const token = { valid: true, generation };
    const deadlineHandle = armBillingDeadline(billingDayDeadlineSlot, controller, CRT_BILLING_DAY_DEADLINE_MS, token, () => { billingDayDetailLoading = false; billingDayDetailAbortController = null; });
    let shouldRetry = false;
    let failureStatus;
    try {
        const response = await fetch(billingPorts.apiPath(`/usage/day?date=${encodeURIComponent(date)}${live ? '&live=1' : ''}`), {
            signal: controller.signal,
            cache: 'no-store',
        });
        failureStatus = response.status;
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || !data.detail) {
            throw new Error(data && data.error ? data.error : `Usage day request failed (${response.status})`);
        }
        if (!token.valid || generation !== billingGeneration || requestSequence !== billingDayDetailRequestSequence)
            return;
        const previousDetail = cached || (billingDayDetail && billingDayDetail.date === date ? billingDayDetail : null);
        const nextTotal = Math.max(0, Number(data.detail.total && data.detail.total.totalTokens) || 0);
        if (nextTotal > 0
            && crtBillingDayDetailHasHourlyActivity(previousDetail)
            && !crtBillingDayDetailHasHourlyActivity(data.detail)) {
            throw new BillingTransientIncompleteHourlyDetailError();
        }
        billingDayDetailCache.set(date, { detail: data.detail, fetchedAt: Date.now() });
        if (billingSelectedDate === date)
            billingDayDetail = data.detail;
        if (live)
            renderCrtBillingDaily();
    }
    catch (error) {
        if (!token.valid || controller.signal.aborted || generation !== billingGeneration || requestSequence !== billingDayDetailRequestSequence)
            return;
        const retryable = isBillingRetryableFailure(error, failureStatus);
        if (billingSelectedDate === date && retryable && retryCount < CRT_BILLING_DAY_DETAIL_MAX_RETRIES) {
            shouldRetry = true;
        }
        else if (billingSelectedDate === date) {
            billingDayDetailError = error instanceof Error ? error.message : 'Failed to load selected day';
        }
    }
    finally {
        clearBillingDeadline(billingDayDeadlineSlot, deadlineHandle);
        if (token.valid && generation === billingGeneration && requestSequence === billingDayDetailRequestSequence) {
            billingDayDetailAbortController = null;
            if (shouldRetry) {
                billingDayDetailLoading = true;
                cancelCrtBillingDayDetailRetry();
                const retryDelay = CRT_BILLING_DAY_DETAIL_RETRY_MS * (2 ** retryCount);
                billingDayDetailRetryTimer = setTimeout(() => {
                    billingDayDetailRetryTimer = null;
                    if (generation !== billingGeneration || billingSelectedDate !== date || !billingPorts || !billingPorts.isActiveView()) {
                        billingDayDetailLoading = false;
                        return;
                    }
                    void loadCrtBillingDayDetail(date, { force: true, live, retryCount: retryCount + 1 });
                }, retryDelay);
            }
            else {
                billingDayDetailLoading = false;
            }
            if (billingSelectedDate === date)
                renderCrtBillingSelectedDay();
        }
    }
}
async function loadCrtTopBarTokenRate() {
    if (billingLoading || crtTokenRateAbortController)
        return;
    const generation = billingGeneration;
    const controller = new window.AbortController();
    crtTokenRateAbortController = controller;
    const token = { valid: true, generation };
    const deadlineHandle = armBillingDeadline(billingTopbarDeadlineSlot, controller, CRT_BILLING_TOPBAR_DEADLINE_MS, token, () => { crtTokenRateAbortController = null; });
    try {
        const response = await fetch(billingPorts.apiPath('/usage'), {
            signal: controller.signal,
            cache: 'no-store',
        });
        const data = await response.json().catch(() => null);
        if (!token.valid || controller.signal.aborted || generation !== billingGeneration)
            return;
        if (!response.ok || !data || !data.usage) {
            throw new Error(data && data.error ? data.error : `Usage request failed (${response.status})`);
        }
        renderCrtTopBarTokenRate(data.usage);
    }
    catch {
        if (token.valid && !controller.signal.aborted && generation === billingGeneration)
            renderCrtTopBarTokenRate(null);
    }
    finally {
        clearBillingDeadline(billingTopbarDeadlineSlot, deadlineHandle);
        if (crtTokenRateAbortController === controller)
            crtTokenRateAbortController = null;
    }
}
// --- Scheduling ---
function stopCrtTopBarTokenRateRefresh({ abort = false } = {}) {
    if (crtTokenRateFirstLoadTimer !== null) {
        clearTimeout(crtTokenRateFirstLoadTimer);
        crtTokenRateFirstLoadTimer = null;
    }
    if (crtTokenRateRefreshTimer !== null) {
        clearInterval(crtTokenRateRefreshTimer);
        crtTokenRateRefreshTimer = null;
    }
    if (abort && crtTokenRateAbortController) {
        crtTokenRateAbortController.abort();
        crtTokenRateAbortController = null;
    }
}
function startCrtTopBarTokenRateRefresh({ immediate = false } = {}) {
    stopCrtTopBarTokenRateRefresh();
    if (immediate) {
        void loadCrtTopBarTokenRate();
    }
    else {
        crtTokenRateFirstLoadTimer = setTimeout(() => {
            crtTokenRateFirstLoadTimer = null;
            if (document.visibilityState !== 'hidden')
                void loadCrtTopBarTokenRate();
        }, CRT_TOKEN_RATE_FIRST_LOAD_MS);
    }
    crtTokenRateRefreshTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden')
            void loadCrtTopBarTokenRate();
    }, CRT_TOKEN_RATE_REFRESH_MS);
}
function stopCrtBillingRefresh({ abort = false } = {}) {
    if (billingRefreshTimer !== null) {
        clearInterval(billingRefreshTimer);
        billingRefreshTimer = null;
    }
    if (billingLiveDayRefreshTimer !== null) {
        clearInterval(billingLiveDayRefreshTimer);
        billingLiveDayRefreshTimer = null;
    }
    if (abort && billingAbortController) {
        billingRequestSequence += 1;
        billingAbortController.abort();
        billingAbortController = null;
        billingLoading = false;
    }
    if (abort && billingDayDetailAbortController) {
        billingDayDetailRequestSequence += 1;
        billingDayDetailAbortController.abort();
        billingDayDetailAbortController = null;
        billingDayDetailLoading = false;
    }
    if (abort) {
        cancelCrtBillingDayDetailRetry();
        cancelCrtBillingTotalAnimation();
        cancelCrtBillingMetricAnimations();
        cancelBillingTrackedFrames();
    }
    if (billingSummaryDeadlineSlot.timer !== null) {
        clearTimeout(billingSummaryDeadlineSlot.timer);
        billingSummaryDeadlineSlot.timer = null;
    }
    if (billingDayDeadlineSlot.timer !== null) {
        clearTimeout(billingDayDeadlineSlot.timer);
        billingDayDeadlineSlot.timer = null;
    }
}
function startCrtBillingRefresh() {
    stopCrtBillingRefresh();
    const generation = billingGeneration;
    billingRefreshTimer = setInterval(() => {
        if (generation !== billingGeneration)
            return;
        if (billingPorts && billingPorts.isActiveView() && document.visibilityState !== 'hidden')
            void loadCrtBilling();
    }, CRT_BILLING_REFRESH_MS);
    billingLiveDayRefreshTimer = setInterval(() => {
        if (generation !== billingGeneration)
            return;
        if (!billingPorts || !billingPorts.isActiveView()
            || billingMode !== 'days'
            || document.visibilityState === 'hidden'
            || billingDayDetailLoading
            || !crtBillingSelectedDayIsCurrent())
            return;
        void loadCrtBillingDayDetail(billingSelectedDate, { force: true, live: true });
    }, CRT_BILLING_LIVE_DAY_REFRESH_MS);
}
// --- Lifecycle (public API) ---
function selectCrtBillingMode(mode) {
    const previousMode = billingMode;
    setCrtBillingMode(mode);
    if (billingPorts) {
        const selectedTab = document.getElementById(billingMode === 'live' ? 'billing-live-tab' : 'billing-days-tab');
        if (selectedTab)
            billingPorts.setNavigationSelection(selectedTab);
    }
    if (billingMode === 'live' && previousMode !== 'live') {
        if (billingAbortController) {
            billingRequestSequence += 1;
            billingAbortController.abort();
            billingAbortController = null;
            billingLoading = false;
        }
        if (billingDayDetailAbortController) {
            billingDayDetailRequestSequence += 1;
            billingDayDetailAbortController.abort();
            billingDayDetailAbortController = null;
            billingDayDetailLoading = false;
        }
        cancelCrtBillingDayDetailRetry();
        void loadCrtBilling();
    }
    else if (billingMode === 'live' && !billingLoading) {
        void loadCrtBilling();
    }
}
function refreshCrtBilling() {
    if (!billingPorts || !billingPorts.isActiveView() || billingLoading)
        return;
    void loadCrtBilling({ fresh: true });
}
function showCrtBilling() {
    if (!billingPorts)
        return;
    billingPorts.clearNavigationSelection();
    billingMode = 'days';
    billingPorts.setMainView('billing');
    renderCrtBilling();
    startCrtBillingRefresh();
    void loadCrtBilling({ fresh: true });
    trackBillingFrame(() => {
        const refresh = document.getElementById('billing-refresh');
        const daysTab = document.getElementById('billing-days-tab');
        if (billingPorts && (daysTab || refresh))
            billingPorts.setNavigationSelection(daysTab || refresh);
    });
}
function hideCrtBilling() {
    if (!billingPorts)
        return;
    billingPorts.clearNavigationSelection();
    billingPorts.setMainView('agents');
    billingPorts.renderShellState();
}
function leaveBilling() {
    stopCrtBillingRefresh({ abort: true });
    if (billingCanvasFrame !== null) {
        window.cancelAnimationFrame(billingCanvasFrame);
        billingCanvasFrame = null;
    }
}
function suspendBilling() {
    stopCrtBillingRefresh({ abort: true });
    stopCrtTopBarTokenRateRefresh({ abort: true });
    if (billingTopbarDeadlineSlot.timer !== null) {
        clearTimeout(billingTopbarDeadlineSlot.timer);
        billingTopbarDeadlineSlot.timer = null;
    }
    if (billingCanvasFrame !== null) {
        window.cancelAnimationFrame(billingCanvasFrame);
        billingCanvasFrame = null;
    }
}
function resumeBilling(isBillingView) {
    startCrtTopBarTokenRateRefresh({ immediate: true });
    if (isBillingView) {
        startCrtBillingRefresh();
        void loadCrtBilling({ fresh: true });
    }
}
function resizeBilling() {
    drawCrtBillingScope();
    trackBillingFrame(() => {
        scrollCrtBillingSelectedDayIntoView();
    });
}
function disposeBilling() {
    billingGeneration += 1;
    stopCrtBillingRefresh({ abort: true });
    stopCrtTopBarTokenRateRefresh({ abort: true });
    if (billingTopbarDeadlineSlot.timer !== null) {
        clearTimeout(billingTopbarDeadlineSlot.timer);
        billingTopbarDeadlineSlot.timer = null;
    }
    cancelCrtBillingTotalAnimation();
    cancelCrtBillingMetricAnimations();
    cancelBillingTrackedFrames();
    if (billingCanvasFrame !== null) {
        window.cancelAnimationFrame(billingCanvasFrame);
        billingCanvasFrame = null;
    }
}
function isBillingHourCellFocused() {
    const active = document.activeElement;
    return Boolean(active && active.classList && active.classList.contains('billing-day-hour-cell'));
}
// --- Controller global ---
const CrtBilling = {
    init(ports) { billingPorts = ports; },
    show: showCrtBilling,
    hide: hideCrtBilling,
    leave: leaveBilling,
    suspend: suspendBilling,
    resume: resumeBilling,
    resize: resizeBilling,
    dispose: disposeBilling,
    selectMode: selectCrtBillingMode,
    refresh: refreshCrtBilling,
    selectDay: selectCrtBillingDay,
    selectDayByArrow: selectCrtBillingDayByArrow,
    isHourCellFocused: isBillingHourCellFocused,
    startTopBarRefresh: startCrtTopBarTokenRateRefresh,
    get mode() { return billingMode; },
    get selectedDate() { return billingSelectedDate; },
    get isLoading() { return billingLoading; },
};
// --- Node.js test exports ---
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        CrtBilling,
        formatCrtUsageValue,
        formatCrtExactUsageValue,
        formatCrtCompactTotalValue,
        crtBillingDayArrowTargetIndex,
        crtBillingTimelineLabels,
        crtBillingTimeline,
        crtBillingCurrentRate,
        crtBillingHeatThresholds,
        crtBillingHeatLevel,
        crtBillingOverrangeTier,
        crtBillingOverrangeLabel,
        isBillingRetryableFailure,
        formatCrtBillingWindow,
        formatCrtBillingReset,
        parseCrtBillingDate,
        crtBillingDayLabel,
        crtBillingHourlyPath,
        crtBillingDayDetailHasHourlyActivity,
        __getSummary: () => billingSummary,
        __getDayDetail: () => billingDayDetail,
        __getRenderCount: () => billingRenderCount,
        __getDayDetailCache: () => Array.from(billingDayDetailCache.entries())
            .map(([cacheDate, entry]) => ({ date: cacheDate, detail: entry.detail })),
    };
}
