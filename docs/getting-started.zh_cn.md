# 快速开始

> English version: [getting-started.md](./getting-started.md)

持续维护的用户说明位于在线文档站：

- [安装与更新](https://zhuwenzhuang.github.io/farming/cn/get-started/installation)
- [快速开始](https://zhuwenzhuang.github.io/farming/cn/get-started/quickstart)

已有 Node.js 22.13+（22.x）或 24+，且 npm 的 bin 目录已在 PATH 中：

```bash
npm install --global farming-code@latest
farming daemon
```

没有系统 Node.js，或使用受支持的旧 Linux 主机时，选择用户目录安装：

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | bash
~/.local/bin/farming daemon
```

打开 daemon 输出的带鉴权 URL，然后选择 **New Agent**。对应 Provider 必须已经能在
Farming Host 上完成登录并正常启动。
