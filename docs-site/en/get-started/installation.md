# Installation and updates

The recommended installation method is npm. It provides one `farming` command and supports update checks in Settings.

## Install with npm

```bash
npm install --global farming-code@latest
```

Confirm the installation:

```bash
farming --help
```

If the command is missing, make sure npm's global executable directory is in `PATH`.

## Start the background service

```bash
farming daemon
```

Farming normally uses its own configuration directory and port. Pass `--config-dir`, `--port`, or `--base-path` only when isolating instances or resolving a port conflict.

## Update

Open **Settings → Updates** to check for updates to an npm installation. After preparation completes, restart the service when prompted.

You can also update directly with npm:

```bash
npm install --global farming-code@latest
```

Before updating, check important running Agents and save any work you need. Do not repeatedly replay side-effecting operations after an ambiguous network failure.

## Uninstall

Stop the service first:

```bash
farming stop
npm uninstall --global farming-code
```

Removing the npm package does not automatically delete Farming configuration or history. Keep or remove those files according to whether you plan to reinstall.

## Platforms

Farming publicly supports macOS and Linux. Other platforms should not be considered validated to the same installation, runtime, and recovery standard.
