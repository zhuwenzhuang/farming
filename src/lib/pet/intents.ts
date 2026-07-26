export type PetIntent =
  | { kind: 'onboarding'; step: 'invitation' | 'appearance' }
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
