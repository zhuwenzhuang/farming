---
pageClass: quickstart-page
description: Install Farming, start a coding Agent, and complete a verifiable first task in five steps.
---

# Quick start

Follow these five steps to install Farming, start a coding Agent, and complete a verifiable first task.

## Prepare the host

You need:

- macOS or Linux;
- Node.js 22.13 LTS (22.x) or Node.js 24+;
- at least one coding Agent that already starts successfully, such as Codex, Claude Code, or OpenCode.

Farming does not replace provider authentication. Sign in to the corresponding CLI on the development machine and confirm that it can start independently.

::: tip Checkpoint
On the same development machine, the target coding Agent CLI starts without waiting for sign-in or initial setup.
:::

## Install and open Farming

```bash
npm install --global farming-code@latest
farming daemon
```

`farming daemon` starts the background service and prints one or more authenticated URLs. On the same machine, open the local address.

::: warning Protect authenticated URLs
The Token in an authenticated URL grants access to Farming. Do not put it in public logs, screenshots, issues, or chat messages.
:::

::: tip Checkpoint
The browser shows Farming Code with **New Agent** in the upper-left corner.
:::

## Start your first Agent

1. Choose **New Agent** in the upper-left corner.
2. Select a coding Agent.
3. Select the Workspace that contains your repository.
4. Choose Chat or Terminal, then create the Agent.

<ThemeImage light="/cn/assets/start-agent.png" dark="/cn/assets/start-agent-dark.png" alt="Select a coding Agent" />

Chat is best for reading structured progress and results. Terminal is best for direct interaction with the native CLI. Both run on the Farming Host, not in the browser.

::: tip Checkpoint
The new Agent page shows the intended Workspace and either the Chat or Terminal interface.
:::

## Complete a read-only task

Start with something small and verifiable:

```text
Explain how this repository runs its tests, then find one small module that a new
contributor could understand. Do not modify files. List the key entry points,
relevant tests, and the commands you actually checked.
```

Then follow the work:

1. Read the Agent's progress and final result in Chat.
2. Open important files mentioned by the Agent and confirm that the paths and code exist.
3. Switch to Terminal, or ask for a focused command, when you need native output.
4. If evidence is missing, ask for it explicitly—for example, “Run the test you mentioned and report the exact command and result.”
5. When the result is verified, give the Agent a searchable title and archive completed work.

::: tip Checkpoint
The result includes file paths, test locations, and command output that you can verify independently.
:::

## Try a small change

After a read-only task, try a narrowly scoped edit:

```text
Fix one clearly outdated command in the README. Change only the relevant paragraph,
preserve the existing writing style, and check adjacent links. Explain the change
and how you verified it.
```

Check whether the Agent:

- changed only the requested scope;
- opened or searched authoritative files;
- ran verification appropriate to the risk;
- clearly separated verified and unverified results.

See [Verify and finish](../workflows/verify-and-finish) for the full workflow.

::: tip Checkpoint
You inspected the actual file changes and can distinguish what the Agent verified from what remains unverified.
:::

## What happens when the browser closes?

Closing the tab does not automatically stop running Agents. Reopen the same Farming address to continue.

To print the address again:

```bash
farming url
```

If the service is not running, start it again with `farming daemon`.

## Next

- [Farming Code overview](../code/overview)
- [Understand a codebase](../workflows/understand-a-codebase)
- [Find and fix a problem](../workflows/fix-a-problem)
- [Use Farming from a phone or another computer](../code/mobile-and-remote)
- [Troubleshooting](../help/troubleshooting)
