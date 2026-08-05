# 安装与更新

Farming 推荐通过 npm 安装。这样可以使用统一的 `farming` 命令，并在设置中检查可用更新。

## npm 安装

```bash
npm install --global farming-code@latest
```

确认安装结果：

```bash
farming --help
```

如果命令不存在，请确认 npm 的全局可执行目录已经加入 `PATH`。

## 启动后台服务

```bash
farming daemon
```

默认情况下，Farming 使用自己的配置目录和端口。只有需要隔离不同实例或端口冲突时，才传入 `--config-dir`、`--port` 或 `--base-path`。

## 更新

打开 **Settings → Updates** 检查 npm 安装的更新。准备完成后，按页面提示重新启动服务。

也可以直接使用 npm：

```bash
npm install --global farming-code@latest
```

更新前如果有正在运行的重要任务，先确认 Agent 当前状态并保存需要的工作。不要在结果不明确的网络失败后反复执行带副作用的操作。

## 卸载

先停止服务：

```bash
farming stop
npm uninstall --global farming-code
```

卸载 npm 包不会自动删除 Farming 配置和历史数据。是否保留这些内容，应根据你是否还会重新安装来决定。

## 平台说明

当前公开支持 macOS 与 Linux。其他平台即使可以安装，也不应视为已经通过相同的运行与恢复验证。
