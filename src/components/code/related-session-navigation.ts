import { createContext } from 'react'

export interface RelatedSessionTarget {
  parentAgentId: string
  sessionId: string
  title: string
  runtimeEpoch?: string
  readable?: boolean
  parentSessionKey?: string
  sideChatSessionKey?: string
}

// Navigation carries exact identities. It never starts, stops or resumes work.
export const RelatedSessionNavigation = createContext<((target: RelatedSessionTarget) => void) | null>(null)

export const SideChatNavigation = createContext<((parentAgentId: string) => void) | null>(null)
