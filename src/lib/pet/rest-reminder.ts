import { appPath } from '../base-path.ts'

export const PET_SETTINGS_STORAGE_KEY = 'farmingPetSettings'
export const PET_SETTINGS_EVENT = 'farming-pet-settings'
export const PET_APPEARANCE_PREVIEW_EVENT = 'farming-pet-appearance-preview'
export const PET_REST_REMINDER_RUNTIME_STORAGE_KEY = 'farmingPetRestReminderRuntime'
export const PET_REST_REMINDER_INVITATION_STORAGE_KEY = 'farmingPetRestReminderInvitationRuntime'

export const REST_REMINDER_DEFAULT_INTERVAL_SECONDS = 50 * 60
export const REST_REMINDER_BREAK_MINUTES = 5
export const REST_REMINDER_LONG_BREAK_MINUTES = 10
export const REST_REMINDER_LONG_INTERVAL_SECONDS = 90 * 60
export const REST_REMINDER_ENTRY_COUNTDOWN_SECONDS = 30
export const REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS = 5
export const REST_REMINDER_SNOOZE_MINUTES = 10
export const REST_REMINDER_IDLE_RESET_MINUTES = 5
export const REST_REMINDER_IDLE_RESET_MS = REST_REMINDER_IDLE_RESET_MINUTES * 60_000
export const REST_REMINDER_INVITATION_MINUTES = 30
export const REST_REMINDER_INVITATION_MS = REST_REMINDER_INVITATION_MINUTES * 60_000
export const REST_REMINDER_INVITATION_TEST_QUERY_PARAM = 'petRestInvitationSeconds'
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
] as const
export const REST_REMINDER_SLIDER_MAX_POSITION = REST_REMINDER_INTERVAL_PRESETS_SECONDS.length

export function restReminderInvitationMs(search = '', allowTestOverride = false) {
  if (!allowTestOverride) return REST_REMINDER_INVITATION_MS
  const rawSeconds = new URLSearchParams(search).get(
    REST_REMINDER_INVITATION_TEST_QUERY_PARAM,
  )
  if (rawSeconds === null) return REST_REMINDER_INVITATION_MS

  const seconds = Number(rawSeconds)
  return Number.isInteger(seconds)
    && seconds >= 1
    && seconds <= REST_REMINDER_INVITATION_MINUTES * 60
    ? seconds * 1000
    : REST_REMINDER_INVITATION_MS
}

export function restReminderBreakMinutes(intervalSeconds: number) {
  return intervalSeconds >= REST_REMINDER_LONG_INTERVAL_SECONDS
    ? REST_REMINDER_LONG_BREAK_MINUTES
    : REST_REMINDER_BREAK_MINUTES
}

export function restReminderSliderPosition(intervalSeconds: number | null): number {
  if (intervalSeconds === null) return 1
  if (intervalSeconds === 0) return 0
  const normalized = intervalSeconds
  const exactIndex = REST_REMINDER_INTERVAL_PRESETS_SECONDS.indexOf(
    normalized as typeof REST_REMINDER_INTERVAL_PRESETS_SECONDS[number],
  )
  if (exactIndex >= 0) return exactIndex + 1

  const upperIndex = REST_REMINDER_INTERVAL_PRESETS_SECONDS.findIndex(
    preset => preset > normalized,
  )
  if (upperIndex < 0) return REST_REMINDER_SLIDER_MAX_POSITION
  if (upperIndex === 0) return 0

  const lowerIndex = upperIndex - 1
  const lower = REST_REMINDER_INTERVAL_PRESETS_SECONDS[lowerIndex]!
  const upper = REST_REMINDER_INTERVAL_PRESETS_SECONDS[upperIndex]!
  return lowerIndex + 1 + ((normalized - lower) / (upper - lower))
}

