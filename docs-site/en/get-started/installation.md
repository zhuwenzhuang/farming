# Installation and updates

## Install

Run these commands on the Mac or Linux host where your Agents will run:

```bash
npm install --global farming-code@latest
farming daemon
```

Open the address printed in the terminal to create your first Agent.

## Dependencies

- Node.js and npm. The current Node.js LTS release is recommended.
- Linux needs `ps`, which most distributions include. On minimal systems, install `procps` or `procps-ng`.
- Sign in to the relevant provider when prompted before using an Agent.

## Update

Check **Settings → Updates** and restart when prompted. You can also update through npm:

```bash
farming stop
npm install --global farming-code@latest
farming daemon
```

Save ongoing work before stopping Farming; its Agents will also stop.

## Uninstall

```bash
farming stop
npm uninstall --global farming-code
```

Configuration and history remain in `~/.farming`.
