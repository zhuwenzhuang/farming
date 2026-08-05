# Agent control commands

Agent control commands support bounded automation. Except for `skills`, most commands connect to a running Farming instance and read that instance's Token.

## Connection and authentication

By default, the CLI discovers the address and Token from the default configuration instance. Pass `--config-dir <path>` for another instance.

Inside a Farming Agent Runtime, the CLI also receives the current Agent identity. `FARMING_CONTROL_URL` and `FARMING_TOKEN_FILE` can override discovery for external automation, but are not ordinary required settings.

Missing authentication, connection failures, HTTP errors, and timeouts return non-zero exit codes.

```bash
farming list --config-dir /path/to/farming-config --json
```

## Commands

| Command | Result |
| --- | --- |
| `farming skills` | Print Farming Skill guidance for the Main Agent |
| `farming capabilities [--json]` | Read Browser and experimental Computer capability |
| `farming list [--json] [--parent <agentId>]` | List Agents, optionally by Parent |
| `farming spawn [options] -- <command...>` | Start an Agent or command in a Workspace |
| `farming output <agentId> [--tail <chars>]` | Read recent Agent output |
| `farming send <agentId> <text...>` | Send one line of input |
| `farming title <concise-title...>` | Update the current Runtime's title |
| `farming kill <agentId>` | Stop and delete an Agent |

## skills and capabilities

`farming skills` takes no arguments and does not need a Server. `farming capabilities --json` reports current Browser and Computer availability with the next supported command.

## list

```bash
farming list
farming list --json
farming list --parent "$FARMING_AGENT_ID"
```

Automation should use JSON rather than parsing human output.

## spawn

```bash
farming spawn --workspace /repo --task "Run focused tests and summarize failures" -- codex
farming spawn --workspace /repo --json -- bash -lc "npm test"
```

```text
farming spawn [--workspace <path>] [--task <text>]
  [--parent <agentId>] [--json] -- <command...>
```

The executable cannot be empty. Arguments remain distinct; callers do not need to reconstruct a shell string.

## output and send

`farming output agent-123 --tail 2000` reads recent characters. Missing Agents and unreadable output fail explicitly.

`farming send agent-123 "Run the new regression test"` appends Enter. A transport timeout is uncertain; inspect output before resending.

## title

```bash
farming title "Fix History request ordering"
```

`title` works only inside the current Farming Agent Runtime, where Agent identity and title authorization are available.

## kill

```bash
farming kill agent-123
```

This is destructive. Verify the exact Agent ID with `list` and `output`, and confirm that its runtime state and Resources are no longer needed.

## Browser and Computer

- `farming browser --help`: Browser Resources, navigation, interaction, and inspection.
- `farming computer --help`: experimental Computer tools and workflow.

See the [Agent Browser workflow](../browser/agent-workflow).
