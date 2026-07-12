import { useCallback, useEffect, useState } from 'react'
import { appPath } from '@/lib/base-path'
import type { AcpSessionSnapshot } from './types'

export function useAcpSession(agentId: string, active: boolean, runtimeState: string) {
  const [session, setSession] = useState<AcpSessionSnapshot | null>(null)
  const [error, setError] = useState('')
  const [updatingId, setUpdatingId] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!agentId || !active) return
    try {
      const response = await fetch(appPath(`/api/agents/${encodeURIComponent(agentId)}/acp-session`), { signal })
      const body = await response.json().catch(() => null) as { session?: AcpSessionSnapshot; error?: string } | null
      if (!response.ok || !body?.session) throw new Error(body?.error || `Failed to read ACP session (${response.status})`)
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

  const patchSession = useCallback(async (id: string, patch: Record<string, unknown>) => {
    if (!agentId || updatingId) return false
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
      setSession(current => current ? {
        ...current,
        ...(body?.modeId ? {
          currentModeId: body.modeId,
          modes: current.modes ? { ...current.modes, currentModeId: body.modeId } : current.modes,
        } : {}),
        ...(body?.configOptions ? { configOptions: body.configOptions } : {}),
      } : current)
      setError('')
      return true
    } catch (nextError) {
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

  return { session, error, updatingId, setMode, setConfigOption }
}
