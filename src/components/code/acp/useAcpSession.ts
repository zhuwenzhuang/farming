import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { appPath } from '@/lib/base-path'
import { RequestOwnershipFence } from '@/lib/request-ownership'
import type { AcpSessionSnapshot } from './types'
import {
  getAcpSessionStateSnapshot,
  subscribeAcpSessionState,
  updateAcpSessionState,
} from './acp-session-state-pool'

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

function optimisticDeferredSession(session: AcpSessionSnapshot) {
  const configured = optimisticConfigSession(session, {
    configOptions: session.deferredConfigOptions || [],
  }) || session
  if (!session.deferredModeId) return configured
  return {
    ...configured,
    currentModeId: session.deferredModeId,
    modes: configured.modes
      ? { ...configured.modes, currentModeId: session.deferredModeId }
      : configured.modes,
  }
}

export function useAcpSession(agentId: string, active: boolean, refreshSignal: string) {
  const state = useSyncExternalStore(
    useCallback(listener => subscribeAcpSessionState(agentId, listener), [agentId]),
    useCallback(() => getAcpSessionStateSnapshot(agentId), [agentId]),
    useCallback(() => getAcpSessionStateSnapshot(agentId), [agentId]),
  )
  const { session, error } = state
  const [updatingId, setUpdatingId] = useState('')
  const [authenticatingId, setAuthenticatingId] = useState('')
  const [loggingOut, setLoggingOut] = useState(false)
  const [validatedScope, setValidatedScope] = useState('')
  // Chat revisions request a fresh session read, but they do not change which
  // Agent owns the already validated controls. Treating the refresh signal as
  // identity made every streamed update revoke the model picker until its GET
  // completed. Agent changes still invalidate the cached controls immediately.
  const validationScope = agentId
  const authoritative = active && validatedScope === validationScope
  const sessionRef = useRef<AcpSessionSnapshot | null>(session)
  const refreshOwnershipRef = useRef(new RequestOwnershipFence(agentId))
  const mutationOwnershipRef = useRef(new RequestOwnershipFence(agentId))
  const accountMutationOwnershipRef = useRef(new RequestOwnershipFence(agentId))
  const mutationRef = useRef<{ agentId: string; id: string; sequence: number } | null>(null)
  const mutationSequenceRef = useRef(0)
  const accountMutationRef = useRef<{ agentId: string; sequence: number } | null>(null)
  const accountMutationSequenceRef = useRef(0)

  for (const ownership of [
    refreshOwnershipRef.current,
    mutationOwnershipRef.current,
    accountMutationOwnershipRef.current,
  ]) {
    ownership.setScope(agentId)
    ownership.setActive(active)
  }

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const setSession = useCallback((
    value: AcpSessionSnapshot | null | ((current: AcpSessionSnapshot | null) => AcpSessionSnapshot | null),
  ) => {
    updateAcpSessionState(agentId, current => {
      const nextSession = typeof value === 'function' ? value(current.session) : value
      sessionRef.current = nextSession
      return nextSession === current.session ? current : { ...current, session: nextSession }
    })
  }, [agentId])

  const setError = useCallback((nextError: string) => {
    updateAcpSessionState(agentId, current => (
      nextError === current.error ? current : { ...current, error: nextError }
    ))
  }, [agentId])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!agentId || !active) return
    const requestMutationSequence = mutationSequenceRef.current
    const lease = refreshOwnershipRef.current.begin()
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=0`), { signal })
      const body = await response.json().catch(() => null) as { session?: AcpSessionSnapshot; error?: string } | null
      if (!response.ok || !body?.session) throw new Error(body?.error || `Failed to read ACP session (${response.status})`)
      if (
        !lease.isCurrent()
        || mutationRef.current
        || mutationSequenceRef.current !== requestMutationSequence
      ) return
      const nextSession = optimisticDeferredSession(body.session)
      sessionRef.current = nextSession
      setSession(nextSession)
      setError('')
      setValidatedScope(validationScope)
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return
      if (
        !lease.isCurrent()
        || mutationRef.current
        || mutationSequenceRef.current !== requestMutationSequence
      ) return
      setValidatedScope('')
      setError(nextError instanceof Error ? nextError.message : 'Failed to read ACP session')
    }
  }, [active, agentId, setError, setSession, validationScope])

  useEffect(() => {
    refreshOwnershipRef.current.invalidate()
    mutationOwnershipRef.current.invalidate()
    mutationSequenceRef.current += 1
    mutationRef.current = null
    accountMutationOwnershipRef.current.invalidate()
    accountMutationSequenceRef.current += 1
    accountMutationRef.current = null
    setUpdatingId('')
    setAuthenticatingId('')
    setLoggingOut(false)
  }, [active, agentId])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh, refreshSignal])

  useEffect(() => {
    // Read the state field directly so the effect depends on it rather than the
    // whole authTerminal object, avoiding needless interval restarts.
    const authState = session?.authTerminal?.state
    if (!authState || !['running', 'completed'].includes(authState)) return undefined
    const timer = window.setInterval(() => { void refresh() }, 500)
    return () => window.clearInterval(timer)
  }, [refresh, session?.authTerminal?.state, session?.authTerminal?.terminalId])

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    if (!agentId || !authoritative || mutationRef.current) return false
    const requestAgentId = agentId
    const lease = mutationOwnershipRef.current.begin()
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
        deferred?: boolean
        configOptions?: AcpSessionSnapshot['configOptions']
        deferredConfigOptions?: AcpSessionSnapshot['deferredConfigOptions']
        deferredModeId?: string
        error?: string
      } | null
      if (!response.ok) throw new Error(body?.error || `Failed to update ACP session (${response.status})`)
      if (body?.deferred !== true && !configChangesConfirmed(body?.configOptions, configChanges)) {
        throw new Error('ACP Agent did not confirm the requested configuration')
      }
      if (!lease.isCurrent() || mutationRef.current?.sequence !== sequence) {
        return false
      }
      setSession(current => {
        const next = current ? {
          ...current,
          ...(body?.modeId ? {
            currentModeId: body.modeId,
            modes: current.modes ? { ...current.modes, currentModeId: body.modeId } : current.modes,
          } : {}),
          ...(body?.configOptions && body.deferred !== true ? { configOptions: body.configOptions } : {}),
          ...(body?.deferredConfigOptions ? { deferredConfigOptions: body.deferredConfigOptions } : {}),
          ...(typeof body?.deferredModeId === 'string' ? { deferredModeId: body.deferredModeId } : {}),
        } : current
        sessionRef.current = next
        return next
      })
      setError('')
      return true
    } catch (nextError) {
      if (
        rollbackSession
        && lease.isCurrent()
        && mutationRef.current?.sequence === sequence
      ) {
        sessionRef.current = rollbackSession
        setSession(rollbackSession)
      }
      if (
        lease.isCurrent()
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
  }, [agentId, authoritative, setError, setSession])

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
    if (!agentId || !authoritative || accountMutationRef.current) return false
    const requestAgentId = agentId
    const lease = accountMutationOwnershipRef.current.begin()
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
        !lease.isCurrent()
        || accountMutationRef.current?.sequence !== sequence
      ) return false
      setError('')
      await refresh()
      return lease.isCurrent()
        && accountMutationRef.current?.sequence === sequence
    } catch (nextError) {
      if (
        lease.isCurrent()
        && accountMutationRef.current?.sequence === sequence
      ) setError(nextError instanceof Error ? nextError.message : 'Failed to authenticate ACP Agent')
      return false
    } finally {
      if (accountMutationRef.current?.sequence === sequence) {
        accountMutationRef.current = null
        setAuthenticatingId('')
      }
    }
  }, [agentId, authoritative, refresh, setError])

  const logout = useCallback(async () => {
    if (!agentId || !authoritative || accountMutationRef.current) return false
    const requestAgentId = agentId
    const lease = accountMutationOwnershipRef.current.begin()
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
        !lease.isCurrent()
        || accountMutationRef.current?.sequence !== sequence
      ) return false
      setError('')
      await refresh()
      return lease.isCurrent()
        && accountMutationRef.current?.sequence === sequence
    } catch (nextError) {
      if (
        lease.isCurrent()
        && accountMutationRef.current?.sequence === sequence
      ) setError(nextError instanceof Error ? nextError.message : 'Failed to log out ACP Agent')
      return false
    } finally {
      if (accountMutationRef.current?.sequence === sequence) {
        accountMutationRef.current = null
        setLoggingOut(false)
      }
    }
  }, [agentId, authoritative, refresh, setError])

  return {
    session,
    error,
    updatingId,
    authenticatingId,
    loggingOut,
    authoritative,
    configDeferred: authoritative && Boolean(session?.deferredConfigOptions?.length || session?.deferredModeId),
    configOptionsDeferred: authoritative && Boolean(session?.deferredConfigOptions?.length),
    modeDeferred: authoritative && Boolean(session?.deferredModeId),
    setMode,
    setConfigOption,
    setConfigOptions,
    authenticate,
    logout,
  }
}
