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

The installer provides private Node.js and npm. This is a separate application directory, not a project-local `npm install`. This example chooses `$HOME/farming`:

```bash
curl -fLO https://zhuwenzhuang.github.io/farming/farming_install.sh
bash farming_install.sh --dir ~/farming
```

You can also <a href="../../farming_install.sh" download="farming_install.sh">download the installer</a>
in a browser with a current CA trust store. If the browser is on another machine,
transfer the file to the development machine over SSH, then run it from the download directory:

```bash
bash farming_install.sh --dir ~/farming
```

This avoids connecting to the documentation site from the development machine;
HTTPS certificate verification for the npm registry is still required.

No sudo or system Node.js is required. The installer only installs; repeating it preserves the existing installation without starting or restarting Farming. Update it through Settings.

The example's program and launcher are at `$HOME/farming` and `$HOME/farming/farming`. Without `--dir` or `FARMING_INSTALL_ROOT`, the default program directory is `~/.local/share/farming/app` (`XDG_DATA_HOME` is respected). The installer also creates a command link at `~/.local/bin/farming` by default; it points to the chosen program directory and is optional for the commands shown here.

Use your preferred npm registry:

```bash
FARMING_NPM_REGISTRY=https://registry.npmjs.org bash farming_install.sh --dir ~/farming
```

Existing npm registry configuration is used when available. The selected registry is saved for later launches and updates. `FARMING_VERSION` selects an exact release; `FARMING_INSTALL_ROOT` and `FARMING_BIN_DIR` select absolute installation paths. For a custom bin directory, use the CLI startup command printed by the installer.

For downloads on networks in mainland China, explicitly enable the mirror:

```bash
bash farming_install.sh --dir ~/farming --mirror cn
```

This uses npmmirror for package downloads and npm dependencies, while official npm
still supplies the Farming version and archive integrity digests. It overrides
the configured registry for this installation without changing your npm settings.
Missing or failed mirror archive downloads fall back to the same official
artifact with a visible message; checksum failures stop installation. Official
npm metadata must remain reachable. Updates retain official version checks and
the preferred download mirror, so a stale mirror tag cannot select an old release.

The installer reports download progress and each preparation stage. Once the
Farming package is verified, its pinned Node.js and npm archives download in parallel.

The npm download cache and retained update versions stay inside the installation directory. A custom directory on another disk does not require separate cache settings.

## Start the background service

```bash
cd ~/farming
./farming daemon
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
"$HOME/farming/farming" stop
```

After stopping every Config using this installation, remove the chosen program directory and its `~/.local/bin/farming` link. This also removes its private npm cache and retained update versions. Configuration and history under `~/.farming` remain separate.

## Platforms

The user-directory installer targets macOS x64/arm64 and glibc Linux x64/arm64. Linux requires glibc 2.28+, with a private compatibility runtime for x64 hosts on glibc 2.17–2.27. It still requires Bash, curl, tar, and a SHA-512 verifier: `sha512sum` or `shasum` with `base64` and `od`, or OpenSSL. It does not support musl Linux or older glibc, upgrade system libraries, modify shell startup files, or configure startup at boot. Provider login is still required; external project tools retain their own system requirements.

Run each step separately and proceed only after it succeeds. `--dir` overrides `FARMING_INSTALL_ROOT`.
Older systems must have an up-to-date CA trust store before downloading the installer.
For `curl: (60)` errors, update the system CA certificates through your trusted OS source,
or supply a trusted CA bundle with `CURL_CA_BUNDLE`. Do not disable TLS verification.
The installer does not change system certificates or install system packages.
