import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PET_REST_REMINDER_RUNTIME_STORAGE_KEY,
  PET_SETTINGS_STORAGE_KEY,
  REST_REMINDER_BREAK_MINUTES,
  REST_REMINDER_CUSTOM_MINUTES_MAX,
  REST_REMINDER_ENTRY_COUNTDOWN_SECONDS,
  REST_REMINDER_IDLE_RESET_MS,
  REST_REMINDER_INTERVAL_PRESETS_SECONDS,
  REST_REMINDER_LONG_BREAK_MINUTES,
  REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
  REST_REMINDER_TEST_INTERVAL_SECONDS,
  createRestReminderState,
  nextRestReminderDeadline,
  normalizeRestReminderIntervalSeconds,
  readPetAppearance,
  readRestReminderIntervalSeconds,
  readRestReminderRuntimeState,
  reconfigureRestReminderInterval,
  reduceRestReminder,
  restReminderBreakMinutes,
  restReminderEntryCountdownSeconds,
  restReminderInvitationMs,
  restReminderSliderIntervalSeconds,
  restReminderSliderPosition,
  savePetAppearance,
  saveRestReminderIntervalSeconds,
  saveRestReminderRuntimeState,
} from '../src/lib/pet/rest-reminder'
import { resolvePetNotificationIntent } from '../src/lib/pet/intents'

function createStorage() {
  const values = new Map<string, string>()
  return {
    storage: {
      getItem(key: string) {
        return values.get(key) ?? null
      },
      removeItem(key: string) {
        values.delete(key)
      },
      setItem(key: string, value: string) {
        values.set(key, value)
      },
    },
    values,
  }
}

test('normalizes reminder intervals and maps slider positions', () => {
  assert.equal(normalizeRestReminderIntervalSeconds(null), null)
  assert.equal(normalizeRestReminderIntervalSeconds('5'), 5)
  assert.equal(normalizeRestReminderIntervalSeconds(30 * 60), 30 * 60)
  assert.equal(normalizeRestReminderIntervalSeconds(37 * 60), 37 * 60)
  assert.equal(normalizeRestReminderIntervalSeconds(4 * 60 * 60), 4 * 60 * 60)
  assert.equal(normalizeRestReminderIntervalSeconds(30), null)
  assert.equal(
    normalizeRestReminderIntervalSeconds((REST_REMINDER_CUSTOM_MINUTES_MAX + 1) * 60),
    null,
  )

  assert.equal(restReminderSliderPosition(0), 0)
  assert.equal(restReminderSliderPosition(null), 1)
  assert.equal(restReminderSliderPosition(REST_REMINDER_TEST_INTERVAL_SECONDS), 2)
  assert.equal(restReminderSliderPosition(37 * 60), 4.7)
  assert.equal(restReminderSliderIntervalSeconds(1), null)
  assert.equal(restReminderSliderIntervalSeconds(4.4), 30 * 60)
  assert.equal(restReminderSliderIntervalSeconds(4.6), 40 * 60)
  assert.equal(
    restReminderSliderIntervalSeconds(REST_REMINDER_INTERVAL_PRESETS_SECONDS.length),
    90 * 60,
  )
  assert.equal(restReminderBreakMinutes(50 * 60), REST_REMINDER_BREAK_MINUTES)
  assert.equal(restReminderBreakMinutes(90 * 60), REST_REMINDER_LONG_BREAK_MINUTES)
  assert.equal(
    restReminderEntryCountdownSeconds(REST_REMINDER_TEST_INTERVAL_SECONDS),
    REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS,
  )
  assert.equal(restReminderEntryCountdownSeconds(50 * 60), REST_REMINDER_ENTRY_COUNTDOWN_SECONDS)
})

test('only accepts the explicit E2E invitation timing override', () => {
  assert.equal(restReminderInvitationMs(''), 30 * 60_000)
  assert.equal(restReminderInvitationMs('?petRestInvitationSeconds=30'), 30 * 60_000)
  assert.equal(restReminderInvitationMs('?petRestInvitationSeconds=30', true), 30_000)
  assert.equal(restReminderInvitationMs('?petRestInvitationSeconds=0', true), 30 * 60_000)
  assert.equal(restReminderInvitationMs('?petRestInvitationSeconds=1801', true), 30 * 60_000)
})

