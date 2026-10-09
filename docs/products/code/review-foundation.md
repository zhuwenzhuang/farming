# Farming Code Review Foundation

> Chinese version: [review-foundation.zh_cn.md](./review-foundation.zh_cn.md)

Farming Review separates the immutable change being reviewed from the reader's
mutable review state. The model is Gerrit-inspired but supports local working
copies, arbitrary Git ranges, and Agent-created historical changes.

## Identity And Ownership

A Review has one stable identity and one or more immutable revisions. A revision
defines a base, a candidate patchset, and an ordered set of file identities.
Review identity includes the canonical workspace and comparison range; display
labels such as `HEAD` are not sufficient identity.

Two independent layers exist:

- the **Diff Snapshot** is read-only evidence of what changed;
- the **Review State** records reviewed files, comments, drafts, and local
  navigation for one exact Review revision.

Changing comparison source or base creates a different identity. Loading
strategy, diff mode, whitespace preference, and context size do not.

Changing identity clears the previous catalog and summary before loading the
new source. Failed loads remain empty with an explicit error; late responses
from the previous identity cannot restore its content.

Repository targets resolve to the canonical top-level directory of the selected
worktree, including when opened from an ordinary subdirectory. Explicit file
paths are relative to that root and are literal identities, never Git patterns.
Nested repositories resolve independently. A shared Git object directory does
not identify a worktree: HEAD, index, and working files belong to the selected
checkout. Directory-limited review requires an explicit path selection.

Revision names are resolved once before admitting a catalog. The browser uses
the returned object IDs and canonical root for all subsequent file, context,
patch, and review-state requests; symbolic names are not revision identities.

## Comparison Sources

Review may compare a working tree, staged changes, a commit, a branch merge
base, an explicit Git range, or an immutable Agent File Changes capture. Source
selection is semantic and must resolve to an exact comparison before the Review
is shown.

Capturing a comparison preserves its source label through refresh, revision-view
changes and reopening. A workspace snapshot is not evidence of an Agent's last
turn. Agent evidence is labeled Agent changes; legacy captures without provenance
use Changes. The comparison menu distinguishes the captured revision from a fresh
working-copy comparison.
Capture accepts both commit and tree bases, including the index tree used by
Unstaged. Both base and candidate objects stay referenced for the Review lineage;
later index changes cannot alter an existing capture.

Source discovery copies the selected worktree index into an isolated temporary
index and pins HEAD. Every index comparison uses that copy; HEAD and the original
index must still match before publication, otherwise the request fails with a
conflict. The comparison-source client retries that explicitly stale read once;
a second conflict remains visible. Reads never refresh the real index. An unmerged index disables Staged
and Unstaged with an explicit reason and unavailable endpoints; commit and branch
comparisons remain usable. Temporary files are released on success and failure.

Source discovery bounds each staged, unstaged, and untracked path enumeration.
An output limit preserves the source's known availability and marks the path
inventory incomplete, so a large untracked area cannot prevent selecting a
commit or staged source. Exact-path consumers treat an incomplete inventory as
unknown; they must not infer a clean path from its absence. Command failure and
timeout remain explicit errors. Review capture separately enforces its selected
scope and complete-file-list contract.
Git directory hints for embedded repositories also make this exact-file
inventory incomplete; they are not passed off as individual file paths.

Selecting a working-copy comparison whose path inventory exceeds its bound
fails explicitly with a request to narrow the scope or choose Staged or a commit;
discovery's partial inventory must never become a partial capture presented as complete.

Historical Agent changes are captured from the structured change evidence that
the Agent produced. Later filesystem edits must not change that historical
Review.

The CLI may open an explicit local Review:

```bash
farming review <git-dir> <old-revision> <new-revision|now>
```

Detached HEAD is supported; a named branch is required only when explicitly
selected with `--branch`.

The resulting Review uses the same identity, comment, reviewed-state, and
loading contracts as Reviews opened from Farming.

## Immutable Revisions

A working-copy Review is captured into an immutable revision before the file
list is presented. Capture must not modify the user's index or worktree. If the
workspace changes during capture and a coherent result cannot be proven,
capture fails visibly and may be retried.

Opening the same canonical worktree, resolved base, source and capture scope
resumes the persisted Review lineage. The backend serializes reopen and refresh
for that identity before capturing: unchanged content returns the existing
revision; changed content appends a revision with the same inheritance rules as
Refresh. Different bases, scopes, path selections and Agent evidence stay
separate. Historical Agent evidence reopens its exact captured revision rather
than the latest workspace revision. Persistence survives process restart; failed
publication cannot advertise a revision before its inherited state is durable.
Legacy captures without source provenance are resumed only where their stored
shape unambiguously identifies a working-copy capture.

