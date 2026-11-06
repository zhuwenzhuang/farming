import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const STORAGE_KEY = 'farming.code.agentChildrenExpanded.v1'
const LEGACY_RESOURCES_KEY = 'farming.code.agentResourcesExpanded.v1'
type Expansion = Record<string, boolean>

function readExpansion(): Expansion {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      return Object.fromEntries(Object.entries(saved).filter(([, value]) => typeof value === 'boolean'))
    }
    const legacy: unknown = JSON.parse(localStorage.getItem(LEGACY_RESOURCES_KEY) || '[]')
    return Array.isArray(legacy)
      ? Object.fromEntries(legacy.filter(id => typeof id === 'string').map(id => [id, true])) : {}
  } catch {
    return {}
  }
}

function useDisclosureState(resourceAgentIds: ReadonlySet<string>) {
  const [expansion, setExpansion] = useState(readExpansion)
  const setExpanded = useCallback((agentId: string, expanded: boolean, onlyIfUnset = false) => {
    setExpansion(current => {
      if ((onlyIfUnset && Object.prototype.hasOwnProperty.call(current, agentId)) || current[agentId] === expanded) return current
      const next = { ...current, [agentId]: expanded }
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* Retain in-memory state. */ }
      return next
    })
  }, [])
  return useMemo(() => ({ expansion, resourceAgentIds, setExpanded }), [expansion, resourceAgentIds, setExpanded])
}

const AgentSidebarDisclosure = createContext<ReturnType<typeof useDisclosureState> | null>(null)

export function AgentSidebarDisclosureProvider({ resourceAgentIds, children }: {
  resourceAgentIds: ReadonlySet<string>
  children: ReactNode
}) {
  const value = useDisclosureState(resourceAgentIds)
  return <AgentSidebarDisclosure.Provider value={value}>{children}</AgentSidebarDisclosure.Provider>
}

export function useAgentSidebarDisclosure() {
  const value = useContext(AgentSidebarDisclosure)
  if (!value) throw new Error('Agent sidebar disclosure requires its workspace provider')
  return value
}
