# Agent List State Protocol

> Chinese version: [agent-list-state-protocol.zh_cn.md](./agent-list-state-protocol.zh_cn.md)

The Farming backend owns the authoritative Agent list and its list-level
metadata. Browser interfaces consume that state through a snapshot plus delta
protocol; they do not reconstruct missing state from terminal or Chat traffic.

An initial connection, explicit resynchronization, or recovery from delivery
backpressure receives one complete logical snapshot through progressive pages.
On initial load, the first bounded page can render immediately. During recovery,
the client retains its last complete inventory while it assembles the replacement
snapshot, then swaps to the exact authoritative inventory at completion;
following pages carry the same snapshot ID, generation, and sequence and append
at an exact offset. A client accepts list deltas only after the page marked
complete reaches the declared total. A missing, reordered, mismatched, or
interrupted page requests a new authoritative snapshot whose first page
replaces the partial result. Each partial page has a bounded next-page deadline.
The first page also carries authoritative per-Project Agent totals, active and
unread counts, Zombie counts, and maximum attention score for the same snapshot
sequence. Code uses those aggregates only while the individual inventory is
incomplete; after completion, ordinary Agent and live-state updates remain the
authoritative source for continuously changing row state. During recovery, the
new aggregate header may therefore be shown alongside rows from the previously
completed inventory until the replacement inventory completes; this bounded
mixed view preserves supervision coverage without treating stale rows as the
new snapshot.
The Server yields after the first page and pauses later pages while that
client's transport buffer is above the state threshold. List mutations during
delivery are held in a bounded per-client sequence and drain after the final
page. Overflow falls back to one fresh authoritative snapshot instead of
allowing unbounded memory growth or sequence gaps. Later list changes carry
complete summaries only for changed Agents, removed Agent IDs, and changed
list-level metadata.
Terminal output, Chat transcript changes, previews, and activity updates remain
on their Agent-scoped streams.

Browser views declare whether Agent activity is relevant for all Agents, only
the focused Agent, or none. Farming Code keeps all activity while the Projects
sidebar is visible and suspends it in non-Agent views. Farming CRT keeps all
activity on its dashboard and only the focused Agent while a Session is open.
Clients that do not declare a scope retain the compatible `all` behavior.

Agent list deltas have an independent per-browser `all` or `focused` scope.
Farming CRT uses `focused` while one Session is open. The browser still receives
every global list sequence: a mutation for the focused Agent carries that Agent,
while an unrelated mutation carries an empty checkpoint plus any changed
list-level metadata. This preserves exact-predecessor checks without sending or
applying unrelated Agent records. Changing the focused target or returning to
`all` requires a fresh authoritative snapshot before broad supervision resumes.
Initial and recovery snapshots remain complete, and clients that do not declare
this scope retain `all` delivery. Agent-scoped `agent-update` and `agent-read`
messages follow the same scope; the authoritative snapshot reconciles updates
intentionally skipped while focused. Off-target Agent records retained from the
last complete snapshot are hidden and intentionally stale during focused scope;
they are not current-state evidence until the next `all` snapshot completes.

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
reserved for initial and recovery snapshots, which are sent in bounded pages
and replace any possibly missed mutation with current authoritative state. The
first page includes the Main Agent so client startup cannot mistake a later
page for a missing Main runtime.

Every snapshot and delta identifies the backend generation and an increasing
sequence. A client applies only the next sequence in its current generation.
After a restart, sequence gap, or uncertain delivery, it requests a fresh
authoritative snapshot instead of guessing, replaying mutations, or requiring
per-message acknowledgements.
