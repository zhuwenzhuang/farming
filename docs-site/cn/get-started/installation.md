# 安装与更新

## 安装

在运行 Agent 的 Mac 或 Linux 主机上执行：

```bash
npm install --global farming-code@latest --registry=https://registry.npmjs.org
farming daemon
```

打开终端输出的访问地址，就可以创建第一个 Agent。

上述命令仅为本次安装指定 npm 官方源，不会修改你的 npm 配置。第三方镜像的 `latest` 可能落后；如果安装后仍显示旧版本，请用上述命令更新并在 Settings 中确认版本。

## 依赖

- Node.js 和 npm，建议使用当前 Node.js LTS 版本。
- Linux 需要 `ps` 命令，常见发行版已自带；精简系统可安装 `procps` 或 `procps-ng`。
- 使用 Agent 前，按提示登录对应的服务账号。

## 更新

在 **Settings → Updates** 中检查更新，按提示重启。也可以通过 npm 更新：

```bash
farming stop
npm install --global farming-code@latest --registry=https://registry.npmjs.org
farming daemon
```

停止前请保存正在进行的工作；停止 Farming 也会停止其 Agent。

## 卸载

```bash
farming stop
npm uninstall --global farming-code
```

配置和历史仍保留在 `~/.farming`。
