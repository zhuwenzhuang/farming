---
description: Understand built-in Farming capabilities, Agent Homes, Agent extensions, and experimental features.
---

# Plugins

The Plugins page manages additional capabilities available to Farming and coding Agents. It contains three groups:

- **Farming**: Browser, Computer, Language Server, and Desktop Connections;
- **Agent Homes**: one or more Homes for Codex, Claude Code, OpenCode, Qoder, and Qwen Code;
- **Extensions**: Skills, MCP servers, Hooks, Plugins, and Commands discovered in each Agent Home.

Opening Plugins performs a fresh read of capability and configuration state. Missing dependencies and read failures are shown explicitly instead of reusing stale results.

## Agent Homes

One coding Agent can have separate Homes for work, personal, or team accounts. Select a Home when starting an Agent to use its isolated authentication, configuration, and extensions.

<ThemeImage light="/cn/assets/agent-homes.png" dark="/cn/assets/agent-homes-dark.png" paper="/cn/assets/agent-homes-paper.png" alt="Multiple Agent Homes in Plugins" />

Continue with [Manage multiple Agent Homes](./agent-homes).

## Built-in capabilities

<div class="docs-card-grid">
  <a class="docs-card" href="../browser/overview"><strong>Farming Browser</strong><span>Let a person and Agent view and operate the same web page.</span></a>
  <a class="docs-card" href="../experimental/computer-use"><strong>Computer Use (Experimental)</strong><span>Full-desktop operation and control handoff.</span></a>
  <a class="docs-card" href="../experimental/language-server"><strong>Language Server</strong><span>Experimental definitions, references, symbols, and diagnostics.</span></a>
  <a class="docs-card" href="../experimental/desktop"><strong>Farming Desktop</strong><span>Experimentally connect to and switch among trusted Farming backends.</span></a>
</div>

Experimental features remain clearly labeled and are not automatically enabled merely because they appear in Plugins.

## Agent extensions

Extensions are grouped by exact Agent Home. Switching Home shows the Skills, MCP servers, Hooks, Plugins, and Commands discovered in that directory; Farming does not merge several Homes into one apparently shared account.
