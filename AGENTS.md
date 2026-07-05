# AGENTS.md - AI Agent Development Guide

> Chinese version: [AGENTS.zh_cn.md](./AGENTS.zh_cn.md)

This document is for AI agents and contributors working on Farming. It describes the product intent, engineering boundaries, repository layout, and verification expectations.

## Product Overview

Farming is a browser-based workspace for supervising AI coding agents. It focuses on the user's attention: when several agents are running at once, the interface should help the human notice what matters, intervene at the right moment, and avoid bouncing between SSH terminals, IDE windows, browser tabs, and monitoring pages.

The current public product line is **Farming 2**, whose default skin is **Farming Code**. It combines remote terminals, Codex / Claude Code sessions, project files, file search, Monaco-based light editing, git blame, usage signals, and machine status in one browser page.

Longer term, Farming explores a Main Agent workflow: a supervising agent can observe other agents, organize work, report progress, and reduce context switching for the human operator.

## Design Philosophy

Farming assumes:

- human attention is limited;
- humans do not truly multitask;
- users dislike being nagged, but appreciate useful reports;
- observing work in progress can be satisfying when the state is clear;
- every important operation should be reachable by keyboard.

Avoid:

- dense information dumps;
- putting every possible state on screen;
- noisy notification dots;
- static screens that look dead.

Prefer:

- clear project and agent grouping;
- visual feedback for every action;
- compact controls that match their content;
- stable, non-jumping layouts;
- fail-fast behavior for core terminal / PTY paths instead of low-quality fallbacks.

## Documentation Rules

When repository structure or behavior changes, update the relevant docs in the same change:

- `README.md` for user-facing project overview and setup;
- `AGENTS.md` for AI-agent development instructions;
- `docs/products/*` for product-specific design and verification notes.

For public documentation, the default Markdown file should be English. Keep the Simplified Chinese version beside it with the `.zh_cn.md` suffix, for example:

- `README.md`
- `README.zh_cn.md`
- `docs/products/code/mobile-guide.md`
- `docs/products/code/mobile-guide.zh_cn.md`

Each English document should link to its Chinese version near the top. Each Chinese document should link back to the English version.

Do not maintain public conversation logs. Ordinary Q&A, temporary debugging, and transient implementation notes should not be written to public docs. Important product, architecture, or interaction decisions should go into the appropriate durable document.

## Engineering Principles

- Keep changes scoped to the request.
- Prefer existing patterns and local helpers.
- Avoid premature abstraction in prototype surfaces.
- Validate user input and return actionable errors.
- Do not hard-code secrets or private environment assumptions.
- Keep agent processes isolated.
- Use asynchronous IO for server paths.
- Cache heavy filesystem / CLI scans with stale-while-refresh behavior where the codebase already does so.
- Add or update tests in proportion to risk.
- Preserve visual style when fixing behavior unless the user explicitly asks for a visual change.
- Do not add, remove, or rewrite visible product copy without a clear product reason.

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

The backend owns lifecycle, auth, session routing, terminal IO, workspace file APIs, session history, usage collection, and configuration. Frontend skins organize these capabilities into product experiences. New interactive sessions use `NativeSessionEngine` by default: Farming keeps node-pty agent processes in a separate native pty host process, so the browser and Farming server can reconnect to live terminals. The native pty host persists across Farming server restarts unless `FARMING_NATIVE_PTY_HOST_PERSIST=0` is set, then exits after an idle grace period once no live sessions or clients remain. `LocalSessionEngine` remains available through `FARMING_SESSION_ENGINE=local` for focused debugging, but product runtime work should target the native pty host path.

The browser terminal renderer defaults to xterm.js. The Ghostty web renderer remains available only as an explicit debug path via `localStorage.farmingTerminalEngine = 'ghostty'`, but new product work should target the xterm adapter first.

## Repository Layout

