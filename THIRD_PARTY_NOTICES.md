# Third Party Notices

Farming is licensed under the MIT License. This file summarizes third-party
software and external tools that Farming bundles, depends on, or interoperates
with.

## Bundled Production Dependencies

Farming's app bundle installs the production dependency tree pinned by
`package.json` and `package-lock.json`. Package-level license files are
preserved in bundled `node_modules` when bundled dependencies are enabled.

## Direct Runtime Dependencies

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@agentclientprotocol/sdk` | 1.2.1 | Apache-2.0 | ACP JSON-RPC client and protocol types |
| `@modelcontextprotocol/sdk` | 1.29.0 | MIT | Browser Extension MCP server and stdio transport |
| `@xterm/addon-clipboard` | 0.2.0 | MIT | Browser terminal clipboard integration |
| `@xterm/addon-fit` | 0.11.0 | MIT | Browser terminal sizing |
| `@xterm/addon-search` | 0.16.0 | MIT | Browser terminal search |
| `@xterm/addon-serialize` | 0.14.0 | MIT | Terminal screen serialization |
| `@xterm/addon-webgl` | 0.19.0 | MIT | CRT terminal GPU renderer |
| `@xterm/headless` | 6.0.0 | MIT | Backend terminal screen state |
| `@xterm/xterm` | 6.0.0 | MIT | Browser terminal renderer |
| `@zumer/snapdom` | 2.23.1 | MIT | Pet rest-scene DOM capture |
| `ansi-to-html` | 0.7.2 | MIT | ANSI text rendering support |
| `chokidar` | 5.0.0 | MIT | Filesystem watching |
| `compression` | 1.8.1 | MIT | HTTP response compression |
| `diff` | 9.0.0 | BSD-3-Clause | Character-level diff ranges for code review |
| `express` | 4.22.2 | MIT | HTTP API server |
| `extract-zip` | 2.0.1 | BSD-2-Clause | Managed Chromium archive extraction |
| `highlight.js` | 11.11.1 | BSD-3-Clause | Syntax highlighting |
| `katex` | 0.17.0 | MIT | Mathematical notation rendering |
| `material-icon-theme` | 5.36.1 | MIT | File and folder icons |
| `mermaid` | 11.16.0 | MIT | Diagram rendering |
| `monaco-editor` | 0.55.1 | MIT | Lightweight code editor |
| `node-pty` | 1.2.0-beta.12 | MIT | Native pseudo-terminal integration |
| `qrcode-generator` | 2.0.4 | MIT | Browser share QR generation |
| `react` | 19.2.4 | MIT | Frontend UI framework |
| `react-arborist` | 3.10.5 | MIT | Tree view UI |
| `react-dom` | 19.2.4 | MIT | React DOM renderer |
| `react-markdown` | 10.1.0 | MIT | Markdown rendering |
| `rehype-highlight` | 7.0.2 | MIT | Markdown syntax-highlighting integration |
| `rehype-katex` | 7.0.1 | MIT | Markdown math rendering integration |
| `remark-gfm` | 4.0.1 | MIT | GitHub Flavored Markdown support |
| `remark-math` | 6.0.0 | MIT | Markdown math syntax support |
| `ripgrep` | 0.3.1 | MIT | Node wrapper for file search support |
| `tar` | 7.5.19 | BlueOak-1.0.0 | Safe extraction of version-locked startup dependency archives |
| `ws` | 8.21.0 | MIT | WebSocket server/client support |
| `yaml` | 2.9.0 | ISC | YAML parsing |
| `zod` | 3.25.76 | MIT | MCP tool input schema validation |

## Vendored Assets

Farming builds version- and SHA-256-locked ACP runtime files from these exact
development dependencies and ships their license texts beside the runtime
files under `dist/acp/`:

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@agentclientprotocol/codex-acp` | 1.1.4 | Apache-2.0 | Reviewed and patched Codex ACP adapter |
| `@openai/codex` | 0.144.6 | Apache-2.0 | Codex executable discovery and launch bridge; platform CLI binaries are excluded |
| `@agentclientprotocol/claude-agent-acp` | 0.59.0 | Apache-2.0 | Claude Code ACP adapter |
| `@anthropic-ai/claude-agent-sdk` | 0.3.207 | Anthropic commercial terms | Claude Agent SDK bridge; platform CLI binaries are excluded |

