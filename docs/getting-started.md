# Getting Started

> Chinese version: [getting-started.zh_cn.md](./getting-started.zh_cn.md)

The maintained guide is on the public documentation site:

- [Installation and updates](https://zhuwenzhuang.github.io/farming/en/get-started/installation)
- [Quick start](https://zhuwenzhuang.github.io/farming/en/get-started/quickstart)

With Node.js 22.13+ (22.x) or 24+ and npm's bin directory in PATH:

```bash
npm install --global farming-code@latest
farming daemon
```

Without system Node.js, or on a supported older Linux host, use the user-directory installer:

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | bash
~/.local/bin/farming daemon
```

Open an authenticated URL printed by the daemon and choose **New Agent**.
Provider authentication must already work on the Farming Host.