```text
farming/
├── README.md
├── README.zh_cn.md
├── AGENTS.md
├── AGENTS.zh_cn.md
├── LICENSE
├── .gitattributes
├── bin/
│   └── farming
├── backend/
│   ├── server.js
│   ├── agent-manager.js
│   ├── native-session-engine.js
│   ├── native-pty-host.js
│   ├── native-pty-host-client.js
│   ├── local-session-engine.js
│   ├── shell-busy-integration.js
│   ├── workspace-file-service.js
│   ├── workspace-file-router.js
│   ├── farming-app-cli.js
│   └── tests/
├── src/
│   ├── App.tsx
│   ├── components/
│   │   └── codex/          # Farming Code skin components and state helpers
│   ├── hooks/
│   ├── lib/
│   └── styles/
├── frontend/
│   └── vendor/
├── docs/
│   └── products/
│       ├── code/
│       ├── crt/
│       └── hive/
├── config/
├── scripts/
├── tests/e2e/
├── pkg.config.cjs
└── package.json
```

`releases/`, `dist/`, `dist-release/`, `.tmp/`, `reference/`, and `node_modules/` are generated or local-only paths and should not be committed.

## Runtime Configuration

Farming stores runtime settings under `~/.farming/settings.json` by default. Important user-facing settings include:

- `defaultLaunchAgent`
- `agentLaunchProfiles.codex`
- `agentLaunchProfiles.claude`
- `workspaceHistory`
- `mainPageSessionKeys`: Farming 自己维护的主页面真实 provider-session membership；Codex `tmp_uuid...` live id 不得进入该列表，不在该列表里的 provider session 只出现在 History。
- `dangerouslySkipAgentPermissionsByDefault`

Interactive runtime sessions default to the native pty host. The host uses a Farming-specific local socket derived from `configDir`, keeps PTY processes outside the Farming server process, and exposes recovery metadata to the server after restarts. By default, server shutdown preserves the host for restart recovery; after the last live session and client disappear, the host shuts itself down after a short idle grace period. Set `FARMING_NATIVE_PTY_HOST_PERSIST=0` only when the host should die with the server. Avoid adding alternate terminal-runtime paths when improving product behavior.

The product CLI defaults to:

- port `6694`;
- base path `/farming`;
- config directory `~/.farming`;
- token auth enabled.

The startup token is stored in `~/.farming/.session-token` and must be reused across restarts and upgrades unless `FARMING_TOKEN` explicitly overrides it. New token generation uses locale `auto`: Chinese time zones produce Chinese haiku-style tokens, Japanese time zones produce Japanese haiku-style tokens, and other time zones produce English passphrases.

In-app upgrades are disabled unless `FARMING_UPDATE_MANIFEST_URL` explicitly points at an HTTP(S) JSON manifest. Do not add default GitHub release polling; unconfigured users should upgrade manually. Configured manifests may declare `version` plus `tarUrl`, or an `assets` array with an `app-bundle` tarball.

## Development Commands

```bash
npm install
npm run build
npm test
npm run typecheck
npm run lint
npm run check
```

Local source smoke for the product path:

```bash
PORT=6695 FARMING_PORT=6695 FARMING_BASE_PATH=/farming FARMING_DISABLE_AUTH=1 npm start
```

Use another port when `6694` is already occupied. When serving the source build under `/farming`, the Vite build and the backend server must use the same `FARMING_BASE_PATH=/farming`. If you split the steps, run `FARMING_BASE_PATH=/farming npm run build` before `FARMING_BASE_PATH=/farming node backend/server.js`; otherwise `dist/index.html` points at `/assets/...` and the browser page white-screens because JS/CSS assets 404.

Playwright UI tests:

```bash
npm run test:e2e:playwright
npm run test:e2e:playwright:update
```

Product screenshot refresh:

```bash
npm run docs:product:screenshots
```

Packaging:

```bash
npm run release:cli
npm run release:cli:all
npm run release:app
```

Pre-release gate for public versions:

