# Provider Session Durable Identity

> Chinese version: [provider-session-identity.zh_cn.md](./provider-session-identity.zh_cn.md)

A Provider Session is the unit of work a user resumes, pins to the main page,
and recognizes across Chat and Terminal, Code and CRT, and across restarts. Its
identity is the exact tuple:

```text
(provider, providerHomeId, sessionId)
```

`providerHomeId` is always part of the identity. The same `sessionId` under two
Agent Homes is two different sessions, and the default Home is written
explicitly rather than implied by omission.

## Ownership

`shared/provider-session-identity.ts` is the single owner of the encoding. The
backend, Farming Code, and Farming CRT all resolve identity through it, so a key
produced by one interface is byte-identical to the key produced by another for
the same tuple. CRT is bundled as a classic script and cannot import shared
modules, so it carries an inline mirror; a test asserts byte-identical output
against the shared codec rather than trusting the copy.

No other module may build or parse these strings by concatenating or splitting
on `:`.

## Encoded Forms

Two durable strings carry the identity.

The **provider session key** identifies a session in durable membership,
authoritative session records, browser handles, DOM keys, and browser-local
state:

```text
agent-session:<provider>:~2~<providerHomeId>~<sessionId>
```

The **resumed source** records that an Agent was started by resuming an exact
session:

```text
<provider>-history:~2~<providerHomeId>~<sessionId>
<provider>-history-fork:~2~<providerHomeId>~<sessionId>
```

A fork starts a new Provider Session, so a fork source never claims the origin
session. Reading the origin tuple out of a fork source is a display-only
operation with an explicit non-claim parser; every claim, handle, and alias helper
resolves a fork source to nothing.

`~2~` is the version marker and `~` separates the segments. Within a segment, `%`
is written `%25` and `~` is written `%7E`; those two uppercase escapes are the
whole grammar. A segment is accepted only when re-encoding its decoded value
reproduces the segment byte-for-byte, so every segment round-trips exactly, no
payload can contain the delimiter, and a spelling no writer can produce — a raw
`%`, `%2F`, a lowercase `%7e`, an incomplete or trailing `%` sequence, a double
escape, or a padded segment — fails closed instead of being decoded as-is and then
canonicalized into a different string. A session id may legally contain `:`, and it
needs no escaping.

The provider and the Agent Home id are validated against the authoritative
charsets — `[a-z][a-z0-9_-]*` and `[A-Za-z0-9._-]+`, the same classes the resume
boundary and settings boundary enforce — while encoding and while decoding, so an
illegal field can neither enter a durable key nor be read back out of one. The
session id stays opaque here; `isSafeProviderSessionId` owns it at the boundaries
that accept one.

The outer `agent-session:<provider>:` prefix is preserved because existing
boundaries — settings validation, the session index, and browser search targets
— depend on it.

## Why The Version Marker Exists

The pre-v2 encoding folded the Agent Home into the session id, writing
`agent-session:<provider>:home:<homeId>:<sessionId>` when the Home was not
`default`. Because a session id may legally contain `:`, that spelling is
ambiguous: session `home:work:x` under the default Home and session `x` under
Agent Home `work` produce exactly the same string. The same ambiguity existed in
the resumed source and in the browser handle. Two distinct sessions could
therefore share one durable identity, one main-page entry, and one claim.

`~` is outside every legal provider, Agent Home, and pre-v2 session id character
class. A `~2~` payload is therefore unreachable by any pre-v2 writer, which makes
version detection exact instead of heuristic. `%` carries no such claim: it is not
a delimiter, an opaque session id may contain it, and it is escaped only so the
escape mapping stays injective.

## Compatibility

Every new write is v2. Decoding accepts v2 and both pre-v2 spellings.

Because the marker is unreachable for a pre-v2 writer, a payload carrying it is a
v2 payload. A malformed v2 payload is corrupt, not legacy, and decoding fails
closed: it is never reinterpreted as a pre-v2 payload, which would invent a
session id of `~2~…` and bind durable state to a tuple no writer produced.

A pre-v2 payload is genuinely ambiguous, and decoding does not guess: the
`home:<segment>:` prefix wins, which is the reading the old decoders used. An
identity persisted before v2 therefore keeps resolving to the same tuple it
resolved to before, and no unprovable interpretation is invented. The Home-scoped
tuple consequently owns that spelling: a pre-v2 alias is reproduced for lookup
only when it decodes back to the same tuple, so the colliding default-Home
session has no alias and cannot adopt the other session's state.

Identity resolution is tuple-exact everywhere it matters. Active claim,
membership order, unclaimed-session listing, and de-duplication compare decoded
tuples or canonical v2 keys, never colon-joined strings. A pre-v2 key or source
still claims its tuple, and a client that still holds a pre-v2 key still
resolves, pins, and removes the same session.

## Migration

The authoritative session store canonicalizes on both read and write:

- Durable main-page membership is canonicalized and de-duplicated by tuple when
  the index is written, including at startup. A pre-v2 alias and its v2 key
  collapse into one entry, so migration cannot produce a duplicate row.
