import { useCallback, useEffect, useRef, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { AcpSessionSnapshot } from './types'

function optimisticConfigSession(
  session: AcpSessionSnapshot | null,
  patch: Record<string, unknown>,
) {
  if (!session) return session
  const changes = Array.isArray(patch.configOptions)
    ? patch.configOptions
    : typeof patch.configId === 'string' && (typeof patch.value === 'string' || typeof patch.value === 'boolean')
      ? [{ configId: patch.configId, value: patch.value }]
      : []
  if (changes.length === 0) return session
  const values = new Map(changes.flatMap(change => (
    change
    && typeof change === 'object'
    && 'configId' in change
    && typeof change.configId === 'string'
    && 'value' in change
    && (typeof change.value === 'string' || typeof change.value === 'boolean')
      ? [[change.configId, change.value] as const]
      : []
  )))
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
  const sessionRef = useRef<AcpSessionSnapshot | null>(null)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!agentId || !active) return
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session?includeEntries=0`), { signal })
      const body = await response.json().catch(() => null) as { session?: AcpSessionSnapshot; error?: string } | null
      if (!response.ok || !body?.session) throw new Error(body?.error || `Failed to read ACP session (${response.status})`)
      sessionRef.current = body.session
      setSession(body.session)
      setError('')
    } catch (nextError) {
      if (nextError instanceof DOMException && nextError.name === 'AbortError') return
      setError(nextError instanceof Error ? nextError.message : 'Failed to read ACP session')
    }
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
    if (!agentId || updatingId) return false
    const rollbackSession = sessionRef.current
    const optimisticSession = optimisticConfigSession(rollbackSession, patch)
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
      if (rollbackSession) {
        sessionRef.current = rollbackSession
        setSession(rollbackSession)
      }
      setError(nextError instanceof Error ? nextError.message : 'Failed to update ACP session')
      return false
    } finally {
      setUpdatingId('')
    }
  }, [agentId, updatingId])

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
    if (!agentId || authenticatingId) return false
    setAuthenticatingId(methodId)
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session/authenticate`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ methodId }),
      })
      const body = await response.json().catch(() => null) as { error?: string } | null
      if (!response.ok) throw new Error(body?.error || `Failed to authenticate ACP Agent (${response.status})`)
      setError('')
      await refresh()
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to authenticate ACP Agent')
      return false
    } finally {
      setAuthenticatingId('')
    }
  }, [agentId, authenticatingId, refresh])

  return { session, error, updatingId, authenticatingId, setMode, setConfigOption, setConfigOptions, authenticate }
}
