import { useMemo } from 'react'
import type { Agent } from '@/types/agent'

/** Derived state from the agent list */
export function useAgents(agents: Agent[], mainAgentId: string | null) {
  const mainAgent = useMemo(
    () => agents.find(a => a.id === mainAgentId) ?? null,
    [agents, mainAgentId]
  )

  const otherAgents = useMemo(
    () => agents.filter(a => (
      a.id !== mainAgentId
      && !a.isMain
      && !a.archived
      && a.status !== 'dead'
      && a.status !== 'stopped'
    )),
    [agents, mainAgentId]
  )

  const activeCount = useMemo(
    () => agents.filter(a => a.status === 'running').length,
    [agents]
  )

  /** Maps keyboard digits 1-9 to non-main agent IDs */
  const keyMap = useMemo(() => {
    const map = new Map<string, string>()
    otherAgents.forEach((agent, i) => {
      if (i < 9) {
        map.set(String(i + 1), agent.id)
      }
    })
    return map
  }, [otherAgents])

  return { mainAgent, otherAgents, activeCount, keyMap }
}
