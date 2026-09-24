# 安装与更新

任选一种安装方式。两者均通过 npm 下载，再用 Farming CLI 单独启动。

| 安装方式 | 适用环境 | 运行环境 |
| --- | --- | --- |
| npm | 已有受支持的 Node.js 和 npm | 使用用户已有的 Node.js 和 npm |
| 指定目录安装 | 缺少 Node.js，或 Linux 需要兼容库 | 自带 Node.js、npm 和受支持的 Linux 兼容库 |

## npm 安装

要求 Node.js 22.13+（22.x）或 24+、可写的 npm 全局目录，且 npm 的 bin 目录已在 PATH 中。
Linux 使用现代 glibc 环境（2.28+）；较旧主机请选择指定目录安装。

```bash
npm install --global farming-code@latest
farming daemon
```

此方式使用已有 Node.js 和 npm 配置，不配置 PATH，也不负责准备旧主机的系统兼容环境。

## 指定目录安装

安装脚本准备专用的 Node.js 和 npm。这是独立应用目录，不是项目内的 `npm install`。下面的示例指定 `$HOME/farming`：

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | FARMING_INSTALL_ROOT="$HOME/farming" bash
```

无需 sudo 或系统 Node.js。脚本只负责安装，重复执行会保留已有安装，不启动或重启 Farming；更新通过设置完成。

示例中的程序目录是 `$HOME/farming`，启动入口是 `$HOME/farming/farming`。不设置 `FARMING_INSTALL_ROOT` 时，程序默认位于 `~/.local/share/farming/app`（支持 `XDG_DATA_HOME`）。安装脚本默认还会在 `~/.local/bin/farming` 创建指向程序目录的命令链接；下方命令不依赖该链接或 PATH。

指定 npm registry：

```bash
curl -fsSL https://zhuwenzhuang.github.io/farming/install.sh | FARMING_INSTALL_ROOT="$HOME/farming" FARMING_NPM_REGISTRY=https://registry.npmjs.org bash
```

已有 npm registry 配置可用时会自动沿用，所选 registry 会保留给后续启动和更新。`FARMING_VERSION` 可指定版本，`FARMING_INSTALL_ROOT` 和 `FARMING_BIN_DIR` 可指定绝对安装路径。自定义 bin 目录时，请使用安装脚本输出的 CLI 启动命令。

npm 下载缓存和保留的更新版本都在安装目录内。选择其它磁盘上的目录时，无需另外设置缓存路径。

## 启动后台服务

```bash
"$HOME/farming/farming" daemon
```

打开 CLI 输出的带鉴权 URL 即可使用。默认情况下，Farming 使用自己的配置目录和端口。只有需要隔离不同实例或端口冲突时，才传入 `--config-dir`、`--port` 或 `--base-path`。

## 更新

两种方式都支持通过 **Settings → Updates** 更新。准备完成后，按页面提示重新启动服务。
重复执行指定目录安装脚本不会升级已有安装。

更新器通过 npm 下载到私有暂存目录，保留旧程序和对应运行环境，用于启动失败时回退。不会替换机器原有的 Node.js 或 npm。

更新前如果有正在运行的重要任务，先确认 Agent 当前状态并保存需要的工作。不要在结果不明确的网络失败后反复执行带副作用的操作。

## 卸载

npm 全局安装：先停止其 Config 实例，再用同一个 npm 卸载。

```bash
farming stop
npm uninstall --global farming-code
```

指定目录安装：先停止服务。

```bash
"$HOME/farming/farming" stop
```

停止使用此安装的所有 Config 后，删除选定的程序目录及其 `~/.local/bin/farming` 软链接，也会一并删除私有 npm 缓存和保留的更新版本。`~/.farming` 下的配置和历史数据独立保留。

## 平台说明

指定目录安装脚本面向 macOS x64/arm64 和 glibc Linux x64/arm64。Linux 要求 glibc 2.28+；
x64 主机的 glibc 2.17–2.27 使用私有兼容运行库。仍需 Bash、curl、tar 和 OpenSSL，
不支持 musl Linux 或更旧的 glibc。脚本不会升级系统库、修改 Shell 启动文件或设置开机自启。
Provider 仍需登录，外部项目工具也有各自的系统要求。
