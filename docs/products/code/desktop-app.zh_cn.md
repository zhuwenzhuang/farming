# Farming Desktop

> English version: [desktop-app.md](./desktop-app.md)

用户指南：[Farming Desktop（实验性）](https://zhuwenzhuang.github.io/farming/cn/experimental/desktop)。
本文继续作为架构、凭证、生命周期和恢复契约。

Farming Desktop 使用 Electron 打包现有 Farming Code 界面。它默认启动本机 Farming Backend，
也可以通过 OpenSSH 把同一套界面连接到已保存的远端 Farming Backend。

## 产品边界

Desktop 只拥有 Backend 选择、Native Window 生命周期、操作系统集成与远端连接 Bootstrap。
Agent、Project、Session、Terminal、Files、Chat、Plugin 与 Review 继续属于共享 Farming
Frontend 和 Backend。

既不选择 Backend、也不需要 Native OS Capability 的功能，不得新增 Desktop 专属实现。

## 架构

```text
打包的 Farming Code Renderer
            |
            | 一个带鉴权的 Loopback Origin
            v
Electron Desktop Gateway
            |
            +-- Desktop 拥有的本机 Farming Backend
            +-- 通过 OpenSSH Tunnel 连接的远端 Backend
            +-- Native Window 与 Notification Integration
```

Renderer 不接收上游 Backend Token，也不拥有 Node.js Access。Desktop Gateway 在 Main
Process 内保存 Backend Credential，认证本机 Renderer，并转发到当前 Backend 的 HTTP 与
WebSocket。Remote Content 不获得 Desktop Preload Bridge。

## 本机与远端 Backend

首次启动直接打开本机 Backend，不要求用户先决定是否连接 SSH。Remote Connection 是基于
用户 OpenSSH 配置的可选 Profile；Platform、Architecture、Version、Endpoint、Authentication
与 Capability 在连接时发现，不复制成需要用户维护的字段。

Desktop 可以安装或复用版本兼容的 Remote Server。Download 与 Transfer 必须有界、校验
完整性、支持取消，并且只有验证完成后才能发布。旧 Linux 兼容只能使用私有且已验证的
Runtime，不得修改系统或编辑器拥有的文件。

从 Renderer 视角看，Backend 切换必须原子完成：目标 Ready 后才能成为 Active；旧 Attempt
的迟到完成不能覆盖更新选择。

## 生命周期

Main Process 拥有 Application、Window、Local Backend 与 Connection Lifecycle。每个异步转换
只有一个 Owner 和 Generation。Quit、Cancel、Profile Change、Connection Replacement 与
Startup Failure 只撤销自己精确拥有的资源。

Desktop 只声明一个主应用实例。第二次启动只聚焦并恢复该主窗口，不得创建第二个 Local
Backend、Gateway 或 Profile Owner。只有无凭证且 Origin 精确等于已鉴权 Loopback Gateway
的目标保留在主窗口内；离开 Gateway 的显式 HTTP(S) 目标交给操作系统打开，而 file、data、
自定义协议，以及 URL 含用户名或密码的目标必须拒绝。

首个窗口必须显示有界 Startup Progress 或可操作错误，不能长时间白屏。Startup 或 Stop
结果不确定时，必须先通过 Backend 权威 Handshake 与进程身份对账，再尝试下一次 Mutation。

进入 Shutdown 后，Desktop 拒绝新 Window、Connection 与 Navigation Effect。Cleanup 保持
幂等，并在应用退出前完成。

## 安全边界

- OpenSSH 配置与 Host-key Verification 保持权威。
- Remote Server Artifact 使用前必须校验；部分传输绝不能被发布。
- 发现的 Backend Token 不写入 Connection Profile，也不暴露给 Renderer。
- Renderer 使用 Context Isolation、Sandbox，并关闭 Node.js Integration。
- Gateway 提供打包 Renderer 前，必须校验本地 Asset 引用，并从该精确 Renderer Document
  派生 Script CSP Hash。
- Native IPC 与设备权限只允许带鉴权的本机应用 Origin。

## 失败与恢复

Connection Cancel、Tunnel Loss、Protocol Incompatibility、Artifact 缺失、Local Startup 失败
与 Backend Switch 失败都必须可见且有界。Replacement Ready 前保留上一个已证明健康的 Backend。
重新启动时对账保存的 Profile 与本机 Ownership，不要求用户重新经过 Modal Backend 选择。

## 验收标准

验证必须覆盖：首次本机启动、Cancel/Retry、远端登记、Artifact Transfer、旧 Linux 兼容、
Backend 切换、Tunnel Loss、Startup 期间 Quit、Relaunch、Credential Isolation、Packaged Asset，
以及通过真实 Desktop UI 执行普通 Farming 用户故事。
