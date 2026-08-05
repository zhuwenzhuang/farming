# Farming CLI

The `farming` CLI starts and maintains the service and gives Agents an instance-exact entry point to capabilities such as Browser.

## Help

```bash
farming --help
```

| Command | Purpose |
| --- | --- |
| `farming daemon` | Start Farming in the background |
| `farming status` | Show service state |
| `farming url` | Print the current address |
| `farming logs` | Read service logs |
| `farming stop` | Stop the service |
| `farming capabilities` | Inspect current instance capabilities |
| `farming browser ...` | Use Farming Browser |

CLI URLs may contain access Tokens. Do not put them in public logs.

## Agent control commands

Farming can discover capabilities, list and start Agents, read output, send messages, and stop Agents. These commands primarily support Agent automation and controlled integrations; ordinary users should prefer Farming Code.

See [Agent control commands](./agent-control) for signatures and failure semantics.

## Browser CLI

Browser help is progressively disclosed:

```bash
farming browser --help
farming browser help workflow
farming browser help navigation
```

See the [Agent Browser workflow](../browser/agent-workflow).

## Configuration instances

Use a separate `--config-dir` only when isolating Farming instances. Each instance owns its configuration, process, and Resource identities; do not mix Tokens or cleanup paths.

Continue with [Service management](./service-management).