Capture transitions from resolving to enumerating, capturing, validating, and
published. Each attempt pins the worktree HEAD and observes its index, enumerates
the selected changes afresh around both captures, and compares the resulting
trees. Only changed paths are materialized over the pinned HEAD tree; unchanged
objects are reused. Updates operate on exact entries, never recursively importing
directory contents or ignored descendants. Observed changes to HEAD, index, path membership, or content
terminate the attempt with a conflict, without publishing a revision or retrying
automatically. This detects concurrent writes; it does not make external writers
transactional. Failure always releases the attempt's temporary index and files.
Git reads and writes have bounded command deadlines and output limits; timeouts
remain explicit timeout errors. Refresh repeats the same protocol.

Refreshing after fixes creates a new revision in the same Review lineage.
Unchanged files may retain reviewed state. Changed files become unreviewed, and
comments whose anchors no longer match become outdated rather than moving to
unrelated lines.
Comment resolution (open/resolved) and anchor validity (current/outdated) are
independent. Resolve and Reopen never change anchor validity or its original
source revision. Further revisions never remap an already outdated anchor.
Legacy outdated statuses are normalized at storage and API boundaries; unresolved
counts include open outdated comments. Failed status writes preserve the prior
state and retry uses the same comment identity.

For a working-copy Review, the requested tracked or untracked scope is applied
during the authoritative Git enumeration before the file limit. A large
untracked area cannot truncate a tracked Review; overflow within the selected
scope remains an explicit capture failure. Rename captures retain both the
previous and current path identities. Selecting either end of a staged rename
also selects its partner, including when the rename crosses a selected directory.
An explicit empty path selection captures no changes. Untracked embedded
repositories must be opened as their own Review instead of captured as files.

Gitlink changes retain their pointer rows and expand into file-level changes
between the exact referenced child commits. Nested paths are qualified by their
submodule path within the parent revision, so comments and reviewed state cannot
collide with parent files. The child checkout supplies Git objects only; later
working edits never replace captured content. Missing repositories or objects,
file limits, and nesting limits remain explicit on the submodule row.

Working-copy captures remain repository-local. Project Changes groups child
repositories separately and opens each child's own immutable capture. Parent
commit-range changes and child uncommitted edits are distinct review scopes.

## File-list-first Loading

The ordered file list is the primary Review navigation. Metadata loads before
expensive inline diffs. Expanding a file loads only that file's content and
merges it into the existing file identity; it must not replace or reorder the
catalog.

Every path is unique within a revision. Rename and copy metadata preserve both
current and previous path identity. Binary, truncated, or too-expensive files
remain reviewable and show an explicit non-inline state rather than an empty
diff.

Hunks carry structured old and new ranges. Display headers are not the
authoritative source for navigation or comments. Special review files may be
shown without contaminating ordinary source-line totals.

## Reviewed State And Comments

Reviewed state is scoped to one Review revision and has set semantics. “Not
loaded” is distinct from “loaded and empty.” Mark-all interactions orchestrate
the same single-file reviewed primitive; they are not an atomic backend batch.

Comments are scoped to Review revision and stable comment identity. Rename-aware
comments retain the appropriate previous or current path. A changed anchor is
preserved as outdated evidence rather than silently attached to new code.

Optimistic updates are allowed, but every asynchronous completion is fenced by
Review identity, revision, path, comment id, and operation type. A stale
response cannot update a newer Review or roll back a newer mutation. After a
partial multi-file failure, the UI reconciles from authoritative reviewed state.

## UI Contract

Review uses one file-list-first workspace. File rows show change type, summary,
reviewed state, comments, and expandable inline diff without duplicating the
same catalog in another panel.

File paths prioritize the basename when space is limited; compact rows show an
abbreviated directory. Current and previous paths retain their full tooltip and
selectable text. Dragging a path selects text without expanding its diff.

The page retains one selected file after opening or collapsing its diff, or
focusing its row controls. Adjacent-file navigation starts from that selection.
Selection uses the shared hover surface and survives scrolling and collapse;
changing comparison or removing the file clears it. Sticky-header visibility
does not replace the user's selected file.
Collapsing a file preserves the clicked header's viewport position, including
when it was sticky. If remaining content is too short, trailing blank space
preserves the scroll position; later content growth reclaims unneeded space.

The comparison menu sizes to commit and branch labels within the viewport and
supports horizontal resizing. Its long-label lists scroll horizontally instead
of truncating source identities, while retaining the shared menu row styling.

