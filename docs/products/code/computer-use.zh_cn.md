# Farming Computer Use

> English version: [computer-use.md](./computer-use.md)

Computer Use 是可选的完整桌面操作能力，包括截图、窗口与应用、原生
弹窗、鼠标、键盘和辅助功能信息。它与 Browser 互补：Browser 负责
结构化的网页和 DOM 操作，Computer Use 负责完整桌面。

产品模型把能力和它操作的界面分开：

```text
Computer Use
└── 桌面
    ├── 本机桌面
    └── 隔离桌面
```

`Computer Use` 是 Agent 使用的插件能力，`Desktop（桌面）` 是用户看到的
Resource。后端路由、持久化兼容字段、CLI 命令和 Agent Tool 暂时保留
`computer` / `computer_*` 名称；这些兼容名称不再是产品层级。

## 桌面类型

本机桌面是机器现有的图形桌面，与用户共享，并且同一时刻只有一个控制者。
在本机 Driver 和生命周期还没有在支持的主机环境中完整实现和持续验证前，
Farming 不展示这个虚假可用选项。

当前版本实现隔离桌面。每个 Agent 在 Docker 中拥有独立的 Linux 桌面，
因此多个 Agent 可以并行工作，不抢占主机桌面。Container 不挂载主机
Docker Socket，也不使用 Docker-in-Docker。

## 安装隔离桌面

Farming 不随发行包交付桌面镜像，也不会在普通安装、更新或 Server 启动时
自动拉取。用户需在**插件 → Computer Use → 桌面 → 隔离桌面**中显式安装。
Farming 按固定 Digest 拉取经过审查的官方 `trycua/xfce-cua` 镜像，并验证
锁定的 CUA Driver，成功后才允许启用插件。

在 macOS 上，本期正式支持且最简单的宿主方案是 Docker Desktop。先安装并启动它，
重新打开插件页让 Farming 实时探测 Docker，再点击**安装隔离桌面**。本机 Chromium
不需要 Docker；这里需要 Docker，是因为 CUA 操作的是完整、独立的 Linux 桌面。
其他兼容 Docker 的 Runtime 在提供兼容的 `docker` CLI 和 Daemon 时可能可用，但不属于
当前持续验证的产品路径。

amd64 镜像压缩下载约 472 MB，解压后本地占用约 1.3 GB。Docker 只保存
一份镜像，多个 Desktop Container 共享镜像层。Farming 使用 Docker 已配置的
Registry 路径；国内或私有网络加速应配在 Docker Daemon 的 Registry Mirror 中，
不在 Farming 里写死第三方镜像地址。

部分老 Docker Engine 的默认 seccomp Profile 无法运行该镜像。只有兼容检查明确
报告这个问题时，用户才可以显式打开“旧版 Docker 兼容模式”并重新安装。
Farming 绝不会静默降低隔离强度。

## Ownership 与生命周期

一个 Agent 最多拥有一个隔离桌面 Resource 及其精确 Docker Container。不同
Agent 绝不共享 Container、Desktop Session、Viewer Password、Browser Profile 或
内部 Endpoint。

- Chat/Terminal 切换和权限重启保留桌面。
- 停止或归档 Agent 会停止 Container，但保留 Resource。
- 删除 Agent 会删除它精确拥有的 Container 与 Resource。
- 关闭 Computer Use 只停止桌面，不删除保留状态。
- Browser 正在租用桌面时，必须先停止 Browser，才能停止或删除桌面。

破坏性操作前，Farming 会校验 Container 身份和 Ownership Label。noVNC 只暴露在
回环地址，并由带鉴权的 Farming Server 代理。

## Agent 与人工控制

Computer Use 在 ACP Session 边界已启用时，Agent 会获得锁定的 `computer_*`
Tool Catalog。Terminal Agent 通过 `farming computer` 使用同一套契约。

控制权始终只有一个 Owner。Agent 控制时，用户只读观察实时桌面；点击**接管**
会创建新的可交互 Viewer Epoch 并阻止 Agent Action；点击**交还 Agent**后，
Agent 必须重新获取 Desktop、Browser、Window 或 Accessibility 状态才能继续。
Action 超时代表结果不确定，Farming 绝不会自动重放。
