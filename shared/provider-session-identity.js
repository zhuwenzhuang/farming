// Generated from TypeScript. Do not edit.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROVIDER_HOME_ID = exports.PROVIDER_SESSION_IDENTITY_VERSION = void 0;
exports.providerSessionIdentity = providerSessionIdentity;
exports.providerSessionIdentityPayload = providerSessionIdentityPayload;
exports.providerSessionIdentityTupleKey = providerSessionIdentityTupleKey;
exports.sameProviderSessionIdentity = sameProviderSessionIdentity;
exports.isProviderSessionIdentityV2Payload = isProviderSessionIdentityV2Payload;
exports.providerSessionKeyFromIdentity = providerSessionKeyFromIdentity;
exports.encodeProviderSessionKey = encodeProviderSessionKey;
exports.decodeProviderSessionKey = decodeProviderSessionKey;
exports.canonicalProviderSessionKey = canonicalProviderSessionKey;
exports.isProviderSessionKeyV2 = isProviderSessionKeyV2;
exports.resumedProviderSessionSourceFromIdentity = resumedProviderSessionSourceFromIdentity;
exports.encodeResumedProviderSessionSource = encodeResumedProviderSessionSource;
exports.decodeResumedProviderSessionSource = decodeResumedProviderSessionSource;
exports.canonicalResumedProviderSessionSource = canonicalResumedProviderSessionSource;
exports.legacyProviderSessionKeyAlias = legacyProviderSessionKeyAlias;
exports.PROVIDER_SESSION_IDENTITY_VERSION = 2;
exports.DEFAULT_PROVIDER_HOME_ID = 'default';
const AGENT_SESSION_KEY_PREFIX = 'agent-session:';
const RESUMED_SOURCE_INFIX = '-history';
const RESUMED_FORK_SOURCE_INFIX = '-history-fork';
// `~` is outside every legal provider, Agent Home, and legacy provider session id
// character class, so a `~2~` payload marker cannot be produced by any legacy
// encoding. `%` is not a delimiter; it is escaped only so the escape mapping stays
// injective for an opaque session id that itself contains `%`.
const V2_PAYLOAD_MARKER = '~2~';
const V2_SEGMENT_DELIMITER = '~';
const LEGACY_KEY_RE = /^agent-session:([^:]+):(.+)$/;
const LEGACY_SOURCE_RE = /^([a-z][a-z0-9_-]*)-history(-fork)?:(.+)$/;
const LEGACY_HOME_PAYLOAD_RE = /^home:([A-Za-z0-9._-]+):(.+)$/;
// The authoritative validators for the identity fields, mirrored from
// backend/agent-session-resume-coordinator.cts and the settings boundary. A
// session id stays opaque here; `isSafeProviderSessionId` owns it at the
// boundaries that accept one.
const PROVIDER_RE = /^[a-z][a-z0-9_-]*$/;
const PROVIDER_HOME_ID_RE = /^[A-Za-z0-9._-]+$/;
function encodeSegment(value) {
    return value.replace(/%/g, '%25').replace(/~/g, '%7E');
}
/**
 * A v2 writer emits exactly `encodeSegment(field)` for an already-trimmed,
 * non-empty field, so that is the only accepted spelling. Requiring the decoded
 * value to re-encode byte-for-byte rejects every sequence no writer can produce —
 * a raw `%`, `%2F`, lowercase `%7e`, a trailing `%`, or padding — instead of
 * canonicalizing it into a tuple nothing wrote.
 */
function decodeSegment(segment) {
    const decoded = segment
        .replace(/%(25|7E)/g, (_match, code) => (code === '25' ? '%' : '~'))
        .trim();
    if (!decoded)
        return null;
    return encodeSegment(decoded) === segment ? decoded : null;
}
function normalizeProvider(provider) {
    return String(provider ?? '').trim().toLowerCase();
}
function normalizeProviderHomeId(providerHomeId) {
    return String(providerHomeId ?? '').trim() || exports.DEFAULT_PROVIDER_HOME_ID;
}
function normalizeSessionId(sessionId) {
    return String(sessionId ?? '').trim();
}
function providerSessionIdentity(provider, sessionId, providerHomeId = exports.DEFAULT_PROVIDER_HOME_ID) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedProviderHomeId = normalizeProviderHomeId(providerHomeId);
    const normalizedSessionId = normalizeSessionId(sessionId);
    if (!normalizedSessionId)
        return null;
    if (!PROVIDER_RE.test(normalizedProvider))
        return null;
    if (!PROVIDER_HOME_ID_RE.test(normalizedProviderHomeId))
        return null;
    return {
        provider: normalizedProvider,
        providerHomeId: normalizedProviderHomeId,
        sessionId: normalizedSessionId,
    };
}
/**
 * Opaque, delimiter-safe representation of the exact tuple. Use it for dedupe
 * sets, ordering maps, and equality instead of joining fields with a colon.
 */
