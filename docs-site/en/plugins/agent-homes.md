---
description: Configure multiple Homes for one coding Agent and select the corresponding account and configuration when starting an Agent.
---

# Agent Homes

An Agent Home stores a coding Agent's authentication, configuration, and extensions. Farming supports several Homes for one Provider so work, personal, and team environments remain separate.

## Configure multiple Homes

Open **Plugins → Agent Homes**, choose **Add Agent**, then enter:

- **Provider**: Codex, Claude Code, OpenCode, Qoder, or Qwen Code;
- **Home path**: the independent directory used by this configuration;
- **Home name**: a stable label such as `work` or `personal`.

Homes must use different directories. Reordering changes only the selection order for new Agents; it does not change existing Session identity.

## Switch accounts

When creating an Agent, select both the coding Agent and its Home. Farming binds the Session to that Provider and Home:

- the new Agent uses authentication and configuration from the selected Home;
- History and resume continue with the original Home;
- deleting, renaming, or reordering configuration does not silently move an existing Session to another account;
- to change accounts, create or resume the correct Session with the target Home.

## Extensions by Home

The **Extensions** tab shows discovered Skills, MCP servers, Hooks, Plugins, and Commands grouped by Home. Work and personal accounts can therefore use different tool sets with visible provenance.

## Suggestions

- Use short, stable names such as `work`, `personal`, or `team-a`.
- Never point two Homes at the same directory.
- Do not copy or expose Tokens, Cookies, or private configuration just to switch accounts.
- Before removing a Home, check for historical Sessions that still need it.
- An unavailable Provider configuration may remain visible, but cannot start a new Agent.
