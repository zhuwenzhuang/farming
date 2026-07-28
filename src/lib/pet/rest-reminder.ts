import { appPath } from '../base-path.ts'

export const PET_SETTINGS_STORAGE_KEY = 'farmingPetSettings'
export const PET_SETTINGS_EVENT = 'farming-pet-settings'
export const PET_REST_REMINDER_RUNTIME_STORAGE_KEY = 'farmingPetRestReminderRuntime'

export const REST_REMINDER_DEFAULT_INTERVAL_SECONDS = 50 * 60
export const REST_REMINDER_BREAK_MINUTES = 5
export const REST_REMINDER_ENTRY_COUNTDOWN_SECONDS = 30
export const REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS = 5
export const REST_REMINDER_SNOOZE_MINUTES = 10
export const REST_REMINDER_IDLE_RESET_MINUTES = 5
export const REST_REMINDER_IDLE_RESET_MS = REST_REMINDER_IDLE_RESET_MINUTES * 60_000
export const REST_REMINDER_TEST_INTERVAL_SECONDS = 5
export const REST_REMINDER_CUSTOM_MINUTES_MIN = 1
export const REST_REMINDER_CUSTOM_MINUTES_MAX = 240
export const REST_REMINDER_INTERVAL_PRESETS_SECONDS = [
  0,
  REST_REMINDER_TEST_INTERVAL_SECONDS,
  25 * 60,
  30 * 60,
  40 * 60,
  REST_REMINDER_DEFAULT_INTERVAL_SECONDS,
  60 * 60,
  90 * 60,
  2 * 60 * 60,
  3 * 60 * 60,
  4 * 60 * 60,
] as const

export function restReminderSliderPosition(intervalSeconds: number | null): number {
  const normalized = intervalSeconds ?? 0
  const exactIndex = REST_REMINDER_INTERVAL_PRESETS_SECONDS.indexOf(
    normalized as typeof REST_REMINDER_INTERVAL_PRESETS_SECONDS[number],
  )
  if (exactIndex >= 0) return exactIndex

  const upperIndex = REST_REMINDER_INTERVAL_PRESETS_SECONDS.findIndex(
    preset => preset > normalized,
  )
  if (upperIndex < 0) return REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1
  if (upperIndex === 0) return 0

  const lowerIndex = upperIndex - 1
  const lower = REST_REMINDER_INTERVAL_PRESETS_SECONDS[lowerIndex]!
  const upper = REST_REMINDER_INTERVAL_PRESETS_SECONDS[upperIndex]!
  return lowerIndex + ((normalized - lower) / (upper - lower))
}

export function restReminderSliderIntervalSeconds(position: number): number {
  const presetIndex = Math.max(
    0,
    Math.min(
      REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1,
      Math.round(position),
    ),
  )
  return REST_REMINDER_INTERVAL_PRESETS_SECONDS[presetIndex] ?? 0
}

export function restReminderEntryCountdownSeconds(intervalSeconds: number) {
  return intervalSeconds === REST_REMINDER_TEST_INTERVAL_SECONDS
    ? REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS
    : REST_REMINDER_ENTRY_COUNTDOWN_SECONDS
}

export type PetAppearance = 'glass' | 'black-hole'

type PetSettingsStorage = Pick<Storage, 'getItem' | 'setItem'>
type PetRuntimeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

interface StoredPetSettings {
  version: 1
  appearance?: PetAppearance
  capabilities: {
    restReminder: {
      intervalSeconds: number
    }
  }
}

function parsePetAppearance(value: unknown): PetAppearance | null {
  return value === 'glass' || value === 'black-hole' ? value : null
}

function parseStoredSettings(value: string | null): Partial<StoredPetSettings> | null {
  if (value === null) return null
  try {
    return JSON.parse(value) as Partial<StoredPetSettings>
  } catch {
    return null
  }
}