test('resolves only unconfigured and appearance setup notifications', () => {
  assert.deepEqual(resolvePetNotificationIntent(null, null), {
    kind: 'notification',
    notification: 'rest-reminder-setup',
    option: 'invitation',
  })
  assert.equal(resolvePetNotificationIntent(0, null), null)
  assert.equal(resolvePetNotificationIntent(50 * 60, null), null)
  assert.deepEqual(resolvePetNotificationIntent(50 * 60, 'appearance'), {
    kind: 'notification',
    notification: 'rest-reminder-setup',
    option: 'appearance',
  })
})

test('persists reminder and appearance settings without overwriting the other value', () => {
  const { storage, values } = createStorage()
  assert.equal(readRestReminderIntervalSeconds(storage), null)
  assert.equal(readPetAppearance(storage), 'glass')
  assert.equal(readPetAppearance(storage, 'black-hole'), 'black-hole')

  assert.equal(
    saveRestReminderIntervalSeconds(REST_REMINDER_TEST_INTERVAL_SECONDS, storage, 'black-hole'),
    true,
  )
  const storedPetSettings = JSON.parse(values.get(PET_SETTINGS_STORAGE_KEY)!)
  assert.equal(storedPetSettings.appearance, undefined)
  assert.equal(readPetAppearance(storage, 'black-hole'), 'black-hole')
  assert.equal(
    storedPetSettings.capabilities.restReminder.intervalSeconds,
    REST_REMINDER_TEST_INTERVAL_SECONDS,
  )
  assert.equal(readRestReminderIntervalSeconds(storage), REST_REMINDER_TEST_INTERVAL_SECONDS)

  assert.equal(savePetAppearance('black-hole', storage), true)
  assert.equal(readPetAppearance(storage), 'black-hole')
  assert.equal(readPetAppearance(storage, 'glass'), 'black-hole')
  assert.equal(saveRestReminderIntervalSeconds(37 * 60, storage), true)
  assert.equal(readRestReminderIntervalSeconds(storage), 37 * 60)
  assert.equal(readPetAppearance(storage), 'black-hole')
  assert.equal(savePetAppearance('glass', storage), true)
  assert.equal(saveRestReminderIntervalSeconds(2 * 60 * 60, storage, 'black-hole'), true)
  assert.equal(readPetAppearance(storage, 'black-hole'), 'glass')
  assert.equal(saveRestReminderIntervalSeconds(30, storage), false)
})

test('advances a due reminder through countdown, late deadlines, and a user interaction', () => {
  const start = 1_000_000
  let state = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  assert.equal(nextRestReminderDeadline(state), start + 5_000)

  state = reduceRestReminder(state, { type: 'deadline', now: start + 5_000 })
  assert.equal(state.phase, 'due')
  assert.equal(
    state.restStartsAt,
    start + 5_000 + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  )
  assert.equal(nextRestReminderDeadline(state), state.restStartsAt)

  const backgroundRestStartsAt = state.restStartsAt!
  const restingInBackground = reduceRestReminder(state, {
    type: 'deadline',
    now: backgroundRestStartsAt + 60_000,
  })
  assert.equal(restingInBackground.phase, 'resting')
  assert.equal(
    restingInBackground.restUntil,
    backgroundRestStartsAt + REST_REMINDER_BREAK_MINUTES * 60_000,
  )
  assert.equal(
    reduceRestReminder(state, {
      type: 'deadline',
      now: backgroundRestStartsAt + REST_REMINDER_BREAK_MINUTES * 60_000,
    }).phase,
    'armed',
  )

  state = reduceRestReminder(state, {
    type: 'interaction',
    now: backgroundRestStartsAt + 100,
  })
  assert.equal(state.phase, 'due')
  assert.equal(
    state.restStartsAt,
    backgroundRestStartsAt + 100 + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  )
})

test('a late first deadline starts and finishes the full break from the correct deadline', () => {
  const start = 1_000_000
  let state = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  state = reduceRestReminder(state, { type: 'deadline', now: start + 60_000 })
  assert.equal(state.phase, 'resting')
  assert.equal(
    state.restUntil,
    start
      + REST_REMINDER_TEST_INTERVAL_SECONDS * 1000
      + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000
      + REST_REMINDER_BREAK_MINUTES * 60_000,
  )
})

test('an overdue user interaction starts a fresh entry countdown', () => {
  const start = 1_000_000
  const interactionAt = start
    + REST_REMINDER_TEST_INTERVAL_SECONDS * 1000
    + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000
    + 3 * 60_000
  let state = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  state = reduceRestReminder(state, { type: 'interaction', now: interactionAt })

  assert.equal(state.phase, 'due')
  assert.equal(
    state.restStartsAt,
    interactionAt + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  )

  const restStartsAt = state.restStartsAt!
  state = reduceRestReminder(state, { type: 'deadline', now: restStartsAt })
  assert.equal(state.phase, 'resting')
  assert.equal(
    state.restUntil,
    restStartsAt + REST_REMINDER_BREAK_MINUTES * 60_000,
  )
})

