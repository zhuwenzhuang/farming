# Third Party Notices

Farming is licensed under the MIT License. This file summarizes third-party
software and external tools that Farming bundles, depends on, or interoperates
with.

## Bundled Production Dependencies

Farming's app bundle installs production npm dependencies from `package.json`
and `package-lock.json`. As of this snapshot, the production dependency tree
contains 115 npm packages with these license families:

| License | Package count |
| --- | ---: |
| MIT | 107 |
| BSD-3-Clause | 3 |
| ISC | 2 |
| BSD-2-Clause | 1 |
| BSD-3-Clause AND Apache-2.0 | 1 |
| MPL-2.0 OR Apache-2.0 | 1 |

The package-level license files are preserved in bundled `node_modules` when
the app bundle is built with bundled dependencies enabled.

## Direct Runtime Dependencies

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.2.1 | Apache-2.0 | ACP JSON-RPC client and protocol types |
| `@agentclientprotocol/codex-acp` | 1.1.2 | Apache-2.0 | Codex ACP adapter |
| `@agentclientprotocol/claude-agent-acp` | 0.58.1 | Apache-2.0 | Claude Code ACP adapter |
| `@xterm/addon-clipboard` | 0.2.0 | MIT | Browser terminal clipboard integration |
| `@xterm/addon-fit` | 0.11.0 | MIT | Browser terminal sizing |
| `@xterm/addon-search` | 0.16.0 | MIT | Browser terminal search |
| `@xterm/addon-serialize` | 0.14.0 | MIT | Terminal screen serialization |
| `@xterm/addon-webgl` | 0.19.0 | MIT | CRT terminal GPU renderer |
| `@xterm/headless` | 6.0.0 | MIT | Backend terminal screen state |
| `@xterm/xterm` | 6.0.0 | MIT | Browser terminal renderer |
| `ansi-to-html` | 0.7.2 | MIT | ANSI text rendering support |
| `chokidar` | 5.0.0 | MIT | Filesystem watching |
| `express` | 4.22.1 | MIT | HTTP API server |
| `ghostty-web` | 0.4.0 | MIT | Optional/debug terminal renderer assets |
| `material-icon-theme` | 5.36.1 | MIT | File and folder icons |
| `monaco-editor` | 0.55.1 | MIT | Lightweight code editor |
| `node-pty` | 1.2.0-beta.12 | MIT | Native pseudo-terminal integration |
| `react` | 19.2.4 | MIT | Frontend UI framework |
| `react-arborist` | 3.10.5 | MIT | Tree view UI |
| `react-dom` | 19.2.4 | MIT | React DOM renderer |
| `ripgrep` | 0.3.1 | MIT | Node wrapper for file search support |
| `systeminformation` | 5.31.5 | MIT | Machine status collection |
| `ws` | 8.20.0 | MIT | WebSocket server/client support |

## Vendored Assets

Farming vendors `ghostty-web` distribution files under
`frontend/vendor/ghostty-web` for the optional Ghostty debug renderer. The
source package is `ghostty-web` 0.4.0, licensed under MIT. Its license is kept
beside the vendored files at `frontend/vendor/ghostty-web/LICENSE`.

If vendored assets are updated, keep this notice in sync with the package name,
version, and license.

The CRT skin bundles one font file under `frontend/skins/crt/fonts/`:

| Font | License | Purpose |
| --- | --- | --- |

The corresponding license texts are stored beside the font files.

## Bundled Data

Farming includes a generated Chinese poetic token word list at
`backend/data/chinese-poetic-words.json`. It is derived from the
`chinese-poetry/chinese-poetry` dataset, licensed under MIT:
https://github.com/chinese-poetry/chinese-poetry.

The generated file stores the source commit and selected corpus directories.
The original corpus is not bundled in the runtime package.

## Development And Build Dependencies

Farming also uses development-time tools such as TypeScript, Vite, ESLint,
Playwright, Puppeteer, esbuild, and package builders. These tools are not part
of the app runtime dependency set unless a release artifact explicitly embeds
their code.

## External Interoperability

Farming can launch or observe coding-agent CLIs installed by the user, including
OpenCode and the terminal forms of OpenAI Codex CLI and Anthropic Claude Code.
The optional structured ACP runtime includes the pinned Codex and Claude ACP
adapter dependency trees, including the provider SDK/runtime packages required
by those adapters. Those packages remain separate projects governed by their
own terms and licenses; package-level license files remain in `node_modules`.

Farming is not affiliated with, sponsored by, or endorsed by OpenAI, Anthropic,
Microsoft, or the maintainers of the third-party projects listed above.

## Design References

Farming's interface is influenced by modern coding workbenches and agent tools,
including Codex, Visual Studio Code, and browser IDEs. This notice covers
software and assets used by Farming; design inspiration alone does not imply
that those projects are bundled with Farming.

The CRT skin also studies the visual behavior of cool-retro-term. Farming's
browser shaders are an independent implementation and do not copy or bundle
cool-retro-term source code.
