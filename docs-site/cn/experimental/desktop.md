---
description: 使用实验性的 Farming Desktop 连接并切换本机与多个远程 Farming 后端。
---

# Farming Desktop <Badge type="warning" text="实验性" />

Farming Desktop 把同一套 Farming Code 界面封装为桌面应用。它默认连接这台 Mac 上的 Farming，也可以保存多个受信任的远程 Farming 后端，并在它们之间切换。

<ThemeImage light="../assets/desktop-connections.png" dark="../assets/desktop-connections-dark.png" alt="Farming Desktop 的多后端连接面板" />

## 多个后端，一个界面

连接设置位于 **插件 → Connections**。本机环境默认可用；远程环境通过系统 OpenSSH 配置连接。

Desktop 可以保存多个后端，但当前窗口一次只使用其中一个。切换后：

- Project、Agent、Session 和 Files 仍保留在各自的后端主机；
- 新界面从选中的后端读取当前状态；
- 随时可以切回这台 Mac 或另一个已保存的后端。

## 连接与恢复

Desktop 会在切换前连接并检查目标后端。如果新连接没有准备好，当前已可用的后端会继续保留，避免窗口落入无法工作的中间状态。

远程连接信息和 Token 由 Desktop 主进程管理，不会暴露给普通网页脚本。仍应只添加你信任的主机，并使用受控的 SSH 配置。

## 当前状态

Farming Desktop 仍是实验性功能。打包、远程安装、协议兼容和断线恢复仍在持续验证中，不应把它当作 Farming Code 的第二套实现。

如果只需要从手机或另一台电脑访问一个 Farming 实例，请先阅读[手机与远程使用](../code/mobile-and-remote)。