test('resumes runtime state, validates stored data, and reconfigures the active interval', () => {
  const { storage, values } = createStorage()
  const start = 1_000_000
  let state = createRestReminderState(50 * 60)
  assert.equal(state.phase, 'armed')
  assert.equal(nextRestReminderDeadline(state), null)

  state = reduceRestReminder(state, { type: 'foreground', now: start })
  assert.equal(state.phase, 'working')
  assert.equal(state.cycleStartedAt, start)
  assert.equal(nextRestReminderDeadline(state), start + 50 * 60_000)

  assert.equal(saveRestReminderRuntimeState(state, storage), true)
  assert.equal(values.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY), true)
  const restored = readRestReminderRuntimeState(50 * 60, start + 60_000, storage)!
  assert.equal(restored.phase, 'working')
  assert.equal(restored.cycleStartedAt, start)
  assert.equal(restored.backgroundedAt, null)

  const longer = reconfigureRestReminderInterval(restored, 60 * 60, start + 10 * 60_000)
  assert.equal(longer.phase, 'working')
  assert.equal(longer.cycleStartedAt, start)
  assert.equal(longer.intervalSeconds, 60 * 60)

  const shorter = reconfigureRestReminderInterval(longer, 5, start + 10 * 60_000)
  assert.equal(shorter.phase, 'due')
  assert.equal(
    shorter.restStartsAt,
    start + 10 * 60_000 + REST_REMINDER_TEST_ENTRY_COUNTDOWN_SECONDS * 1000,
  )

  values.set(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify({
    version: 1,
    state: { ...state, phase: 'due', restStartsAt: null },
  }))
  assert.equal(readRestReminderRuntimeState(50 * 60, start + 60_000, storage), null)
  assert.equal(saveRestReminderRuntimeState(null, storage), true)
  assert.equal(values.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY), false)
})

test('allows one snooze and pauses or resets foreground activity across background time', () => {
  const start = 1_000_000
  let state = createRestReminderState(50 * 60)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  state = reduceRestReminder(state, { type: 'deadline', now: start + 50 * 60_000 })
  assert.equal(state.phase, 'due')
  assert.equal(
    state.restStartsAt,
    start + 50 * 60_000 + REST_REMINDER_ENTRY_COUNTDOWN_SECONDS * 1000,
  )

  state = reduceRestReminder(state, { type: 'snooze', now: start + 50 * 60_000 })
  assert.equal(state.phase, 'snoozed')
  assert.equal(state.snoozeUsed, true)
  state = reduceRestReminder(state, { type: 'interaction', now: start + 54 * 60_000 })
  state = reduceRestReminder(state, { type: 'interaction', now: start + 58 * 60_000 })
  state = reduceRestReminder(state, { type: 'deadline', now: start + 60 * 60_000 })
  assert.equal(state.phase, 'due')
  const restStartsAt = state.restStartsAt
  state = reduceRestReminder(state, { type: 'snooze', now: start + 60 * 60_000 })
  assert.equal(state.phase, 'due')
  assert.equal(state.restStartsAt, restStartsAt)

  state = reduceRestReminder(state, { type: 'deadline', now: state.restStartsAt! })
  assert.equal(state.phase, 'resting')
  state = reduceRestReminder(state, { type: 'deadline', now: state.restUntil! })
  assert.equal(state.phase, 'armed')

  state = reduceRestReminder(state, { type: 'foreground', now: start })
  state = reduceRestReminder(state, { type: 'background', now: start + 10 * 60_000 })
  assert.equal(nextRestReminderDeadline(state), null)
  state = reduceRestReminder(state, { type: 'foreground', now: start + 12 * 60_000 })
  assert.equal(state.phase, 'working')
  assert.equal(state.cycleStartedAt, start + 2 * 60_000)
  state = reduceRestReminder(state, { type: 'background', now: start + 20 * 60_000 })
  state = reduceRestReminder(state, {
    type: 'foreground',
    now: start + 20 * 60_000 + REST_REMINDER_IDLE_RESET_MS,
  })
  assert.equal(state.cycleStartedAt, start + 20 * 60_000 + REST_REMINDER_IDLE_RESET_MS)
})
