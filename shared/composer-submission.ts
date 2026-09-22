export const COMPOSER_SUBMISSION_PHASES = ['received', 'queued', 'preparing', 'waiting-turn', 'dispatching', 'submitted', 'failed', 'unknown'] as const
export type ComposerSubmissionPhase = typeof COMPOSER_SUBMISSION_PHASES[number]
export interface ComposerSubmissionStatus {
  phase: ComposerSubmissionPhase
  updatedAt: number
  message?: string
}