Review displays the exact Base (left) and Candidate (right) independently of
comparison presets. Each endpoint can select a commit or the freshly discovered
index tree. Candidate can also capture the latest working tree against the
selected Base. Unstaged means index-to-working-tree, not a separate Git version.
The backend resolves and owns both immutable endpoints. Changing one endpoint
preserves the other, creates a new comparison identity and clears prior content;
nonempty drafts prevent switching. Endpoint menus perform fresh bounded reads,
discard abandoned results, and expose failures. Capturing disables competing
selections until success or explicit failure, without replaying uncertain writes.
Snapshots are labeled as captured revisions with object IDs, never as live
latest state after capture. Reopening preserves the exact pair in the URL.

Diff text uses native selection. Pointer-down chooses the selectable side in a
split diff; copying takes the selected original source text, excluding line
numbers, the opposite side, comments and whitespace visualization glyphs.
Selection remains selected and keeps focus on pointer-up. A selection offers an
explicit comment action (or `c` shortcut); line-number activation opens a line
comment. Only explicit comment activation transfers focus to the editor. A new
pointer selection, Escape or a comparison change dismisses the selection action;
selection alone never creates a draft or writes review state.

Review follows the authoritative Farming Code appearance preference. Its
canvas, controls, syntax, comments, and diff states consume the shared semantic
theme roles; the route must not fall back to a fixed Light skin.

Reviewed actions remain visually quiet until row hover, keyboard focus, or
expansion. Loaded, loading, failed, binary, truncated, and unavailable diff
states are explicit. Common-line gaps expand in bounded ranges without moving
the opposite boundary or discarding the control after failure.

Final change and fixes since the previous revision serve different attention
needs. The complete base-to-current result remains authoritative, while the
incremental view is the default way to understand what changed since the last
Review pass.

### Review Interaction Transitions

- Source discovery is a fresh, bounded read on each menu opening. Selecting a
  live working tree captures it before showing the new catalog. Revision and
  Final change / Fixes since review selectors always identify immutable objects.
- One active comment draft owns its anchor until Save or explicit Discard.
  Navigation cannot overwrite a nonempty draft. Draft text and its stable save
  identity are stored locally per Review revision and restored after reopening.
  Saving freezes the editor; confirmation clears it. Failure retains it, and
  an uncertain outcome requires authoritative reconciliation before editing or
  retrying. A retry retains the same comment identity.
- Reviewed state defaults to automatic marking, with a manual preference. Existing
  explicit preferences are preserved. Automatic marking requires an
  individually opened file, successful diff loading, and authoritative reviewed
  hydration. Once eligible, a file remains queued through collapse while another
  reviewed write completes. Expand all does not mark files reviewed. Unknown write outcomes
  invalidate reviewed status until a successful read restores it.
- Inline diff loads share a four-request budget. Queued requests from an
  abandoned comparison are dropped and late responses cannot update it. Failed
  diffs expose Retry; failed comment/reviewed hydration exposes Reload review
  state. Review HTTP operations have a bounded timeout.
  Changing context or whitespace preferences invalidates cached diffs, including
  collapsed files. Expanded files reload through the same loader; responses from
  superseded preferences cannot replace the current diff or context.
- Source text for metadata and expandable context has a separate 16 MiB per-file
  budget from patch output; a large unchanged source must not fail under the
  smaller patch budget. Oversized text produces an explicit size-limit error.
- File rows expose unresolved/total comment counts and file-mode changes.
  Navigation offers adjacent files, next unreviewed file, changed hunks and
  comments. `[` / `]` navigate files; `p` / `n` navigate changed hunks and Shift
  navigates comments. Text-entry controls retain their native keyboard behavior.
- Comment ranges have a non-destructive text annotation. Refresh maps candidate
  anchors only across unchanged line intervals; overlapping edits remain outdated.
  Original-base comments keep their original coordinates. In Fixes view they are
  shown separately, and new base-side comments require Final change, whose left
  object is the authoritative original base.

## Failure And Recovery

Malformed identities, duplicate paths, inconsistent ranges, and source mismatch
fail at the boundary. A late file load, comment save, reviewed write, or refresh
is ignored when it no longer belongs to the active Review.

Refresh reconciles all path-scoped UI state with the new catalog. Removed or
renamed files cannot leave stale pending loads, selection, comments, or reviewed
writes attached to unrelated rows.

## Acceptance Criteria

Verification must cover working-copy and Git-range identity, symlink-equivalent
workspaces, immutable capture under concurrent writes, revision refresh,
file-list-first loading, rename/copy comments, reviewed-state reconciliation,
partial failures, stale asynchronous completion, binary and truncated files,
split/unified presentation, keyboard navigation, and large Reviews.
