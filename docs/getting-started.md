# Getting Started

> Chinese version: [getting-started.zh_cn.md](./getting-started.zh_cn.md)

This guide takes you from installation to a running Agent.

## Requirements

- macOS or Linux
- Node.js 22.18 LTS (22.x) or Node.js 24+
- access to at least one supported coding Agent provider

Provider login is still required. If you use a locally detected CLI, make sure
that CLI can already start on the Farming host.

## Install And Start

```bash
npm install --global farming-code@latest
farming daemon
```

Open one of the authenticated URLs printed by `farming daemon`.

## Start The First Agent

1. Choose **New Agent**.
2. Select an Agent, workspace, and Chat or Terminal.
3. Send a task.

Closing the browser does not stop the Agent. In the same signed-in browser, run
`farming url` on the host to print the local address again. To sign in from a
new browser, use an authenticated URL from the `farming daemon` startup output.

## Next

- [Farming Code guide](products/code/README.md)
- [Farming Browser](products/code/browser-agent-cli.md)
- [Farming CRT guide](products/crt/README.md)
- [Remote use and operations](operations/README.md)
