# Agent List State Protocol

> Chinese version: [agent-list-state-protocol.zh_cn.md](./agent-list-state-protocol.zh_cn.md)

The Farming backend owns the authoritative Agent list and its list-level
metadata. Browser interfaces consume that state through a snapshot plus delta
protocol; they do not reconstruct missing state from terminal or Chat traffic.

An initial connection, explicit resynchronization, or recovery from delivery
backpressure receives a complete snapshot. Later list changes carry complete
summaries only for changed Agents, removed Agent IDs, and changed list-level
metadata. Terminal output, Chat transcript changes, previews, and activity
updates remain on their Agent-scoped streams.

Browser views declare whether Agent activity is relevant for all Agents, only
the focused Agent, or none. Farming Code keeps all activity while the Projects
sidebar is visible and suspends it in non-Agent views. Farming CRT keeps all
activity on its dashboard and only the focused Agent while a Session is open.
Clients that do not declare a scope retain the compatible `all` behavior.

Activity messages are replaceable absolute projections. A slow `focused`
client retains one pending Agent checkpoint marker. A slow `all` client retains
one pending marker and recovers with one compact authoritative activity
snapshot, without replaying individual updates, the complete Agent state, or
Agent previews. Returning from `focused` or `none` to `all` requests that
snapshot only when the connection actually skipped activity.

Adaptive Agent titles publish an Agent-scoped optimistic patch, then join one
pending durability result per Agent. Repeated titles replace the queued value.
Admission requires the Agent's Create intent to have already established its
persisted session record; title updates never create or claim one implicitly.
The durable metadata read, temporary-file write, and `fdatasync` run through
asynchronous filesystem I/O. A generation check prevents that prepared title
from overwriting a concurrent lifecycle metadata commit; on conflict it rereads
the latest record and retries within a bounded budget. Each retry resolves the
canonical provider-session record again and verifies that its runtime owner is
still the requesting Agent. The accepted result is acknowledged only after
atomic publication. Failure rolls the visible title back when that failed
value is still current, and shutdown drains every accepted title operation.

The backend updates the list projection from exact Agent and collection
mutations. Mutations within the broadcast window are coalesced by Agent ID, so
ordinary delta construction is proportional to the changed working set rather
than the complete Agent inventory. Building the complete Agent payload is
reserved for initial and recovery snapshots, which replace any possibly missed
mutation with current authoritative state.

Every snapshot and delta identifies the backend generation and an increasing
sequence. A client applies only the next sequence in its current generation.
After a restart, sequence gap, or uncertain delivery, it requests a fresh
authoritative snapshot instead of guessing, replaying mutations, or requiring
per-message acknowledgements.
