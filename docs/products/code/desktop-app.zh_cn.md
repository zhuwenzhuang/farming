# Farming Desktop MVP

> English version: [desktop-app.md](./desktop-app.md)

Farming Desktop 使用 Electron 打包现有 Farming Code React 界面。首个窗口打开前会先启动
本机 Farming Backend，因此第一次启动立即可用，不要求用户先决定是否连接 SSH。远程 SSH
管理作为桌面专属的内置插件放在现有插件页中；需要时，同一份界面可连接多个已保存的远端。
普通 SSH Profile 只保存名称、`~/.ssh/config` Host 和可选
Farming Home；Server 的平台、架构、版本、端口、base path、token 和能力都在连接时发现。

## 运行

```bash
npm install
npm run desktop
```

开发运行和后续 macOS 安装包统一使用 `desktop/assets/` 中的品牌桌面图标；运行时构建会把
PNG 复制到 Electron 主进程旁，供 Dock 和窗口图标使用。

打开 **插件 → 连接**（或桌面端远程图标），填写 `~/.ssh/config` 的 Host 即可。用户名、端口、`IdentityFile`、
`ProxyJump` 等高级 SSH 设置继续由 OpenSSH 管理。Farming Home 默认是
`~/.farming-desktop`；其中 `server/<version>/` 保存版本化 Server，`data/` 是该桌面实例
独立的 Config 目录。MVP 使用 `BatchMode=yes`，因此远端必须已经能通过密钥或
`ssh-agent` 非交互登录。Linux 远端优先使用系统 glibc 2.28+；旧系统会自动发现兼容
glibc runtime，并可直接复用已存在的 VS Code sysroot 配置。

连接状态机为：探测远端平台/架构 → 查找精确版本 → 远端下载并校验 → 必要时本地下载、
校验后经 SSH 上传 → 启动或复用 daemon → 读取版本化握手 → 建立 loopback 隧道 → 重新读取
Browser/Computer 能力。默认从同版本 GitHub Release 下载单文件 CLI；开发分支可用
`FARMING_DESKTOP_SERVER_VERSION` 指向一个已经发布的兼容版本进行 dogfood。也可通过
`FARMING_DESKTOP_RELEASE_ROOT` 指定具有相同目录结构和 checksum 清单的 HTTP(S) 镜像；
带凭证、query 或 fragment 的地址会被拒绝。

旧 Linux 的发现顺序是 Farming 专用环境变量
`FARMING_SERVER_CUSTOM_GLIBC_LINKER`、`FARMING_SERVER_CUSTOM_GLIBC_PATH`、
`FARMING_SERVER_PATCHELF_PATH`，然后是等价的三个 `VSCODE_SERVER_*` 变量。Desktop 只
patch 已验证 artifact 的版本化副本：临时副本只把较短的 linker alias 设为 interpreter，
启动时再传入 library path。由于 patchelf 合法地重排 ELF 布局，验收依据是回读到精确的
interpreter，并通过打包 CLI 的启动自检；通过后临时副本才会原子替换。它不会修改系统
glibc 或 VS Code Server。daemon 同时收到既有的 `FARMING_NODE_LD` 和
`FARMING_NODE_LIBRARY_PATH` 兼容契约，让托管子运行时自动选择或使用兼容旧系统的 artifact。
仅启动所需的 library path 会在 Node 入口移除，避免污染系统工具；只有打包 Server 再次执行
自身时才会恢复。

## 架构

```text
本地打包的 React renderer
        |
        | 单一 loopback HTTP/WebSocket origin
        v
Electron Desktop Gateway
        |
        +-- active backend 路由
        +-- Desktop 拥有的本机 Farming Backend
        +-- 版本化远端 Server bootstrap
        +-- 原生系统通知
        |
        v
        +-- 本机 Backend
        |
        +-- Connection Manager -- 系统 OpenSSH bootstrap + 隧道 --> 远端 Farming Backend
```

## 生命周期状态机

Electron 主进程统一拥有应用生命周期和 renderer 窗口生命周期。后端回调不能直接调用
`show`、`reload` 或 `loadURL`。

