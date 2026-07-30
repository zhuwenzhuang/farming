# Farming Computer

> English version: [computer-use.md](./computer-use.md)

Farming Computer 是可选的实验性完整桌面操作入口。它与 Farming Browser
互补：快速、结构化的网页自动化优先使用 Browser；必须看到并操作最终渲染桌面、
浏览器工具栏、原生弹窗或其他 Linux 应用时使用 Computer。

## 准备

Farming 不随包交付桌面镜像，也不会在安装、更新或 Server 启动时拉取镜像。用户需
在**插件 → Computer**中显式准备。Farming 随后按插件显示的精确 Digest 拉取经过
审查的上游 `trycua/xfce-cua` 镜像，并校验锁定的 Cua Driver 版本，成功后才允许
启用 Computer。

同一个 Extension 也拥有 Browser 可选“隔离浏览器”来源的 Docker 边界。该路径在
**插件 → 浏览器**中单独准备锁定的上游 `trycua/cuabot` 镜像，只把 Chromium CDP
发布到回环地址，并私下交给 Farming 现有的 `agent-browser` Runtime；它不会增加
第二套 Browser Automation 实现。
隔离 Browser 使用独立容器，因为经过审查的完整 Computer Desktop 镜像不包含
Chromium；两者只共享 Computer Extension 已校验的 Docker Ownership Boundary。

部分旧 Docker Engine 的默认 seccomp Profile 无法运行该镜像。只有 Probe 明确
报告这一兼容问题时，用户才应先关闭 Computer、显式启用兼容模式、重新准备，再启用
插件。Farming 不会静默降低隔离级别重试。

## Ownership 与生命周期

一个 Agent 打开一台隔离 Computer。稳定的 Farming Agent Record 拥有 Resource
和精确 Docker Container；Project 只保留为 Workspace 隔离边界。不同 Agent
绝不会共享 Container、Desktop、Session 或 Viewer Password。

- Chat/Terminal 切换和权限重启保留 Computer。
- 停止或归档 Agent 会停止 Container，但保留 Resource。
- 删除 Agent 会删除它精确拥有的 Container 与 Resource。
- 关闭插件只停止 Computer，不删除保留状态。

任何破坏性操作前，Farming 都会校验 Container ID 与 Ownership Label。Container
只在回环地址暴露 noVNC，再由带鉴权的 Farming Server 代理给 Viewer。

## Agent 与人工控制

Computer 在 ACP Session 创建边界已经启用时，Agent 会获得锁定版本的完整
`computer_*` Tool Catalog。Terminal Agent 通过 `farming computer` 使用同一
Contract；运行 `farming computer help workflow` 可查看渐进式 CLI 流程。

控制权始终只有一个明确 Owner。Agent 控制时，用户看到只读实时桌面；点击**接管**
会把 Viewer 重新加载为新的可交互 Epoch，并阻止 Agent Action；点击**交还 Agent**
会关闭该 Epoch，Agent 必须重新获取 Desktop、Browser、Window 或 Accessibility
Tree 的状态观察后才能继续操作；只读取普通 Metadata 不能解除这一栅栏。控制权切换和
生命周期删除都会先关闭新准入、排空已经接收的 Action，再推进 Epoch 或删除 Container。
Farming 只接收锁定 Cua Manifest 中声明的 Tool；已停止、退出、失败、死亡或归档的
Agent 不能重新启动其 Computer。Action 超时代表结果不确定，Farming 绝不会自动重放。

首版 Runtime 有意只支持锁定的 Linux Cua Driver Contract，尚不是通用的第三方
Computer Provider API。
