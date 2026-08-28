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

固定 Provider、Browser 与 Project Files Search Runtime 在安装或更新前写入 Package Image。
应用启动只验证已经准备好的 Artifact；缺失或损坏时给出可操作的修复说明，不会在启动中静默下载替代品。

Project Files Search 只使用 Farming 自带、版本固定且匹配目标 OS 与 Architecture 的原生 ripgrep
Artifact。Linux Image 使用静态 musl Build，因此该 Runtime 不增加 glibc 兼容分支。Runtime 不会用
系统 `rg`、WebAssembly 实现或其它 Search Command 替代 Managed Artifact。

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

npm Image 将精确版本的 Codex 与 Claude Native Carrier 声明为受平台约束的 Optional Dependency，
由 npm 在不执行生命周期代码的前提下按 OS、Architecture 与 libc 选择；Release Pipeline 则把经过
审查的 agent-browser 与 ripgrep 二进制直接嵌入 Farming Image，Target-specific Release Image 只保留
目标平台 Artifact。Launcher 会把 npm Image 标记为禁止下载，Runtime Manager 只能在校验后绑定
精确声明的 Carrier 或内置 Artifact。

由于 Executable 不能直接从 Standalone CLI 的 Virtual Filesystem 执行，该安装形态会在 Server
初始化前，把内置且固定版本的 ripgrep 原子写入所属 Config 的私有 Versioned Runtime Directory。
这是本地 Image Extraction，不是下载或 Executable Fallback；写入后仍执行相同的版本与可执行校验。

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

对于 npm 更新，Update Registry 的元数据负责证明精确目标版本与 Integrity。Prepare 首先尊重
Operator 配置的 npm Registry；该命令失败后，Helper 只删除自己拥有的 Staging Prefix，并显式
指定权威 Update Registry 重试一次。这个转换只依赖命令是否成功、Registry 身份和 Operation
Ownership，绝不能解析 npm 日志文案或错误文本。只有权威来源的尝试也失败，更新才进入 `Failed`。

通过 Read-only Share 打开的更新状态只用于观察：忽略强制刷新请求，只投影 Persisted Operation
Recovery 而不提交状态，也不准备 Immutable Installation Directory。持久对账仍由 Owner 或启动
恢复路径负责。

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
不中断的更新准备、配置 Registry 失败后不检查错误文本并从干净 Staging 切换到权威 Registry、
陈旧 Selection 竞争、精确 Rollback、Cleanup 失败、外部 npm 替换，以及各安装形态的边界。
聚焦的 npm 更新状态机测试属于 Release Preparation Gate，不能只作为普通 Unit Test。
