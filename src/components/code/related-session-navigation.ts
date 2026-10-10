import { createContext } from 'react'
import type { Agent } from '../../types/agent'
import { decodeProviderSessionKey } from '../../../shared/provider-session-identity'

export function communicationPeer(agents: Agent[], parentAgentId: string, sessionId: string): Agent | null {
  const parent = agents.find(agent => agent.id === parentAgentId)
  const owner = decodeProviderSessionKey(parent?.providerSessionKey)
  if (!owner || !sessionId || owner.sessionId === sessionId) return null
  const peers = agents.filter(agent => {
    const identity = decodeProviderSessionKey(agent.providerSessionKey)
    return identity?.provider === owner.provider && identity.providerHomeId === owner.providerHomeId
      && identity.sessionId === sessionId
  })
  return peers.length === 1 ? peers[0] || null : null
}

// Labels/navigation only; a peer reference does not establish child ownership
// or replace the delivery outcome recorded by the provider.
export const CommunicationPeerNavigation = createContext<{
  resolve: (parentAgentId: string, sessionId: string) => Agent | null
  open?: (agentId: string) => void
} | null>(null)

export interface RelatedSessionTarget {
  parentAgentId: string
  sessionId: string
  title: string
  runtimeEpoch?: string
  readable?: boolean
  parentSessionKey?: string
  subagentSessionKey?: string
}

// Navigation carries exact identities. It never starts, stops or resumes work.
export const RelatedSessionNavigation = createContext<((target: RelatedSessionTarget) => void) | null>(null)

export const SubagentNavigation = createContext<((parentAgentId: string) => void) | null>(null)
