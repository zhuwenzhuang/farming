# Package 安装与更新生命周期

> English version: [package-installation-lifecycle.md](./package-installation-lifecycle.md)

本文档定义多套 Config 实例可能共享同一份 npm 安装时，Farming 如何安装和更新应用版本。

## 产品结果

- 全新安装启动时不下载固定 Runtime Dependency。
- 准备更新不会停止当前 Server。
- 一套 Config 更新时，不替换另一套 Live Config 正在执行的代码。
- 新版本启动失败时，发起 Config 从精确旧版本恢复。
- Source、npm、App Bundle、Standalone 与 Remote Deployment 保持明确且独立的生命周期。

## 架构

一份 npm 安装包含三个角色：

1. **Bootstrap Launcher**：稳定入口，为新启动选择版本；
2. 不可变的 **Package Image**：一份完整 Farming 版本及其已验证 Runtime Dependency；
3. 原子发布的 **Current Selection**：只影响之后的新启动。

Config 状态与 Package Image 属于不同 Owner。Config 状态按 Config 身份隔离；同一 Installation
中的 Package Image 只读共享，而每套 Live Config 始终绑定启动它的精确 Image。

固定 Provider 与 Browser Runtime 在安装或更新阶段准备。应用启动只验证已经准备好的 Artifact；
缺失或损坏时给出可操作的修复说明，不会在启动中静默下载替代品。

Managed ACP Dependency 必须始终从固定 Manifest 准备；即使系统 Provider CLI 版本相同，
也不能满足该 Managed Dependency。Prepared Image 还携带目标平台所需的 Child Process
Invocation Contract，包括必要时使用的兼容 Loader。

### npm 生命周期脚本约束

npm 安装不得为了正确运行而依赖 `preinstall`、`install`、`postinstall` 或任何其他 npm
生命周期脚本。安装 Farming 必须是纯解包操作：Package Image 已包含其目标平台所需、经过验证的
Runtime Artifact。

Release Pipeline，而不是用户的 npm Client，拥有 Runtime Prepare 与 Platform Selection 的职责。
它必须随 Package Image 发布所需的预构建 Artifact（或由 Package Manager 声明式选择的平台包）。
Server 启动只校验这些 Artifact；它们缺失或损坏时给出可操作的修复错误，绝不通过下载或准备来补偿。

## 更新状态机

- **Idle**：没有更新。
- **Preparing**：当前 Server 保持服务，同时校验目标 Package 与 Runtime Dependency。
- **Ready to restart**：旧 Image 与目标 Image 都已可用。
- **Restarting**：只停止发起 Config，并从目标 Image 启动。
- **Succeeded**：发起 Config 已运行目标版本。
- **Rolling back**：目标启动失败，正在启动精确旧 Image。
- **Rolled back / Failed**：已经恢复旧版本，或需要可见的人工处理。

Prepare 与 Publication 是独立转换。基于旧 Selection 准备的目标不能覆盖更新部署；Detached
工作只有在仍拥有同一个 Update Operation 时才能提交状态。

## 安装形态边界

- **Source Checkout** 遵循该仓库的源码与 Package Manager 工作流。
- **npm Installation** 可以使用应用内更新和不可变 Package Image。
- **App Bundle** 从 Release Pipeline 获得已准备 Dependency。
- **Standalone 与 Remote Server** 遵循各自 Deployment Artifact 契约。

一种安装形态不能静默进入另一种更新路径。Server 不会把 GitHub Releases 当成自动 Fallback 更新源。

## 安全性与活性

安全性要求：

1. 已发布 Image 完整且永不原地修改；
2. Live Config 始终绑定精确 Image；
3. Current Selection 只能从预期旧值原子变化；
4. Stop 与 Rollback 指向精确 Server 和精确 Image；
5. Cleanup 保留 Current、Rollback、近期和已证明 Live 的全部 Image；
6. Live Usage 证据不明确时停止 Cleanup；
7. 应用启动绝不下载固定 Runtime Dependency。

在文件系统、进程检查和 Package Registry 正常可用时，每次更新都会到达成功、回退或有界
可见失败。无关 Config 不需要因为另一套 Config 更新而停止。

## 恢复语义

Launcher 或 Helper 崩溃后，新 Server 会用实际运行版本对账 Update 状态。目标启动失败时，
发起 Config 从精确旧 Image 恢复，同时不覆盖其它流程发布的更新 Selection。权限或 Ownership
结果不明确时保持旧 Server 或 Image 不变，并报告可重试失败。

## 验收标准

验证必须覆盖：在 npm 生命周期脚本禁用时安装、首次安装无启动下载、多个 Config 并行、服务
不中断的更新准备、陈旧 Selection 竞争、精确 Rollback、Cleanup 失败、外部 npm 替换，以及各
安装形态的边界。
