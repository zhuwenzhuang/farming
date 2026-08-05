# Language Server

<Badge type="warning" text="Experimental" />

::: warning Experimental feature
Language Server connectivity and editor integration exist, but coverage across real projects is still limited. Actual capability depends on the language, Project, and Server.
:::

Language Server helps Farming Files understand code through definitions, references, symbols, hierarchies, and diagnostics.

## How it works

The Language Server runs on the Farming Host that owns the Project. Farming discovers a suitable Server, selects the Project root, manages process lifecycle and failure, bounds requests with timeouts, and filters results outside the Project.

The browser does not connect directly to a Language Server socket.

## Available capabilities

Depending on the Server, Farming may offer Hover, Definition, Reference, Implementation, Workspace Symbol, Call Hierarchy, Type Hierarchy, and Diagnostics.

Capabilities appear only after a real successful initialization. Registry support for a language does not prove that the current Project is connected.

## Saved state

Cross-file semantic results usually describe files saved on disk. When the editor has an unsaved draft, Farming may hide semantic operations that could present stale meaning.

## Suggestions

- Begin with a small Project and a known language toolchain.
- Confirm that the Server is installed or can be prepared by Farming.
- Treat navigation and diagnostics as supporting evidence; use files, builds, and tests as final evidence.
- Report language, Project root, Server state, and visible error when it fails.
