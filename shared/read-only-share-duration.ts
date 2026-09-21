export const DEFAULT_READ_ONLY_SHARE_HOURS = 24
export const MIN_READ_ONLY_SHARE_HOURS = 1
export const MAX_READ_ONLY_SHARE_HOURS = 168

export function validReadOnlyShareHours(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_READ_ONLY_SHARE_HOURS && value <= MAX_READ_ONLY_SHARE_HOURS
}

export function normalizeReadOnlyShareHours(value: unknown): number {
  return validReadOnlyShareHours(value) ? value : DEFAULT_READ_ONLY_SHARE_HOURS
}
