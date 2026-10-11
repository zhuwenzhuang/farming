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
curl -fLO https://zhuwenzhuang.github.io/farming/farming_install.sh
bash farming_install.sh --dir ~/farming
```

也可以 <a href="../../farming_install.sh" download="farming_install.sh">下载安装脚本</a>。
在证书正常的浏览器中下载；如果浏览器和开发机不在同一台机器上，先通过 SSH 将文件传到开发机。
进入文件所在目录后执行：

```bash
bash farming_install.sh --dir ~/farming
```

此方式不要求开发机连接官网，但后续仍需正常验证 npm registry 的 HTTPS 证书。

无需 sudo 或系统 Node.js。脚本只负责安装和更新；重复执行会检查目标版本，按需更新，保留配置和历史，不启动或重启 Farming。

示例中的程序目录是 `$HOME/farming`，启动入口是 `$HOME/farming/farming`。不设置 `--dir` 或 `FARMING_INSTALL_ROOT` 时，程序默认位于 `~/.local/share/farming/app`（支持 `XDG_DATA_HOME`）。安装脚本不在该目录外创建命令链接，也不修改 PATH。

指定 npm registry：

```bash
FARMING_NPM_REGISTRY=https://registry.npmjs.org bash farming_install.sh --dir ~/farming
```

已有 npm registry 配置可用时会自动沿用，所选 registry 会保留给后续启动和更新。`FARMING_VERSION` 可指定版本，未传入 `--dir` 时，`FARMING_INSTALL_ROOT` 可指定绝对安装路径。

npm 下载缓存和保留的更新版本都在安装目录内。选择其它磁盘上的目录时，无需另外设置缓存路径。

国内网络可显式启用下载镜像：

```bash
bash farming_install.sh --dir ~/farming --mirror cn
```

该选项通过 npmmirror 下载软件包和 npm 依赖，但 Farming 版本和压缩包校验摘要仍从官方 npm
获取。它覆盖本次安装使用的源，不修改用户的 npm 配置。镜像缺包或压缩包传输失败时，明确
提示并回退到同一个官方包；校验失败则终止安装。官方 npm 元数据仍需可访问。后续更新保留
官方版本检查和优先下载镜像，避免因镜像标签过旧而选到旧版。

安装器显示下载进度和各准备阶段。Farming 包校验完成后，其固定版本的 Node.js 和 npm
压缩包并行下载。

## 启动后台服务

```bash
cd ~/farming
./farming daemon
```

如需前台运行，使用 `~/farming/farming start` 并保持终端开启；停止 Farming 及其 Agent 使用 `~/farming/farming stop`。安装完成时会按实际安装目录输出这三条完整命令和说明。重复执行前台或后台启动命令，会先停止当前 Config 及其 Agent，再按所选模式重新启动。

打开 CLI 输出的带鉴权 URL 即可使用。默认情况下，Farming 使用自己的配置目录和端口。只有需要隔离不同实例或端口冲突时，才传入 `--config-dir`、`--port` 或 `--base-path`。

## 更新

两种方式都支持通过 **Settings → Updates** 更新。准备完成后，按页面提示重新启动服务。
重复执行同一条指定目录安装命令也会检查并安装更新，已是目标版本时无需下载。之后执行启动命令，使运行中的服务切换到选中的版本。

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

停止使用此安装的所有 Config 后，删除选定的程序目录，也会一并删除私有 npm 缓存和保留的更新版本。`~/.farming` 下的配置和历史数据独立保留。

## 平台说明

指定目录安装脚本面向 macOS x64/arm64 和 glibc Linux x64/arm64。Linux 要求 glibc 2.28+；
x64 主机的 glibc 2.17–2.27 使用私有兼容运行库。仍需 Bash、curl、tar，以及 SHA-512 校验工具：`sha512sum` 或 `shasum`（配合 `base64`、`od`），或 OpenSSL；
不支持 musl Linux 或更旧的 glibc。脚本不会升级系统库、修改 Shell 启动文件或设置开机自启。
Provider 仍需登录，外部项目工具也有各自的系统要求。

逐条执行命令，每步成功后再继续。`--dir` 的优先级高于 `FARMING_INSTALL_ROOT`。旧系统下载前需具备最新的 CA 信任库。
若出现 `curl: (60)`，请通过可信系统软件源更新 CA 证书，或用 `CURL_CA_BUNDLE` 指定可信证书包，
不要关闭 TLS 校验。安装脚本不会修改系统证书或安装系统软件包。