export function normalizeRestReminderIntervalSeconds(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const seconds = Number(value)
  if (!Number.isInteger(seconds)) return null
  if (seconds === 0 || seconds === REST_REMINDER_TEST_INTERVAL_SECONDS) return seconds
  const minimum = REST_REMINDER_CUSTOM_MINUTES_MIN * 60
  const maximum = REST_REMINDER_CUSTOM_MINUTES_MAX * 60
  return seconds >= minimum && seconds <= maximum && seconds % 60 === 0
    ? seconds
    : null
}

function parseStoredIntervalSeconds(value: string | null) {
  const settings = parseStoredSettings(value)
  return normalizeRestReminderIntervalSeconds(
    settings?.capabilities?.restReminder?.intervalSeconds,
  )
}

export function readRestReminderIntervalSeconds(storage?: PetSettingsStorage): number | null {
  if (!storage && typeof window === 'undefined') return null
  try {
    const target = storage ?? window.localStorage
    return parseStoredIntervalSeconds(target.getItem(PET_SETTINGS_STORAGE_KEY))
  } catch {
    return null
  }
}

export function readPetAppearance(
  storage?: PetSettingsStorage,
  defaultAppearance: PetAppearance = 'glass',
): PetAppearance {
  if (!storage && typeof window === 'undefined') return defaultAppearance
  try {
    const target = storage ?? window.localStorage
    return parsePetAppearance(
      parseStoredSettings(target.getItem(PET_SETTINGS_STORAGE_KEY))?.appearance,
    ) ?? defaultAppearance
  } catch {
    return defaultAppearance
  }
}

function dispatchPetSettings(intervalSeconds: number, appearance: PetAppearance) {
  window.dispatchEvent(new CustomEvent(PET_SETTINGS_EVENT, {
    detail: {
      capability: 'rest-reminder',
      intervalSeconds,
      appearance,
    }
  }))
}