function providerSessionIdentityPayload(identity) {
    return `${V2_PAYLOAD_MARKER}${encodeSegment(identity.providerHomeId)}`
        + `${V2_SEGMENT_DELIMITER}${encodeSegment(identity.sessionId)}`;
}
function providerSessionIdentityTupleKey(identity) {
    return `${encodeSegment(identity.provider)}${V2_SEGMENT_DELIMITER}${providerSessionIdentityPayload(identity)}`;
}
function sameProviderSessionIdentity(left, right) {
    if (!left || !right)
        return false;
    return providerSessionIdentityTupleKey(left) === providerSessionIdentityTupleKey(right);
}
function decodeV2Payload(payload) {
    if (!payload.startsWith(V2_PAYLOAD_MARKER))
        return null;
    const segments = payload.slice(V2_PAYLOAD_MARKER.length).split(V2_SEGMENT_DELIMITER);
    if (segments.length !== 2)
        return null;
    const providerHomeId = decodeSegment(segments[0] ?? '');
    const sessionId = decodeSegment(segments[1] ?? '');
    if (!providerHomeId || !sessionId)
        return null;
    return { providerHomeId, sessionId };
}
/**
 * Legacy payloads are ambiguous: a legal session id may itself start with
 * `home:<segment>:`. Decoding keeps the historical interpretation (Agent Home
 * wins) rather than guessing, so an already-persisted identity keeps resolving
 * to the same tuple it resolved to before v2.
 */
function decodeLegacyPayload(payload) {
    const homeMatch = payload.match(LEGACY_HOME_PAYLOAD_RE);
    const providerHomeId = homeMatch ? String(homeMatch[1]) : exports.DEFAULT_PROVIDER_HOME_ID;
    const sessionId = String((homeMatch ? homeMatch[2] : payload) || '').trim();
    if (!sessionId)
        return null;
    return { providerHomeId, sessionId };
}
function decodePayload(payload) {
    // The marker is unreachable for a pre-v2 writer, so its presence proves the
    // payload is v2. A malformed v2 payload is corrupt, not legacy: reading it as
    // a legacy payload would invent a session id of `~2~...` that no writer can
    // produce and bind durable state to it.
    if (payload.startsWith(V2_PAYLOAD_MARKER))
        return decodeV2Payload(payload);
    return decodeLegacyPayload(payload);
}
function isProviderSessionIdentityV2Payload(payload) {
    return String(payload ?? '').startsWith(V2_PAYLOAD_MARKER);
}
function providerSessionKeyFromIdentity(identity) {
    return `${AGENT_SESSION_KEY_PREFIX}${identity.provider}:${providerSessionIdentityPayload(identity)}`;
}
function encodeProviderSessionKey(provider, sessionId, providerHomeId = exports.DEFAULT_PROVIDER_HOME_ID) {
    const identity = providerSessionIdentity(provider, sessionId, providerHomeId);
    return identity ? providerSessionKeyFromIdentity(identity) : '';
}
function decodeProviderSessionKey(key) {
    const match = String(key ?? '').trim().match(LEGACY_KEY_RE);
    if (!match)
        return null;
    const payload = decodePayload(String(match[2] || '').trim());
    if (!payload)
        return null;
    return providerSessionIdentity(match[1], payload.sessionId, payload.providerHomeId);
}
/**
 * Rewrites any accepted key shape to the v2 key for the same tuple. A v2 key is
 * returned unchanged, so this is safe to apply repeatedly.
 */
function canonicalProviderSessionKey(key) {
    const identity = decodeProviderSessionKey(key);
    return identity ? providerSessionKeyFromIdentity(identity) : '';
}
function isProviderSessionKeyV2(key) {
    const match = String(key ?? '').trim().match(LEGACY_KEY_RE);
    return Boolean(match && isProviderSessionIdentityV2Payload(match[2]));
}
function resumedProviderSessionSourceFromIdentity(identity, options = {}) {
    const infix = options.forked === true ? RESUMED_FORK_SOURCE_INFIX : RESUMED_SOURCE_INFIX;
    return `${identity.provider}${infix}:${providerSessionIdentityPayload(identity)}`;
}
function encodeResumedProviderSessionSource(provider, sessionId, providerHomeId = exports.DEFAULT_PROVIDER_HOME_ID, options = {}) {
    const identity = providerSessionIdentity(provider, sessionId, providerHomeId);
    return identity ? resumedProviderSessionSourceFromIdentity(identity, options) : '';
}
function decodeResumedProviderSessionSource(source) {
    const match = String(source ?? '').trim().match(LEGACY_SOURCE_RE);
    if (!match)
        return null;
    const payload = decodePayload(String(match[3] || '').trim());
    if (!payload)
        return null;
    const identity = providerSessionIdentity(match[1], payload.sessionId, payload.providerHomeId);
    if (!identity)
        return null;
    return { ...identity, forked: match[2] === '-fork' };
}
function canonicalResumedProviderSessionSource(source) {
    const decoded = decodeResumedProviderSessionSource(source);
    return decoded ? resumedProviderSessionSourceFromIdentity(decoded, { forked: decoded.forked }) : '';
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
function legacyProviderSessionKeyAlias(identity) {
    const payload = identity.providerHomeId === exports.DEFAULT_PROVIDER_HOME_ID
        ? identity.sessionId
        : `home:${identity.providerHomeId}:${identity.sessionId}`;
    const alias = `${AGENT_SESSION_KEY_PREFIX}${identity.provider}:${payload}`;
    return sameProviderSessionIdentity(decodeProviderSessionKey(alias), identity) ? alias : '';
}
