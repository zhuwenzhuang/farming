export const PROVIDER_SESSION_IDENTITY_VERSION = 2
export const DEFAULT_PROVIDER_HOME_ID = 'default'

const AGENT_SESSION_KEY_PREFIX = 'agent-session:'
const RESUMED_SOURCE_INFIX = '-history'
const RESUMED_FORK_SOURCE_INFIX = '-history-fork'

// `~` is outside every legal provider, Agent Home, and legacy provider session id
// character class, so a `~2~` payload marker cannot be produced by any legacy
// encoding. `%` is not a delimiter; it is escaped only so the escape mapping stays
// injective for an opaque session id that itself contains `%`.
const V2_PAYLOAD_MARKER = '~2~'
const V2_SEGMENT_DELIMITER = '~'

const LEGACY_KEY_RE = /^agent-session:([^:]+):(.+)$/
const LEGACY_SOURCE_RE = /^([a-z][a-z0-9_-]*)-history(-fork)?:(.+)$/
const LEGACY_HOME_PAYLOAD_RE = /^home:([A-Za-z0-9._-]+):(.+)$/

// The authoritative validators for the identity fields, mirrored from
// backend/agent-session-resume-coordinator.cts and the settings boundary. A
// session id stays opaque here; `isSafeProviderSessionId` owns it at the
// boundaries that accept one.
const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/
const PROVIDER_HOME_ID_RE = /^[A-Za-z0-9._-]+$/

export interface ProviderSessionIdentity {
  provider: string
  providerHomeId: string
  sessionId: string
}

export interface DecodedProviderSessionSource extends ProviderSessionIdentity {
  forked: boolean
}

function encodeSegment(value: string): string {
  return value.replace(/%/g, '%25').replace(/~/g, '%7E')
}

/**
 * A v2 writer emits exactly `encodeSegment(field)` for an already-trimmed,
 * non-empty field, so that is the only accepted spelling. Requiring the decoded
 * value to re-encode byte-for-byte rejects every sequence no writer can produce —
 * a raw `%`, `%2F`, lowercase `%7e`, a trailing `%`, or padding — instead of
 * canonicalizing it into a tuple nothing wrote.
 */
function decodeSegment(segment: string): string | null {
  const decoded = segment
    .replace(/%(25|7E)/g, (_match, code: string) => (code === '25' ? '%' : '~'))
    .trim()
  if (!decoded) return null
  return encodeSegment(decoded) === segment ? decoded : null
}

function normalizeProvider(provider: unknown): string {
  return String(provider ?? '').trim().toLowerCase()
}

function normalizeProviderHomeId(providerHomeId: unknown): string {
  return String(providerHomeId ?? '').trim() || DEFAULT_PROVIDER_HOME_ID
}

function normalizeSessionId(sessionId: unknown): string {
  return String(sessionId ?? '').trim()
}

export function providerSessionIdentity(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = DEFAULT_PROVIDER_HOME_ID,
): ProviderSessionIdentity | null {
  const normalizedProvider = normalizeProvider(provider)
  const normalizedProviderHomeId = normalizeProviderHomeId(providerHomeId)
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!normalizedSessionId) return null
  if (!PROVIDER_RE.test(normalizedProvider)) return null
  if (!PROVIDER_HOME_ID_RE.test(normalizedProviderHomeId)) return null
  return {
    provider: normalizedProvider,
    providerHomeId: normalizedProviderHomeId,
    sessionId: normalizedSessionId,
  }
}

/**
 * Opaque, delimiter-safe representation of the exact tuple. Use it for dedupe
 * sets, ordering maps, and equality instead of joining fields with a colon.
 */
export function providerSessionIdentityPayload(identity: ProviderSessionIdentity): string {
  return `${V2_PAYLOAD_MARKER}${encodeSegment(identity.providerHomeId)}`
    + `${V2_SEGMENT_DELIMITER}${encodeSegment(identity.sessionId)}`
}

export function providerSessionIdentityTupleKey(identity: ProviderSessionIdentity): string {
  return `${encodeSegment(identity.provider)}${V2_SEGMENT_DELIMITER}${providerSessionIdentityPayload(identity)}`
}

export function sameProviderSessionIdentity(
  left: ProviderSessionIdentity | null | undefined,
  right: ProviderSessionIdentity | null | undefined,
): boolean {
  if (!left || !right) return false
  return providerSessionIdentityTupleKey(left) === providerSessionIdentityTupleKey(right)
}

function decodeV2Payload(payload: string): { providerHomeId: string; sessionId: string } | null {
  if (!payload.startsWith(V2_PAYLOAD_MARKER)) return null
  const segments = payload.slice(V2_PAYLOAD_MARKER.length).split(V2_SEGMENT_DELIMITER)
  if (segments.length !== 2) return null
  const providerHomeId = decodeSegment(segments[0] ?? '')
  const sessionId = decodeSegment(segments[1] ?? '')
  if (!providerHomeId || !sessionId) return null
  return { providerHomeId, sessionId }
}

/**
 * Legacy payloads are ambiguous: a legal session id may itself start with
 * `home:<segment>:`. Decoding keeps the historical interpretation (Agent Home
 * wins) rather than guessing, so an already-persisted identity keeps resolving
 * to the same tuple it resolved to before v2.
 */