| Owner | 状态 | 转换契约 |
| --- | --- | --- |
| 应用 | `starting → running → stopping → stopped` | Gateway、IPC 和 Store 全部就绪后才能进入 `running`。任意退出或不可恢复的启动失败只能进入一次 `stopping`。Connection 与 Gateway 清理共享同一个 Promise；清理完成后才进入 `stopped` 并退出 Electron。 |
| 主窗口 | `absent ↔ loading → ready`，或 `loading → failed` | 创建窗口会递增 window generation。每次导航都捕获该 generation 和当前 renderer-route revision。只有当前 generation 才能 ready、显示、聚焦、报告启动失败或触发下一次导航。 |
| 本机 Backend | `idle → starting → ready → stopping → stopped`，或 `starting → failed` | 并发 start 复用一个 Promise，stop 保持幂等。只有本机 daemon 发布了合法 port、base path 和 token 后才允许开窗；桌面退出统一负责有界停止。 |

激活后端、重启时恢复已保存后端、删除活动后端和通知跳转，都会通过递增 revision 使 renderer
路由失效。窗口 ready 时会在当前 IPC action 返回后排队一个导航 effect；同一轮事件中的多次
失效只保留最新 revision。窗口已经 loading 时，后续失效也会合并。旧 revision
完成后按最新目标重试；已关闭窗口或进入 `stopping` 后到达的结果直接丢弃，避免过期启动数据
和相互竞争的多次 reload。

进入 `stopping` 后，状态机拒绝新窗口和新路由，并禁止状态广播及迟到的 UI 副作用。即使
macOS 连续产生多个退出事件，关闭过程也保持幂等。

Renderer 没有 Node.js integration，也不会收到上游 token。自动发现的 token 只存在于受
认证的 SSH 握手和 Electron main process 内存中。随机 HttpOnly desktop-session cookie
保护本地 Gateway；Gateway 注入后端 bearer 鉴权，并转发 REST 与 WebSocket。Electron
只加载本地打包资源，不会在有桌面权限的界面中执行远端 Farming HTML。

每个后端都有稳定本地 ID。连接状态按 ID 隔离，并在 `disconnected`、`connecting`、
`ready`、`error` 间转换。每次连接尝试增加 generation，旧结果不能覆盖新的断开或连接。
只有 `/api/auth/status` 探测通过且能力读取结束后才进入 ready。切换后端时先连接目标，再
更新 active ID、关闭 renderer WebSocket 并重载界面。

## 安全边界

- SSH 通过参数数组执行并遵循用户的 OpenSSH 配置；绝不关闭 host key 校验。
- 自动下载先验证所选 Release 的 SHA-256 清单；远端无法访问时，本地验证同一 artifact 后
  通过已认证 SSH 通道流式上传。远端先写本次临时文件，再复核字节数和 SHA-256 后原子发布；
  中断只删除该临时文件，不能替换已安装 Server。
- 旧 Linux 兼容 runtime 的 linker、library path 和 patchelf 必须存在；私有 linker alias、
  patch 后的 interpreter 和可执行自检必须全部通过。
- 自动发现的 token 不写入 Profile，也不会发送给 renderer。
- Renderer 开启 context isolation 与 sandbox，并关闭 Node.js integration。
- IPC 只接受精确 loopback Gateway origin；麦克风权限也仅允许该 origin 的 main frame。
- Browser 与 Computer 的远端内容不会获得 desktop preload bridge。

## MVP 边界

MVP 不支持 SSH 密码交互、Windows 远端、自动构建 glibc sysroot、带认证的企业镜像源或非 active 后端通知。握手协议当前为
版本 1；握手缺失、端口非法或精确 Server artifact 不存在时明确失败，不猜测旧监听端口。
可信本地 renderer 已可采集麦克风，但语音识别暂时仍沿用现有浏览器实现。

## 验证

聚焦自动化覆盖 Profile 归一化、握手解析、SSH option 注入拒绝、host key 策略、renderer
token 脱敏、bearer/base-path 路由、生命周期 generation/revision 守卫，以及拒绝误用后端 base path 构建的 renderer artifact。
Desktop build 固定生成根路径资源；开窗前，main 会验证入口脚本、样式和 module preload，
并一直隐藏窗口，直到应用外壳或可见错误页真正渲染。Smoke 会断言这些资源全部成功返回、
首屏存在可见内容且 renderer 没有未捕获异常。产品形态冒烟还应覆盖真实远端首次安装、远端
断网的本地传输回退、版本复用、活动 WebSocket 中切换后端、隧道掉线和通知点击路由。
