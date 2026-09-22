/** Budgets leave room for identities, JSON escaping and control acknowledgments. */
export const CHAT_PROMPT_MAX_ENCODED_BYTES = 12 * 1024 * 1024
export const CHAT_ATTACHMENT_MAX_COUNT = 8
export const ACP_HOST_FRAME_MAX_BYTES = 16 * 1024 * 1024
export const ACP_HOST_PENDING_MAX = 256
export const ACP_HOST_CONTROL_RESERVE = 32
export const ACP_HOST_RECOVERY_MAX_EVENTS = 1024
export const ACP_HOST_RECOVERY_MAX_BYTES = 2 * 1024 * 1024
export const COMPOSER_ADMISSION_TIMEOUT_MS = 30_000
