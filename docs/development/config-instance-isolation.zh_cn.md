# Config 实例隔离

> English version: [config-instance-isolation.md](./config-instance-isolation.md)

本文档定义多套 Farming 如何共享同一台机器，同时不混淆 Farming 自有状态，也不错误地
独占外部开发资源。

## 实例身份

Canonical Config 目录是一套 Farming 实例的身份。软链接等价路径必须解析为同一身份。
不同 Config 身份可以同时运行；同一个 Config 身份不能同时被两套 Server 拥有。

资源遵循以下所有权边界：

| 资源 | Owner |
| --- | --- |
| Settings、鉴权、Session 元数据、Runtime 记录和受管 Cache | 一套 Config 实例 |
| Farming 自有 Socket、进程命名空间、Browser Profile 和 Computer Resource | 一套 Config 实例 |
| Farming 子进程 | 精确 Config 实例与精确操作系统进程身份 |
| Project、Git Repository、Provider Home 和 Provider Session | 各自外部系统；Farming 只是一个客户端 |

Farming Package Installation 不属于 Config 身份。Package 选择与更新协调由独立契约定义。

## Server 所有权

Config Owner 只有三种业务状态：

- **unowned**：没有有效 Owner；
- **owned**：一个精确存活的 Server 拥有 Config；
- **uncertain**：存在 Ownership 元数据，但无法安全验证。

Server 必须在初始化 Config 自有 Runtime 前原子发布所有权。已证明存活的 Owner 会拒绝
第二次启动；已证明死亡的 Owner 可以回收；格式损坏、不可读、权限结果不明确或其它无法
证明的情况一律 fail closed，并要求运维者处理。

时间久不能证明进程已死亡。Server 生命周期遵循 Crash-only：持久化、Ownership 与恢复在
非优雅退出后仍必须正确，不能依赖 Graceful Shutdown Hook。停止、崩溃恢复和清理只能作用于
仍能精确证明的进程与 Owner Claim。

## Runtime 与鉴权隔离

Config 自有存储和 Runtime Namespace 必须来自同一个 Canonical 身份。因此不同 Config
实例拥有独立的 Token、Browser Cookie、Native PTY Endpoint、受管 Runtime Binding、
Browser Profile、Computer Ownership 与持久化进程记录。

复制 Config 不能获得管理原实例进程的权限。清理持久化进程前必须同时证明 Config 归属与
精确进程身份；证据不明确时显式失败。

外部 Project 与 Provider Home 仍然可以共享。Farming 不得排斥其它编辑器、Git 命令、
Provider 工具或另一套 Farming；这些资源的冲突通过各自的权威状态收敛。

## 浏览器路由边界

Live Server 拥有当前实例的 Browser Base Path。入口文档必须在应用 Transport 启动前建立
一份不可变路由快照；所有同源 HTTP、WebSocket、导航与静态资源地址都使用该快照。构建时
默认值可以服务独立开发或预览，但不能覆盖 Live Server 的权威路由。

Base Path 改变时必须重新读取入口文档。路由缺失或不一致时应显式失败，不能静默请求 Origin Root。

## 安全性与活性

安全性要求：

1. 每个 Canonical Config 身份最多有一个有效 Live Owner；
2. 建立所有权之前不能初始化 Config 自有 Runtime；
3. 没有精确 Config 与进程证明时不能执行破坏性进程操作；
4. 不同 Config 的自有可变命名空间不能冲突；
5. 不得虚构对外部资源的独占所有权。

活性要求：空闲 Config 可以启动，已证明失效的 Owner 可以回收，每次 Ownership 尝试都能
到达成功或有界可见失败。操作系统无法证明归属时，Farming 有意等待运维处理，而不是猜测。

## 验收标准

验证必须覆盖：同 Config 并发启动、不同 Config 同时运行、软链接等价、失效与不确定 Owner、
精确进程清理、独立鉴权与 Runtime Namespace、Browser Base Path，以及 Project 与 Provider
Home 的安全共享。
