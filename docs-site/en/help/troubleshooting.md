# Troubleshooting

First identify the failing layer: Farming service, Provider, Project, Browser, or an experimental capability.

## Farming does not open

```bash
farming status
farming logs
```

If the service is stopped, run `farming daemon`. If it works on the Host but not another device, inspect network reachability, firewall, reverse proxy, and the address. Do not expose an unprotected service publicly for a quick test.

## `farming` is missing after installation

```bash
npm config get prefix
command -v farming
```

On macOS and Linux, the executable is usually under the Prefix's `bin/` directory. Put that directory in `PATH` and reopen the shell. Do not work around installation by copying executables into random system directories.

## Port or configuration conflict

Run `farming status` to see whether the current configuration directory already owns a Server. For another instance, use a separate directory and port:

```bash
farming daemon --port 6794 --config-dir /path/to/another-farming-config
```

Never share a mutable configuration directory or stop an unidentified PID.

## Agent fails to start

1. Start the coding CLI in a normal Host shell.
2. Confirm authentication.
3. Confirm that the Workspace exists and Farming can access it.
4. Return to Farming and start the Agent again.

An executable alone does not prove valid login, model, or Session capability.

## Chat stalls or disconnects

Inspect current Agent state, reopen or refresh it, and check files and Git state. Do not immediately repeat a modification request while the prior outcome is uncertain.

## Terminal has no output

Confirm that the Agent is running and not waiting for input. Reopen Terminal to restore backend state and inspect service logs for PTY or process errors.

## Browser is unavailable

```bash
farming capabilities
farming browser capability
```

Open **Plugins → Browser** for source and dependency state. Ordinary installation does not download isolated Browser dependencies. For local Browser failure, verify the Host installation; for isolated Browser failure, check container runtime, disk space, and the earliest preparation error.

## Update fails

Record current version, target version, and installation source from Settings, then read `farming logs`. Do not repeatedly click update after an ambiguous network result.

For an npm installation:

```bash
npm install --global farming-code@latest
```

Restart Farming and confirm the actual version in Settings.

## Files cannot read a path

Confirm that the path belongs to the current Project Workspace and does not escape through a symlink. Narrow large searches by path and query.

## Language Server is unavailable

Open **Plugins → Farming** and check the Server state and Project for that language. Save the file before retrying cross-file navigation or hierarchy queries.

## Experimental capability fails

Desktop and Computer Use may be unavailable when dependencies or remote-environment prerequisites are missing. Mark the report as experimental and include prerequisites, steps, and visible errors.

## Report an issue

Provide the Farming version, Host OS and Node.js version, Provider or capability, minimal reproduction, exact visible error, and a relevant sanitized log excerpt in [GitHub Issues](https://github.com/zhuwenzhuang/farming/issues).

Logs belong to a specific configuration instance. When using `--config-dir`, read logs from the same instance and search near the failure time rather than posting the complete long-term log.