export function restReminderSliderIntervalSeconds(position: number): number | null {
  if (Math.round(position) === 1) return null
  const presetIndex = Math.max(
    0,
    Math.min(
      REST_REMINDER_INTERVAL_PRESETS_SECONDS.length - 1,
      Math.round(position) - 1,
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

export function requestPetAppearancePreview(
  appearance: PetAppearance,
  options?: { onEnd?: () => void },
) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PET_APPEARANCE_PREVIEW_EVENT, {
    detail: { appearance, onEnd: options?.onEnd },
  }))
}

type PetSettingsStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
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

function dispatchPetSettings(intervalSeconds: number | null, appearance: PetAppearance) {
  window.dispatchEvent(new CustomEvent(PET_SETTINGS_EVENT, {
    detail: {
      capability: 'rest-reminder',
      intervalSeconds,
      appearance,
    }
  }))
}

function clearRestReminderIntervalSeconds(defaultAppearance: PetAppearance) {
  try {
    window.localStorage.removeItem(PET_SETTINGS_STORAGE_KEY)
  } catch {
    return false
  }
  dispatchPetSettings(null, defaultAppearance)
  return true
}

export function markRestReminderInvitationReady() {
  try {
    window.sessionStorage.setItem(
      PET_REST_REMINDER_INVITATION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        foregroundMs: REST_REMINDER_INVITATION_MS,
        foregroundStartedAt: null,
      }),
    )
  } catch {
    // The reminder will use its normal invitation delay when session storage is unavailable.
  }
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

async function postRestReminderIntervalSeconds(seconds: number | null) {
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
  const savedValue = data?.settings?.restReminderIntervalSeconds
  if (savedValue === null) return null
  const saved = normalizeRestReminderIntervalSeconds(savedValue)
  if (saved === null) throw new Error('The saved break reminder setting is invalid.')
  return saved
}

