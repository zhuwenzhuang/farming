# Language Tooling, Execution, And Debugging

> Chinese version: [language-tooling-design.zh_cn.md](./language-tooling-design.zh_cn.md)

Status: design proposal; runtime and UI implementation are not yet delivered.
The existing [Language Server](language-server.md),
[Terminal state protocol](terminal-state-protocol.md), and
[Extension model](extension-model.md) remain authoritative for shipped behavior.

## Product Outcome

Opening a supported file should provide useful structural coloring immediately,
discover its language project and environments, and offer Run and Debug without
requiring the user to construct shell commands. Python is the first complete
implementation. Language support must remain usable when one optional service
is unavailable.

Zero configuration is the default acceptance path: with a compatible existing
project environment, opening a file and clicking Run or Debug must work without
selecting an interpreter, creating a launch profile, writing JSON, or entering
a command. Discovery must apply its recommendation automatically, not merely
populate a picker. Overrides are optional and never part of normal onboarding.
Missing Farming-owned analysis/debug tools are prepared automatically within
their lifecycle contract, with visible progress rather than setup instructions.

The first acceptance scenario is a Python package inside a nested assignment
directory, with an interpreter in an ancestor's `.venv`, a module entry point,
command-line arguments, and a loop that can be stopped and stepped through.
Project detection does not prove dependencies are installed or a program will
complete successfully.

## Reference Behavior And Deliberate Differences

The Zed reference is commit `bc6dd34d4c91632680df02355c2381c5f53ea73f`.
The following are behavioral observations, not a promise of Zed feature parity.

| Layer | Zed behavior | Farming design |
| --- | --- | --- |
| Language recognition | File names, extensions, shebangs, language configuration | Language adapter supplies recognition; preserve explicit editor overrides |
| Structural understanding | Tree-sitter queries drive coloring, outlines, indentation, brackets, injections, and runnable locations | Retain Monaco; introduce a bounded worker-based structural provider for Python, reusable by other grammars |
| Semantic services | LSP supplies diagnostics, navigation, completion, rename, actions, and optional semantic tokens | Reuse the existing managed LSP path; first delivery focuses on reading aids and environment alignment |
| Python services | Defaults to basedpyright and Ruff, with separate analysis and formatting responsibilities | One analysis service first; formatting and editing actions remain separate capabilities |
| Environment | Per-subproject toolchains, automatic recommendations, manual selection, remote-host discovery | Backend-owned environment selection per Config, workspace, language, and subproject |
| Execution | Structural queries identify entry points and tests; tasks resolve arguments and environment | A typed target resolves once and feeds both Run and Debug |
| Debugging | Generic DAP client, language adapters, contextual scenarios, integrated terminal, breakpoint and variable UI | Generic DAP session service plus Python debugpy adapter, using the native PTY host |
| REPL | Jupyter kernel discovery, inline output, cells, kernel installation | A separate future capability; not a dependency of Run or Debug |

Zed's default `semantic_tokens` is `off`. Its rich Python coloring therefore
cannot be reproduced merely by installing Pyright. Structural coloring and
semantic analysis have different ownership, latency, and failure behavior.

Zed discovers Python environments through Python Environment Tools locators,
ranks them by project proximity and environment kind, and shares the selected
toolchain with language services, tasks, and new terminals. Its manifest search
can prefer an ancestor with a lockfile. Its default module task also derives a
module name from a relative path; neither behavior proves arbitrary nested or
`src` layouts will execute correctly.

The REPL picker recommends the environment matching the selected toolchain.
An environment missing `ipykernel` can still run scripts and use debugpy. Zed
can install ipykernel when such an environment is selected. Farming's first
delivery does not need kernels or modifications to project dependencies.

