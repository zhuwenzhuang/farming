import { useCallback, useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { AcpSessionSnapshot } from './types'

type AcpConfigChange = {
  configId: string
  value: string | boolean
}

function configChangesFromPatch(patch: Record<string, unknown>): AcpConfigChange[] {
  const changes = Array.isArray(patch.configOptions)
    ? patch.configOptions
    : typeof patch.configId === 'string' && (typeof patch.value === 'string' || typeof patch.value === 'boolean')
      ? [{ configId: patch.configId, value: patch.value }]
      : []
  return changes.flatMap(change => (
    change
    && typeof change === 'object'
    && 'configId' in change
    && typeof change.configId === 'string'
    && 'value' in change
    && (typeof change.value === 'string' || typeof change.value === 'boolean')
      ? [{ configId: change.configId, value: change.value }]
      : []
  ))
}

function configChangesConfirmed(
  configOptions: AcpSessionSnapshot['configOptions'] | undefined,
  changes: AcpConfigChange[],
) {
  if (changes.length === 0) return true
  if (!configOptions) return false
  return changes.every(change => configOptions.some(option => (
    option.id === change.configId
    && typeof option.currentValue === typeof change.value
    && option.currentValue === change.value
  )))
}

function optimisticConfigSession(
  session: AcpSessionSnapshot | null,
  patch: Record<string, unknown>,
) {
  if (!session) return session
  const changes = configChangesFromPatch(patch)
  if (changes.length === 0) return session
  const values = new Map(changes.map(change => [change.configId, change.value] as const))
  if (values.size === 0) return session
  return {
    ...session,
    configOptions: session.configOptions.map(option => {
      const value = values.get(option.id)
      if (value === undefined || typeof value !== typeof option.currentValue) return option
      return { ...option, currentValue: value } as typeof option
    }),
  }
}

export function useAcpSession(agentId: string, active: boolean, runtimeState: string) {
  const [session, setSession] = useState<AcpSessionSnapshot | null>(null)
  const [error, setError] = useState('')
  const [updatingId, setUpdatingId] = useState('')
  const [authenticatingId, setAuthenticatingId] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const sessionRef = useRef<AcpSessionSnapshot | null>(null)
  const scopeRef = useRef({ agentId, active })
  const refreshRequestRef = useRef(0)
  const mutationRef = useRef<{ agentId: string; id: string; sequence: number } | null>(null)
  const mutationSequenceRef = useRef(0)
  const accountMutationRef = useRef<{ agentId: string; sequence: number } | null>(null)
  const accountMutationSequenceRef = useRef(0)

  scopeRef.current = { agentId, active }

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!agentId || !active) return
    const requestAgentId = agentId
    const requestMutationSequence = mutationSequenceRef.current
    const requestId = refreshRequestRef.current + 1
    refreshRequestRef.current = requestId
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=0`), { signal })
      const body = await response.json().catch(() => null) as { session?: AcpSessionSnapshot; error?: string } | null
      if (!response.ok || !body?.session) throw new Error(body?.error || `Failed to read ACP session (${response.status})`)
      if (
        scopeRef.current.agentId !== requestAgentId
        || !scopeRef.current.active
        || refreshRequestRef.current !== requestId
        || mutationRef.current
        || mutationSequenceRef.current !== requestMutationSequence
      ) return
      sessionRef.current = body.session
      setSession(body.session)
      setError('')
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return
      if (
        scopeRef.current.agentId !== requestAgentId
        || !scopeRef.current.active
        || refreshRequestRef.current !== requestId
        || mutationRef.current
        || mutationSequenceRef.current !== requestMutationSequence
      ) return
      setError(nextError instanceof Error ? nextError.message : 'Failed to read ACP session')
    }
  }, [active, agentId])

  useEffect(() => {
    refreshRequestRef.current += 1
    mutationSequenceRef.current += 1
    mutationRef.current = null
    accountMutationSequenceRef.current += 1
    accountMutationRef.current = null
    sessionRef.current = null
    setSession(null)
    setError('')
    setUpdatingId('')
    setAuthenticatingId('')
    setLoggingOut(false)
  }, [active, agentId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh, runtimeState])

  useEffect(() => {
    if (!session?.authTerminal || !['running', 'completed'].includes(session.authTerminal.state)) return undefined
    const timer = window.setInterval(() => { void refresh() }, 500)
    return () => window.clearInterval(timer)
  }, [refresh, session?.authTerminal?.state, session?.authTerminal?.terminalId])

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    if (!agentId || mutationRef.current) return false
    const requestAgentId = agentId
    const sequence = ++mutationSequenceRef.current
    mutationRef.current = { agentId: requestAgentId, id, sequence }
    const rollbackSession = sessionRef.current
    const optimisticSession = optimisticConfigSession(rollbackSession, patch)
    const configChanges = configChangesFromPatch(patch)
    if (optimisticSession !== rollbackSession) {
      sessionRef.current = optimisticSession
      setSession(optimisticSession)
    }
    setUpdatingId(id)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await response.json().catch(() => null) as {
        modeId?: string
        configOptions?: AcpSessionSnapshot['configOptions']
        error?: string
      } | null
      if (!response.ok) throw new Error(body?.error || `Failed to update ACP session (${response.status})`)
      if (!configChangesConfirmed(body?.configOptions, configChanges)) {
        throw new Error('ACP Agent did not confirm the requested configuration')
      }
      if (scopeRef.current.agentId !== requestAgentId || mutationRef.current?.sequence !== sequence) {
        return false
      }
      setSession(current => {
        const next = current ? {
          ...current,
          ...(body?.modeId ? {
            currentModeId: body.modeId,
            modes: current.modes ? { ...current.modes, currentModeId: body.modeId } : current.modes,
          } : {}),
          ...(body?.configOptions ? { configOptions: body.configOptions } : {}),
        } : current
        sessionRef.current = next
        return next
      })
      setError('')
      return true
    } catch (nextError) {
      if (
        rollbackSession
        && scopeRef.current.agentId === requestAgentId
        && mutationRef.current?.sequence === sequence
      ) {
        sessionRef.current = rollbackSession
        setSession(rollbackSession)
      }
      if (
        scopeRef.current.agentId === requestAgentId
        && scopeRef.current.active
        && mutationRef.current?.sequence === sequence
      ) {
        setError(nextError instanceof Error ? nextError.message : 'Failed to update ACP session')
      }
      return false
    } finally {
      if (mutationRef.current?.sequence === sequence) {
        mutationRef.current = null
        setUpdatingId('')
      }
    }
  }, [agentId])

  const setMode = useCallback(
    (modeId: string) => patchSession('mode', { modeId }),
    [patchSession],
  )
  const setConfigOption = useCallback(
    (configId: string, value: string | boolean) => patchSession(configId, { configId, value }),
    [patchSession],
  )
  const setConfigOptions = useCallback(
    (changes: Array<{ configId: string; value: string | boolean }>) => patchSession(
      changes.map(change => change.configId).join(':'),
      { configOptions: changes },
    ),
    [patchSession],
  )

  const authenticate = useCallback(async (methodId: string) => {
    if (!agentId || !active || accountMutationRef.current) return false
    const requestAgentId = agentId
    const sequence = ++accountMutationSequenceRef.current
    accountMutationRef.current = { agentId: requestAgentId, sequence }
    setAuthenticatingId(methodId)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(requestAgentId)}/acp-session/authenticate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId }),
      })
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(body?.error || `Failed to authenticate ACP Agent (${response.status})`)
      if (
        scopeRef.current.agentId !== requestAgentId
        || !scopeRef.current.active
        || accountMutationRef.current?.sequence !== sequence
      ) return false
      setError('')
      await refresh()
      return scopeRef.current.agentId === requestAgentId
        && scopeRef.current.active
        && accountMutationRef.current?.sequence === sequence
    } catch (nextError) {
      if (
        scopeRef.current.agentId === requestAgentId
        && scopeRef.current.active
        && accountMutationRef.current?.sequence === sequence
      ) setError(nextError instanceof Error ? nextError.message : 'Failed to authenticate ACP Agent')
      return false
    } finally {
      if (accountMutationRef.current?.sequence === sequence) {
        accountMutationRef.current = null
        setAuthenticatingId('')
      }
    }
  }, [active, agentId, refresh])

  const logout = useCallback(async () => {
    if (!agentId || !active || accountMutationRef.current) return false
    const requestAgentId = agentId
    const sequence = ++accountMutationSequenceRef.current
    accountMutationRef.current = { agentId: requestAgentId, sequence }
    setLoggingOut(true)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(requestAgentId)}/acp-session/logout`), {
        method: 'POST',
      })
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(body?.error || `Failed to log out ACP Agent (${response.status})`)
      if (
        scopeRef.current.agentId !== requestAgentId
        || !scopeRef.current.active
        || accountMutationRef.current?.sequence !== sequence
      ) return false
      setError('')
      await refresh()
      return scopeRef.current.agentId === requestAgentId
        && scopeRef.current.active
        && accountMutationRef.current?.sequence === sequence
    } catch (nextError) {
      if (
        scopeRef.current.agentId === requestAgentId
        && scopeRef.current.active
        && accountMutationRef.current?.sequence === sequence
      ) setError(nextError instanceof Error ? nextError.message : 'Failed to log out ACP Agent')
      return false
    } finally {
      if (accountMutationRef.current?.sequence === sequence) {
        accountMutationRef.current = null
        setLoggingOut(false)
      }
    }
  }, [active, agentId, refresh])

  return { session, error, updatingId, authenticatingId, loggingOut, setMode, setConfigOption, setConfigOptions, authenticate, logout }
}
