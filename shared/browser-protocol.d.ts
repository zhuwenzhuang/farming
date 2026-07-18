export const PROTOCOL_VERSION: number
export const MIN_PROTOCOL_VERSION: number
export function protocolCompatible(version: number): boolean
export function validateClientMessage(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string }
export function validateServerMessage(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string }
