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

When one Agent owns several active Resources of the same kind, compact previews
may overlap, but every visible preview must identify and open its exact Resource.
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

Agent-owned Resources may survive Chat/Terminal replacement. Stopping or
archiving an Agent may stop their runtime while retaining user-visible state;
deleting the Agent removes only Resources it exactly owns.

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
while separate CLI credentials keep Resource identity, authorization, and
mutable Session state isolated by owner. Farming does not inject or host a
second Browser/Computer MCP implementation.

## Files And Language Server

File viewers demonstrate the same model: different file types may use different
Viewers while sharing one Project authorization and editor workspace. Language
Server is a built-in viewing capability that composes the Project and Extension
boundaries rather than introducing a separate editor or remote-execution path.

## Security And Failure

Extensions validate all input at their boundary, expose current availability,
and fail explicitly when prerequisites are missing. A capability token or
Viewer connection must be scoped to the exact Resource and owner. Transport
timeouts with uncertain outcomes are reconciled before any replay.

## Acceptance Criteria

Verification must cover Resource identity, Agent and Config isolation,
authorization, lifecycle transitions, restart, reconnect, uncertain outcomes,
shared presentation behavior, fresh capability reads, Agent Home scoping, and
one CLI-backed capability implementation across Chat and Terminal.

Before a third-party API is declared stable, Farming must also define package
trust, UI isolation, capability-name collision handling, and the minimum
lifecycle guarantees required from an external runtime.
