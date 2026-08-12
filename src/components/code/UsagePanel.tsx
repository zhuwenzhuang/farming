import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDownGlyph,
  ChevronRightGlyph,
  CloseGlyph,
} from '@/components/IconGlyphs'
import type {
  Agent,
  ProviderQuotaLimit,
  SystemStats,
  UsageDailyPoint,
  UsageDayDetail,
  UsageProviderSummary,
  UsageSummary,
  UsageTimelinePoint,
} from '@/types/agent'
import { appPath } from '@/lib/base-path'
import { useBackendSystemStats, useHasBackendSystemStats } from '@/lib/backend-live-status'
import { agentDisplayName, agentTitle } from '@/lib/format'
import { useEscapeKey } from '@/hooks/useKeyboard'
import type { AgentLaunchOption } from './agent-launch-options'

function formatUsageWindow(minutes: number | null | undefined) {
  const value = Number(minutes)
  if (!Number.isFinite(value) || value <= 0) return 'Window'
  if (value === 10080) return 'Weekly'
  if (value % 1440 === 0) return `${value / 1440}d`
  if (value % 60 === 0) return `${value / 60}h`
  return `${value}m`
}

function formatPercent(value: number | null | undefined) {
  const percent = Number(value)
  if (!Number.isFinite(percent)) return '--'
  return `${Math.round(percent)}%`
}

function formatRemainingPercent(value: number | null | undefined) {
  const usedPercent = Number(value)
  if (!Number.isFinite(usedPercent)) return '-- left'
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
  return `${Math.round(remainingPercent)}% left`
}

function formatQuotaRemaining(limit: ProviderQuotaLimit) {
  const remainingTokensRaw = limit.forecast?.remainingTokens
  const remainingTokens = remainingTokensRaw === null || remainingTokensRaw === undefined
    ? null
    : Number(remainingTokensRaw)
  if (typeof remainingTokens === 'number' && Number.isFinite(remainingTokens) && remainingTokens >= 0) {
    return `${formatCompactNumber(Math.round(remainingTokens))} tok left`
  }
  return formatRemainingPercent(limit.usedPercent)
}

function formatQuotaLimitTitle(source: string, limit: ProviderQuotaLimit) {
  const parts = [source]
  const used = formatPercent(limit.usedPercent)
  const remaining = formatQuotaRemaining(limit)
  if (used !== '--') parts.push(`${used} used`)
  if (remaining !== '-- left') parts.push(remaining)
  return parts.filter(Boolean).join(' / ')
}

function formatQuotaReset(resetsAt: number | null | undefined, now: number) {
  const timestamp = Number(resetsAt)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  const remainingMinutes = Math.max(0, Math.round((timestamp - now) / 60_000))
  if (remainingMinutes === 0) return 'reset now'
  if (remainingMinutes >= 24 * 60) {
    return `reset ${Math.floor(remainingMinutes / (24 * 60))}d ${Math.floor((remainingMinutes % (24 * 60)) / 60)}h`
  }
  if (remainingMinutes >= 60) {
    return `reset ${Math.floor(remainingMinutes / 60)}h ${remainingMinutes % 60}m`
  }
  return `reset ${remainingMinutes}m`
}

function formatCompactNumber(value: number) {
  if (value >= 1_000_000_000) {
    const compact = value / 1_000_000_000
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}B`
  }
  if (value >= 1_000_000) {
    const compact = value / 1_000_000
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}M`
  }
  if (value >= 1_000) {
    const compact = value / 1_000
    return `${compact >= 10 ? Math.round(compact) : Math.round(compact * 10) / 10}k`
  }
  return `${value}`
}

function formatTokenRate(value: number | null | undefined, approximate = false) {
  const rate = Number(value)
  if (!Number.isFinite(rate)) return '-- tok/min'
  const rounded = rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate)
  return `${approximate ? '~' : ''}${formatCompactNumber(rounded)} tok/min`
}

function formatAuthStatus(provider: UsageProviderSummary) {
  const status = provider.auth?.status || ''
  if (!provider.auth?.available) return 'offline'
  if (/logged in/i.test(status)) return 'logged in'
  return status || 'available'
}

function providerHasUsableTokenInfo(provider: UsageProviderSummary) {
  if (provider.tokenUsage.available === false) return false
  const eventCount = Number(provider.tokenUsage.eventCount)
  const totalTokens = Number(provider.tokenUsage.totalTokens)
  const hasObservedTokens = (Number.isFinite(eventCount) && eventCount > 0)
    || (Number.isFinite(totalTokens) && totalTokens > 0)
  return provider.auth.available || hasObservedTokens
}

function visibleUsageProviders(usageSummary: UsageSummary | null) {
  return usageSummary?.providers.filter(providerHasUsableTokenInfo) ?? []
}

function providerLocalTokenRate(usageSummary: UsageSummary | null) {
  const providers = visibleUsageProviders(usageSummary)
  if (!providers.length) return null
  return providers.reduce((sum, provider) => {
    const rate = Number(provider.tokenUsage.tokensPerMinute)
    return sum + (Number.isFinite(rate) ? rate : 0)
  }, 0)
}

