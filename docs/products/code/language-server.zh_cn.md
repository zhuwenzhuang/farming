# Language Server

> English version: [language-server.md](./language-server.md)

用户指南：[Language Server（实验性）](https://zhuwenzhuang.github.io/farming/cn/experimental/language-server)。
本文继续作为后端权威性、生命周期和验收契约。

状态：Farming 托管、面向代码查看的能力。

## 产品边界

Farming 可以在拥有 Project 的 Backend 上启动匹配的 Language Server。Editor 使用它理解
代码；用户不需要配置 Transport Socket，也不需要在 Farming 内维护另一套 Language Server
Workspace。

```text
Farming Editor
      |
      | 带鉴权、Project-scoped Request
      v
Project 所在主机的 Farming Backend
      |
      | Language Server Protocol
      v
受管或系统 Language Server
```

Backend 拥有 Server Discovery、Project Root 选择、进程生命周期、Request Deadline 与 Result
Authorization。同一 Config、Language 与 Project Root 边界内可以复用一份兼容 Server；不同
Config Instance 不共享可变 Language Server 状态。

## 文件与结果权威

Request 必须按精确 Project Root 授权；Symlink Escape 和 Project 外 Result Location 必须拒绝。

Semantic Result 描述磁盘上已保存文件。Farming Editor 存在未保存 Draft 时，可能展示陈旧
跨文件语义的操作应暂时隐藏，而不是假装磁盘结果描述当前 Draft。

## 能力

面向查看的 Surface 可以提供 Hover、Definition、Reference、Implementation、Symbol、Call/
Type Hierarchy 与 Diagnostics，具体取决于 Active Server 实际支持的能力。Availability 来自真实
初始化完成的 Connection，不能把内置 Registry 本身当作已经连接。

## 生命周期与失败

受管 Server 处于 Absent、Starting、Ready、Stopping 或 Failed。相同 Ownership Boundary 的
并发启动加入同一转换。退出或失败的 Server 会从 Active State 移除；之后用户显式请求可以
重新启动。Request 与 Shutdown 都必须有界；失败保持可见，不静默切换到另一 Provider。

## 验收标准

验证必须覆盖：Project Root Discovery、Saved-file Semantics、Result Filtering、Process Reuse
与 Restart、Concurrent Request、显式失败、Remote SSH Ownership，以及代表性真实 Language Server。
