# 远端部署生命周期

> English version: [remote-deployment-lifecycle.md](./remote-deployment-lifecycle.md)

本文定义把一个已提交的 Farming 版本私有部署到远端 Linux Server 的契约。部署复用
Release 准备所使用的 App Bundle 格式，但不会创建 GitHub Release，也不会发布 npm。

## 产品契约

操作者提供普通 OpenSSH 连接参数和绝对远端安装路径。仓库中的一条命令负责构建或
接收一个已验证的 Linux artifact，并拥有完整部署过程。目标机器不再接收源码用于
安装依赖、编译前端或 prune。

Artifact 明确记录完整 Git SHA、平台、架构、兼容运行时、包内容和 checksum。认证
继续由目标 Config 目录持有；SSH 凭证和私有主机信息不会进入 artifact 或仓库配置。

## 所有权与目录布局

- 本地 builder 拥有 artifact 构建与验证。操作者可以显式选择本地 Unix socket
  Docker context 和 npm registry；部署不会推断或改变其他容器引擎的生命周期。
  由于 builder 需要 bind-mount 本机仓库路径，远端、TCP、转发 socket 和 Windows
  pipe Docker endpoint 会在远端预检或源码 worktree 创建前被拒绝。
- 本地 builder 在 artifact 输出之外缓存 checksum 固定的兼容 runtime 输入；每次
  复用前都重新校验。
- 规范化 Config 目录拥有 Server、认证、Agent、PTY、ACP、Browser 和 Computer 状态。
- 配置安装路径旁边的部署根目录拥有不可变 image、staging、部署锁和回滚选择。
- 配置安装路径是一个 symlink，只决定后续启动选择哪个 image。运行中的 Server 始终
  绑定到它启动时解析出的确切 image。

Config 状态和部署 image 不共享所有权身份。更新一个安装路径只能停止选定 Config
能够精确证明的 Server。

## 状态机

| 状态 | 触发与效果 | 终止失败或恢复 |
| --- | --- | --- |
| Idle | 没有部署持有目标锁。 | 新操作可以开始。 |
| Building | 隔离 Linux builder 为一个已提交 SHA 打包。 | 构建失败不改变远端。 |
| Staging | checksum 匹配的压缩包安全解压到唯一 staging 路径。 | 路径、元数据、平台或身份非法时只删除该 staging。 |
| Prepared | 通过 artifact 自带兼容运行时加载原生模块，并用 `--no-activate` 准备固定 runtime。 | 失败时当前 Server 继续运行。 |
| Activating | 精确停止旧 Server，为其 Config 建立 checkpoint，在同一文件系统创建工作副本，原子切换 symlink，并让新 Server 使用工作副本启动。 | 停止或 checkpoint 失败不改变选择和持久 Config 状态；切换或启动失败进入回滚。 |
| Verifying | 通过不进入交互式浏览器 Agent 清单的内部 smoke Agent 验证认证 HTTP、版本化 WebSocket、PTY Host、ACP Host 和一个全新空 Chat，随后删除这些确切 Agent。 | 任一步失败都进入回滚，不重放结果不确定的 mutation。 |
| Succeeded | 记录 current 与 rollback 选择，只清理保留策略外且可证明安全的旧 image。 | 清理失败不会否定运行中的 image，但必须可见。 |
| Rolling back | 停止失败 image，隔离其 Config 工作副本，恢复 activation 前的 Config checkpoint，选择旧 image，并启动旧 Server。 | 成功则部署失败，但旧 image 与兼容的旧 Config 状态一同恢复；回滚失败时保留确切快照并要求人工处理。 |

一个部署根目录同时只能有一个 activation。锁的 owner 存活时，另一个 activation 立即
失败。Artifact preparation 按 checksum 幂等；连接结果不确定时不得重放 activation，
必须先核对 current symlink 和 Config 拥有的 Server 状态。

## Safety 与 Liveness

Safety 要求：

1. 只有 checksum 验证通过、自包含的 Linux artifact 才能成为 image；
2. image 发布前必须完整，发布后不得原地修改；
3. 原生依赖与 runtime preflight 成功前不得停止 Server；
4. current 选择原子切换，验证结束前必须保留确切旧选择；
5. readiness 成功之前，新 image 只能迁移 Config 工作副本；回滚恢复 activation 前的确切
   Config，而不是要求旧 image 读取新 schema 写出的状态；
6. smoke Agent 只服务于 readiness 且不进入交互清单；stop、smoke 清理、rollback 和 retention 都以确切 Config、Agent 和 image 身份为目标；
7. 私有 SSH 或 Farming 凭证不得被打印或复制进 image。

在文件系统、SSH、容器 builder、Provider 和进程控制正常可用时，每次操作最终必须是
成功、恢复旧 image，或明确需要人工处理的失败。Timeout 由所属产品协议明确限制，
不能通过部署重试隐藏。

## 验证

自动验证覆盖非法 artifact、在构建或 SSH 操作前拒绝非本地 Docker context、原生模块
preflight、并发 activation、启动失败、产品 smoke 失败、精确回滚、从旧源码目录首次
迁移以及有界清理。真实目标验收还必须通过公开命令入口构建并部署私有 Linux artifact，
确认选中的确切 SHA，并根据变更范围使用真实 Provider 和可见 UI journey。