- A session record hands callers the canonical key, and the next canonical write
  persists it. The pre-v2 spelling on disk is replaced rather than aliased.
- Record lookup, membership removal, and agent binding accept either spelling and
  resolve the same record.

A persisted index may hold both spellings for one tuple. Collapsing them must not
depend on persisted key order, so precedence is explicit: a v2-spelled binding
outranks a pre-v2 alias, because only a v2 build writes it. When two equally
authoritative spellings name different records the binding is dropped and the
startup reconcile pass rebuilds it from the authoritative records; when two
records claim the same tuple, startup fails rather than picking one.

Browser-local state is keyed by the handle, so a stored pre-v2 handle is upgraded
on load (session display state) or resolved through the existing alias mechanism
(composer drafts). Changing the handle does not discard a user's pins or drafts.
Stored display state can hold a pre-v2 alias and its v2 key for the same tuple, so
loading groups entries by tuple rather than by property order and applies the same
explicit precedence: the v2 spelling wins, and two equally authoritative spellings
that disagree drop that pin or archive override instead of letting the last
property win, leaving the session on its authoritative state.

The handle is opaque. URL parameters, DOM attributes, and React keys may change
shape between versions; product behavior may not.

### Rollback

The session index and the settings key list keep their existing shape and
version, so an older build still parses them. It cannot resolve a v2 key: it has
no version marker, so it reads the whole `~2~<providerHomeId>~<sessionId>` payload
as one opaque default-Home session id. That id contains `~`, which the resume
boundary's session-id charset refuses, so the membership entry names a session the
older build cannot find and its auto-resume is skipped rather than restoring the
session. For that build the session has no main-page row and no record binding,
and the real session reappears as an unclaimed history session.

Resuming that history session on the older build is a mutation, and it is not
reversible by simply upgrading again: the older build cannot see the existing v2
record, so it writes a second, pre-v2-spelled record for the same tuple. Coming
back to a v2 build, startup finds two records claiming one tuple and fails
instead of picking one, so a human must decide which record survives. Pinning or
archiving an affected session on the older build likewise writes pre-v2 state
that the v2 build must reconcile.

An operator-initiated downgrade of a live Config is therefore supported for
reading an affected instance, not for mutating it. A read-only downgrade destroys
nothing and the v2 build resolves membership and bindings from the same records
when it runs again; a downgrade that resumes or re-pins an affected session needs
manual reconciliation first. Farming does not promise an unconditional restore
when an operator points an older build at state already committed by a newer one.

Transactional remote deployment does not perform that kind of downgrade. It
checkpoints the stopped Config before activating a new image and lets the new
image migrate a working copy. A failed activation restores both the previous
image and the pre-activation Config checkpoint, so the older image never reads
v2 state created during the failed deployment. Readiness success commits the
working copy and discards the checkpoint.

Farming does not write a pre-v2 alias to make v2 state legible to an older
build. The pre-v2 spelling is ambiguous, so double-writing it would reintroduce
the collision this identity exists to remove.

## Verification

The identity codec owns these acceptance criteria:

- The exact collision pair — default-Home session `home:work:x` versus session
  `x` under Agent Home `work` — produces different keys, sources, and handles,
  and each round-trips to its own tuple.
- Arbitrary session ids round-trip exactly, including ids containing `:`, `~`,
  `%`, and a spoofed `~2~` prefix. An identity whose fields contain a literal `%`
  or `~` re-encodes byte-for-byte after decoding. An illegal provider or Agent
  Home id is refused on encode and on decode rather than reaching a durable key.
- A segment carrying a percent sequence no writer emits — a raw `%`, `%2F`, a
  lowercase `%7e`, an incomplete or trailing `%` sequence, a double escape, or a
  padded segment — fails closed in every decoder, including the CRT mirror, rather
  than canonicalizing into a different string.
- A payload carrying the version marker but not parsing as v2 fails closed in
  every decoder, including the CRT mirror.
- Both pre-v2 spellings decode to their historical tuple, and a fork source
  decodes as forked. The ambiguous pre-v2 alias is offered only to the
  Home-scoped tuple that historically owned it.
- CRT output is byte-identical to the shared codec.
- A frontend handle equals the backend key for the same tuple.
- Startup migration rewrites a pre-v2 membership entry to v2 without creating a
  second entry; remember and remove accept either spelling.
- An index holding both spellings for one tuple resolves to the v2-spelled
  binding regardless of persisted key order; equally authoritative spellings that
  disagree are dropped, and two records claiming one tuple fail startup.
- A pre-v2 key, a pre-v2 source, and the provider/session/home fields each claim
  their own tuple and never the colliding one.
- A pending fork — a live Agent carrying only a fork source, before its own
  provider session id exists — claims nothing in Code or CRT: no main-page
  handle, no session-row claim, no composer key or alias for the origin, and the
  origin session stays listed and resumable. A fork row may still display the
  origin id, through the explicit non-claim parser.
- Browser-local display state loads the same way in either persisted property
  order: a pre-v2 alias and its v2 key collapse into one promoted entry, the v2
  spelling decides a pin or archive override, and two equally authoritative
  spellings that disagree drop the override.
