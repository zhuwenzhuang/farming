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
| `@agentclientprotocol/sdk` | 1.3.0 | Apache-2.0 | ACP JSON-RPC client and protocol types |
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
| `highlight.js` | 11.11.1 | BSD-3-Clause | Syntax highlighting |
| `katex` | 0.17.0 | MIT | Mathematical notation rendering |
| `material-icon-theme` | 5.36.1 | MIT | File and folder icons |
| `mermaid` | 11.16.1 | MIT | Diagram rendering |
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
| `remark-parse` | 11.0.0 | MIT | Markdown syntax tree parsing for virtual preview sections |
| `tar` | 7.5.22 | BlueOak-1.0.0 | Safe extraction of version-locked startup dependency archives |
| `unified` | 11.0.5 | MIT | Markdown parser pipeline for virtual preview sections |
| `vscode-jsonrpc` | 9.0.1 | MIT | Language Server JSON-RPC stream transport |
| `vscode-languageserver-protocol` | 3.18.2 | MIT | Language Server Protocol types and contracts |
| `ws` | 8.21.0 | MIT | WebSocket server/client support |
| `yaml` | 2.9.0 | ISC | YAML parsing |
| `yauzl` | 3.4.0 | MIT | Validated managed ZIP archive parsing |
| `zod` | 3.25.76 | MIT | MCP tool input schema validation |

## Vendored Assets

Farming builds version- and SHA-256-locked ACP runtime files from these exact
development dependencies and ships their license texts beside the runtime
files under `dist/acp/`:

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| `@agentclientprotocol/codex-acp` | 1.6.0 | Apache-2.0 | Reviewed and patched Codex ACP adapter |
| `@openai/codex` | 0.148.0 | Apache-2.0 | Codex executable discovery and launch bridge; platform CLI binaries are excluded |
| `@agentclientprotocol/claude-agent-acp` | 0.70.0 | Apache-2.0 | Claude Code ACP adapter |
| `@anthropic-ai/claude-agent-sdk` | 0.3.232 | Anthropic commercial terms | Claude Agent SDK bridge; platform CLI binaries are excluded |
| `pi-acp` | 0.0.33 | MIT | Pi ACP adapter, with Farming Agent Home isolation and bootstrap patches |
| `@agentclientprotocol/sdk` | 0.26.0 | Apache-2.0 | Protocol runtime bundled inside the Pi ACP adapter |
| `zod` | 3.25.76 | MIT | Schema validation bundled inside the Pi ACP adapter |

Farming also embeds the pinned native ripgrep 15.2.0 executable for Project
Files search. ripgrep is dual-licensed under MIT or the Unlicense; Farming uses
it under the Unlicense.

The npm distribution declares the exact Codex CLI 0.148.0 and Claude Agent SDK
CLI package 0.3.232 platform carriers as optional dependencies and embeds the
reviewed `agent-browser` 0.32.3 platform artifacts. Other release forms may
prepare the same exact artifacts in a private runtime cache. These artifacts
remain independent works under their own terms. Farming accepts only the
version-locked sources and integrity values declared
by its release manifest. The `agent-browser` license text is included at
`backend/data/LICENSE.agent-browser`.

The optional Computer plugin interoperates with the version-pinned Cua Driver
0.12.4 and `trycua/xfce-cua` container image. Farming does not bundle that
container image in its release package. Cua is licensed under MIT; its license
text is included at `backend/data/LICENSE.cua`.

Farming's monochrome Pi launch icon is copied from the `pi-acp` entry in the
[ACP Registry](https://github.com/agentclientprotocol/registry/tree/0b3f7a7197452251a08d87ce8339fbbd707049f5/pi-acp),
which declares the agent under the MIT License, Copyright (c) 2025 Sergii
Kozak.

Farming's dynamic-pinning bell icon is copied from
[Lucide Icons](https://lucide.dev/icons/bell), licensed under the ISC License,
Copyright (c) 2026 Lucide Icons and Contributors.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

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

Farming Browser Connector and its CDP relay adapt the OpenClaw Browser Chrome
extension and extension-relay implementation from commit
`57fabb2c9c35db79956c9aa1e9a1956b09d9a39e`. OpenClaw is licensed under the
MIT License, Copyright (c) 2026 OpenClaw Foundation. Farming keeps the upstream
revision and transformation scope at
`extensions/browser/chrome-extension/upstream/upstream.json`; the retained MIT
license is stored beside it as `LICENSE.openclaw`. Farming changes product,
protocol, Native Messaging Host, alarm, and tab-group namespaces so the Farming
and OpenClaw extensions can be installed together without sharing pairing data
or browser authority.

Farming's managed Language Server registry, root discovery, stdio client, and
launch behavior adapt the OpenCode LSP implementation from commit
`1882c33827cf0ce5c948b69ab5a87ed8f6790cf8`. OpenCode is licensed under the
MIT License, Copyright (c) 2025 opencode. The retained license is stored at
`extensions/language-server/backend/LICENSE.opencode`.

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
