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

For a product-oriented introduction, screenshots, and the architecture diagram, see the [Farming 2 Wiki](https://github.com/zhuwenzhuang/farming/wiki/English).

![Farming Code workspace](./docs/products/code/assets/01-code-workspace.png)

> If you are an AI agent contributing to this repository, read [AGENTS.md](./AGENTS.md) first.

## Why Farming Exists

Current AI-agent interfaces are often chat-session lists. They are not great at showing which long-running task matters now, which agent is waiting, which one is stale, and where a human should intervene.

Farming first solves the practical workbench problem: put the tools needed to supervise coding agents into one remote UI. Longer term, it explores attention management through a Main Agent that can observe, coordinate, and summarize multiple child agents.

## Farming 2

Farming 2 turns the project into a remote coding workbench:

- start and manage `codex`, `claude`, `bash`, and `zsh` sessions in the browser;
- resume local Codex / Claude session history and reconnect to live Farming terminals;
- group agents by project;
- open Project Files with Open Editors, file tree, search, Monaco editing, Markdown/image preview, git changes, diff, and blame;
- click terminal `path:line` references and HTTP URLs;
- use provider controls for Codex / Claude permissions, model, and speed where the underlying CLI supports them;
- attach text and images to composer messages;
- view lightweight usage, context, token-rate, quota, and CPU/MEM signals where available;
- access the same remote service from desktop and mobile browsers.

Screenshots, install details, and product notes are in [Farming 2 product guide](./docs/products/code/README.md).

## Quick Start

The easiest path is to run Farming on the same Linux development machine where `codex` or `claude` already works in a normal SSH shell.

```bash
chmod +x farming
./farming daemon
```

Farming defaults to port `6694`, base path `/farming`, config directory `~/.farming`, and token auth. The first authenticated start generates a random readable token and stores it in `~/.farming/.session-token`; later restarts and upgrades reuse that token unless `FARMING_TOKEN` is explicitly set. In Chinese time zones this is a Chinese haiku-style passphrase by default; Japanese time zones use Japanese haiku-style passphrases, and other time zones use English passphrases. The startup log prints a URL like:

```text
http://linux-host:6694/farming?token=<startup-token>
```

Open that URL in a desktop or mobile browser, click `New Agent`, choose `Codex`, `Claude Code`, `bash`, or `zsh`, select a workspace, and start working.

## Downloads

Download release artifacts from [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases), or build them locally from source.

Farming uses three practical deployment shapes:

| Environment | Artifact | When to use it |
| --- | --- | --- |
| Modern Linux | `farming_2_linux_amd64` / `farming_2_linux_arm64` | The target machine has a compatible glibc and should run a single executable. |
| Older Linux | `farming-2.tar.gz` | CentOS 7 / glibc 2.17 style hosts that need the app bundle launcher and bundled glibc 2.28 runtime. |
| macOS | `farming_2_darwin_arm64` | Local development, demos, and light use from a Mac. |

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

The app bundle always includes production dependencies and `vendor/glibc228-lib.tar.gz` for older Linux hosts. If the packager cannot reach the default glibc source, set `FARMING_GLIBC_BUNDLE=/opt/farming/glibc228-lib.tar.gz` to provide the source tarball; the generated bundle still carries it.

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
tar -xzf farming-2.tar.gz
cd farming-2
./farming
```

On older Linux hosts the same command works. The launcher uses `FARMING_USE_GLIBC=auto` by default and installs the bundled glibc 2.28 runtime when the system glibc is too old.

For older Linux environments with an existing glibc 2.28 runtime:

```bash
FARMING_USE_GLIBC=auto FARMING_GLIBC_ROOT=/opt/farming/glibc228 ./farming
```

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

Common settings:

- `defaultLaunchAgent`
- `agentLaunchProfiles.codex`
- `agentLaunchProfiles.claude`
- `workspaceHistory`
- `mainPageSessionKeys`: the real provider session keys Farming keeps on the main Projects page; Codex `tmp_uuid...` live ids are not stored here, while sessions not listed here stay in History.
- `dangerouslySkipAgentPermissionsByDefault`

Native terminal sessions are owned by a Farming pty host reached through a local socket derived from `configDir`. By default the host is preserved during server shutdown so a restarted Farming server can recover live terminals; after the last live session and client disappear, the host shuts itself down after a short idle grace period. Set `FARMING_NATIVE_PTY_HOST_PERSIST=0` to tie the host lifetime to the server process. Terminal work should target the native pty host and xterm.js path.

In-app upgrades are disabled unless an update source is configured. Set `FARMING_UPDATE_MANIFEST_URL` to an HTTP(S) JSON manifest that declares a version and an app-bundle tarball:

```json
{
  "version": "2.0.7",
  "tarUrl": "farming-2.0.7.tar.gz",
  "bundledGlibc": true,
  "sha256": "<optional-sha256>"
}
```

Relative `tarUrl` values are resolved relative to the manifest URL. Use `FARMING_UPDATE_ASSET_BASE_URL` when tarballs live under a different base URL. The updater does not contact GitHub unless you explicitly point `FARMING_UPDATE_MANIFEST_URL` at a GitHub-hosted manifest.

Example deployment templates:

- `config/farming.deploy.env.example`
- `config/farming.install.env.example`

Real `.env` files are ignored by git.

## Security

Farming controls real terminals and agent processes on the target machine. Run it on trusted development hosts and trusted networks. Do not expose it directly to the public internet without an additional layer such as VPN, SSH tunnel, HTTPS reverse proxy, or network ACLs.

The startup token protects both HTTP and WebSocket traffic. It is generated on first authenticated startup, persisted in `~/.farming/.session-token`, and reused across restarts and upgrades. The generated token is designed to be easier to copy than a long hexadecimal secret: Chinese time zones get a Chinese haiku-style passphrase by default, Japanese time zones get a Japanese haiku-style passphrase, and other time zones get an English passphrase. `FARMING_TOKEN_LOCALE=zh|ja|en|auto` can override generation behavior for a new token.

`FARMING_DISABLE_AUTH=1` is only for trusted local development. Agent permissions are still handled by the underlying Codex / Claude Code profile and CLI behavior.

See [SECURITY.md](./SECURITY.md) for the reporting policy and deployment notes.

## Troubleshooting

- **No `codex` or `claude` option works**: verify the CLI is installed, logged in, and runnable from a normal shell on the same host.
- **Native PTY cannot start**: verify the packaged `node-pty` runtime can load on the host; on older Linux hosts use the `farming-2.tar.gz` app bundle instead of the single-file binary.
- **Port already in use**: pass `--port <port>` or let the default daemon mode choose the next available port when no explicit port is provided.
- **Phone cannot connect**: use the network URL printed by the server and make sure the phone can reach the target machine.
- **Lost the token URL**: run `./farming url`, or check `./farming logs`.

## Repository Layout

```text
farming/
├── .gitattributes          # Source archive export rules
├── backend/                 # Node.js server, session engines, and backend APIs
├── src/                     # React + Vite frontend; Farming Code helpers live under src/components/code/
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