- Start from a clean worktree. Bump `package.json` and `package-lock.json` before creating a new release tag; never move or reuse an existing `vX.Y.Z` tag.
- Run the fast source checks first: `npm test`, `npm run typecheck`, `npm run lint`, and `FARMING_BASE_PATH=/farming npm run build`.
- Run focused Playwright specs for changed UI surfaces. Prefer small, targeted browser checks during iteration, then broaden only when the changed surface warrants it.
- Add or update `release-notes/vX.Y.Z.md` for the release. The package version, Git tag, and release note filename must match exactly, and the GitHub Release body should come from that file rather than a generic inline note.
- Before pushing to GitHub, scan the full outgoing diff for secrets, private hosts, tokens, personal machine paths, company-internal environment names, and internal vendor/tool names. Public release notes and docs must not mention private deployment hosts or local security tooling names; keep those details in local-only ignored files or private handoff notes.
- Do a human-like smoke on the local Mac browser: create and switch Codex / Claude / shell agents, type through the terminal and composer, verify Chinese IME, select/copy terminal text, click file/path links, pin/unpin, archive, refresh/reconnect, and watch obvious CPU/memory behavior.
- For macOS release artifacts, explicitly record whether the binary is ad-hoc signed, Developer ID signed, or notarized. If it is not notarized, verify and document the first-run security allow behavior instead of treating a manually allowed smoke as a clean first-run experience.
- Do a human-like smoke on the configured remote Linux dogfood environment with token auth: agent creation, terminal input/output, refresh/reconnect, archive cleanup, native pty host recovery, and process-count cleanup.
- Verify the remote Linux instance has only the intended Farming service/listener and no leaked old Farming server, native pty host, bash, zsh, Codex, or Claude processes from previous deploys.
- Build release artifacts through the repo release scripts or GitHub release workflow, not by committing generated bundles.
- Guard packaged dependencies: when packaging-related files change, compare package contents or manifests against the previous release so an update cannot accidentally drop required production dependencies, native assets, runtime files, or install scripts.
- Smoke-test the built CLI/app bundle artifacts, not only the source checkout.
- Push the release commit first, then push the new `vX.Y.Z` tag. Watch the GitHub Release workflow and confirm Linux/macOS artifacts, checksums, manifest, and the GitHub Release page using `release-notes/vX.Y.Z.md` exist before calling the release done.

## Testing Expectations

- Backend tests live in `backend/tests/`.
- Browser and visual flows live in `tests/e2e/`.
- Use fake coding agents for deterministic CI-style checks.
- Real Codex / Claude smoke tests must be explicit, low-volume, and isolated.
- Critical desktop and mobile visual states should be covered by Playwright screenshots where practical.
- Main Projects page membership for Codex / Claude history sessions is covered by `backend/tests/test-code-main-page-session.js`; update it when changing `mainPageSessionKeys` behavior.

## Files And Editor

Project Files are scoped to a concrete project agent. Main Agent rows should not show Files. The file service must keep all operations inside the workspace root and support:

- lazy directory tree loading;
- text read and save with version checks;
- create / rename / delete / move;
- file search through ripgrep where available;
- git status / diff / blame;
- bounded file watching when enabled.

The frontend should keep the Files section in the project scroll flow rather than adding a second nested scrollbar. The editor is a lightweight intervention surface, not a full IDE replacement.

## Main Agent

The Main Agent is a long-term product mechanism, not just another chat. It should help observe running agents, summarize progress, identify blocked or stale work, and coordinate child agents when useful. It should not spawn child agents just because it can.

The Main Agent control CLI and skill files are generated by backend code. The canonical public development instructions remain this `AGENTS.md`.

## Release And Open Source Hygiene

- Do not commit release binaries.
- Do not commit internal hosts, private paths, personal machine names, or private documentation links.
- Do not commit secrets or authentication tokens.
- Keep config examples generic.
- Product screenshots must use anonymous demo workspaces and example hostnames.
