# Package 安装与更新生命周期

> English version: [package-installation-lifecycle.md](./package-installation-lifecycle.md)

本文档定义多套 Config 实例可能共享同一份 npm 安装时，Farming 如何安装和更新应用版本。整体模型参考 VS Code 的稳定启动入口、按版本寻址的远程安装，以及显式更新状态机。

## 用户故事

- 首次通过 npm 安装后，用户直接启动 npm 安装的版本。
- 应用内更新在不停止当前 Server 的情况下完成准备。
- Config A 更新时，不会停止 Config B，也不会替换 Config B 正在执行的代码。
- 新 Config 使用当前选中的版本；已运行 Config 继续使用启动时的精确版本。
- 新版本启动失败时，发起更新的 Config 从精确旧版本恢复。
- 用户之后显式执行 `npm install` 或 `npm update` 时，新安装版本成为后续启动的默认版本。
- Source、App Bundle 与 Standalone 安装继续使用各自部署路径，不会静默进入 npm 更新生命周期。

## 架构

一份 npm 安装包含三个角色：

1. **Bootstrap Launcher** 是 npm 安装的稳定命令，负责识别 Installation，并为新启动选择版本。
2. **Package Image** 是一份完整且不可变的 Farming 版本；运行进程只从自己选中的 Image 加载代码。
3. 安装级 **Current Selection** 是一个原子替换的小型指针，只影响后续新启动。

Config 状态与 Package Image 的归属不同。Config 状态继续按 canonical Config 目录隔离；同一 npm Installation 下的多个 Config 只读共享 Package Image。每个 Config 记录自己精确使用的 live Image，供清理时保护。

显式 npm 替换会改变 Bootstrap 内容。Launcher 将新的 Bootstrap Generation 视为用户主动部署，把它发布为后续启动的 Selection，但绝不改写 live Process 正在使用的 Image。

## 更新状态机

持久化的业务状态包括：

- **Idle**：没有更新。
- **Preparing**：旧 Server 保持运行，同时验证目标 Package 与 Runtime Dependency。
- **Ready to restart**：旧 Image 和目标 Image 都已不可变发布，发起 Config 可以重启。
- **Restarting**：停止精确的发起 Server，切换 Selection，并让该 Config 从目标 Image 启动。
- **Succeeded**：发起 Config 已运行目标版本。
- **Rolling back**：目标启动失败，发起 Config 正从精确旧 Image 恢复。
- **Rolled back / Failed**：已在旧版本恢复，或需要用户进行可见的人工处理。

Prepare 与 Selection Publication 是两个独立转换。Selection 使用 Compare-and-swap，因此基于旧 Selection 准备的更新不能覆盖更新的部署。整个过程中只停止发起更新的 Config。

## 安全性与活性

安全性依赖以下不变式：

1. 已发布 Image 必须完整，且永远不原地更新。
2. 运行中的 Config 在整个进程生命周期内固定使用精确 Image。
3. Current Selection 原子变化，并且只能从预期旧 Selection 迁移。
4. Stop 与 Rollback 都以精确 Server Process Identity 和精确 Image 为目标。
5. 清理永远保留 Current、Previous、近期以及所有精确 live Image。
6. live 使用证据不可读时停止清理，不能把“不知道”解释成“无人使用”。

在文件系统、进程检查和 npm 正常可用的前提下，每次更新转换最终都会成功、回退，或进入有界且可见的失败。无关 Config 不需要为了另一个 Config 的更新而停止。Selection 竞争失败时，发起 Config 从旧 Image 重启，并要求用户基于新 Selection 重试。

## 恢复语义

- Helper 或 Launcher 崩溃后，新 Server 用权威实际运行版本收敛持久化 Restart 状态。
- 已运行目标版本时，Restart Recovery 收敛为成功。
- 目标启动失败时，即使其他进程已经选择了另一版本，发起 Config 仍从自己的精确旧 Image 重启。
- Rollback 不会覆盖已经被其他流程独立移动的 Selection。
- Signal 权限失败时旧 Server 保持运行，更新回到可重试的 Ready 状态。
- Package 清理只在健康启动后尽力执行；归属证据不确定时必须 fail closed。

## 安装形态边界

只有 npm 安装使用应用内自更新。Source Checkout 直接从源码启动并遵循 Git 工作流；App Bundle 与 Standalone Executable 通过外部安装器或部署流程替换。Server 不会把 GitHub Releases 作为第二套更新源。

## 验证策略

持续验证应覆盖 Bootstrap 与 Image-local 启动、外部 npm 替换、Selection 原子竞争、精确 live Usage 保护、fail-closed 清理、目标启动失败、Rollback 失败，以及两套 live Config 中只有发起 Config 重启到新版本的场景。
