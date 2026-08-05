<p align="center">
  <img src="./public/farming-2/app-icon-v2-512.png" alt="Farming Code" width="112">
</p>

<h1 align="center">Farming Code</h1>

<p align="center">
  Farming Code is an open-source, self-hosted browser workspace for running and supervising Codex, Claude Code, OpenCode, and other AI coding agents.
</p>

<p align="center"><a href="./README.zh_cn.md">简体中文</a></p>

<p align="center">
  <a href="https://zhuwenzhuang.github.io/farming/en/">Documentation</a> ·
  <a href="https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/zhuwenzhuang/farming/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/zhuwenzhuang/farming/releases"><img alt="Release" src="https://img.shields.io/github/v/release/zhuwenzhuang/farming?label=release"></a>
  <a href="https://www.npmjs.com/package/farming-code"><img alt="npm" src="https://img.shields.io/npm/v/farming-code?label=npm"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/github/license/zhuwenzhuang/farming"></a>
  <img alt="Node.js 22.13 LTS or 24+" src="https://img.shields.io/badge/node-22.13_LTS_%7C_24%2B-339933?logo=nodedotjs&amp;logoColor=white">
  <img alt="macOS and Linux" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555">
</p>

![Farming Code workbench](./docs/products/code/assets/01-code-workspace.png)

Farming Code runs on the same development machine as your repositories and coding CLIs. Agent processes, terminals, and project files stay on that machine; a desktop or phone browser connects to those real sessions.

## Quick Start

With Node.js 22.13 LTS (22.x) or Node.js 24+ and access to a supported coding
Agent provider:

```bash
npm install --global farming-code@latest && farming daemon
```

Open one of the authenticated URLs printed by the command, choose **New Agent**,
and start a task. See [Getting started](./docs/getting-started.md) for the complete
first-run flow.

![Start an Agent](./docs/products/code/assets/02-start-agent-picker.png)

## Farming Code

Farming Code is the default desktop and mobile interface. It groups work by project and keeps live Agents, resumable history, files, browsers, and review in the same browser workspace.

### Agents, Chat, and Terminal

Start or resume Codex, Claude Code, OpenCode, Qoder, and other detected coding
Agents. Use structured Chat to read results and inspect the process, or Terminal
to work directly with the CLI.

![Farming Code structured Agent process](./docs/products/code/assets/11-code-agent-process.png)

### Files and Review

Browse, search, and lightly edit Project Files without leaving the current task.
Inspect changes and open Review when you need evidence.

### Browser Resources

Farming lets people and Agents use the same project browser. See [Farming Browser](docs/products/code/browser-agent-cli.md).

## Supported Agents

| Agent | Structured Chat | Terminal | History / resume |
| --- | --- | --- | --- |
| Codex | Yes | Yes | Yes |
| Claude Code | Yes | Yes | Yes |
| OpenCode | Yes | Yes | Yes |
| Qoder | Yes | Yes | Yes |
| bash / zsh | — | Yes | No |

Provider-backed Agents still require a valid provider login. Other detected CLIs
must be able to run on the Farming host.

## Remote Use

Run Farming on the development machine and open its authenticated URL from a
desktop or phone that can reach it. Agents keep running when the browser
disconnects. See [Operations](./docs/operations/README.md) for remote-access and
security guidance.

## Farming CRT

Farming CRT is an optional keyboard-first, retro control-room interface for scanning many Agents, opening their Chat or Terminal sessions, searching history, and viewing usage telemetry.

![Farming CRT multi-agent dashboard](./docs/products/crt/assets/01-crt-dashboard.png)

Code and CRT use the same backend Agents and sessions. Switching interfaces does not create a second Agent. Farming Code remains the default interface and the supported phone interface. See the [Farming CRT guide](./docs/products/crt/README.md) for controls and workflows.

## Installation And Updates

Install with the Quick Start command above. npm installations can update from
**Settings → Updates**.

![Farming npm update settings](./docs/products/code/assets/14-code-settings.png)

Standalone CLI and directory bundles remain available from [GitHub Releases](https://github.com/zhuwenzhuang/farming/releases) for manual installation. The in-app updater never reads GitHub Releases; it is available only to npm installations.

## Security

Farming controls real terminals and files on the development machine. Run it on a trusted host and network. Do not expose it directly to the public internet without a VPN, SSH tunnel, HTTPS reverse proxy, or equivalent access control.

See [SECURITY.md](./SECURITY.md) for deployment and reporting guidance.

## Documentation

- [English user documentation](https://zhuwenzhuang.github.io/farming/en/)
- [Repository architecture and development documentation](./docs/README.md)
- [Release history](https://github.com/zhuwenzhuang/farming/releases)
- [Contributing](./CONTRIBUTING.md)

## License

Farming is released under the [MIT License](./LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
