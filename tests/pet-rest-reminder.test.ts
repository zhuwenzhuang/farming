import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PET_REST_REMINDER_RUNTIME_STORAGE_KEY,
  PET_SETTINGS_STORAGE_KEY,
  REST_REMINDER_BREAK_MINUTES,
  REST_REMINDER_CUSTOM_MINUTES_MAX,
  REST_REMINDER_IDLE_RESET_MS,
  REST_REMINDER_INTERVAL_PRESETS_SECONDS,
  REST_REMINDER_LONG_BREAK_MINUTES,
  REST_REMINDER_TEST_INTERVAL_SECONDS,
  createRestReminderState,
  loadRestReminderIntervalSeconds,
  nextRestReminderDeadline,
  normalizeRestReminderIntervalSeconds,
  readPetAppearance,
  readRestReminderIntervalSeconds,
  readRestReminderRuntimeState,
  reconfigureRestReminderInterval,
  reduceRestReminder,
  restReminderBreakMinutes,
  restReminderInvitationMs,
  restReminderSliderIntervalSeconds,
  restReminderSliderPosition,
  persistRestReminderIntervalSeconds,
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

test('a stale reminder load cannot restore the value replaced by a newer write', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const { storage } = createStorage()
  saveRestReminderIntervalSeconds(50 * 60, storage)

  let resolveLoad!: (response: Response) => void
  const pendingLoad = new Promise<Response>(resolve => {
    resolveLoad = resolve
  })
  const writes: Array<number | null> = []

  globalThis.window = {
    localStorage: storage,
    dispatchEvent() {
      return true
    },
  } as unknown as Window & typeof globalThis
  globalThis.fetch = (async (_input, init) => {
    if (!init?.method || init.method === 'GET') return pendingLoad
    const body = JSON.parse(String(init.body)) as { restReminderIntervalSeconds: number | null }
    writes.push(body.restReminderIntervalSeconds)
    return new Response(JSON.stringify({
      settings: { restReminderIntervalSeconds: body.restReminderIntervalSeconds },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const load = loadRestReminderIntervalSeconds()
    assert.equal(await persistRestReminderIntervalSeconds(null), true)
    resolveLoad(new Response(JSON.stringify({
      settings: { restReminderIntervalSeconds: null },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))

    assert.equal(await load, null)
    assert.equal(readRestReminderIntervalSeconds(storage), null)
    assert.deepEqual(writes, [null])
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('only an explicit start action can enter a blocking break', () => {
  const start = 1_000_000
  let state = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  assert.equal(nextRestReminderDeadline(state), start + 5_000)

  state = reduceRestReminder(state, { type: 'deadline', now: start + 5_000 })
  assert.equal(state.phase, 'due')
  assert.equal(state.restStartsAt, null)
  assert.equal(nextRestReminderDeadline(state), null)

  for (const event of [
    { type: 'deadline' as const, now: start + 60_000 },
    { type: 'interaction' as const, now: start + 70_000 },
    { type: 'entry-unblocked' as const, now: start + 80_000 },
    { type: 'foreground' as const, now: start + 90_000 },
  ]) {
    state = reduceRestReminder(state, event)
    assert.equal(state.phase, 'due')
    assert.equal(state.restUntil, null)
  }

  const restStartedAt = start + 100_000
  state = reduceRestReminder(state, { type: 'start', now: restStartedAt })
  assert.equal(state.phase, 'resting')
  assert.equal(
    state.restUntil,
    restStartedAt + REST_REMINDER_BREAK_MINUTES * 60_000,
  )
  const resting = state
  assert.equal(reduceRestReminder(state, { type: 'start', now: restStartedAt + 1 }), resting)
  assert.equal(reduceRestReminder(state, { type: 'snooze', now: restStartedAt + 1 }), resting)
  state = reduceRestReminder(state, { type: 'dismiss', now: restStartedAt + 2 })
  assert.equal(state.phase, 'working')
  assert.equal(state.cycleStartedAt, restStartedAt + 2)
})

test('snooze replaces the current reminder with one deadline and rejects stale actions', () => {
  const start = 1_000_000
  let due = createRestReminderState(REST_REMINDER_TEST_INTERVAL_SECONDS)
  due = reduceRestReminder(due, { type: 'foreground', now: start })
  due = reduceRestReminder(due, { type: 'deadline', now: start + 5_000 })

  const snoozedAt = start + 6_000
  const snoozed = reduceRestReminder(due, { type: 'snooze', now: snoozedAt })
  assert.equal(snoozed.phase, 'snoozed')
  assert.equal(snoozed.snoozedUntil, snoozedAt + 10 * 60_000)
  assert.equal(nextRestReminderDeadline(snoozed), snoozed.snoozedUntil)
  assert.equal(reduceRestReminder(snoozed, { type: 'snooze', now: snoozedAt + 1 }), snoozed)
  assert.equal(reduceRestReminder(snoozed, { type: 'start', now: snoozedAt + 2 }), snoozed)
  assert.equal(reduceRestReminder(snoozed, { type: 'dismiss', now: snoozedAt + 3 }), snoozed)

  const early = reduceRestReminder(snoozed, {
    type: 'deadline',
    now: snoozed.snoozedUntil! - 1,
  })
  assert.equal(early, snoozed)
  const reminded = reduceRestReminder(snoozed, {
    type: 'deadline',
    now: snoozed.snoozedUntil!,
  })
  assert.equal(reminded.phase, 'due')
  assert.equal(reminded.snoozeUsed, true)
  assert.equal(nextRestReminderDeadline(reminded), null)
  assert.equal(
    reduceRestReminder(reminded, { type: 'deadline', now: snoozed.snoozedUntil! + 60_000 }),
    reminded,
  )
  assert.equal(
    reduceRestReminder(reminded, { type: 'snooze', now: snoozed.snoozedUntil! + 1 }),
    reminded,
  )
  assert.equal(reminded.restUntil, null)
})

test('refresh restores overdue reminders without reviving automatic rest callbacks', () => {
  const { storage, values } = createStorage()
  const now = 1_000_000
  const staleDue = {
    ...createRestReminderState(50 * 60),
    phase: 'due' as const,
    restStartsAt: now - 60_000,
  }
  values.set(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify({
    version: 2,
    state: staleDue,
  }))

  const restoredDue = readRestReminderRuntimeState(50 * 60, now, storage)!
  assert.equal(restoredDue.phase, 'due')
  assert.equal(restoredDue.restUntil, null)
  assert.equal(nextRestReminderDeadline(restoredDue), null)

  const snoozed = reduceRestReminder(restoredDue, { type: 'snooze', now })
  assert.equal(saveRestReminderRuntimeState(snoozed, storage), true)
  assert.equal(readRestReminderRuntimeState(50 * 60, now + 1, storage)?.phase, 'snoozed')
  assert.equal(
    readRestReminderRuntimeState(50 * 60, snoozed.snoozedUntil!, storage)?.phase,
    'due',
  )
})

test('entry blockers do not pause the work deadline and unblock deterministically', () => {
  const start = 1_000_000
  let state = createRestReminderState(60)
  state = reduceRestReminder(state, { type: 'foreground', now: start })

  const beforeDeadline = reduceRestReminder(state, {
    type: 'entry-unblocked',
    now: start + 45_000,
  })
  assert.equal(beforeDeadline.phase, 'working')
  assert.equal(beforeDeadline.cycleStartedAt, start)
  assert.equal(beforeDeadline.backgroundedAt, null)

  const unblockedAt = start + 65_000
  const overdue = reduceRestReminder(state, {
    type: 'entry-unblocked',
    now: unblockedAt,
  })
  assert.equal(overdue.phase, 'due')
  assert.equal(overdue.cycleStartedAt, start)
  assert.equal(overdue.backgroundedAt, null)
  assert.equal(overdue.restStartsAt, null)
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
  assert.equal(shorter.restStartsAt, null)

  values.set(PET_REST_REMINDER_RUNTIME_STORAGE_KEY, JSON.stringify({
    version: 1,
    state: { ...state, phase: 'snoozed', snoozedUntil: null },
  }))
  assert.equal(readRestReminderRuntimeState(50 * 60, start + 60_000, storage), null)
  assert.equal(saveRestReminderRuntimeState(null, storage), true)
  assert.equal(values.has(PET_REST_REMINDER_RUNTIME_STORAGE_KEY), false)
})

test('ends explicit rest at its deadline and pauses or resets foreground activity', () => {
  const start = 1_000_000
  let state = createRestReminderState(50 * 60)
  state = reduceRestReminder(state, { type: 'foreground', now: start })
  state = reduceRestReminder(state, { type: 'deadline', now: start + 50 * 60_000 })
  assert.equal(state.phase, 'due')
  state = reduceRestReminder(state, { type: 'start', now: start + 50 * 60_000 })
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
