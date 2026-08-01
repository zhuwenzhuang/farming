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
  const pendingInteractionAtRef = useRef<number | null>(null)
  const interactionTimerRef = useRef<number | null>(null)
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

  const clearInteractionTimer = useCallback(() => {
    if (interactionTimerRef.current === null) return
    window.clearTimeout(interactionTimerRef.current)
    interactionTimerRef.current = null
  }, [])

  const stateWithPendingInteraction = useCallback(() => {
    const interactionAt = pendingInteractionAtRef.current
    pendingInteractionAtRef.current = null
    const current = stateRef.current
    if (
      interactionAt === null
      || current === null
      || entryBlockedRef.current
    ) {
      return current
    }
    const deadline = nextRestReminderDeadline(current)
    if (current.phase !== 'due' && (deadline === null || interactionAt < deadline)) {
      return current
    }
    return reduceRestReminder(current, { type: 'interaction', now: interactionAt })
  }, [])

  const flushPendingInteraction = useCallback((
    render = true,
    reportFailure = true,
  ) => {
    clearInteractionTimer()
    const current = stateRef.current
    const nextState = stateWithPendingInteraction()
    if (nextState !== current) commit(nextState, render, reportFailure)
    return nextState
  }, [clearInteractionTimer, commit, stateWithPendingInteraction])

  useEffect(() => {
    const interval = enabledInterval(intervalSeconds)
    clearInteractionTimer()
    const current = stateWithPendingInteraction()
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
    clearInteractionTimer,
    commit,
    intervalSeconds,
    persist,
    stateWithPendingInteraction,
  ])

  useEffect(() => {
    const wasBlocked = previousEntryBlockedRef.current
    previousEntryBlockedRef.current = entryBlocked
    if (wasBlocked === entryBlocked) return

    clearInteractionTimer()
    pendingInteractionAtRef.current = null
    const current = stateRef.current
    if (!current || current.phase === 'resting') return

    commit(reduceRestReminder(current, {
      type: entryBlocked ? 'background' : 'foreground',
      now: Date.now(),
    }))
  }, [clearInteractionTimer, commit, entryBlocked])

  // Listener wiring only cares whether a reminder exists, not about each state
  // transition, so keying on the boolean avoids re-binding on every tick.
  const reminderActive = state !== null

  useEffect(() => {
    if (!reminderActive) return undefined
    const recordInteraction = (event: Event) => {
      if (isPetUiEvent(event)) return
      if (event instanceof KeyboardEvent && !isMeaningfulKey(event)) return
      if (entryBlockedRef.current) return
      const now = Date.now()
      const current = stateRef.current
      if (!current) return
      const deadline = nextRestReminderDeadline(current)
      if (current.phase !== 'due' && (deadline === null || now < deadline)) return
      pendingInteractionAtRef.current = Math.max(
        pendingInteractionAtRef.current ?? 0,
        now,
      )
      if (interactionTimerRef.current !== null) return
      interactionTimerRef.current = window.setTimeout(() => {
        interactionTimerRef.current = null
        const current = stateRef.current
        const nextState = stateWithPendingInteraction()
        if (nextState !== current) commit(nextState)
      }, ACTIVITY_COMMIT_INTERVAL_MS)
    }
    window.addEventListener('pointerdown', recordInteraction, true)
    window.addEventListener('keydown', recordInteraction, true)
    window.addEventListener('input', recordInteraction, true)
    return () => {
      window.removeEventListener('pointerdown', recordInteraction, true)
      window.removeEventListener('keydown', recordInteraction, true)
      window.removeEventListener('input', recordInteraction, true)
    }
  }, [commit, reminderActive, stateWithPendingInteraction])

  useEffect(() => {
    const syncVisibility = () => {
      const visible = document.visibilityState !== 'hidden'
      if (!visible) {
        const current = flushPendingInteraction()
        if (current && current.phase !== 'resting') {
          commit(reduceRestReminder(current, { type: 'background', now: Date.now() }))
        }
        setPageVisible(false)
        return
      }
      setPageVisible(true)
      const current = stateWithPendingInteraction()
      if (current && !entryBlockedRef.current) {
        commit(reduceRestReminder(current, { type: 'foreground', now: Date.now() }))
      }
    }
    document.addEventListener('visibilitychange', syncVisibility)
    return () => document.removeEventListener('visibilitychange', syncVisibility)
  }, [commit, flushPendingInteraction, stateWithPendingInteraction])

  useEffect(() => {
    if (
      !pageVisible
      || entryBlocked
      || !state
      || (state.phase !== 'armed' && state.backgroundedAt === null)
    ) return
    commit(reduceRestReminder(state, { type: 'foreground', now: Date.now() }))
  }, [commit, entryBlocked, pageVisible, state])

  useEffect(() => {
    if (!pageVisible || !state) return undefined
    if (entryBlocked && state.phase !== 'resting') return undefined
    const deadline = nextRestReminderDeadline(state)
    if (deadline === null) return undefined
    const timeout = window.setTimeout(() => {
      clearInteractionTimer()
      const current = stateWithPendingInteraction()
      if (
        current
        && (current.phase === 'resting' || !entryBlockedRef.current)
      ) {
        commit(reduceRestReminder(current, { type: 'deadline', now: Date.now() }))
      }
    }, Math.max(0, deadline - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [
    clearInteractionTimer,
    commit,
    entryBlocked,
    pageVisible,
    state,
    stateWithPendingInteraction,
  ])

  useEffect(() => () => {
    clearInteractionTimer()
    const current = stateWithPendingInteraction()
    const nextState = current && current.phase !== 'resting'
      ? reduceRestReminder(current, { type: 'background', now: Date.now() })
      : current
    stateRef.current = nextState
    persist(nextState, false)
  }, [clearInteractionTimer, persist, stateWithPendingInteraction])

  const act = useCallback((type: 'dismiss' | 'snooze') => {
    clearInteractionTimer()
    pendingInteractionAtRef.current = null
    const current = stateRef.current
    if (!current) return
    commit(reduceRestReminder(current, { type, now: Date.now() }))
  }, [clearInteractionTimer, commit])

  return {
    state,
    pageVisible,
    persistenceFailed,
    dismiss: useCallback(() => act('dismiss'), [act]),
    snooze: useCallback(() => act('snooze'), [act]),
  }
}
