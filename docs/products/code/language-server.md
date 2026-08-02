# Language Server

> Chinese version: [language-server.zh_cn.md](./language-server.zh_cn.md)

Status: first viewing-oriented MVP.

## Product Boundary

Language Server is a built-in Farming plugin that reuses language providers already running inside VS Code. Farming does not install, start, stop, restart, or configure VS Code or individual language servers. It also does not expose a provider selector or command, argument, socket, initialization-option, or per-language form.

The supported path is deliberately singular:

```text
Farming Monaco editor
        |
        | authenticated Farming HTTP API
        v
Farming backend
        |
        | loopback, token-authenticated bridge protocol
        v
Farming VS Code Bridge extension
        |
        | public VS Code language-provider commands
        v
Existing VS Code extensions and their language servers
```

Stock VS Code Server does not expose its language-provider results as a public external API. The small VS Code Bridge therefore runs inside the existing VS Code extension host. It calls VS Code's public provider commands and leaves every language extension's configuration and lifecycle with VS Code. The Bridge is user-managed: Farming discovers it but never installs or launches it.

Because the Bridge is plain JavaScript running in the already-compatible VS Code extension host, it adds no separate native runtime requirement on legacy hosts such as glibc 2.17 systems. Language-server compatibility remains exactly the compatibility provided by the user's installed VS Code extensions.

## First-release Capabilities

The first release is language-agnostic and capability-driven. It provides:

- hover;
- go to definition, references, and implementation;
- document and workspace symbols;
- incoming and outgoing call hierarchy with lazy recursive expansion;
- supertype and subtype hierarchy with lazy recursive expansion;
- diagnostics.

The same code path works for TypeScript, JavaScript, Python, Go, Rust, and other languages when the corresponding VS Code extension is installed, active, and implements the requested provider. An unsupported hierarchy or symbol provider is reported explicitly, while a supported provider with no match shows an empty result; Farming does not synthesize call hierarchy from references.

Completion, rename, formatting, code actions, and Farming-managed language-server installation are intentionally outside this release. Language queries use the last saved file. A dirty Farming working copy keeps syntax editing available but temporarily withholds Bridge actions and clears remote diagnostics, because silently querying stale VS Code text would be misleading.

## State Model

The Farming backend owns the authoritative connection state:

- `Unavailable`: no Bridge descriptor was discovered;
- `Connected`: at least one discovered Bridge completed a bounded authenticated health request and reports its provider request path as ready;
- `Error`: a descriptor exists but is invalid, incompatible, unreachable, or stalled with no ready Bridge remaining.

Opening Plugins performs a fresh bounded discovery. Retry invalidates the short discovery cache. A request failure invalidates the active Bridge and the next operation discovers again. Farming never turns a failed or absent Bridge into a lower-quality language-server fallback.

Each VS Code window writes a mode-`0600` instance descriptor containing a random bearer token and a random loopback port under its VS Code global storage directory. Farming health-checks the bounded discovered set, merges its capabilities, and routes each Project request to the Bridge instance that has that exact workspace open. Farming accepts only literal loopback HTTP endpoints owned by the current user. The backend validates every input file against an authoritative Project root and removes every result outside that same root before returning it to the browser. The Bridge independently accepts only workspaces open in its VS Code window and files owned by that workspace.

Ready Bridges allow normal language-provider requests to run concurrently; the lifecycle is not a global single-flight lock. Each request also has a Bridge-local deadline that finishes before the backend's transport timeout. VS Code's public provider commands do not expose cancellation, so crossing that deadline returns public Farming error `504 LANGUAGE_SERVER_BRIDGE_STALLED` without pretending to cancel, restart, or replay the underlying operation. The Bridge retains that exact Promise and generation, reports `requestState: stalled` from health, and rejects later provider requests before invoking VS Code again; Farming exposes that fence as `503 LANGUAGE_SERVER_BRIDGE_STALLED`. Direct Bridge errors and health-observed stalls are normalized to this same public code. The Bridge returns to ready only after every timed-out generation's original Promise actually settles; one old late result cannot clear another stalled generation. Extension shutdown uses a distinct error and is never reported as a provider stall.

A stalled Bridge is excluded from connected capability and workspace inventory. If another ready Bridge has the same workspace open, Farming routes to that instance. If only a stalled instance owns the requested workspace, the request preserves the stalled error and its recovery instruction instead of reporting that the workspace is closed. An operation that never settles is a terminal failure for that VS Code window: reload the VS Code window to recreate its Extension Host. Farming does not automatically replay the query or restart VS Code.

Hierarchy item handles are opaque, process-local, capacity-bounded, and expire after ten minutes. Losing or restarting the Bridge makes old handles fail explicitly; the user prepares the hierarchy again.

## User-managed Bridge

The reference Bridge source is in `extensions/language-server/vscode-bridge`. For development it can be packaged with the standard VS Code extension packager and installed through VS Code:

```bash
cd extensions/language-server/vscode-bridge
npx @vscode/vsce package
code --install-extension vscode-bridge-0.1.0.vsix
```

For Remote SSH, install the extension into the remote host from the VS Code Extensions view, then keep that VS Code workspace open. The extension activates after VS Code startup, publishes its descriptor, and Farming discovers it automatically. No Farming setting is required.

The standard discovery locations cover VS Code Server, VS Code Server Insiders, legacy VS Code Remote, desktop Code, and desktop Code Insiders global storage. The extension id and storage identity are `farming.vscode-bridge`.
The Bridge supports VS Code and VS Code Server 1.85 or newer so existing remote installations do not need an upgrade solely for Farming.

## Verification

The backend regression tests cover authenticated discovery, protocol health, Project-root input validation, result filtering, transition back to Unavailable, concurrent healthy requests, the stalled deadline/fence/recovery generations, exact deactivation cleanup, and ready-Bridge fallback for the same workspace. Manifest regression checks keep every Bridge runtime helper in both the VSIX and Farming npm package file lists. Frontend type checking covers Monaco provider registration and the hierarchy/symbol panel. A production-shaped acceptance pass should additionally package the VSIX, then use one real VS Code Remote SSH workspace and verify TypeScript definition/reference/call hierarchy, followed by one non-TypeScript language extension installed in that same VS Code Server.