Reference evidence: Zed's [toolchains](https://github.com/zed-industries/zed/blob/bc6dd34d4c91632680df02355c2381c5f53ea73f/docs/src/toolchains.md),
[Python adapter](https://github.com/zed-industries/zed/blob/bc6dd34d4c91632680df02355c2381c5f53ea73f/crates/languages/src/python.rs),
[Python grammar queries](https://github.com/zed-industries/zed/tree/bc6dd34d4c91632680df02355c2381c5f53ea73f/crates/grammars/src/python),
[default settings](https://github.com/zed-industries/zed/blob/bc6dd34d4c91632680df02355c2381c5f53ea73f/assets/settings/default.json),
[debugger](https://github.com/zed-industries/zed/blob/bc6dd34d4c91632680df02355c2381c5f53ea73f/docs/src/debugger.md),
and [REPL](https://github.com/zed-industries/zed/blob/bc6dd34d4c91632680df02355c2381c5f53ea73f/docs/src/repl.md).
Zed is primarily GPL-3.0-or-later with separately marked components. This design
references behavior and standard protocols; it does not copy Zed implementation
or query files. Grammar/runtime dependencies require their own license review.

## Open-File Experience

1. Show the file immediately with local syntax coloring. Start bounded project
   and environment discovery in parallel with structural parsing.
2. Show a compact environment control, for example `Python 3.12 · .venv`.
   Its picker lists version, kind, path, recommendation reason, and unavailable
   reasons. A fresh read occurs when the picker opens; refresh and manual
   executable selection are optional. Apply the best compatible recommendation
   automatically; multiple listed environments alone do not require a choice.
3. Offer Run and Debug in the editor header. A recognized `__main__` entry also
   gets a gutter action. Primary Run/Debug actions launch the inferred target
   directly. Target options are a secondary action, not a mandatory dialog.
   Breakpoint clicks have a separate hit target from runnable actions.
4. Save modified open files in the affected language project before launch.
   A save conflict or newer edit during preparation blocks that launch. Label
   the action as saving and running/debugging; never run an unnoticed old copy.
5. Open an editor tool dock containing the task terminal. Debugging adds
   Continue/Pause, Step Over, Step Into, Step Out, Stop, stack, and lazy variables.
   Stopping at a breakpoint reveals the source and marks the execution line.
6. Keep the target, environment, arguments, and working directory inspectable.
   A completed task retains its exit status and terminal output; rerun creates
   a new execution identity.

The dock uses shared tool-window geometry, menus, focus arbitration, themes,
and disabled/loading/error states. At narrow widths it moves below the editor.
It must compose with the language navigation dock and Agent side pane, keeping
one selected tool body rather than stacking competing full-size panels. Closing
the dock or switching files changes presentation, not process lifetime.
Keyboard commands are scoped to the editor/debug surface and respect Monaco,
terminal input, IME, and shared Escape handling.

## Architecture And Ownership

```text
Monaco model ── structural worker ── colors / runnable locations
     │
     └── editor actions and tool dock
                  │ authenticated, versioned contracts
                  ▼
        Language tooling orchestration
        project context / environment / target resolution
             │                 │                 │
       existing LSP      execution service    DAP service
             │                 │                 │
       language server         └── native PTY ────┘
                                               debug adapter
```

Language tooling is a built-in Extension capability. The backend owns discovery,
selection, launch admission, session lifecycle, and capabilities. The browser
owns the unsaved editor model, parser projections, and presentation. Browser
runnable locations are hints; the backend validates the saved target before
execution. LSP and DAP are separate protocols and process owners.

There are four minimum contracts:

- **Language context:** language, authorized workspace root, subproject root,
  manifest evidence, environment selection revision, and available capabilities.
- **Environment:** stable selection identity, launch executable path, environment
  prefix, version, kind, discovery source, compatibility, and probe status.
- **Target:** file/module/test identity, source revision, arguments, working
  directory, environment reference, and explicit launch strategy.
- **Execution:** exact resource owner, session id and epoch, immutable resolved
  target, terminal id, state revision, outcome, and optional debug adapter state.

Adapters contribute recognition, project/environment discovery, target
resolution, analysis configuration, and debug launch translation. Contributions
are optional and typed; capabilities must distinguish unsupported, preparing,
available, and failed. Generic UI and lifecycle code must not branch on Python
names or accept an arbitrary browser-supplied executable or DAP request.
This is an internal adapter boundary, not a new public plugin SDK.

Reuse the existing LSP manager and runtime preparation facilities. A tooling
coordinator must not become a second LSP manager. For Python, evaluate
basedpyright as the managed default, including its actual semantic-token
capabilities; retain explicit existing server configuration with visible
capability differences. Never run competing analysis servers implicitly.
Ruff formatting, refactoring, completion, and live draft LSP synchronization
are follow-up capabilities rather than prerequisites for this workflow.

## Project And Environment Resolution

The authorized workspace boundary, language project root, environment prefix,
module import root, and execution working directory are distinct values.
Discovery walks ancestors only within the authorized workspace and reads
manifest metadata without executing project scripts. The global read-only file
browser does not gain execution authority merely by opening a file.

Python discovery initially covers `.venv`/`venv` in relevant ancestors, explicit
selection, inherited environment candidates, and host Python executables.
Version constraints and workspace membership inform ranking. uv, Poetry, Conda,
and other managers may contribute bounded locator adapters; unavailable locators
are reported rather than treated as evidence that no environment exists.
Do not recursively scan the user's home or create an environment during discovery.

Selection priority is: a still-valid explicit choice; a compatible environment
associated with the declared project/workspace; nearest compatible ancestor
environment; compatible host candidates. Deterministic tie-breaking does not
hide equally plausible project choices. Persist selection under Config + root +
language + subproject. A disappeared explicit selection becomes unavailable;
it must not silently switch the next run to another interpreter.

Automatic selection and a user override have distinct provenance. Refresh may
recompute an automatic recommendation but cannot replace an explicit override.
List alternatives and explain the selected default without interrupting normal
execution. Request a decision only when conflicting evidence prevents resolving
a valid target or when a required user-specific value has no default.

Probe candidates with bounded concurrency, output size, and deadlines. A venv
interpreter can be a symlink to a shared base binary: retain the invocation path
and environment prefix. Deduplicating only by executable realpath would merge
different virtual environments incorrectly. Tool executables outside the
workspace are validated separately from workspace source-file authorization.

The selected environment configures language analysis and new launches. Changing
it invalidates affected analysis bindings and target resolutions, with generation
fencing. Already-running sessions retain their immutable launch environment.
An unsupported interpreter can still be listed with the precise unsupported
capability; debugpy compatibility must not be inferred from version labels alone.

## Python Targets And Dependency Preparation

Recognize standalone files and package module entry points from syntax and
manifest/package evidence. Support common package and `src` layouts explicitly.
Use module execution when the import root is established and direct file
execution for an established standalone script. Exhaust supported manifest and
package conventions before asking for missing information; only unresolved
layouts need a focused correction, not a generic configuration wizard.
Do not guess module names from Git paths or run package imports for discovery.

For example, `assignments/basics/example_pkg/bpe.py` can resolve to module
`example_pkg.bpe`, cwd `assignments/basics`, and an ancestor `.venv/bin/python`.
Default execution uses the program's own defaults with no extra arguments.
Reuse arguments from an applicable existing project task when explicitly
running that task. Optional arguments such as `--trace` can be added through
secondary target options and remembered, but are not required for Run/Debug.
The editor must not invent application-specific arguments from an entry glyph.

Direct execution of a selected interpreter and `uv run --frozen` are distinct
strategies. `--frozen` prevents lockfile updates but can still prepare/synchronize
an environment. Opening a file must not trigger that operation. Recognize uv
projects from supported project metadata without asking users to write a uv
command. A uv target has a visible preparation phase and binds Run and Debug to the same
resolved interpreter, arguments, environment, and cwd. Missing dependencies
produce actionable output; silently switching interpreters is not recovery.

Run and Debug consume one resolved target. Debug translates its file/module
entry into debugpy configuration; it does not independently guess the command.
Arguments are arrays and environment values stay private. Shell commands remain
an explicit separate target type; do not parse arbitrary Bash into Python DAP.

Farming-owned analysis/debug tools live in verified, versioned private artifacts,
separate from project dependencies. Tool installation has bounded progress,
integrity verification, atomic publication, and exact staging cleanup. Fixed
artifacts follow the package-image installation contract; optional on-demand
tools follow an explicitly documented extension preparation contract. Debugpy
must be tested with the target interpreter without installing it into the
project environment. Python itself remains a host/project prerequisite.
When no usable environment exists, report the actual missing prerequisite and
offer a supported preparation action with progress. Do not replace that recovery
with a request to write launch configuration.

## Coloring And Model Revisions

### Presentation Comes First

The first visible milestone is a richer, stable reading experience immediately
after opening Python, independently of execution and debugging. Match Zed's
information hierarchy while preserving Farming's visual language.

The current Python lexer primarily categorizes identifiers through a keyword
list and an `identifier` catch-all. Functions, ordinary methods, keyword argument
names, attributes, and user-defined types therefore usually share the default
text color. Current theme overrides provide type/function/variable/enum roles,
but a function palette cannot color tokens that never arrive as functions.
Basic coloring exists; the issue is insufficient classification, not proof
that the model is plain text or that Monaco cannot render richer information.

The existing LSP semantic-token, hover, highlight, and inlay providers are
already present. They need a live server that supplies the requested capability,
and currently apply only to saved files. The missing Python server makes that
additional layer unavailable. Installing it alone does not fix the structural
layer, and enabling semantic highlighting does not manufacture semantic tokens.

For a representative expression such as
`parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)`, use the
following information roles; roles need not all have unique colors:

| Information | Presentation contract | Evidence source |
| --- | --- | --- |
| Keywords and control flow | A consistent keyword accent | Local syntax |
| Function definitions and calls | A shared callable family, including method calls | Local syntax; LSP can refine symbol identity |
| Types and annotations | A distinct type family | Explicit syntax; inferred/imported types need semantic evidence |
| Properties and keyword arguments | Distinguishable from the receiver/local variable | Local structural context |
| Constants and built-ins | Consistent constant/builtin roles | Literal syntax or declared naming convention; LSP may refine |
| Strings and f-strings | String text keeps its role; interpolation is parsed code with distinct delimiters | Local syntax |
| Locals, punctuation, comments | Neutral readable body text, restrained punctuation, legible secondary comments | Local syntax and shared theme |

Uppercase naming is a coloring convention, not proof that a Python value is
immutable. A call expression identifies a callable position, not the resolved
function's type. Reserve type signatures, documentation, inferred types,
diagnostics, and symbol identity for language-service evidence.

Structural context also needs presentation: extend path breadcrumbs with the
current class/function, reuse parsed ranges for folding and active scope guides,
and reuse the existing symbol navigation surface for an on-demand outline.
The current breadcrumb only renders file-path segments. Retain current Monaco
guides/folding where they already work; improve their source rather than adding
duplicate decorations. These projections share the same current model revision.

Use a small semantic palette across Light, Dark, and Paper. Do not copy Zed's
literal colors or assign a bright color to every variable. Keep selection,
occurrence highlights, diagnostic underlines, and the future execution line
legible together. Inlay hints remain secondary and capability-driven; do not
display guessed type labels to make the editor appear richer.

Verify classification and rendered color separately on the same representative
Python sample. Opening, typing, saving, and switching files must preserve local
structural richness with the LSP stopped. Check nested calls, decorated and
multiline definitions, f-string expressions, Unicode, incomplete syntax, and
scope breadcrumbs in all three themes. Then verify that supported LSP details
add accurate information without changing the base palette or reviving stale
tokens. A visual comparison must use matching code and viewport, not just two
unrelated editor screenshots.

### Structural Provider Integration

Keep Monaco as the editor. The proposed Python structural provider uses a
version-pinned Tree-sitter grammar in a lazy browser worker, with independently
authored mappings to shared theme token roles. Validate its Monaco token bridge,
incremental edits, UTF-8/UTF-16 conversion, worker disposal, size limits, and
package/CSP behavior before committing to that dependency. Do not create a
second editor or thousands of per-character DOM decorations.

One token composition owner merges structural tokens with supported LSP tokens;
registering competing semantic providers is not a merge strategy. Local syntax
describes the current draft. Existing LSP results remain saved-file-only until
the LSP contract is deliberately extended. After an edit, stale LSP overlays
are removed while local coloring continues. Every result carries model identity
and version; late results cannot recolor a replacement model.

## Execution And Terminal Integration

An execution is a resource owned by the Project/workspace, or by the exact Agent
when its workspace authority is Agent-scoped. Merely navigating from an Agent
does not transfer a Project resource's ownership. No fake Agent is created.
Stopping/deleting an owning Agent or removing its workspace stops its executions;
a Project task is independent of an unrelated Agent's lifecycle.

The current terminal path is Agent-keyed, including browser attachment and
checkpoint authorization. Introduce a typed terminal reference distinguishing
Agent terminals from execution terminals at the shared protocol boundary.
Resolve both through their authoritative owner before attachment, input, resize,
or cleanup. Keep legacy shapes at the boundary during migration; do not pass a
synthetic Agent id through new code. Code and CRT retain one checkpoint/delta
implementation and native PTY host. This requires protocol and regression work,
not just placing a new terminal component below the editor.

Agent provider activity observers do not apply to execution terminals. The
native host's process outcome determines task exit; prompt text and output
silence do not. Debug adapter `exited`/`terminated` events and PTY exit can arrive
in either order. Finalization joins them with exact child cleanup under one
owner, retains the program exit code separately from adapter errors, and has a
deadline if either side disappears.

Open Terminal reveals a compatible user shell without executing a command;
New Terminal creates one. Insert Command fills a user command composer without
submission; Run submits an explicit target into its own execution. Never inject
commands into a coding-agent terminal or infer shell idleness from output.
VS Code's chat insertion also uses a non-executing terminal command operation;
Codex's command execution/session polling is a different lifetime contract and
must not redefine Farming's persistent terminals.

## Debug Protocol And Source State

The DAP service owns framing, bounded requests, request/event ordering,
capability negotiation, session state, and adapter reverse requests. The Python
adapter owns debugpy preparation and launch configuration. `runInTerminal`
creates an exactly owned native PTY execution and returns its process identity;
it does not open an external browser-machine terminal.

Initialize the adapter, begin launch, accept its initialized event, install
breakpoints, and send configurationDone when supported. Launch responses may
arrive after configuration; awaiting launch before handling initialization can
deadlock. Capabilities determine which controls are offered.

Breakpoints are persisted intent identified by workspace/file and source
revision. Runtime verification is session-specific and includes adapter-adjusted
locations. Pending, verified, disabled, and rejected breakpoints look distinct.
Edits remap draft breakpoint positions but do not claim that running code moved.
When saved source changes during debugging, mark source mismatch and withhold
misleading execution-line/verified-breakpoint projections until a valid source
mapping or rerun exists.

Paused snapshots have a stop revision. Stack, scopes, and variable references
are valid only within it; resume invalidates them immediately. Fetch children
lazily with bounds. A late variable response cannot restore the previous stop's
values. The first delivery supports line breakpoints, verification, stack,
variables, pause/continue, and stepping. Attach, expression evaluation,
conditional/log breakpoints, and multi-process debugging are later capabilities.

Source navigation is authorized through the existing file service. An adapter
path outside the workspace is not automatic file-read permission. Initially show
external frames with path/function context and an explicit unavailable source
state; broader library-source access needs its own read-only authority.

## Minimal State Model

| Owner | States and triggers | Guards, effects, and terminal outcomes |
| --- | --- | --- |
| Context service | unresolved → discovering → ready / needs-input / failed | Apply a valid default automatically; needs-input is only for unresolved required information; file/root and generation must match; opening the picker refreshes evidence |
| Tool manager | absent → preparing → ready / failed / cancelled | Concurrent requests share preparation by artifact identity; cancelling one subscriber does not cancel another; no partial artifact is published |
| Execution service | preparing → starting → running → exited / failed; active → stopping → stopped / cleanup-failed | Validate authority, saves, selection revision, and target before effects; persist identity before process creation; Stop hard-kills the exact owned process set |
| DAP service | initializing → configuring → running ↔ paused → terminated / failed | Handshake is event-driven; stepping only from the matching paused revision; terminate invalidates pending requests and variables |
| Browser attachment | detached → attaching → attached / failed | Snapshot plus ordered revisions; closing a view detaches only; reconnect reads current state without launching again |

Initial budgets: discovery 10 seconds; tool preparation 120 seconds; execution
startup/DAP handshake 30 seconds; ordinary DAP requests and stop reconciliation
10 seconds. Each owner must cancel/fence expired work and expose a terminal
outcome; interactive programs themselves have no arbitrary execution deadline.
Tune budgets from measured tests without removing bounded behavior.

Launch operations carry a client operation id bound to owner and target digest.
Duplicate admission returns the same recorded operation; a different payload
under that id is rejected. Persisted terminal identity allows reconciliation
after an ambiguous create response. Browser launch timeouts query that operation
instead of replaying a command. Serial admission prevents duplicate clicks from
creating unintended concurrent sessions; intentional parallel runs have distinct
operation ids.

Step/continue actions are serialized for one session and stop revision. An
uncertain response is never automatically resent; reconcile adapter events and
bounded state reads. If state cannot be established, fail the debug session and
clean up its exact process set rather than guessing paused/running.

Browser reconnect does not stop a backend-owned task. Server-only recovery may
reattach an exactly verified live PTY through the existing recovery contract.
Do not claim DAP recovery if its control connection was lost: terminate and
reconcile the exact orphaned debug execution, retain breakpoints/profile, and
offer rerun. A full Farming stop hard-kills all selected owned processes.
Restart never automatically reexecutes the user's program. Cleanup failure is
visible and retains ownership evidence for bounded recovery.

Owner authentication and workspace authorization apply to every read and
mutation. Read-only shares cannot discover executable capabilities, prepare
tools, select environments, launch, debug, or write terminal input. Session
snapshots and events are scoped by exact resource, epoch, and revision.

## Delivery Order And Acceptance

First prove three architectural seams with disposable fixtures: structural
tokens in Monaco; a non-Agent native terminal with checkpoint recovery; debugpy
launch through runInTerminal using a separate target environment. These are
feasibility gates, not user-visible substitute implementations.

Then deliver in dependency order: environment/context ownership and picker;
Python coloring and aligned analysis; resolved Run targets and terminal resource;
DAP and breakpoint/step UI; integrated failure/recovery verification.
Python-specific choices stay in its adapter throughout. A fake second language
adapter verifies that the shared contracts do not require Python fields.

Acceptance must cover:

- A fresh Config with no interpreter override, run profile, or launch JSON:
  open the nested Python file, run, set a breakpoint, debug, and step without
  opening any configuration UI. Several detected interpreters must not by
  themselves break this path. Also verify optional overrides separately.
- Nested project with ancestor `.venv`, competing environments, unsupported
  versions, absent/removed explicit selection, paths containing spaces and
  Unicode, venv symlink identity, `src` layout, and explicit uv preparation.
- Python functions, methods, decorators, type annotations, f-strings, constants,
  multiline strings, and edits during parsing; delayed or absent LSP must not
  erase valid local coloring. Shared theme roles in Light, Dark, and Paper.
- Module and script execution with arguments, imports, stdin, stdout/stderr,
  exit codes, save conflicts, target changes during preparation, stop, rerun,
  uncertain launch, and two independent authorized browser views.
- Real debugpy breakpoint hit, verified line, stepping, stack, nested variables,
  source changes, late paused responses, adapter failure, and startup stop races.
- Browser reconnect, server-only loss, hard stop/restart, exact child-process
  cleanup, cross-Config isolation, Agent terminal/CRT regressions, and read-only
  and path-escape rejection. No broad process or directory cleaners.

Use deterministic protocol fakes for races and a real local Python fixture for
the end-to-end workflow. Production-shaped UI acceptance combines the file tree,
editor, environment picker, Agent side pane, and execution dock at wide and
narrow widths. Capture through checked-in scenarios in all supported themes.
Do not call the feature complete based on buttons or protocol mocks alone.