export function saveRestReminderIntervalSeconds(
  seconds: number,
  storage?: PetSettingsStorage,
  defaultAppearance: PetAppearance = 'glass',
) {
  const normalized = normalizeRestReminderIntervalSeconds(seconds)
  if (normalized === null) return false
  const target = storage ?? window.localStorage
  let appearance: PetAppearance
  try {
    const storedAppearance = parsePetAppearance(
      parseStoredSettings(target.getItem(PET_SETTINGS_STORAGE_KEY))?.appearance,
    )
    appearance = storedAppearance ?? defaultAppearance
    const settings: StoredPetSettings = {
      version: 1,
      ...(storedAppearance ? { appearance: storedAppearance } : {}),
      capabilities: {
        restReminder: {
          intervalSeconds: normalized,
        },
      },
    }
    target.setItem(PET_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  if (typeof window !== 'undefined' && !storage) {
    dispatchPetSettings(normalized, appearance)
  }
  return true
}

export function savePetAppearance(appearance: PetAppearance, storage?: PetSettingsStorage) {
  const target = storage ?? window.localStorage
  const intervalSeconds = readRestReminderIntervalSeconds(target) ?? 0
  const settings: StoredPetSettings = {
    version: 1,
    appearance,
    capabilities: {
      restReminder: {
        intervalSeconds,
      },
    },
  }
  try {
    target.setItem(PET_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    return false
  }
  if (typeof window !== 'undefined' && !storage) {
    dispatchPetSettings(intervalSeconds, appearance)
  }
  return true
}

type RestReminderServerSettings = {
  restReminderIntervalSeconds?: unknown
}

let restReminderSettingWrite = Promise.resolve(true)

async function postRestReminderIntervalSeconds(seconds: number) {
  const response = await fetch(appPath('/api/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restReminderIntervalSeconds: seconds }),
  })
  const data = await response.json().catch(() => null) as {
    settings?: RestReminderServerSettings
    error?: string
  } | null
  if (!response.ok) {
    throw new Error(data?.error || `Could not save break reminder (${response.status})`)
  }
  const saved = normalizeRestReminderIntervalSeconds(
    data?.settings?.restReminderIntervalSeconds,
  )
  if (saved === null) throw new Error('The saved break reminder setting is invalid.')
  return saved
}

export function persistRestReminderIntervalSeconds(
  seconds: number,
  defaultAppearance: PetAppearance = 'glass',
) {
  const normalized = normalizeRestReminderIntervalSeconds(seconds)
  if (normalized === null) return Promise.resolve(false)
  const write = async () => {
    try {
      const saved = await postRestReminderIntervalSeconds(normalized)
      return saveRestReminderIntervalSeconds(saved, undefined, defaultAppearance)
    } catch {
      return false
    }
  }
  const result = restReminderSettingWrite.then(write, write)
  restReminderSettingWrite = result.then(() => true, () => true)
  return result
}

export async function loadRestReminderIntervalSeconds(
  defaultAppearance: PetAppearance = 'glass',
) {
  const localIntervalSeconds = readRestReminderIntervalSeconds()
  try {
    const response = await fetch(appPath('/api/settings'))
    if (!response.ok) return localIntervalSeconds
    const data = await response.json() as { settings?: RestReminderServerSettings }
    const persistedIntervalSeconds = normalizeRestReminderIntervalSeconds(
      data.settings?.restReminderIntervalSeconds,
    )
    if (persistedIntervalSeconds !== null) {
      saveRestReminderIntervalSeconds(
        persistedIntervalSeconds,
        undefined,
        defaultAppearance,
      )
      return persistedIntervalSeconds
    }
    if (localIntervalSeconds === null) return null
    await persistRestReminderIntervalSeconds(
      localIntervalSeconds,
      defaultAppearance,
    )
    return localIntervalSeconds
  } catch {
    return localIntervalSeconds
  }
}

export function isPetSettingsStorageKey(key: string | null) {
  return key === PET_SETTINGS_STORAGE_KEY
}

export type RestReminderPhase = 'armed' | 'working' | 'due' | 'snoozed' | 'resting'

export interface RestReminderState {
  phase: RestReminderPhase
  intervalSeconds: number
  cycleStartedAt: number | null
  lastActivityAt: number | null
  snoozedUntil: number | null
  restStartsAt: number | null
  restUntil: number | null
  snoozeUsed: boolean
}

interface StoredRestReminderRuntime {
  version: 1
  state: RestReminderState
}

export type RestReminderEvent =
  | { type: 'activity'; now: number }
  | { type: 'deadline'; now: number }
  | { type: 'snooze'; now: number }
  | { type: 'dismiss'; now: number }

export function createRestReminderState(intervalSeconds: number): RestReminderState {
  return {
    phase: 'armed',
    intervalSeconds,
    cycleStartedAt: null,
    lastActivityAt: null,
    snoozedUntil: null,
    restStartsAt: null,
    restUntil: null,
    snoozeUsed: false,
  }
}

function beginRest(state: RestReminderState, now: number): RestReminderState {
  return {
    ...createRestReminderState(state.intervalSeconds),
    phase: 'resting',
    restUntil: now + REST_REMINDER_BREAK_MINUTES * 60_000,
    snoozeUsed: state.snoozeUsed,
  }
}

function beginRestCountdown(state: RestReminderState, now: number): RestReminderState {
  return {
    ...state,
    phase: 'due',
    snoozedUntil: null,
    restStartsAt: now + restReminderEntryCountdownSeconds(state.intervalSeconds) * 1000,
  }
}

function advanceRestReminder(
  state: RestReminderState,
  now: number,
): RestReminderState {
  if (state.phase === 'resting') {
    if (state.restUntil !== null && now >= state.restUntil) {
      return createRestReminderState(state.intervalSeconds)
    }
    return state
  }

  if (
    state.lastActivityAt !== null
    && now - state.lastActivityAt >= REST_REMINDER_IDLE_RESET_MS
  ) {
    return createRestReminderState(state.intervalSeconds)
  }

  if (
    state.phase === 'working'
    && state.cycleStartedAt !== null
    && now - state.cycleStartedAt >= state.intervalSeconds * 1000
  ) {
    const dueAt = state.cycleStartedAt + state.intervalSeconds * 1000
    const dueState = beginRestCountdown(state, dueAt)
    if (dueState.restStartsAt !== null && now >= dueState.restStartsAt) {
      const restingState = beginRest(dueState, dueState.restStartsAt)
      return restingState.restUntil !== null && now >= restingState.restUntil
        ? createRestReminderState(state.intervalSeconds)
        : restingState
    }
    return dueState
  }

  if (
    state.phase === 'snoozed'
    && state.snoozedUntil !== null
    && now >= state.snoozedUntil
  ) {
    const dueState = beginRestCountdown(state, state.snoozedUntil)
    if (dueState.restStartsAt !== null && now >= dueState.restStartsAt) {
      const restingState = beginRest(dueState, dueState.restStartsAt)
      return restingState.restUntil !== null && now >= restingState.restUntil
        ? createRestReminderState(state.intervalSeconds)
        : restingState
    }
    return dueState
  }

  if (
    state.phase === 'due'
    && state.restStartsAt !== null
    && now >= state.restStartsAt
  ) {
    const restingState = beginRest(state, state.restStartsAt)
    return restingState.restUntil !== null && now >= restingState.restUntil
      ? createRestReminderState(state.intervalSeconds)
      : restingState
  }

  return state
}

export function reconfigureRestReminderInterval(
  state: RestReminderState,
  intervalSeconds: number,
  now: number,
): RestReminderState {
  const normalized = normalizeRestReminderIntervalSeconds(intervalSeconds)
  if (normalized === null || normalized <= 0) {
    throw new Error('A positive rest reminder interval is required.')
  }
  if (state.intervalSeconds === normalized) return state
  const configured = { ...state, intervalSeconds: normalized }
  if (
    configured.phase === 'working'
    && configured.cycleStartedAt !== null
    && now - configured.cycleStartedAt >= normalized * 1000
  ) {
    return beginRestCountdown(configured, now)
  }
  return configured
}

export function reduceRestReminder(
  state: RestReminderState,
  event: RestReminderEvent,
): RestReminderState {
  // A concrete user action wins over a delayed countdown callback. This keeps
  // the rest scene from appearing over a click or keystroke that is already
  // being handled by the page.
  if (event.type === 'activity' && state.phase === 'due') {
    return {
      ...state,
      lastActivityAt: event.now,
      restStartsAt: event.now
        + restReminderEntryCountdownSeconds(state.intervalSeconds) * 1000,
    }
  }

  if (event.type === 'dismiss') {
    return createRestReminderState(state.intervalSeconds)
  }

  if (event.type === 'snooze' && state.phase === 'due' && !state.snoozeUsed) {
    return {
      ...createRestReminderState(state.intervalSeconds),
      phase: 'snoozed',
      lastActivityAt: event.now,
      snoozedUntil: event.now + REST_REMINDER_SNOOZE_MINUTES * 60_000,
      snoozeUsed: true,
    }
  }

  const advanced = advanceRestReminder(state, event.now)

  if (event.type === 'deadline') return advanced

  if (event.type === 'snooze') {
    return advanced
  }

  if (advanced.phase === 'resting') {
    return advanced
  }

  if (advanced.phase === 'due') {
    return {
      ...advanced,
      lastActivityAt: event.now,
      restStartsAt: event.now
        + restReminderEntryCountdownSeconds(advanced.intervalSeconds) * 1000,
    }
  }

  if (advanced.phase === 'armed') {
    return {
      ...advanced,
      phase: 'working',
      cycleStartedAt: event.now,
      lastActivityAt: event.now,
    }
  }

  return { ...advanced, lastActivityAt: event.now }
}

export function nextRestReminderDeadline(state: RestReminderState): number | null {
  if (state.phase === 'resting') return state.restUntil
  if (state.phase === 'due') return state.restStartsAt
  if (state.phase === 'armed') return null

  const idleAt = state.lastActivityAt === null
    ? null
    : state.lastActivityAt + REST_REMINDER_IDLE_RESET_MS

  if (state.phase === 'working' && state.cycleStartedAt !== null) {
    const dueAt = state.cycleStartedAt + state.intervalSeconds * 1000
    return idleAt === null ? dueAt : Math.min(dueAt, idleAt)
  }

  if (state.phase === 'snoozed' && state.snoozedUntil !== null) {
    return idleAt === null ? state.snoozedUntil : Math.min(state.snoozedUntil, idleAt)
  }

  return idleAt
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function normalizeStoredRestReminderState(value: unknown): RestReminderState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const state = value as Partial<RestReminderState>
  if (
    !['armed', 'working', 'due', 'snoozed', 'resting'].includes(String(state.phase))
    || normalizeRestReminderIntervalSeconds(state.intervalSeconds) !== state.intervalSeconds
    || !state.intervalSeconds
    || state.intervalSeconds <= 0
    || !isNullableFiniteNumber(state.cycleStartedAt)
    || !isNullableFiniteNumber(state.lastActivityAt)
    || !isNullableFiniteNumber(state.snoozedUntil)
    || !isNullableFiniteNumber(state.restStartsAt)
    || !isNullableFiniteNumber(state.restUntil)
    || typeof state.snoozeUsed !== 'boolean'
  ) {
    return null
  }
  const normalized: RestReminderState = {
    phase: state.phase as RestReminderPhase,
    intervalSeconds: state.intervalSeconds,
    cycleStartedAt: state.cycleStartedAt,
    lastActivityAt: state.lastActivityAt,
    snoozedUntil: state.snoozedUntil,
    restStartsAt: state.restStartsAt,
    restUntil: state.restUntil,
    snoozeUsed: state.snoozeUsed,
  }
  if (
    (normalized.phase === 'working'
      && (normalized.cycleStartedAt === null || normalized.lastActivityAt === null))
    || (normalized.phase === 'due' && normalized.restStartsAt === null)
    || (normalized.phase === 'snoozed'
      && (normalized.snoozedUntil === null || normalized.lastActivityAt === null))
    || (normalized.phase === 'resting' && normalized.restUntil === null)
  ) {
    return null
  }
  return normalized
}

export function readRestReminderRuntimeState(
  intervalSeconds: number,
  now = Date.now(),
  storage?: PetRuntimeStorage,
): RestReminderState | null {
  if (!storage && typeof window === 'undefined') return null
  try {
    const target = storage ?? window.sessionStorage
    const raw = target.getItem(PET_REST_REMINDER_RUNTIME_STORAGE_KEY)
    if (raw === null) return null
    const stored = JSON.parse(raw) as Partial<StoredRestReminderRuntime>
    if (stored.version !== 1) return null
    const state = normalizeStoredRestReminderState(stored.state)
    if (!state) return null
    const configured = reconfigureRestReminderInterval(state, intervalSeconds, now)
    return advanceRestReminder(configured, now)
  } catch {
    return null
  }
}

export function saveRestReminderRuntimeState(
  state: RestReminderState | null,
  storage?: PetRuntimeStorage,
) {
  if (!storage && typeof window === 'undefined') return false
  try {
    const target = storage ?? window.sessionStorage
    if (state === null) {
      target.removeItem(PET_REST_REMINDER_RUNTIME_STORAGE_KEY)
    } else {
      const stored: StoredRestReminderRuntime = { version: 1, state }
      target.setItem(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify(stored))
    }
    return true
  } catch {
    return false
  }
}