export function persistRestReminderIntervalSeconds(
  seconds: number | null,
  defaultAppearance: PetAppearance = 'glass',
) {
  const normalized = seconds === null ? null : normalizeRestReminderIntervalSeconds(seconds)
  if (seconds !== null && normalized === null) return Promise.resolve(false)
  const write = async () => {
    try {
      const saved = await postRestReminderIntervalSeconds(normalized)
      if (saved === null) return clearRestReminderIntervalSeconds(defaultAppearance)
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
  backgroundedAt: number | null
  snoozedUntil: number | null
  restStartsAt: number | null
  restUntil: number | null
  snoozeUsed: boolean
}

interface StoredRestReminderRuntime {
  version: 2
  state: RestReminderState
}

interface LegacyStoredRestReminderRuntime {
  version: 1
  state: Omit<RestReminderState, 'backgroundedAt'> & { lastActivityAt: number | null }
}

export type RestReminderEvent =
  | { type: 'foreground'; now: number }
  | { type: 'background'; now: number }
  | { type: 'interaction'; now: number }
  | { type: 'deadline'; now: number }
  | { type: 'snooze'; now: number }
  | { type: 'dismiss'; now: number }

export function createRestReminderState(intervalSeconds: number): RestReminderState {
  return {
    phase: 'armed',
    intervalSeconds,
    cycleStartedAt: null,
    backgroundedAt: null,
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
    restUntil: now + restReminderBreakMinutes(state.intervalSeconds) * 60_000,
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

  if (state.backgroundedAt !== null) return state

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
  const activeNow = configured.backgroundedAt ?? now
  if (
    configured.phase === 'working'
    && configured.cycleStartedAt !== null
    && activeNow - configured.cycleStartedAt >= normalized * 1000
  ) {
    return beginRestCountdown(configured, activeNow)
  }
  return configured
}

function beginForegroundCycle(state: RestReminderState, now: number): RestReminderState {
  return {
    ...createRestReminderState(state.intervalSeconds),
    phase: 'working',
    cycleStartedAt: now,
  }
}

function resumeForeground(state: RestReminderState, now: number): RestReminderState {
  if (state.phase === 'resting') return advanceRestReminder(state, now)
  if (state.phase === 'armed') return beginForegroundCycle(state, now)
  if (state.backgroundedAt === null) return advanceRestReminder(state, now)

  const backgroundDuration = Math.max(0, now - state.backgroundedAt)
  if (backgroundDuration >= REST_REMINDER_IDLE_RESET_MS) {
    return beginForegroundCycle(state, now)
  }

  return advanceRestReminder({
    ...state,
    backgroundedAt: null,
    cycleStartedAt: state.cycleStartedAt === null
      ? null
      : state.cycleStartedAt + backgroundDuration,
    snoozedUntil: state.snoozedUntil === null
      ? null
      : state.snoozedUntil + backgroundDuration,
    restStartsAt: state.restStartsAt === null
      ? null
      : state.restStartsAt + backgroundDuration,
  }, now)
}

export function reduceRestReminder(
  state: RestReminderState,
  event: RestReminderEvent,
): RestReminderState {
  // A concrete user action wins over a delayed countdown callback. This keeps
  // the rest scene from appearing over a click or keystroke that is already
  // being handled by the page.
  if (event.type === 'interaction' && state.phase === 'due') {
    return {
      ...state,
      restStartsAt: event.now
        + restReminderEntryCountdownSeconds(state.intervalSeconds) * 1000,
    }
  }

  if (event.type === 'dismiss') {
    return beginForegroundCycle(state, event.now)
  }

  if (event.type === 'snooze' && state.phase === 'due' && !state.snoozeUsed) {
    return {
      ...createRestReminderState(state.intervalSeconds),
      phase: 'snoozed',
      snoozedUntil: event.now + REST_REMINDER_SNOOZE_MINUTES * 60_000,
      snoozeUsed: true,
    }
  }

  if (event.type === 'background') {
    if (state.phase === 'resting' || state.backgroundedAt !== null) return state
    return { ...state, backgroundedAt: event.now }
  }

  if (event.type === 'foreground') return resumeForeground(state, event.now)

  const advanced = advanceRestReminder(state, event.now)

  if (event.type === 'deadline') return advanced

  if (event.type === 'interaction' && advanced.phase === 'due') {
    return {
      ...advanced,
      restStartsAt: event.now
        + restReminderEntryCountdownSeconds(advanced.intervalSeconds) * 1000,
    }
  }

  return advanced
}

export function nextRestReminderDeadline(state: RestReminderState): number | null {
  if (state.phase === 'resting') return state.restUntil
  if (state.backgroundedAt !== null) return null
  if (state.phase === 'due') return state.restStartsAt
  if (state.phase === 'armed') return null

  if (state.phase === 'working' && state.cycleStartedAt !== null) {
    return state.cycleStartedAt + state.intervalSeconds * 1000
  }

  if (state.phase === 'snoozed' && state.snoozedUntil !== null) {
    return state.snoozedUntil
  }

  return null
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
    || !isNullableFiniteNumber(state.backgroundedAt)
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
    backgroundedAt: state.backgroundedAt,
    snoozedUntil: state.snoozedUntil,
    restStartsAt: state.restStartsAt,
    restUntil: state.restUntil,
    snoozeUsed: state.snoozeUsed,
  }
  if (
    (normalized.phase === 'working' && normalized.cycleStartedAt === null)
    || (normalized.phase === 'due' && normalized.restStartsAt === null)
    || (normalized.phase === 'snoozed' && normalized.snoozedUntil === null)
    || (normalized.phase === 'resting' && normalized.restUntil === null)
  ) {
    return null
  }
  return normalized
}

function normalizeLegacyRestReminderState(value: unknown): RestReminderState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const legacy = value as Partial<LegacyStoredRestReminderRuntime['state']>
  return normalizeStoredRestReminderState({
    ...legacy,
    backgroundedAt: null,
  })
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
    const stored = JSON.parse(raw) as Partial<
      StoredRestReminderRuntime | LegacyStoredRestReminderRuntime
    >
    const state = stored.version === 2
      ? normalizeStoredRestReminderState(stored.state)
      : (stored.version === 1 ? normalizeLegacyRestReminderState(stored.state) : null)
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
      const stored: StoredRestReminderRuntime = { version: 2, state }
      target.setItem(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify(stored))
    }
    return true
  } catch {
    return false
  }
}