function quotaRemainingPercent(limit: ProviderQuotaLimit) {
  const forecastRemaining = limit.forecast?.remainingPercent
  if (typeof forecastRemaining === 'number' && Number.isFinite(forecastRemaining)) {
    return Math.max(0, Math.min(100, forecastRemaining))
  }
  const usedPercent = Number(limit.usedPercent)
  if (!Number.isFinite(usedPercent)) return null
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

function quotaLimitSortWeight(limit: ProviderQuotaLimit) {
  const minutes = Number(limit.windowMinutes)
  if (Number.isFinite(minutes) && minutes >= 7 * 24 * 60 - 60) return 0
  if (Number.isFinite(minutes) && minutes >= 5 * 60 - 15 && minutes <= 5 * 60 + 15) return 1
  return 2
}

function providerQuotaLimits(provider: UsageProviderSummary) {
  return [provider.quota.primary, provider.quota.secondary]
    .filter((limit): limit is ProviderQuotaLimit => Boolean(limit))
    .map(limit => ({
      label: formatUsageWindow(limit.windowMinutes),
      limit,
      remaining: quotaRemainingPercent(limit),
      exhaustedAt: typeof limit.forecast?.projectedExhaustedAt === 'number' && Number.isFinite(limit.forecast.projectedExhaustedAt)
        ? limit.forecast.projectedExhaustedAt
        : null,
    }))
    .filter(item => item.remaining !== null)
    .sort((a, b) => quotaLimitSortWeight(a.limit) - quotaLimitSortWeight(b.limit))
}

function providerHasTokenBurn(provider: UsageProviderSummary) {
  const tokensPerMinute = Number(provider.tokenUsage.tokensPerMinute)
  return Number.isFinite(tokensPerMinute) && tokensPerMinute > 0
}

function dynamicQuotaProvider(usageSummary: UsageSummary | null) {
  const providers = visibleUsageProviders(usageSummary)
  if (!providers.length) return null
  const candidates = providers
    .filter(provider => providerHasTokenBurn(provider) && provider.quota.available)
    .map(provider => {
      const limits = providerQuotaLimits(provider)
      const lowLimits = limits.filter(item => item.remaining !== null && item.remaining < 50)
      if (!lowLimits.length) return null
      const earliestExhaustedAt = lowLimits.reduce<number | null>((best, item) => {
        if (item.exhaustedAt === null) return best
        return best === null ? item.exhaustedAt : Math.min(best, item.exhaustedAt)
      }, null)
      const lowestRemaining = lowLimits.reduce((best, item) => Math.min(best, item.remaining ?? 100), 100)
      return {
        provider,
        limits,
        earliestExhaustedAt,
        lowestRemaining,
      }
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  return candidates.sort((a, b) => {
    if (a.earliestExhaustedAt !== null && b.earliestExhaustedAt !== null) {
      return a.earliestExhaustedAt - b.earliestExhaustedAt
    }
    if (a.earliestExhaustedAt !== null) return -1
    if (b.earliestExhaustedAt !== null) return 1
    return a.lowestRemaining - b.lowestRemaining
  })[0] ?? null
}

function formatDynamicQuotaSummary(usageSummary: UsageSummary | null, now: number) {
  const candidate = dynamicQuotaProvider(usageSummary)
  if (!candidate) return null

  const parts = [candidate.provider.providerName]
  candidate.limits.forEach(item => {
    parts.push(`${item.label} ${Math.round(item.remaining ?? 0)}%`)
    const reset = formatQuotaReset(item.limit.resetsAt, now)
    if (reset) parts.push(reset)
  })
  return parts.join(' · ')
}

function formatCollapsedUsageSummary(
  usageSummary: UsageSummary | null,
  systemStats: SystemStats | null,
  now: number,
) {
  const dynamicSummary = formatDynamicQuotaSummary(usageSummary, now)
  if (dynamicSummary) {
    return dynamicSummary
  }

  const parts: string[] = []
  const localTokenRate = providerLocalTokenRate(usageSummary)
  if (localTokenRate !== null) parts.push(formatTokenRate(localTokenRate))
  if (systemStats) parts.push(`CPU ${systemStats.cpu}% / MEM ${systemStats.memory.percentage}%`)
  return parts.join(' · ') || '5m'
}

function systemStatsWithFallback(liveStats: SystemStats | null, usageSummary: UsageSummary | null) {
  return liveStats ?? usageSummary?.systemStats ?? null
}

function CollapsedUsageSummary({ usageSummary, now }: { usageSummary: UsageSummary | null; now: number }) {
  const liveStats = useBackendSystemStats()
  const summary = formatCollapsedUsageSummary(
    usageSummary,
    systemStatsWithFallback(liveStats, usageSummary),
    now,
  )
  return (
    <span className="code-usage-summary" data-testid="code-usage-summary" title={summary}>
      {summary}
    </span>
  )
}

function SystemUsageRow({ usageSummary }: { usageSummary: UsageSummary | null }) {
  const liveStats = useBackendSystemStats()
  const systemStats = systemStatsWithFallback(liveStats, usageSummary)
  if (!systemStats) return null
  return (
    <div className="code-usage-row">
      <span>System</span>
      <strong>CPU {systemStats.cpu}% / MEM {systemStats.memory.percentage}%</strong>
    </div>
  )
}

interface UsagePanelProps {
  collapsed: boolean
  mainAgent: Agent | null
  now: number
  usageSummary: UsageSummary | null
  agentLaunchOptions: AgentLaunchOption[]
  onToggleCollapsed: () => void
  onOpenMainAgent: () => void
  onRestartMainAgent: (command: string) => void
}

function formatHeatmapTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatHeatmapHour(timestamp: number) {
  return `${String(new Date(timestamp).getHours()).padStart(2, '0')}:00`
}

function formatExactTokenCount(value: number) {
  return Math.round(value).toLocaleString('en-US')
}

function usageHeatThresholds(values: number[]) {
  const activeValues = values
    .map(value => Math.max(0, Number(value) || 0))
    .filter(value => value > 0)
    .sort((left, right) => left - right)
  if (!activeValues.length) return []
  const minimum = activeValues[0]!
  const maximum = activeValues[activeValues.length - 1]!
  if (minimum === maximum) return [0.2, 0.4, 0.6, 0.8].map(portion => maximum * portion)
  return [0.2, 0.4, 0.6, 0.8].map(quantile => {
    const position = (activeValues.length - 1) * quantile
    const lowerIndex = Math.floor(position)
    const upperIndex = Math.ceil(position)
    const lower = activeValues[lowerIndex]!
    const upper = activeValues[upperIndex]!
    return lower + (upper - lower) * (position - lowerIndex)
  })
}

function usageHeatLevel(value: number, thresholds: number[]) {
  const total = Math.max(0, Number(value) || 0)
  if (total <= 0) return 0
  return Math.max(1, Math.min(5, 1 + thresholds.filter(threshold => total > threshold).length))
}

function validUsageTimelinePoints(usageSummary: UsageSummary) {
  const timeline = usageSummary.timeline
  const points = Array.isArray(timeline?.points) ? timeline.points : []
  const hasValidPoints = points.length > 0 && points.every((point, index) => (
    Number.isFinite(Number(point.startedAt))
    && Number.isFinite(Number(point.endedAt))
    && Number(point.endedAt) > Number(point.startedAt)
    && Number.isFinite(Number(point.totalTokens))
    && Number(point.totalTokens) >= 0
    && (index === 0 || Number(point.startedAt) >= Number(points[index - 1]!.startedAt))
  ))
  return hasValidPoints ? points : null
}

function parseUsageDate(dateValue: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12, 0, 0, 0)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

function validUsageDailyPoints(usageSummary: UsageSummary) {
  const points = Array.isArray(usageSummary.daily?.points) ? usageSummary.daily.points : []
  const hasValidPoints = points.length > 0 && points.every((point, index) => (
    Boolean(parseUsageDate(point.date))
    && Number.isFinite(Number(point.totalTokens))
    && Number(point.totalTokens) >= 0
    && (index === 0 || point.date > points[index - 1]!.date)
  ))
  return hasValidPoints ? points.slice(-(52 * 7)) : null
}

type UsageHeatmapInspection = {
  label: string
  tokens: number
}

function TokenUsageSparkline({
  usageSummary,
  points,
  onInspect,
}: {
  usageSummary: UsageSummary
  points: UsageTimelinePoint[]
  onInspect: (inspection: UsageHeatmapInspection) => void
}) {
  const timeline = usageSummary.timeline
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  const total = points.reduce((sum, point) => sum + Number(point.totalTokens), 0)
  const windowLabel = formatUsageWindow(Number(timeline.windowMs) / 60_000).toLowerCase()
  const tickTimes = [0, 0.25, 0.5, 0.75, 1].map(position => (
    timeline.startAt + (timeline.endAt - timeline.startAt) * position
  ))
  const width = 100
  const height = 30
  const maximum = Math.max(0, ...points.map(point => Number(point.totalTokens)))
  const coordinates = points.map((point, index) => ({
    x: points.length > 1 ? (index / (points.length - 1)) * width : width / 2,
    y: maximum > 0 ? height - (Number(point.totalTokens) / maximum) * (height - 4) - 2 : height - 2,
  }))
  const path = coordinates.reduce((value, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`
    const previous = coordinates[index - 1]!
    const midpoint = (previous.x + point.x) / 2
    return `${value} C ${midpoint} ${previous.y}, ${midpoint} ${point.y}, ${point.x} ${point.y}`
  }, '')
  const hoveredCoordinate = hoveredIndex === null ? null : coordinates[hoveredIndex] ?? null

  return (
    <>
      <svg
        className="code-usage-sparkline"
        data-testid="code-usage-sparkline"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Token activity over the last ${windowLabel}, ${formatCompactNumber(total)} tokens`}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        <path className="code-usage-sparkline-line" d={path} vectorEffect="non-scaling-stroke" />
        {hoveredCoordinate ? (
          <path
            className="code-usage-sparkline-point"
            data-testid="code-usage-sparkline-point"
            d={`M ${hoveredCoordinate.x} ${hoveredCoordinate.y} h 0.001`}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {points.map((point, index) => {
          const tokens = Number(point.totalTokens)
          const label = `${formatHeatmapTime(point.startedAt)}–${formatHeatmapTime(point.endedAt)}`
          const title = `${label} · ${formatExactTokenCount(tokens)} tokens`
          return (
            <rect
              key={`${point.startedAt}-${index}`}
              className="code-usage-sparkline-hit"
              data-start={point.startedAt}
              x={(index / points.length) * width}
              y="0"
              width={width / points.length}
              height={height}
              aria-label={title}
              onMouseEnter={() => {
                setHoveredIndex(index)
                onInspect({ label, tokens })
              }}
            />
          )
        })}
      </svg>
      <div className="code-usage-time-axis" data-testid="code-usage-time-axis" aria-hidden="true">
        {tickTimes.map((timestamp, index) => (
          <span key={`${timestamp}-${index}`}>{formatHeatmapHour(timestamp)}</span>
        ))}
      </div>
    </>
  )
}

const DailyUsageGrid = memo(function DailyUsageGrid({
  points,
  layout,
  peakDay,
  recentStartIndex,
  selectedDay,
  showDayHighlight,
  onInspect,
  onPreview,
  ariaLabel,
}: {
  points: UsageDailyPoint[]
  layout: 'calendar' | 'matrix'
  peakDay: UsageDailyPoint | null
  recentStartIndex: number
  selectedDay: UsageDailyPoint | null
  showDayHighlight: boolean
  onInspect: (inspection: UsageHeatmapInspection) => void
  onPreview: (inspection: UsageHeatmapInspection | null) => void
  ariaLabel: string
}) {
  const firstDate = parseUsageDate(points[0]!.date)!
  const leadingDays = layout === 'calendar' ? (firstDate.getDay() + 6) % 7 : 0
  const columnCount = layout === 'calendar'
    ? Math.max(1, Math.ceil((leadingDays + points.length) / 7))
    : Math.min(10, points.length)
  const trailingDays = layout === 'calendar' ? columnCount * 7 - leadingDays - points.length : 0
  const thresholds = usageHeatThresholds(points.map(point => point.totalTokens))
  const pointsByDate = new Map(points.map(point => [point.date, point]))
  const pointFromTarget = (target: EventTarget | null) => {
    const cell = target instanceof HTMLElement
      ? target.closest<HTMLElement>('.code-usage-daily-heatmap-cell')
      : null
    return cell ? pointsByDate.get(cell.dataset.date || '') ?? null : null
  }
  const inspectTarget = (target: EventTarget | null) => {
    const point = pointFromTarget(target)
    if (point) onInspect({ label: point.date, tokens: point.totalTokens })
  }

  return (
    <div
      className="code-usage-daily-heatmap"
      data-layout={layout}
      data-testid="code-usage-daily-heatmap"
      role={showDayHighlight ? 'group' : 'img'}
      aria-label={ariaLabel}
      style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(2px, 1fr))` }}
      onClick={showDayHighlight ? event => inspectTarget(event.target) : undefined}
      onFocus={showDayHighlight ? event => {
        const point = pointFromTarget(event.target)
        if (point) onPreview({ label: point.date, tokens: point.totalTokens })
      } : undefined}
      onBlur={showDayHighlight ? event => {
        if (!event.currentTarget.contains(event.relatedTarget)) onPreview(null)
      } : undefined}
      onKeyDown={showDayHighlight ? event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          inspectTarget(event.target)
        }
      } : undefined}
      onPointerOver={showDayHighlight ? event => {
        const point = pointFromTarget(event.target)
        if (point) onPreview({ label: point.date, tokens: point.totalTokens })
      } : undefined}
      onPointerLeave={showDayHighlight ? () => onPreview(null) : undefined}
    >
      {Array.from({ length: leadingDays }, (_, index) => (
        <span key={`leading-${index}`} className="code-usage-daily-spacer" aria-hidden="true" />
      ))}
      {points.map((point, index) => {
        const tokens = Number(point.totalTokens)
        const isPeak = point.date === peakDay?.date
        const isBillion = tokens > 1_000_000_000
        const markerLabel = isPeak ? 'Token king' : isBillion ? 'Over 1B tokens' : ''
        const title = `${point.date} · ${formatCompactNumber(tokens)} tokens${markerLabel ? ` · ${markerLabel}` : ''}`
        const ariaLabel = `${point.date} · ${formatExactTokenCount(tokens)} tokens${markerLabel ? ` · ${markerLabel}` : ''}`
        return (
          <span
            key={point.date}
            className="code-usage-heatmap-cell code-usage-daily-heatmap-cell"
            data-date={point.date}
            data-level={usageHeatLevel(tokens, thresholds)}
            data-peak={isPeak ? 'true' : undefined}
            data-billion={isBillion ? 'true' : undefined}
            data-shape={isPeak ? 'crown' : isBillion ? 'flame' : undefined}
            data-recent={index >= recentStartIndex ? 'true' : undefined}
            data-selected={point.date === selectedDay?.date ? 'true' : undefined}
            title={showDayHighlight ? undefined : title}
            aria-label={ariaLabel}
            role={showDayHighlight ? 'button' : undefined}
            tabIndex={showDayHighlight ? 0 : undefined}
            onMouseEnter={showDayHighlight ? undefined : () => onInspect({ label: point.date, tokens })}
          />
        )
      })}
      {Array.from({ length: trailingDays }, (_, index) => (
        <span key={`trailing-${index}`} className="code-usage-daily-spacer" aria-hidden="true" />
      ))}
    </div>
  )
})

function DailyUsageHeatmap({
  points,
  onInspect,
  inspection = null,
  layout = 'calendar',
  rangeLabel = '52w',
  peakDay: authoritativePeakDay,
  showDayHighlight = false,
}: {
  points: UsageDailyPoint[]
  onInspect: (inspection: UsageHeatmapInspection) => void
  inspection?: UsageHeatmapInspection | null
  layout?: 'calendar' | 'matrix'
  rangeLabel?: string
  peakDay?: UsageDailyPoint | null
  showDayHighlight?: boolean
}) {
  const [previewInspection, setPreviewInspection] = useState<UsageHeatmapInspection | null>(null)
  const activeDays = points.filter(point => point.totalTokens > 0).length
  const recentStartIndex = Math.max(0, points.length - 7)
  const recentTokens = points.slice(recentStartIndex).reduce((sum, point) => sum + point.totalTokens, 0)
  const peakCandidate = points.reduce<UsageDailyPoint | null>((peak, point) => (
    !peak || point.totalTokens > peak.totalTokens ? point : peak
  ), null)
  const computedPeakDay = peakCandidate && peakCandidate.totalTokens > 0 ? peakCandidate : null
  const peakDay = authoritativePeakDay === undefined ? computedPeakDay : authoritativePeakDay
  const selectedDay = inspection ? points.find(point => point.date === inspection.label) ?? null : null
  const previewDay = previewInspection ? points.find(point => point.date === previewInspection.label) ?? null : null
  const today = points[points.length - 1] ?? null
  const highlightedDay = previewDay ?? selectedDay ?? today
  const highlightedDayIsPeak = Boolean(highlightedDay && highlightedDay.date === peakDay?.date)
  const isPreviewingUnselectedDay = Boolean(previewDay && previewDay.date !== selectedDay?.date)

  return (
    <>
      <div className="code-usage-activity-heading">
        <span>{rangeLabel} · daily</span>
        {showDayHighlight && highlightedDay ? (
          <div
            className="code-usage-detail-day-highlight"
            data-state={isPreviewingUnselectedDay ? 'preview' : selectedDay ? 'selected' : 'today'}
            data-testid="code-usage-detail-day-highlight"
          >
            <span>{(previewDay || selectedDay) && highlightedDayIsPeak ? 'Top · ' : ''}{formatUsageDay(highlightedDay.date)}</span>
            <strong>{formatCompactNumber(highlightedDay.totalTokens)}</strong>
            <small>tokens</small>
          </div>
        ) : (
          <span>7d {formatCompactNumber(recentTokens)}</span>
        )}
      </div>
      <DailyUsageGrid
        points={points}
        layout={layout}
        peakDay={peakDay}
        recentStartIndex={recentStartIndex}
        selectedDay={selectedDay}
        showDayHighlight={showDayHighlight}
        onInspect={onInspect}
        onPreview={setPreviewInspection}
        ariaLabel={`Daily token activity over ${rangeLabel}, ${activeDays} active days`}
      />
      {showDayHighlight && (selectedDay ?? today) && (
        <label className="code-usage-mobile-date-picker">
          <span>Selected day</span>
          <input
            type="date"
            min={points[0]!.date}
            max={today?.date}
            value={(selectedDay ?? today)!.date}
            data-testid="code-usage-mobile-date-picker"
            onChange={event => {
              const point = points.find(candidate => candidate.date === event.currentTarget.value)
              if (point) onInspect({ label: point.date, tokens: point.totalTokens })
            }}
          />
        </label>
      )}
    </>
  )
}

function sumDailyTokens(points: UsageDailyPoint[]) {
  return points.reduce((sum, point) => sum + Number(point.totalTokens), 0)
}

function formatUsageChange(current: number, previous: number) {
  if (previous <= 0) return current > 0 ? 'New' : '0%'
  const percent = Math.round(((current - previous) / previous) * 100)
  return `${percent > 0 ? '+' : ''}${percent}%`
}

function formatUsageDay(dateValue: string) {
  const date = parseUsageDate(dateValue)
  if (!date) return dateValue
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function validUsageDayDetail(value: unknown, date: string): value is UsageDayDetail {
  if (!value || typeof value !== 'object') return false
  const detail = value as UsageDayDetail
  return detail.date === date
    && Array.isArray(detail.hours)
    && detail.hours.length === 24
    && detail.hours.every((hour, index) => (
      hour.hour === index
      && Number.isFinite(Number(hour.totalTokens))
      && hour.totalTokens >= 0
      && Boolean(hour.agents && typeof hour.agents === 'object')
    ))
    && Array.isArray(detail.agents)
    && detail.agents.every(agent => (
      Boolean(agent.key && agent.label)
      && Number.isFinite(Number(agent.totalTokens))
      && agent.totalTokens >= 0
    ))
}

function useUsageDayDetail(date: string, live: boolean) {
  const [retry, setRetry] = useState(0)
  const [state, setState] = useState<{
    date: string
    detail: UsageDayDetail | null
    error: string
    loading: boolean
  }>({ date: '', detail: null, error: '', loading: false })

  useEffect(() => {
    if (!date) {
      setState({ date: '', detail: null, error: '', loading: false })
      return
    }
    const controller = new AbortController()
    setState({ date, detail: null, error: '', loading: true })
    const params = new URLSearchParams({ date })
    if (live) params.set('live', '1')
    fetch(appPath(`/api/usage/day?${params.toString()}`), { signal: controller.signal })
      .then(async response => {
        const payload = await response.json() as { detail?: unknown; error?: string }
        if (!response.ok) throw new Error(payload.error || 'Failed to load day activity')
        if (!validUsageDayDetail(payload.detail, date)) throw new Error('Day activity response was incomplete')
        return payload.detail
      })
      .then(detail => {
        if (!controller.signal.aborted) setState({ date, detail, error: '', loading: false })
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setState({
          date,
          detail: null,
          error: error instanceof Error ? error.message : 'Failed to load day activity',
          loading: false,
        })
      })
    return () => controller.abort()
  }, [date, live, retry])

  return {
    ...state,
    retry: () => setRetry(value => value + 1),
  }
}

const USAGE_AGENT_COLORS = [
  '#245f1d',
  '#3b782f',
  '#548f47',
  '#70a766',
  '#8dbc86',
  '#aacda5',
  '#486d42',
  '#789473',
]

function usageAgentTypeColor(agentType: string) {
  let hash = 0
  for (const character of agentType) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  return USAGE_AGENT_COLORS[Math.abs(hash) % USAGE_AGENT_COLORS.length]!
}

function UsageDayHistogram({
  date,
  detail,
  error,
  loading,
  onRetry,
}: {
  date: string
  detail: UsageDayDetail | null
  error: string
  loading: boolean
  onRetry: () => void
}) {
  const [inspection, setInspection] = useState<UsageHeatmapInspection | null>(null)

  useEffect(() => setInspection(null), [date])

  if (loading) {
    return (
      <div className="code-usage-day-breakdown loading" data-testid="code-usage-day-histogram-loading">
        <div className="code-usage-day-breakdown-status">Loading hourly Agent activity…</div>
      </div>
    )
  }
  if (error) {
    return (
      <div className="code-usage-day-breakdown error" data-testid="code-usage-day-histogram-error">
        <span>{error}</span>
        <button type="button" onClick={onRetry}>Retry</button>
      </div>
    )
  }
  if (!detail) return null

  const maximumHourTokens = Math.max(0, ...detail.hours.map(hour => hour.totalTokens))
  const agentTypes = Array.from(detail.agents.reduce((types, agent) => {
    const current = types.get(agent.provider)
    if (current) {
      current.totalTokens += agent.totalTokens
    } else {
      types.set(agent.provider, {
        key: agent.provider,
        label: agentDisplayName(agent.provider),
        totalTokens: agent.totalTokens,
      })
    }
    return types
  }, new Map<string, { key: string; label: string; totalTokens: number }>()).values()).sort((left, right) => (
    right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)
  ))
  const readout = inspection
    ? `${inspection.label} · ${formatCompactNumber(inspection.tokens)} tokens`
    : `${formatUsageDay(detail.date)} · ${formatCompactNumber(detail.total.totalTokens)} tokens`

  return (
    <div
      className="code-usage-day-breakdown"
      data-testid="code-usage-day-histogram"
      onMouseLeave={() => setInspection(null)}
    >
      <div className="code-usage-day-breakdown-heading">
        <span>Hourly by Agent type</span>
        <strong data-testid="code-usage-day-histogram-readout">{readout}</strong>
      </div>
      <div
        className="code-usage-day-histogram-chart"
        role="img"
        aria-label={`Hourly token activity for ${detail.date}, split across ${agentTypes.length} Agent types`}
      >
        <div className="code-usage-day-histogram-scale" aria-hidden="true">
          <span>{formatCompactNumber(maximumHourTokens)}</span>
          <span>0</span>
        </div>
        <div className="code-usage-day-histogram-plot">
          <div className="code-usage-day-histogram-bars">
            {detail.hours.map(hour => {
              const height = maximumHourTokens > 0 ? (hour.totalTokens / maximumHourTokens) * 100 : 0
              return (
                <div
                  key={hour.hour}
                  className="code-usage-day-histogram-column"
                  data-hour={hour.hour}
                  title={`${hour.label}:00 · ${formatCompactNumber(hour.totalTokens)} tokens`}
                >
                  <div className="code-usage-day-histogram-stack" style={{ height: `${height}%` }}>
                    {agentTypes.map(agentType => {
                      const tokens = detail.agents.reduce((sum, agent) => (
                        agent.provider === agentType.key
                          ? sum + (Number(hour.agents[agent.key]?.totalTokens) || 0)
                          : sum
                      ), 0)
                      if (tokens <= 0 || hour.totalTokens <= 0) return null
                      const label = `${hour.label}:00 · ${agentType.label}`
                      const title = `${label} · ${formatCompactNumber(tokens)} tokens`
                      return (
                        <span
                          key={agentType.key}
                          className="code-usage-day-histogram-segment"
                          data-agent-type={agentType.key}
                          style={{
                            backgroundColor: usageAgentTypeColor(agentType.key),
                            height: `${(tokens / hour.totalTokens) * 100}%`,
                          }}
                          title={title}
                          onMouseEnter={() => setInspection({ label, tokens })}
                        />
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="code-usage-day-histogram-axis" aria-hidden="true">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>23:00</span>
          </div>
        </div>
      </div>
      {agentTypes.length > 0 && (
        <div className="code-usage-day-agent-legend" data-testid="code-usage-day-agent-legend">
          {agentTypes.map(agentType => (
            <span key={agentType.key} title={`${agentType.label} · ${formatCompactNumber(agentType.totalTokens)} tokens`}>
              <i style={{ backgroundColor: usageAgentTypeColor(agentType.key) }} aria-hidden="true" />
              <b>{agentType.label}</b>
              <small>{formatCompactNumber(agentType.totalTokens)}</small>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function UsageAnalysisCard({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="code-usage-detail-stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  )
}

function UsageActivityDialog({
  usageSummary,
  onClose,
}: {
  usageSummary: UsageSummary
  onClose: () => void
}) {
  const [inspection, setInspection] = useState<UsageHeatmapInspection | null>(null)
  const dailyPoints = validUsageDailyPoints(usageSummary)
  const peakDay = dailyPoints?.reduce<UsageDailyPoint | null>((peak, point) => (
    !peak || point.totalTokens > peak.totalTokens ? point : peak
  ), null) ?? null
  const today = dailyPoints?.[dailyPoints.length - 1] ?? null
  const inspectedDay = dailyPoints?.find(point => point.date === inspection?.label) ?? null
  const histogramDay = (inspectedDay ?? today)?.date || ''
  const dayDetail = useUsageDayDetail(
    histogramDay,
    Boolean(histogramDay && dailyPoints && histogramDay === dailyPoints[dailyPoints.length - 1]?.date),
  )
  useEscapeKey(onClose)

  if (typeof document === 'undefined') return null

  const currentSevenDays = dailyPoints?.slice(-7) ?? []
  const previousSevenDays = dailyPoints?.slice(-14, -7) ?? []
  const currentSevenDayTotal = sumDailyTokens(currentSevenDays)
  const previousSevenDayTotal = sumDailyTokens(previousSevenDays)
  const annualTotal = dailyPoints ? sumDailyTokens(dailyPoints) : 0
  const activeDays = dailyPoints?.filter(point => point.totalTokens > 0).length ?? 0
  const currentSevenDayCache = currentSevenDays.reduce((sum, point) => (
    sum + (Number(point.cacheReadTokens) || 0) + (Number(point.cacheWriteTokens) || 0)
  ), 0)
  const cacheShare = currentSevenDayTotal > 0
    ? Math.min(100, Math.round((currentSevenDayCache / currentSevenDayTotal) * 100))
    : 0
  const yearReadout = inspection
    ? `${inspection.label} · ${formatCompactNumber(inspection.tokens)} tokens`
    : `Last 52 weeks · ${formatCompactNumber(annualTotal)} tokens`

  return createPortal(
    <div
      className="code-usage-detail-backdrop"
      data-testid="code-usage-detail-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="code-usage-detail-dialog"
        data-testid="code-usage-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-usage-detail-title"
      >
        <header className="code-usage-detail-header">
          <div>
            <span className="code-usage-detail-eyebrow">Local provider tokens</span>
            <h2 id="code-usage-detail-title">Usage activity</h2>
          </div>
          <button type="button" className="code-usage-detail-close" aria-label="Close usage activity" onClick={onClose}>
            <CloseGlyph />
          </button>
        </header>
        <div className="code-usage-detail-chart">
          {dailyPoints && (
            <DailyUsageHeatmap
              points={dailyPoints}
              inspection={inspection}
              showDayHighlight
              onInspect={setInspection}
            />
          )}
          <UsageDayHistogram
            date={histogramDay}
            detail={dayDetail.date === histogramDay ? dayDetail.detail : null}
            error={dayDetail.date === histogramDay ? dayDetail.error : ''}
            loading={dayDetail.date === histogramDay ? dayDetail.loading : true}
            onRetry={dayDetail.retry}
          />
          <div className="code-usage-detail-readout" data-testid="code-usage-detail-readout">
            {yearReadout}
          </div>
        </div>
        <div className="code-usage-detail-analysis" data-testid="code-usage-detail-analysis">
          <UsageAnalysisCard label="Last 7 days" value={formatCompactNumber(currentSevenDayTotal)} />
          <UsageAnalysisCard
            label="Previous 7 days"
            value={formatCompactNumber(previousSevenDayTotal)}
            detail={`${formatUsageChange(currentSevenDayTotal, previousSevenDayTotal)} change`}
          />
          <UsageAnalysisCard
            label="Peak day"
            value={peakDay ? formatUsageDay(peakDay.date) : '--'}
            detail={peakDay ? `${formatCompactNumber(peakDay.totalTokens)} tokens` : 'no activity'}
          />
          <UsageAnalysisCard label="Active days" value={`${activeDays}`} detail="within 52 weeks" />
          <UsageAnalysisCard label="7-day cache share" value={`${cacheShare}%`} detail="read and write tokens" />
          <UsageAnalysisCard label="52-week tokens" value={formatCompactNumber(annualTotal)} />
        </div>
      </section>
    </div>,
    document.body,
  )
}

function UsageActivityHeatmaps({ usageSummary }: { usageSummary: UsageSummary }) {
  const timelinePoints = validUsageTimelinePoints(usageSummary)
  const dailyPoints = validUsageDailyPoints(usageSummary)
  const compactDailyPoints = dailyPoints?.slice(-30) ?? null
  const peakDay = dailyPoints?.reduce<UsageDailyPoint | null>((peak, point) => (
    !peak || point.totalTokens > peak.totalTokens ? point : peak
  ), null) ?? null
  const [inspection, setInspection] = useState<UsageHeatmapInspection | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  if (!timelinePoints && !dailyPoints) return null

  const timelineTotal = timelinePoints?.reduce((sum, point) => sum + point.totalTokens, 0) ?? 0
  const timelineLabel = formatUsageWindow(Number(usageSummary.timeline?.windowMs) / 60_000).toLowerCase()
  const sevenDayTotal = compactDailyPoints?.slice(-7).reduce((sum, point) => sum + point.totalTokens, 0) ?? 0
  const dailyTotal = compactDailyPoints?.reduce((sum, point) => sum + point.totalTokens, 0) ?? 0
  const baseReadout = inspection
    ? `${inspection.label} · ${formatCompactNumber(inspection.tokens)} tokens`
    : `${timelinePoints ? `${timelineLabel} ${formatCompactNumber(timelineTotal)}` : ''}${timelinePoints && compactDailyPoints ? ' · ' : ''}${compactDailyPoints ? `7d ${formatCompactNumber(sevenDayTotal)} · 30d ${formatCompactNumber(dailyTotal)}` : ''}`
  const readout = `${baseReadout}${usageSummary.daily?.syncing === true ? ' · syncing history' : ''}`

  return (
    <div className="code-usage-activity" onMouseLeave={() => setInspection(null)}>
      {timelinePoints && (
        <div className="code-usage-chart-summary" data-testid="code-usage-day-summary">
          <div className="code-usage-activity-heading">
            <span>{timelineLabel} · activity</span>
            <span>{formatUsageWindow(usageSummary.timeline.bucketMs / 60_000).toLowerCase()} buckets</span>
          </div>
          <TokenUsageSparkline usageSummary={usageSummary} points={timelinePoints} onInspect={setInspection} />
        </div>
      )}
      {compactDailyPoints && (
        <button
          type="button"
          className="code-usage-chart-trigger"
          data-testid="code-usage-open-year"
          title="Open 52-week usage details"
          onClick={() => setDetailOpen(true)}
        >
          <DailyUsageHeatmap
            points={compactDailyPoints}
            layout="matrix"
            rangeLabel="30d"
            peakDay={peakDay}
            onInspect={setInspection}
          />
        </button>
      )}
      <div className="code-usage-activity-readout" data-testid="code-usage-activity-readout" title={readout}>
        {readout}
      </div>
      {detailOpen && (
        <UsageActivityDialog
          usageSummary={usageSummary}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  )
}

export function UsagePanel({
  collapsed,
  mainAgent,
  now,
  usageSummary,
  agentLaunchOptions,
  onToggleCollapsed,
  onOpenMainAgent,
  onRestartMainAgent,
}: UsagePanelProps) {
  const providers = visibleUsageProviders(usageSummary)
  const localTokenRate = providerLocalTokenRate(usageSummary)
  const [restartMenuOpen, setRestartMenuOpen] = useState(false)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const hasLiveSystemStats = useHasBackendSystemStats()
  if (!usageSummary && !mainAgent && !hasLiveSystemStats) return null
  const mobileDetailAvailable = Boolean(usageSummary && validUsageDailyPoints(usageSummary))

  return (
    <div
      className={`code-usage-panel ${collapsed ? 'collapsed' : ''} ${mobileDetailAvailable ? '' : 'mobile-unavailable'}`}
      data-testid="code-usage-panel"
      onKeyDown={event => {
        if (event.key !== 'Escape' || collapsed || event.defaultPrevented) return
        event.preventDefault()
        event.stopPropagation()
        onToggleCollapsed()
      }}
    >
      {mobileDetailAvailable && (
        <button
          type="button"
          className="code-usage-mobile-open"
          data-testid="code-mobile-usage-open"
          onClick={() => setMobileDetailOpen(true)}
        >
          <span>Usage activity</span>
          <span>
            52 Weeks
            <ChevronRightGlyph />
          </span>
        </button>
      )}
      <button
        type="button"
        className="code-usage-header"
        data-testid="code-usage-toggle"
        aria-expanded={!collapsed}
        title="Provider local token usage refreshes periodically."
        onClick={onToggleCollapsed}
      >
        <span className="code-usage-title">
          <span className={`code-usage-chevron ${collapsed ? 'collapsed' : 'expanded'}`} aria-hidden="true">
            {collapsed ? <ChevronRightGlyph /> : <ChevronDownGlyph />}
          </span>
          <span>Usage</span>
        </span>
        <span className="code-usage-header-meta">
          {collapsed
            ? <CollapsedUsageSummary usageSummary={usageSummary} now={now} />
            : (
              <span
                className="code-usage-summary"
                data-testid="code-usage-summary"
                title="5-minute rate · hourly and daily activity"
              >
                5m rate · activity
              </span>
              )}
        </span>
      </button>
      {!collapsed && (
        <>
          {providers.length > 0 && usageSummary?.timeline && <UsageActivityHeatmaps usageSummary={usageSummary} />}
          {mainAgent && (
            <div className="code-usage-main-agent-block">
              <div
                className="code-usage-row code-usage-main-agent"
                title={`${agentTitle(mainAgent)} · ${mainAgent.command} · ${mainAgent.cwd}`}
                data-testid="code-main-agent-usage-row"
              >
                <button
                  type="button"
                  className="code-usage-main-agent-open"
                  data-testid="code-main-agent-open"
                  onClick={onOpenMainAgent}
                >
                  <span>Main Agent</span>
                  <strong>{mainAgent.status === 'pending' ? 'starting' : mainAgent.status === 'dead' ? 'offline' : mainAgent.status}</strong>
                </button>
                <button
                  type="button"
                  className="code-usage-main-agent-restart"
                  data-testid="code-main-agent-restart"
                  aria-expanded={restartMenuOpen}
                  onClick={() => setRestartMenuOpen(open => !open)}
                >
                  Restart
                </button>
              </div>
              {restartMenuOpen && (
                <div className="code-main-agent-restart-menu" data-testid="code-main-agent-restart-menu" role="menu">
                  {agentLaunchOptions.map(option => (
                    <button
                      key={option.name}
                      type="button"
                      role="menuitem"
                      data-testid={`code-main-agent-restart-${option.name}`}
                      onClick={() => {
                        setRestartMenuOpen(false)
                        onRestartMainAgent(option.name)
                      }}
                    >
                      {agentDisplayName(option.name)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {providers.map(provider => (
            <ProviderUsage key={provider.provider} provider={provider} />
          ))}
          {providers.length > 1 && localTokenRate !== null && (
            <div className="code-usage-row" title="Sum of local token usage reported by providers.">
              <span>Total local tokens</span>
              <strong>{formatTokenRate(localTokenRate)}</strong>
            </div>
          )}
          <SystemUsageRow usageSummary={usageSummary} />
        </>
      )}
      {mobileDetailOpen && mobileDetailAvailable && usageSummary && (
        <UsageActivityDialog
          usageSummary={usageSummary}
          onClose={() => setMobileDetailOpen(false)}
        />
      )}
    </div>
  )
}

function ProviderUsage({
  provider,
}: {
  provider: UsageProviderSummary
}) {
  const primary = provider.quota.primary ?? null
  const secondary = provider.quota.secondary ?? null
  const quotaTitle = provider.quota.available
    ? provider.quota.source
    : provider.quota.reason || provider.quota.source

  return (
    <div className="code-usage-provider">
      <div className="code-usage-row">
        <span>{provider.providerName}</span>
        <strong title={provider.auth?.status}>{formatAuthStatus(provider)}</strong>
      </div>
      {provider.quota.available && (
        <>
          {primary && (
            <div className="code-usage-row code-usage-subrow" title={formatQuotaLimitTitle(quotaTitle, primary)}>
              <span>{formatUsageWindow(primary.windowMinutes)}</span>
              <strong>{formatQuotaRemaining(primary)}</strong>
            </div>
          )}
          {secondary && (
            <div className="code-usage-row code-usage-subrow" title={formatQuotaLimitTitle(quotaTitle, secondary)}>
              <span>{formatUsageWindow(secondary.windowMinutes)}</span>
              <strong>{formatQuotaRemaining(secondary)}</strong>
            </div>
          )}
        </>
      )}
      <div className="code-usage-row code-usage-subrow" title={provider.tokenUsage.source}>
        <span>Local tokens</span>
        <strong>{formatTokenRate(provider.tokenUsage.tokensPerMinute)}</strong>
      </div>
    </div>
  )
}
