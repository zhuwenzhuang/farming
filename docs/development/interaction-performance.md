# Interaction Performance

> Chinese version: [interaction-performance.zh_cn.md](./interaction-performance.zh_cn.md)

Performance diagnostics observe user intent through the existing authoritative
owners. They do not acknowledge Terminal input, replay mutations, change
selection, or own file and Agent state. Browser and server durations use their
own monotonic clocks; wall times align incident windows but are never subtracted
to manufacture one-way network latency.

## Observation state model

One observation is pending until its owner reports completion, failure,
cancellation, supersession, timeout, or a hidden/unobservable presentation.
Every pending observation has a deadline and a bounded retention slot. Late
callbacks cannot complete a replaced observation. Page hiding closes pending
presentation observations instead of counting background-tab throttling as
interactive latency. Diagnostic failure never changes a product result.

Terminal observations distinguish input dispatch, subsequent output, renderer
completion, and a subsequent frame opportunity. Output is only temporally
associated: concurrent output, no-echo programs, IME, and multiple writers
prevent claiming that the next bytes are the typed character. No output is
`unobserved`, not proof of a slow or failed input. A frame opportunity is not a
GPU presentation acknowledgement. The first coverage is Farming Code Terminal
input and Terminal-view Agent switching, Monaco text-file opening and editing,
file saves, and shared workspace / Language Server requests (including tree and
search requests). This does not claim CRT, Chat-message submission, binary
previews, or exact pixel-presentation coverage. Editor observations distinguish model change,
draft propagation, and frame opportunity; programmatic model replacement must
not be counted as typing. File save records the captured revision's result,
not whether a newer draft is clean.

## Cost, privacy, and investigation

Use bounded in-memory observations, sampled ordinary results, complete slow and
failure results subject to explicit capacity limits, and asynchronous bounded
batch persistence. Report discarded records and persistence errors. Never log
keys, commands, file contents, paths, credentials, arbitrary exception messages,
or DOM snapshots. Target labels are page- or server-boot-local opaque hashes. Diagnostics
are Config-owned and owner-only; no external collector receives data.

The browser exposes `window.farmingPerformance.snapshot()` for its last 512
observations. An owner can GET `/api/diagnostics/performance` under the instance's
base path for the server's last 512 retained observations and drop/write-failure
counters. Snapshots also summarize recent completed observations with counts,
outcomes, P50/P95/max, separating browser/server and request kinds. Server-side
browser summaries describe the uploaded sample, not unbiased population
percentiles; hidden and unobserved results do not enter latency percentiles.
The same endpoint accepts bounded browser batches. Read-only shares
cannot read or submit diagnostics. An auth-disabled instance has local owner
semantics, as with its other owner APIs.

The journal is `<config>/logs/performance/interactions.jsonl`, with three previous
segments (`.1` through `.3`), rotating before a batch would exceed 2 MiB. Browser
uploads run at most once a second, 32 records per batch, with no retry after an
uncertain upload. Ordinary observations are sampled 1 in 20; slow observations
(100 ms for typing, 500 ms for browser operations, 200 ms for server workspace
requests, and 50 ms for long tasks) and non-success outcomes bypass sampling,
but remain subject to bounds. Pending traces cap at 128, browser upload queues
at 128, and the server write queue at 256. The ingest allowance is 128 records
per second across the instance. Counters expose loss; this is not a lossless
audit log. No logging I/O is awaited on the input path.

Join Terminal browser/server observations by `id`; join workspace transport
spans by `requestId`. A persisted browser sample also includes its matching
server observation if still retained, even when the server span was fast.
Deduplicate by `(bootId, source, id)` when reading the journal. Server receive
and dispatch offsets describe queue waiting; dispatch to service describes
service completion (for Terminal, the native write RPC, not shell execution).
Server runtime observations every five seconds carry event-loop delay, process
CPU time, heap use and output volume, with bounded per-Agent output groups.
These are context windows, not proof that a particular Agent caused a stall.
Window timestamps can be skewed across machines: use correlated local durations,
not browser-wall-clock minus server-wall-clock subtraction.

Existing business-health probes are recorded as `connection.probe` without
creating additional probes or changing recovery. Their round trip includes
network/proxy transit and scheduling on both endpoints, not pure wire latency.
These low-frequency observations bypass ordinary-success sampling.

Remote browser-to-instance interaction is the primary optimization target.
Local tests establish regressions, not remote acceptance. Compare the same
remote route and foreground workload with and without concurrent Agent work;
report network route, visible surface, workload cardinality, sample count,
latency percentiles and losses. Never point destructive isolated-test cleanup
at a user's live Config. Enabling a new collector on a live instance requires
the normal authorized deployment; a local build does not instrument a remote
server or reconstruct incidents that predate logging.

Investigation compares frontend long tasks and frame wait with server queue,
service, event-loop, socket backlog, and per-Agent output activity in the same
window. Correlation is not attribution. Background work is measured even when
its presentation is hidden. Validation covers bounded overhead, cancellation,
late completion, hidden tabs, persistence failure, and foreground input under
multiple background producers. Fixed geometry and increasing Agent cardinality
are separate from network-dependent end-to-end latency.