function decodeLegacyPayload(payload: string): { providerHomeId: string; sessionId: string } | null {
  const homeMatch = payload.match(LEGACY_HOME_PAYLOAD_RE)
  const providerHomeId = homeMatch ? String(homeMatch[1]) : DEFAULT_PROVIDER_HOME_ID
  const sessionId = String((homeMatch ? homeMatch[2] : payload) || '').trim()
  if (!sessionId) return null
  return { providerHomeId, sessionId }
}

function decodePayload(payload: string): { providerHomeId: string; sessionId: string } | null {
  // The marker is unreachable for a pre-v2 writer, so its presence proves the
  // payload is v2. A malformed v2 payload is corrupt, not legacy: reading it as
  // a legacy payload would invent a session id of `~2~...` that no writer can
  // produce and bind durable state to it.
  if (payload.startsWith(V2_PAYLOAD_MARKER)) return decodeV2Payload(payload)
  return decodeLegacyPayload(payload)
}

export function isProviderSessionIdentityV2Payload(payload: unknown): boolean {
  return String(payload ?? '').startsWith(V2_PAYLOAD_MARKER)
}

export function providerSessionKeyFromIdentity(identity: ProviderSessionIdentity): string {
  return `${AGENT_SESSION_KEY_PREFIX}${identity.provider}:${providerSessionIdentityPayload(identity)}`
}

export function encodeProviderSessionKey(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = DEFAULT_PROVIDER_HOME_ID,
): string {
  const identity = providerSessionIdentity(provider, sessionId, providerHomeId)
  return identity ? providerSessionKeyFromIdentity(identity) : ''
}

export function decodeProviderSessionKey(key: unknown): ProviderSessionIdentity | null {
  const match = String(key ?? '').trim().match(LEGACY_KEY_RE)
  if (!match) return null
  const payload = decodePayload(String(match[2] || '').trim())
  if (!payload) return null
  return providerSessionIdentity(match[1], payload.sessionId, payload.providerHomeId)
}

/**
 * Rewrites any accepted key shape to the v2 key for the same tuple. A v2 key is
 * returned unchanged, so this is safe to apply repeatedly.
 */
export function canonicalProviderSessionKey(key: unknown): string {
  const identity = decodeProviderSessionKey(key)
  return identity ? providerSessionKeyFromIdentity(identity) : ''
}

export function isProviderSessionKeyV2(key: unknown): boolean {
  const match = String(key ?? '').trim().match(LEGACY_KEY_RE)
  return Boolean(match && isProviderSessionIdentityV2Payload(match[2]))
}

export function resumedProviderSessionSourceFromIdentity(
  identity: ProviderSessionIdentity,
  options: { forked?: boolean } = {},
): string {
  const infix = options.forked === true ? RESUMED_FORK_SOURCE_INFIX : RESUMED_SOURCE_INFIX
  return `${identity.provider}${infix}:${providerSessionIdentityPayload(identity)}`
}

export function encodeResumedProviderSessionSource(
  provider: unknown,
  sessionId: unknown,
  providerHomeId: unknown = DEFAULT_PROVIDER_HOME_ID,
  options: { forked?: boolean } = {},
): string {
  const identity = providerSessionIdentity(provider, sessionId, providerHomeId)
  return identity ? resumedProviderSessionSourceFromIdentity(identity, options) : ''
}

export function decodeResumedProviderSessionSource(source: unknown): DecodedProviderSessionSource | null {
  const match = String(source ?? '').trim().match(LEGACY_SOURCE_RE)
  if (!match) return null
  const payload = decodePayload(String(match[3] || '').trim())
  if (!payload) return null
  const identity = providerSessionIdentity(match[1], payload.sessionId, payload.providerHomeId)
  if (!identity) return null
  return { ...identity, forked: match[2] === '-fork' }
}

export function canonicalResumedProviderSessionSource(source: unknown): string {
  const decoded = decodeResumedProviderSessionSource(source)
  return decoded ? resumedProviderSessionSourceFromIdentity(decoded, { forked: decoded.forked }) : ''
}

/**
 * Reproduces the pre-v2 spelling of a key. Read-only: it exists so a caller can
 * find state persisted by an older build under the old spelling. Never persist
 * this shape — new writes are always v2.
 *
 * Returns '' when the pre-v2 spelling is ambiguous. A default-Home session id
 * shaped like `home:<homeId>:<rest>` reproduces the string that historically
 * meant the Home-scoped tuple, and that tuple owns the alias, so the colliding
 * default-Home session must not claim it.
 */
export function legacyProviderSessionKeyAlias(identity: ProviderSessionIdentity): string {
  const payload = identity.providerHomeId === DEFAULT_PROVIDER_HOME_ID
    ? identity.sessionId
    : `home:${identity.providerHomeId}:${identity.sessionId}`
  const alias = `${AGENT_SESSION_KEY_PREFIX}${identity.provider}:${payload}`
  return sameProviderSessionIdentity(decodeProviderSessionKey(alias), identity) ? alias : ''
}
