export type PetNotificationIntent = {
  kind: 'notification'
  notification: 'rest-reminder-setup'
  option: 'invitation' | 'appearance'
}

export type PetIntent =
  | PetNotificationIntent
  | {
    kind: 'capability'
    capability: 'rest-reminder'
    phase: 'due'
    restStartsAt: number
  }
  | {
    kind: 'capability'
    capability: 'rest-reminder'
    phase: 'resting'
    restUntil: number
  }

export function resolvePetNotificationIntent(
  restReminderIntervalSeconds: number | null,
  restReminderSetupOption: 'appearance' | null,
): PetNotificationIntent | null {
  if (restReminderSetupOption === 'appearance') {
    return {
      kind: 'notification',
      notification: 'rest-reminder-setup',
      option: 'appearance',
    }
  }
  if (restReminderIntervalSeconds === null) {
    return {
      kind: 'notification',
      notification: 'rest-reminder-setup',
      option: 'invitation',
    }
  }
  return null
}
