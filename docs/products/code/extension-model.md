# Farming Code Extension Model

> Chinese version: [extension-model.zh_cn.md](./extension-model.zh_cn.md)

Status: internal built-in Extension architecture. This is not yet a stable
third-party Extension API.

## Purpose

Farming should add live resources, viewers, and Agent capabilities through one
Extension model instead of embedding each capability directly into Agent,
Files, and sidebar code.

An Extension may contribute:

- a typed Resource with stable identity and lifecycle;
- one or more Viewers and contextual actions;
- a backend runtime or connection adapter;
- Agent-facing tools and capability metadata;
- installation, permission, health, and failure information.

Built-in and future external Extensions should use the same ownership model.
Distribution and trust may differ; integration architecture should not.

## Resource And Viewer Boundary

Farming core owns workspace composition, tabs, sidebar structure, navigation,
authentication, and shared interaction patterns. An Extension owns only its
resource-specific lifecycle, rendering, status meaning, and actions.

All Resource rows compose one core presentation contract for geometry, focus,
hover, active state, action reveal, keyboard behavior, and empty states.
Extension-specific styling is limited to genuinely resource-specific surfaces
such as a Browser or Desktop Viewer.

Viewer access must pass through the same authorized Resource identity. Preview
or streaming paths must not create an independent file, browser, or desktop
authority.

Live Agent activity such as the current Plan and Browser previews shares one
core-owned right-side dock. Every activity keeps a compact identifiable header,
while at most one activity body is expanded. Selecting another activity folds
the previous body instead of moving both surfaces across the transcript. Only
the expanded Browser preview maintains a live Viewer stream; collapsed previews
retain their latest frame and reconnect when expanded again.
Agent detail previews summarize owned Resource counts by kind with compact icons
so users can estimate Resource usage without expanding each Resource section.

## Ownership And Lifecycle

Each live Resource has one stable id, one exact owner, and one authorization
scope. Lifecycle states and destructive actions are defined by the owning
Extension, while Farming core requires:

- exact identity before mutation or cleanup;
- generation fencing for stale asynchronous results;
- bounded startup, stop, reconnect, and failure;
- explicit handling of uncertain mutation outcomes;
- restart reconciliation from authoritative persisted state;
- deletion of only the Resource and external objects that owner can prove.

Agent-owned Resources may survive Chat/Terminal replacement. When an Agent is
stopped or archived, its Browser Resources are deleted by exact id so temporary
Browser rows and profiles do not accumulate. Other Resource types retain the
lifecycle defined by their owning Extension. Deleting the Agent removes only
Resources it exactly owns.

For Browser Resources, `stop` retains the row and persistent profile for later
reuse, while `delete` stops the runtime and removes both. The Agent-facing CLI
must expose both operations so temporary verification Resources can be deleted
by exact id instead of accumulating as stopped inventory. An Agent lifecycle
stop or archive uses deletion; Chat/Terminal replacement is explicitly exempt.

## Agent Capability Projection

Extensions publish Agent tools through one Farming-owned capability contract.
An Extension must not implement separate generic integrations for Codex,
Claude Code, OpenCode, Qoder, or Qwen.

Supported command-capable Agents discover the same capability through the
instance-exact Farming CLI. Live availability is discovered from current
backend state, not assumed from a prompt. Tool identity, schema, ownership,
permission, and result semantics remain defined by the Extension contract.

User-installed or provider-native tools may coexist. Ownership and name
collisions must be explicit; Farming does not silently replace another tool.

## Plugins And Agent Homes

The Plugins surface presents built-in capabilities, Agent Home configuration,
and extension catalogs. Opening it is a current-state boundary: capability and
catalog views perform a fresh authoritative read with visible loading and
failure.

Provider plus Agent Home id is one configuration identity. Global settings own
which Homes accept new Agents and their display order. Existing Agent records
retain an immutable binding to the exact Provider Home used for their Session;
removing or reordering a configuration must not relabel existing Sessions.

Extension catalogs are scoped to one exact Home. Provider-owned configuration
remains authoritative for enabled/configured state and defaults; Farming does
not create a parallel enablement database or merge several Homes into one
provider-wide identity.

## Browser And Computer

Browser and Computer are built-in Extensions over the same Resource contract:

- Browser owns structured webpage automation and a shared page Viewer.
- Computer owns a full Desktop and its control handoff.
- Isolated Browser may lease an Agent-owned Desktop, but Browser-tab and Desktop
  lifecycles remain distinct.

Browser and Computer share lightweight backend capability services where safe,
while the Agent name carried by the CLI resolves Resource identity and mutable
Session state to the current owner. The name is local routing state rather than
a separate permission credential. Farming does not inject or host a second
Browser/Computer MCP implementation.

## Files And Language Server

File viewers demonstrate the same model: different file types may use different
Viewers while sharing one Project authorization and editor workspace. Language
Server is a built-in viewing capability that composes the Project and Extension
boundaries rather than introducing a separate editor or remote-execution path.

## Security And Failure

Extensions validate all input at their boundary, expose current availability,
and fail explicitly when prerequisites are missing. Unknown or inactive Agent
names fail instead of falling back to another owner's Resource. Viewer
connections remain scoped to the exact Resource. Transport timeouts with
uncertain outcomes are reconciled before any replay.

## Acceptance Criteria

Verification must cover Resource identity, Agent and Config isolation,
authorization, lifecycle transitions, restart, reconnect, uncertain outcomes,
shared presentation behavior, fresh capability reads, Agent Home scoping, and
one CLI-backed capability implementation across Chat and Terminal.

Before a third-party API is declared stable, Farming must also define package
trust, UI isolation, capability-name collision handling, and the minimum
lifecycle guarantees required from an external runtime.
