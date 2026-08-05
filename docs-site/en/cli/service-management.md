# Service management

Farming can run continuously as a background service. Disconnecting the browser does not stop the service or Agents.

## Start

```bash
farming daemon
```

For temporary foreground output:

```bash
farming start
```

## Status

```bash
farming status
```

Use status to confirm whether the service is running and which instance owns it. Browser reachability alone is not authoritative service state.

## Address

```bash
farming url
```

This prints an address only when the current configuration instance is running. A new browser still needs valid authentication.

## Logs

```bash
farming logs
```

Before reporting a problem, capture only the necessary log lines near the failure and remove Tokens, private paths, repository content, and account information.

## Stop

```bash
farming stop
```

Stopping disconnects browsers and affects running Agents. Confirm that important work has reached a recoverable state.

## Custom instance parameters

```bash
farming daemon --port 6694 --base-path /farming --config-dir /path/to/config
```

Use an explicit, dedicated configuration directory. Never share one mutable root between instances or use a broad cleanup command across them.
