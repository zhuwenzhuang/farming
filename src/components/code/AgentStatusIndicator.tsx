import { useEffect, useState } from 'react'
import type { AgentRowDisplayState } from './agent-row-state'

function StatusIndicator({ state, className, decorative }: {
  state: AgentRowDisplayState
  className: string
  decorative: boolean
}) {
  const [revealed, setRevealed] = useState(state.statusIndicatorDelayMs === 0)
  useEffect(() => {
    if (state.statusIndicatorDelayMs === 0) return
    const timer = window.setTimeout(() => setRevealed(true), state.statusIndicatorDelayMs)
    return () => window.clearTimeout(timer)
  }, [state.statusIndicatorDelayMs])

  return (
    <span
      className={`${className} ${state.lifecycleStatus} ${state.turnActive ? 'turn-active' : ''}`}
      style={revealed ? undefined : { visibility: 'hidden' }}
      aria-hidden={decorative ? true : undefined}
      title={decorative ? undefined : state.commandTitle || state.lifecycleStatus}
    />
  )
}

export function AgentStatusIndicator({ state, className, decorative = false }: {
  state: AgentRowDisplayState
  className: string
  decorative?: boolean
}) {
  if (!state.statusIndicatorVisible) return null
  // Completion unmounts the timer immediately. A replacement runtime/command
  // gets its own delay even when its preceding idle update was coalesced.
  return <StatusIndicator key={`${state.statusIndicatorKey}:${state.statusIndicatorDelayMs}`} state={state} className={className} decorative={decorative} />
}
