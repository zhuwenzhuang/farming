# Installation and updates

Choose one installation method. Both download from npm and start separately through the Farming CLI.

| Method | Use when | Runtime |
| --- | --- | --- |
| npm | Supported Node.js and npm are already available | Uses your Node.js and npm |
| Directory installation | Node.js is missing or Linux needs compatibility libraries | Provides private Node.js, npm, and supported Linux compatibility libraries |

## npm installation

Requires Node.js 22.13+ (22.x) or 24+, a writable npm global prefix, and npm's bin directory in PATH. On Linux, use a modern glibc host (2.28+); for older hosts, use the user-directory installer.

```bash
npm install --global farming-code@latest
farming daemon
```

This method uses your existing Node.js and npm configuration; it does not configure PATH or prepare an older host's system environment.

## Directory installation

The installer provides private Node.js and npm. This is a separate application directory, not a project-local `npm install`.

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | bash
```

No sudo or system Node.js is required. The installer only installs; repeating it preserves the existing installation without starting or restarting Farming. Update it through Settings.

The default program directory is `~/.local/share/farming/app` (`XDG_DATA_HOME` is respected). The command is `~/.local/bin/farming`; add `~/.local/bin` to `PATH` to use the shorter `farming` command. The full CLI path below works without changing PATH.

Use your preferred npm registry:

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | FARMING_NPM_REGISTRY=https://registry.npmjs.org bash
```

Existing npm registry configuration is used when available. The selected registry is saved for later launches and updates. `FARMING_VERSION` selects an exact release; `FARMING_INSTALL_ROOT` and `FARMING_BIN_DIR` select absolute installation paths. For a custom bin directory, use the CLI startup command printed by the installer.

The npm download cache and retained update versions stay inside the installation directory. A custom directory on another disk does not require separate cache settings.

## Start the background service

```bash
~/.local/bin/farming daemon
```

Open an authenticated URL printed by the CLI. Farming normally uses its own configuration directory and port. Pass `--config-dir`, `--port`, or `--base-path` only when isolating instances or resolving a port conflict.

## Update

Both methods support **Settings → Updates**. After preparation completes, restart the service when prompted. Re-running the user-directory installer does not upgrade the installation.

The updater uses npm in a private staging directory and retains the prior application and runtime for startup failure recovery. It does not replace the machine's Node.js or npm installation.

Before updating, check important running Agents and save any work you need. Do not repeatedly replay side-effecting operations after an ambiguous network failure.

## Uninstall

For an npm global installation, stop its Config instances, then uninstall with the same npm:

```bash
farming stop
npm uninstall --global farming-code
```

For a user-directory installation, stop the service first:

```bash
~/.local/bin/farming stop
```

After stopping every Config using this installation, remove its program directory and the `~/.local/bin/farming` symlink. This also removes its private npm cache and retained update versions. Configuration and history under `~/.farming` remain separate.

## Platforms

The user-directory installer targets macOS x64/arm64 and glibc Linux x64/arm64. Linux requires glibc 2.28+, with a private compatibility runtime for x64 hosts on glibc 2.17–2.27. It still requires Bash, curl, tar, and OpenSSL. It does not support musl Linux or older glibc, upgrade system libraries, modify shell startup files, or configure startup at boot. Provider login is still required; external project tools retain their own system requirements.
