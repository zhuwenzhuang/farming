# Language Server

> Chinese version: [language-server.zh_cn.md](./language-server.zh_cn.md)

Status: managed viewing-oriented MVP.

## Product Boundary

Language Server is a built-in Farming capability. Opening or querying a
supported saved file causes the backend that owns that Project to locate and
start the matching language server over stdio. Users do not configure commands,
arguments, sockets, or ports.

```text
Farming Monaco editor
        |
        | authenticated Farming HTTP API
        v
Farming backend on the Project host
        |
        | stdio Language Server Protocol
        v
clangd / JDTLS / another server from PATH
```

The implementation adapts OpenCode's language registry, upward root-marker
search, PATH-first executable discovery, and lazy `server + root` process
reuse. Farming adds its existing authoritative Project-root authorization and
filters every returned file location back to that same Project.

Managed server failures are returned explicitly; Farming does not silently
replay a request through another provider.

## Discovery Algorithm

For a file request Farming:

1. validates the relative file against the authoritative Project root;
2. matches the file extension to one language definition;
3. walks from the file's directory up to the Project root looking for that
   language's markers;
4. uses the nearest matching directory, or the Project root for definitions
   that allow a fallback;
5. finds the configured command on `PATH`;
6. starts one stdio process per `language server + root` and reuses it for later
   files and requests.

C and C++ use `compile_commands.json`, `compile_flags.txt`, or `.clangd` and
start:

```text
clangd --background-index --clang-tidy
```

clangd reads the per-file include paths, defines, language standard, and other
compiler arguments from the compilation database. Farming does not parse or
generate those arguments. When clangd is absent from `PATH`, Farming downloads
the matching archive from the latest official clangd GitHub release into the
Config-local language-server cache.

Java detects Gradle settings/wrappers/build files, a verified Maven parent
`<modules>` chain, or Eclipse project files. It uses a `jdtls` command from
`PATH` when present. Otherwise Java 21 or newer is required and Farming
downloads the latest official Eclipse JDTLS snapshot into the Config-local
cache. JDTLS mutable workspace data is isolated by Project root.

Other registered languages use their normal command from `PATH`. Missing
commands fail explicitly.

## Registered Languages

The managed registry currently includes C/C++, Java, Kotlin, C#, F#, Go, Rust,
Python, JavaScript/TypeScript, Deno, Vue, Svelte, Astro, Ruby, PHP, Swift,
Objective-C, Dart, Lua, Elixir, Zig, OCaml, Shell, YAML, Terraform, LaTeX,
Dockerfile, Prisma, Gleam, Clojure, Nix, Typst, Haskell, and Julia.

## Capabilities And Saved Files

The current UI exposes hover, definition, references, implementation, document
and workspace symbols, call/type hierarchy, and diagnostics. Managed processes
receive `didOpen` and full-text `didChange` notifications from the saved file on
disk. The existing Farming editor still withholds semantic actions while its
working copy is dirty, so results cannot describe an older disk version as the
current draft.

Read-only queries have bounded deadlines. Hierarchy handles are opaque and
process-local. Server shutdown belongs to Farming backend shutdown; a later
request lazily starts the process again.

Each `server + root` follows `absent -> starting -> ready -> stopping ->
absent`. A failed start returns an explicit request error and leaves the entry
absent so a later user request may retry. An exited ready process is removed by
exact identity; the next request starts a fresh process instead of writing to a
stale transport. Concurrent starts for the same key join one Promise.

The plugin information status is derived from live managed processes that have
completed initialization: with no active process it shows “Ready on demand”,
and it shows “Connected” only when at least one real `server + root` connection
exists. The capability snapshot lists each connected Project, language server,
and language root; built-in registry availability is not presented as a
connected Project.

## Security And Isolation

- File inputs are resolved through `WorkspaceRootRegistry`.
- Symlink escapes and results outside the same Project are rejected.
- Processes run on the backend that owns the Project, including Remote SSH
  backends; Desktop does not execute one SSH command per language query.
- Managed caches and JDTLS workspace data live below the exact Farming Config
  directory, so Config instances do not share mutable language state.
- Downloads are bounded in size and extracted only below the Config-local
  language-server cache.

## Source And Verification

The adapted OpenCode source revision and MIT notice are recorded in
`THIRD_PARTY_NOTICES.md` and
`extensions/language-server/backend/LICENSE.opencode`.

Focused regression coverage uses a real fake stdio Language Server to verify
root detection, initialization, document opening, hover, definitions,
diagnostics, hierarchy handles, workspace symbols, process reuse, bounded
shutdown, and Project result filtering.
