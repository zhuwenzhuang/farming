import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { appPath } from '@/lib/base-path'
import {
  MainPageSessionMembershipController,
  type MainPageSessionKeyOperation,
  type MainPageSessionKeysInitialGuard,
  type MainPageSessionMembershipPorts,
} from '@/lib/main-page-session-mutations'
import { normalizeMainPageSessionKeys } from './session-display'

const MAIN_PAGE_SESSION_MUTATION_TIMEOUT_MS = 15_000

async function fetchMainPageSessionMutation(url: string, init?: RequestInit) {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), MAIN_PAGE_SESSION_MUTATION_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

const defaultPorts: MainPageSessionMembershipPorts = {
  async mutateMainPageSessionKeys(operation, sessionKeys) {
    const response = await fetchMainPageSessionMutation(appPath('/api/main-page-agent-sessions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, sessionKeys }),
    })
    const data = await response.json().catch(() => null) as { mainPageSessionKeys?: string[] } | null
    if (!response.ok || !Array.isArray(data?.mainPageSessionKeys)) {
      throw new Error(`Failed to update main-page sessions: ${response.status}`)
    }
    return normalizeMainPageSessionKeys(data.mainPageSessionKeys)
  },
  async loadMainPageSessionKeys() {
    const response = await fetchMainPageSessionMutation(appPath('/api/settings'))
    if (!response.ok) throw new Error(`Failed to reconcile main-page sessions: ${response.status}`)
    const data = await response.json() as { settings?: { mainPageSessionKeys?: string[] } }
    if (!Array.isArray(data.settings?.mainPageSessionKeys)) {
      throw new Error('Failed to reconcile main-page sessions: invalid response')
    }
    return normalizeMainPageSessionKeys(data.settings.mainPageSessionKeys)
  },
}

export function useMainPageSessionMembershipController(remoteMainPageSessionKeys: string[]) {
  const [controller] = useState(() => (
    new MainPageSessionMembershipController(
      normalizeMainPageSessionKeys(remoteMainPageSessionKeys),
      defaultPorts,
    )
  ))
  const lastRemoteBaselineRef = useRef(remoteMainPageSessionKeys)
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useEffect(() => {
    if (lastRemoteBaselineRef.current === remoteMainPageSessionKeys) return
    lastRemoteBaselineRef.current = remoteMainPageSessionKeys
    controller.receiveRemoteBaseline(normalizeMainPageSessionKeys(remoteMainPageSessionKeys))
  }, [controller, remoteMainPageSessionKeys])

  const mainPageSessionKeys = useMemo(
    () => new Set(state.projectedKeys),
    [state.projectedKeys],
  )
  const mutateMainPageSessionKeys = useCallback((
    operation: MainPageSessionKeyOperation,
    sessionKeys: string[],
  ) => {
    const normalizedKeys = normalizeMainPageSessionKeys(sessionKeys)
    return controller.mutate(operation, normalizedKeys).then(() => {
      const projectedKeys = new Set(controller.getSnapshot().projectedKeys)
      return operation === 'remove'
        ? normalizedKeys.every(sessionKey => !projectedKeys.has(sessionKey))
        : normalizedKeys.every(sessionKey => projectedKeys.has(sessionKey))
    })
  }, [controller])
  const observeSessionKeys = useCallback((sessionKeys: string[]) => {
    controller.observeSessionKeys(normalizeMainPageSessionKeys(sessionKeys))
  }, [controller])
  const receiveInitialSettings = useCallback((
    authoritativeKeys: string[],
    guard: MainPageSessionKeysInitialGuard,
  ) => {
    controller.receiveInitialSettings(
      normalizeMainPageSessionKeys(authoritativeKeys),
      guard,
    )
  }, [controller])

  return {
    mainPageSessionKeys,
    mutateMainPageSessionKeys,
    observeSessionKeys,
    captureInitialSettingsGuard: controller.captureInitialSettingsGuard,
    receiveInitialSettings,
  }
}
