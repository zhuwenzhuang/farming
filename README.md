# Farming

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

[![CI](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg)](https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release)](https://github.com/zhuwenzhuang/farming/releases)
[![npm](https://img.shields.io/npm/v/farming-code?label=npm)](https://www.npmjs.com/package/farming-code)
[![License](https://img.shields.io/github/license/zhuwenzhuang/farming)](./LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555)

Farming is a remote browser workspace for AI coding agents. The current public product line is **Farming 2**.

It brings remote terminal sessions, Codex / Claude Code, project-scoped agents, open editors, file search, lightweight editing, git review tools, usage signals, and machine status into one browser page. The goal is to reduce the context switching that usually happens between SSH, an IDE, browser tabs, monitoring pages, and separate agent panels.

Farming is designed around remote hosting. Agents, shells, project files, and git state keep running on the remote machine. A desktop browser is good for editing, reviewing, searching, and long follow-up sessions; a mobile browser is good for checking progress, switching sessions, and sending a short intervention while away from the desk.

The browser exposes two live interfaces over the same backend: Farming Code at `/farming/code/` and the original CRT interface at `/farming/crt/`. `/farming/` continues to open Farming Code. If Code cannot start or render, the failure view keeps the live CRT interface visible behind the bounded error details, without restarting running agents.

For a product-oriented introduction, screenshots, and the architecture diagram, see the [Farming 2 Wiki](https://github.com/zhuwenzhuang/farming/wiki/English).

![Farming Code workspace](./docs/products/code/assets/01-code-workspace.png)

> If you are an AI agent contributing to this repository, read [AGENTS.md](./AGENTS.md) first.

## Why Farming Exists

Current AI-agent interfaces are often chat-session lists. They are not great at showing which long-running task matters now, which agent is waiting, which one is stale, and where a human should intervene.

Farming first solves the practical workbench problem: put the tools needed to supervise coding agents into one remote UI. Longer term, it explores attention management through a Main Agent that can observe, coordinate, and summarize multiple child agents.

## Farming 2

Farming 2 turns the project into a remote coding workbench:

- start and manage Codex, Claude, OpenCode, Qoder, bash, and zsh sessions in the browser;
- discover and resume local Codex, Claude, OpenCode, and Qoder session history, then reconnect it to live Farming terminals;
- group agents by project;
- open Project Files with Open Editors, file tree, search, Monaco editing, Markdown/image preview, git changes, diff, and blame;
- click terminal `path:line` references and HTTP URLs;
- set Codex / Claude launch profiles for permissions, model, and speed where the underlying runtime supports them; App Server Codex updates permissions on its current thread, while terminal-owned sessions restart and resume when they already have a provider session id, or start fresh when no resumable id exists yet;
- attach text and images to composer messages;
- view lightweight usage, context, token-rate, quota, and CPU/MEM signals where available;
- access the same remote service from desktop and mobile browsers.

Screenshots, install details, and product notes are in [Farming 2 product guide](./docs/products/code/README.md).

## Quick Start

The easiest path is the npm package. Run Farming on the same development machine where `codex` or `claude` already works in a normal shell.

```bash
npm install --global farming-code
farming daemon
```

Farming defaults to port `6694`, base path `/farming`, config directory `~/.farming`, and token auth. The first authenticated start generates a random readable token and stores it in `~/.farming/.session-token`; later restarts and upgrades reuse that token unless `FARMING_TOKEN` is explicitly set. In Chinese time zones this is a Chinese haiku-style passphrase by default; Japanese time zones use Japanese haiku-style passphrases, and other time zones use English passphrases. The startup log prints a URL like:

```text
http://linux-host:6694/farming?token=<startup-token>
```

Open that URL in a desktop or mobile browser, click `New Agent`, choose `Codex`, `Claude Code`, `bash`, or `zsh`, select a workspace, and start working.

## Downloads

The npm package is the default distribution. GitHub release artifacts remain available for manual installation.

Farming uses these practical deployment shapes:

| Environment | Artifact | When to use it |
| --- | --- | --- |
| macOS and Linux | `npm install --global farming-code` | Default path. Requires Node.js 22 or newer and a system runtime that can load `node-pty`. |
| Standalone use | platform CLI from GitHub Releases | Manual installation for environments that do not want npm; upgrades remain manual. |
| Directory deployment | `farming-<version>-<platform>-<arch>.tar.gz` | App bundle with production dependencies and launcher scripts; it uses the target system runtime. |
| Older Linux runtime | `farming-<version>-linux-x64-glibc217.tar.gz` | Separately built compatibility bundle. It requires Node.js 22+, but rebuilds `node-pty` against a glibc 2.17 baseline. |

If you want Farming to launch Codex or Claude Code, install and log in to those CLIs on the same machine first. Farming hosts their CLI sessions; it does not replace their installation or account setup.

## Architecture

```text
Browser skins
  React + Vite + Monaco + terminal renderer
        |
        | HTTP / WebSocket
        v
Farming core
  Express server + token auth + agent manager + session providers
        |
        | native pty host + session engine
        v
Execution environment
  bash / zsh / Codex / Claude Code
```

The backend owns agent lifecycle, WebSocket state sync, session engines, workspace file APIs, session providers, model/profile discovery, usage collection, and configuration. Frontend skins organize those capabilities into different experiences. New interactive sessions use the native pty host by default, keeping node-pty agent processes outside the Farming server process so the server and browser can reconnect to live terminals. The native pty host persists across Farming server restarts unless `FARMING_NATIVE_PTY_HOST_PERSIST=0` is set, then exits after an idle grace period once no live sessions or clients remain. Set `FARMING_SESSION_ENGINE=local` only when debugging the in-process node-pty engine.

The browser terminal renderer defaults to xterm.js. The older Ghostty web renderer is still kept as an explicit debug path through `localStorage.farmingTerminalEngine = 'ghostty'`.

## Install And Run

### Install From npm

```bash
npm install --global farming-code
farming daemon
```

Open **Settings → Updates** to check and install a newer npm version in one click. Farming installs the new package while the current server is still running, restarts only after installation succeeds, and attempts to restore the previous version if the new server cannot start. The equivalent manual command is `npm install --global farming-code@latest`.

### Build From Source

```bash
npm install
npm run release:cli
```

To build an app bundle:

```bash
npm install
npm run release:app
```

The app bundle includes production dependencies and launcher scripts. It does not bundle or install a private system C library; Node.js and native dependencies must run on the target system as installed.

Older Linux compatibility is an explicit, separate build and is not part of the normal release workflow. Run the following command inside a clean Linux x64 builder that has glibc 2.17, Node.js 22+, GCC/G++, Make, and Python 3:

```bash
npm run release:app:linux-compat
```

The command forces `node-pty` to build from source and rejects the archive unless its native module requires no newer than glibc 2.17. Install it remotely with `FARMING_REMOTE=user@host FARMING_RELEASE_TARBALL=<archive> npm run release:remote:linux-compat`. This compatibility bundle still uses the target machine's Node.js and libc; it does not carry a private glibc or a custom loader.

### Run A Single-File CLI

```bash
chmod +x farming
./farming daemon
```

By default it listens on port `6694`, serves under `/farming`, creates `~/.farming`, enables token auth, and prints a browser URL containing the startup token.

Useful commands:

```bash
./farming status
./farming logs
./farming url
./farming stop
```

### Run An App Bundle

```bash
tar -xzf farming-<version>-linux-x64.tar.gz
cd farming-<version>-linux-x64
./farming
```

The launcher uses the target machine's ordinary Node.js and native runtime. Farming no longer bundles, downloads, or selects a private system C library.

## Development

```bash
npm install
npm start
```

For trusted local development only, token auth can be disabled:

```bash
npm run start:no-auth
```

## Configuration

Runtime settings are stored in `~/.farming/settings.json`.
Agent session metadata is stored separately in `~/.farming/sessions/`. Farming
uses stable `fsess_*` files for its own Agent records; live `agent-...` ids and
Codex / Claude provider session ids are stored as metadata on those records.
The main Projects page membership lives in `sessions/index.json` and is exposed
as `mainPageSessionKeys` only for API compatibility.
Archived run history is stored in `~/.farming/history/runs.json`, not in
`settings.json`.
Theme overrides, the startup token, server pid/state/log files, and native pty
host logs live under the same config directory.

Common settings:

- `defaultLaunchAgent`
- `agentLaunchProfiles.codex`
- `agentLaunchProfiles.claude`
- `agentHomes` (home metadata for Codex, Claude, OpenCode, and Qoder; each provider keeps a non-removable `default` home)
- `workspaceHistory`
- `dangerouslySkipAgentPermissionsByDefault` (launch supported coding agents such as Codex, Claude, OpenCode, Qoder, Qwen, Aider, GitHub Copilot CLI, and Amazon Q with their provider-specific dangerous permission-skip flags by default)

Native terminal sessions are owned by a Farming pty host reached through a local socket derived from `configDir`. By default the host is preserved during server shutdown so a restarted Farming server can recover live terminals; after the last live session and client disappear, the host shuts itself down after a short idle grace period. Set `FARMING_NATIVE_PTY_HOST_PERSIST=0` to tie the host lifetime to the server process. Terminal work should target the native pty host and xterm.js path.

Update behavior follows the installation method. npm installations read versions from the npm registry and provide one-click upgrades in **Settings → Updates**. Source checkouts update through Git, and standalone CLI artifacts are replaced manually. App-bundle installations can use a trusted HTTP(S) package directory or manifest URL; the updater only offers a bundle matching the current OS and CPU architecture and verifies its checksum before installation. The app-bundle Update URL is stored in `~/.farming/settings.json` as `updateUrl`.

The simplest source is an HTTP(S) directory URL ending in `/` that lists platform-tagged `farming-<version>-<platform>-<arch>.tar.gz` app bundles and an adjacent `<bundle>.sha256` file for every bundle. Farming verifies the selected bundle's SHA-256 and archive layout before extraction, then runs its installer.

Example deployment templates:

- `config/farming.deploy.env.example`
- `config/farming.install.env.example`

Real `.env` files are ignored by git.

## Security

Farming controls real terminals and agent processes on the target machine. Run it on trusted development hosts and trusted networks. Do not expose it directly to the public internet without an additional layer such as VPN, SSH tunnel, HTTPS reverse proxy, or network ACLs.

The startup token protects both HTTP and WebSocket traffic. It is generated on first authenticated startup, persisted in `~/.farming/.session-token`, and reused across restarts and upgrades. The generated token is designed to be easier to copy than a long hexadecimal secret: Chinese time zones get a Chinese haiku-style passphrase by default, Japanese time zones get a Japanese haiku-style passphrase, and other time zones get an English passphrase. `FARMING_TOKEN_LOCALE=zh|ja|en|auto` can override generation behavior for a new token.

`FARMING_DISABLE_AUTH=1` is only for trusted local development. Terminal-owned Codex / Claude sessions apply a permission change by restarting with the selected CLI flags, resuming when a provider session id is available and starting fresh otherwise. App Server Codex applies the new approval and sandbox policy to its existing thread without a CLI restart.

See [SECURITY.md](./SECURITY.md) for the reporting policy and deployment notes.

## Troubleshooting

- **No `codex` or `claude` option works**: verify the CLI is installed, logged in, and runnable from a normal shell on the same host.
- **Native PTY cannot start**: verify the target system's Node.js and packaged `node-pty` runtime are compatible; Farming does not provide a private system-runtime compatibility layer.
- **Port already in use**: pass `--port <port>` or let the default daemon mode choose the next available port when no explicit port is provided.
- **Phone cannot connect**: use the network URL printed by the server and make sure the phone can reach the target machine.
- **Lost the token URL**: run `./farming url`, or check `./farming logs`.

## Repository Layout

```text
farming/
├── .gitattributes          # Source archive export rules
├── backend/                 # Node.js server, session engines, and backend APIs
├── src/                     # React + Vite frontend; Farming Code helpers live under src/components/code/
├── frontend/skins/crt/      # Independent live CRT entry, app, and visual effects
├── frontend/*.js            # Shared terminal/session browser bridges
├── docs/products/code/      # Farming Code product docs and screenshots
├── docs/products/crt/       # CRT skin layout docs
├── config/                  # deployment / install templates
├── scripts/                 # release, deployment, screenshots, tests
├── tests/e2e/               # Playwright browser flows
├── pkg.config.cjs
└── bin/farming
```

`releases/` is a local packaging output directory and is not committed.

## Tests

```bash
npm run check
```

Common individual checks:

```bash
npm test
npm run typecheck
npm run lint
npm run test:e2e:playwright
```

## Authors

- [zhuwenzhuang](https://github.com/zhuwenzhuang)
- [l4wei](https://github.com/l4wei)

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and keep user-facing docs updated when behavior or packaging changes.

## License

Farming is released under the MIT License. See [LICENSE](./LICENSE).