Before starting a fresh Server, Farming may prepare the exact Codex CLI
0.144.6, Claude Agent SDK CLI package 0.3.207, and `agent-browser` 0.32.3
platform artifacts in its private runtime cache. They are not part of the npm
or application package and remain independent works under their own terms.
Farming accepts only the version-locked sources and integrity values declared
by its release manifest. The `agent-browser` license text is included at
`backend/data/LICENSE.agent-browser`.

The optional Computer plugin interoperates with the version-pinned Cua Driver
0.12.4 and `trycua/xfce-cua` container image. Farming does not bundle that
container image in its release package. Cua is licensed under MIT; its license
text is included at `backend/data/LICENSE.cua`.

Farming vendors `ghostty-web` distribution files under
`frontend/vendor/ghostty-web` for the optional Ghostty debug renderer. The
source package is `ghostty-web` 0.4.0, licensed under MIT. Its license is kept
beside the vendored files at `frontend/vendor/ghostty-web/LICENSE`.

If vendored assets are updated, keep this notice in sync with the package name,
version, and license.

Farming's TypeScript token-history scanner adapts the cumulative Codex
accounting and copied-prefix classification semantics from
[`CodexBar`](https://github.com/steipete/CodexBar) 0.45.2 at commit
`91560ca98e776b96fdf910d4a0423c2f0c07a3b9` (MIT, Copyright (c) 2026 Peter
Steinberger). It adapts Claude assistant usage extraction, streaming message-id
deduplication, and cached-input normalization from
[`cc-statistics`](https://github.com/androidZzT/cc-statistics) 1.1.0 at commit
`c98be0af52bbc7f09a1f277747744ace48d9e014` (MIT, Copyright (c) 2026
androidZzT).

Farming does not bundle either application's runtime. The adapted TypeScript
scanner, incremental filesystem checkpoints, SQLite schema, scan budgeting,
and product result shape are maintained by Farming. Exact source files,
adaptation scope, revisions, and both MIT licenses are retained under
`backend/vendor/usage-parsers/`.

The CRT skin bundles one font file under `frontend/skins/crt/fonts/`:

| Font | License | Purpose |
| --- | --- | --- |

The corresponding license texts are stored beside the font files.

## Adapted Source Code

Farming's Git history swimlane transform and graph-row renderer adapt the
Visual Studio Code SCM history graph from Microsoft Visual Studio Code commit
`0217c2f1a0defc7fdbfb4feba74e71e366de6822`. The adapted files retain the
Microsoft copyright and MIT license header. Visual Studio Code is licensed
under the MIT License:
https://github.com/microsoft/vscode/blob/0217c2f1a0defc7fdbfb4feba74e71e366de6822/LICENSE.txt

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
The structured ACP runtime includes reviewed Codex and Claude adapter code, but
Farming does not bundle a platform Codex or Claude Code CLI inside its package.
The adapters use the exact system or verified startup-cache executable prepared
by the Farming launcher. Those tools remain separate projects governed by their
own terms and licenses.

Farming is not affiliated with, sponsored by, or endorsed by OpenAI, Anthropic,
Microsoft, or the maintainers of the third-party projects listed above.

## Design References

Farming Code's interface design references Visual Studio Code and Codex.
Farming's browser-based approach to terminal and coding-agent sessions also
draws on the idea explored by
[VibeTunnel](https://github.com/amantus-ai/vibetunnel). These design references
are separate from the software and assets identified above.
