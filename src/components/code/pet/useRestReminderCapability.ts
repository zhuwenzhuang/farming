import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createRestReminderState,
  nextRestReminderDeadline,
  normalizeRestReminderIntervalSeconds,
  readRestReminderRuntimeState,
  reconfigureRestReminderInterval,
  reduceRestReminder,
  saveRestReminderRuntimeState,
  type RestReminderState,
} from '@/lib/pet/rest-reminder'

const ACTIVITY_COMMIT_INTERVAL_MS = 1000

function enabledInterval(value: number | null) {
  const normalized = normalizeRestReminderIntervalSeconds(value)
  return normalized !== null && normalized > 0 ? normalized : null
}

function isPetUiEvent(event: Event) {
  return event.target instanceof Element && Boolean(event.target.closest('[data-pet-ui]'))
}

function isMeaningfulKey(event: KeyboardEvent) {
  return !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)
}

function initialState(intervalSeconds: number | null) {
  const interval = enabledInterval(intervalSeconds)
  if (interval === null) return null
  return readRestReminderRuntimeState(interval) ?? createRestReminderState(interval)
}

export function useRestReminderCapability(
  intervalSeconds: number | null,
  entryBlocked = false,
) {
  const [state, setState] = useState<RestReminderState | null>(() => (
    initialState(intervalSeconds)
  ))
  const [pageVisible, setPageVisible] = useState(() => (
    typeof document === 'undefined' || document.visibilityState !== 'hidden'
  ))
  const [persistenceFailed, setPersistenceFailed] = useState(false)
  const stateRef = useRef(state)
  const entryBlockedRef = useRef(entryBlocked)
  const previousEntryBlockedRef = useRef(entryBlocked)
  const pendingActivityAtRef = useRef<number | null>(null)
  const activityTimerRef = useRef<number | null>(null)
  const persistenceFailedRef = useRef(false)
  entryBlockedRef.current = entryBlocked

  const updatePersistenceStatus = useCallback((failed: boolean) => {
    if (persistenceFailedRef.current === failed) return
    persistenceFailedRef.current = failed
    setPersistenceFailed(failed)
  }, [])

  const persist = useCallback((
    nextState: RestReminderState | null,
    reportFailure = true,
  ) => {
    const saved = saveRestReminderRuntimeState(nextState)
    if (reportFailure) updatePersistenceStatus(!saved)
  }, [updatePersistenceStatus])

  const commit = useCallback((
    nextState: RestReminderState | null,
    render = true,
    reportFailure = true,
  ) => {
    stateRef.current = nextState
    persist(nextState, reportFailure)
    if (render) setState(nextState)
  }, [persist])

  const clearActivityTimer = useCallback(() => {
    if (activityTimerRef.current === null) return
    window.clearTimeout(activityTimerRef.current)
    activityTimerRef.current = null
  }, [])

  const stateWithPendingActivity = useCallback(() => {
    const activityAt = pendingActivityAtRef.current
    pendingActivityAtRef.current = null
    const current = stateRef.current
    if (
      activityAt === null
      || current === null
      || current.phase === 'resting'
      || entryBlockedRef.current
    ) {
      return current
    }
    return reduceRestReminder(current, { type: 'activity', now: activityAt })
  }, [])

  const flushPendingActivity = useCallback((
    render = true,
    reportFailure = true,
  ) => {
    clearActivityTimer()
    const current = stateRef.current
    const nextState = stateWithPendingActivity()
    if (nextState !== current) commit(nextState, render, reportFailure)
    return nextState
  }, [clearActivityTimer, commit, stateWithPendingActivity])

  useEffect(() => {
    const interval = enabledInterval(intervalSeconds)
    clearActivityTimer()
    const current = stateWithPendingActivity()
    if (interval === null) {
      if (current !== null) commit(null)
      else persist(null, false)
      return
    }
    if (current === null) {
      commit(createRestReminderState(interval))
      return
    }
    if (current.intervalSeconds !== interval) {
      commit(reconfigureRestReminderInterval(current, interval, Date.now()))
      return
    }
    persist(current)
  }, [
    clearActivityTimer,
    commit,
    intervalSeconds,
    persist,
    stateWithPendingActivity,
  ])

  useEffect(() => {
    const wasBlocked = previousEntryBlockedRef.current
    previousEntryBlockedRef.current = entryBlocked
    if (wasBlocked === entryBlocked) return

    clearActivityTimer()
    pendingActivityAtRef.current = null
    const current = stateRef.current
    if (!current || current.phase === 'resting') return

    if (!entryBlocked) {
      commit(reduceRestReminder(current, { type: 'activity', now: Date.now() }))
    }
  }, [clearActivityTimer, commit, entryBlocked])

  useEffect(() => {
    if (state === null) return undefined
    const recordActivity = (event: Event) => {
      if (isPetUiEvent(event)) return
      if (event instanceof KeyboardEvent && !isMeaningfulKey(event)) return
      if (entryBlockedRef.current) return
      if (stateRef.current?.phase === 'resting') return
      const now = Date.now()
      pendingActivityAtRef.current = Math.max(
        pendingActivityAtRef.current ?? 0,
        now,
      )
      if (activityTimerRef.current !== null) return
      activityTimerRef.current = window.setTimeout(() => {
        activityTimerRef.current = null
        const current = stateRef.current
        const nextState = stateWithPendingActivity()
        if (nextState !== current) commit(nextState)
      }, ACTIVITY_COMMIT_INTERVAL_MS)
    }
    window.addEventListener('pointerdown', recordActivity, true)
    window.addEventListener('keydown', recordActivity, true)
    window.addEventListener('input', recordActivity, true)
    return () => {
      window.removeEventListener('pointerdown', recordActivity, true)
      window.removeEventListener('keydown', recordActivity, true)
      window.removeEventListener('input', recordActivity, true)
    }
  }, [commit, state !== null, stateWithPendingActivity])

  useEffect(() => {
    const syncVisibility = () => {
      const visible = document.visibilityState !== 'hidden'
      if (!visible) {
        flushPendingActivity()
        setPageVisible(false)
        return
      }
      setPageVisible(true)
      const current = stateWithPendingActivity()
      if (
        current
        && (current.phase === 'resting' || !entryBlockedRef.current)
      ) {
        commit(reduceRestReminder(current, { type: 'deadline', now: Date.now() }))
      }
    }
    document.addEventListener('visibilitychange', syncVisibility)
    return () => document.removeEventListener('visibilitychange', syncVisibility)
  }, [commit, flushPendingActivity, stateWithPendingActivity])

  useEffect(() => {
    if (!pageVisible || !state) return undefined
    if (entryBlocked && state.phase !== 'resting') return undefined
    const deadline = nextRestReminderDeadline(state)
    if (deadline === null) return undefined
    const timeout = window.setTimeout(() => {
      clearActivityTimer()
      const current = stateWithPendingActivity()
      if (
        current
        && (current.phase === 'resting' || !entryBlockedRef.current)
      ) {
        commit(reduceRestReminder(current, { type: 'deadline', now: Date.now() }))
      }
    }, Math.max(0, deadline - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [
    clearActivityTimer,
    commit,
    entryBlocked,
    pageVisible,
    state,
    stateWithPendingActivity,
  ])

  useEffect(() => () => {
    clearActivityTimer()
    const nextState = stateWithPendingActivity()
    stateRef.current = nextState
    persist(nextState, false)
  }, [clearActivityTimer, persist, stateWithPendingActivity])

  const act = useCallback((type: 'dismiss' | 'snooze') => {
    clearActivityTimer()
    pendingActivityAtRef.current = null
    const current = stateRef.current
    if (!current) return
    commit(reduceRestReminder(current, { type, now: Date.now() }))
  }, [clearActivityTimer, commit])

  return {
    state,
    pageVisible,
    persistenceFailed,
    dismiss: useCallback(() => act('dismiss'), [act]),
    snooze: useCallback(() => act('snooze'), [act]),
  }
}
