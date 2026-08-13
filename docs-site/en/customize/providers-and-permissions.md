# Providers and permissions

Farming connects to different coding Agents. Providers continue to own authentication, models, and Session capabilities; Farming supplies a consistent Project, Chat, Terminal, and Files experience.

## Supported interactions

Common Providers include Codex, Claude Code, Pi, OpenCode, Qoder, Qwen Code, and other discovered coding CLIs. Depending on the Provider, Farming may offer structured Chat, native Terminal, Session resume, model and reasoning controls, and live Chat/Terminal switching.

Pi Chat uses the release-pinned `pi-acp` adapter and an installed Pi executable.
It requires Pi 0.80.4 or newer and Node.js 22.19 or newer. Farming verifies both
the Pi product identity and its version before starting Chat. The adapter does
not yet forward ACP MCP servers or delegate client filesystem and terminal
operations, so Farming exposes only the capabilities returned by its live
handshake.

Farming shows only capabilities actually declared and verified by the current runtime.

## Authentication

Provider login happens on the Farming Host. Installing Farming does not sign in to coding Agents.

To diagnose login:

1. start the CLI in a normal Host shell;
2. complete authentication or repair Provider configuration;
3. return to Farming and check capability or start the Agent again.

Do not put Provider Tokens in Project files or public configuration examples.

## Permission principles

Higher permissions let an Agent act with fewer interruptions while increasing possible impact.

- Use confirmation-oriented policies in unfamiliar repositories.
- Grant access only to the Workspace required by the task.
- Keep human confirmation for accounts, releases, payments, messages, and deletion.
- Browser and experimental Computer accounts and system permissions are separate security boundaries.

Changing permissions does not change the Agent or Workspace, create another Browser Profile, or transfer a Resource to another Agent. After an ambiguous permission result, inspect the page, files, and Git state before repeating the operation.
