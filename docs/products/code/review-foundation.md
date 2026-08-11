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

## Comparison Sources

Review may compare a working tree, staged changes, a commit, a branch merge
base, an explicit Git range, or an immutable Agent File Changes capture. Source
selection is semantic and must resolve to an exact comparison before the Review
is shown.

Historical Agent changes are captured from the structured change evidence that
the Agent produced. Later filesystem edits must not change that historical
Review.

The CLI may open an explicit local Review:

```bash
farming review <git-dir> <old-revision> <new-revision|now>
```

The resulting Review uses the same identity, comment, reviewed-state, and
loading contracts as Reviews opened from Farming.

## Immutable Revisions

A working-copy Review is captured into an immutable revision before the file
list is presented. Capture must not modify the user's index or worktree. If the
workspace changes during capture and a coherent result cannot be proven,
capture fails visibly and may be retried.

Refreshing after fixes creates a new revision in the same Review lineage.
Unchanged files may retain reviewed state. Changed files become unreviewed, and
comments whose anchors no longer match become outdated rather than moving to
unrelated lines.

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
