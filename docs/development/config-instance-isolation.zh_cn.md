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

Config 统一拥有各客户端共享的界面语言设置。新 Config 或没有有效语言设置的 Config，
在中国地区服务端时区默认使用中文，其它时区使用英文；地区集合与 Token 语言检测一致。
已保存的中文或英文始终优先，重启、时区改变和 Token 专用语言覆盖都不能改写它。
正常启动不向终端倾倒设置对象或可选程序的查找失败信息，确保访问地址与鉴权提示清晰可见。

## Server 所有权

Config Owner 只有三种业务状态：

- **unowned**：没有有效 Owner；
- **owned**：一个精确存活的 Server 拥有 Config；
- **uncertain**：存在 Ownership 元数据，但无法安全验证。

Server 必须在初始化 Config 自有 Runtime 前原子发布所有权。已证明存活的 Owner 会拒绝
第二次启动；已证明死亡的 Owner 可以回收；格式损坏、不可读、权限结果不明确或其它无法
证明的情况一律 fail closed，并要求运维者处理。

CLI 的 `start` 和 `daemon` 遇到同 Config 的存活 Server 时，先执行普通的精确所有权
Hard-stop（包括其 Agent），然后按要求以前台或后台方式启动新的 Server。停止失败或结果
不明确时必须终止，不能继续启动。进程 Claim 仍拒绝并发重复 Server，绝不停止其它 Config。
重复启动不能仅返回旧 Server 或旧 URL 就宣称成功。

生命周期命令必须在执行前说明决策：首次启动还是重启、Config 身份，以及重启会停止当前实例和它的 Agents。停止和后台就绪检查显示有界进度，并明确结束于成功或失败。交互终端使用紧凑动画和耗时，重定向日志使用稳定文本行，`NO_COLOR` 禁用颜色。进度写入 stderr，命令结果保留在 stdout。实际就绪前不得宣称成功，身份校验失败不得显示为停止成功。

时间久不能证明进程已死亡。Server 生命周期遵循 Crash-only：持久化、Ownership 与恢复在
非优雅退出后仍必须正确，不能依赖 Graceful Shutdown Hook。停止、崩溃恢复和清理只能作用于
仍能精确证明的进程与 Owner Claim。

即使 Server 已经消失，一次有意的 Config Stop 仍是一项精确 Hard-stop 操作。Config 自有的
进程组 Root 必须在接收工作前持久化精确身份。每个自有进程组的 Runtime 必须在独立进程组中
启动，并记录 Leader 身份（`PID == PGID`）。前台 Server 可以共享调用者进程组，但它的精确
PID 不代表拥有整个组。仍存活的旧版非 Leader 记录必须显式拒绝，不能向继承的组发送信号。
Stop 会合并这些记录、精确 Host Endpoint 以及
持久化 Runtime/Resource 身份，重新校验当前操作系统进程身份，然后直接发送 `SIGKILL`。
Computer Container 必须通过持久化 Container ID 与精确 Config Ownership Label 选中，并接收
Docker `KILL` 信号。证明缺失或不匹配时显式失败；Stop 绝不能扫描或终止当前用户的所有进程。
进程组 Leader 成为僵尸后已经不能执行或接收有意义的信号，但这不能单独证明其 Descendant
也已停止。Stop 必须检查完整进程组：只有 Exited-only Group 才能无信号收敛；仍有 Live
Descendant 时必须继续向精确进程组发送 `SIGKILL`。由于身份与环境检查是两次独立的操作系统
观察，Stop 在拒绝表面不匹配前还
必须复核一次：进程已经消失或成为僵尸时收敛为已退出；仍然存活且身份不匹配时才显式失败，
并且绝不向它发送信号。

本地启动的 Browser 必须将 Chromium 进程组身份与 agent-browser daemon 分开记录：
Chromium 可能建立独立进程组，并在 daemon 退出后继续存活。Config 硬停止必须包含两组，
Browser 恢复只选择该 Session generation 记录的 Chromium 组。借用 Chrome 或连接远程
Browser 端点不代表 Farming 拥有其浏览器进程。

停止单个 Terminal 也遵循同一 Hard-stop Ownership 规则。Native 与 Local PTY Engine 必须对
完整进程组直接发送 `SIGKILL`，不能只杀 Leader PID，确保后台 Descendant 不会在 Agent Row
消失后继续存活。发送信号前必须立即复核已记录的 Leader Identity；Identity 不匹配，或 Leader
仍存在但无法读取其 Identity 时，必须显式失败且不得发送信号。Exit 路径也必须先执行相同的
进程组清理，再释放持久 Ownership Record。

### 显式停止全部开发实例

源码工作区的 `npm restart` 会先显式停止当前用户的 Farming 进程，再构建并启动。
这个范围更广的开发命令记录选中的 Farming 根进程及其后代，逐一重新核验进程身份，
先对 Server 根进程、再对工作进程直接发送 `SIGKILL`。等待仅用于确认退出，绝不请求
优雅退出。目标已退出时直接收敛且不发信号；仍存活的身份不匹配或信号失败会明确报错。

最后再次发现进程，确认没有 Farming 残留。操作期间独立启动的新进程会作为并发启动
冲突报告，不会自动纳入重复停止。若其他任务或监督进程持续启动 Farming，需要先停止
该启动来源，再重试全局重启。

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
有无 Live Server 时的精确进程清理、Hard-stop Signal 语义、独立鉴权与 Runtime Namespace、
Browser Base Path，以及 Project 与 Provider Home 的安全共享。
