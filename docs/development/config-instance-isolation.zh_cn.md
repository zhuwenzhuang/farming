# Config 实例隔离

> English version: [config-instance-isolation.md](./config-instance-isolation.md)

本文档定义多套 Farming 如何在同一台机器上运行，同时避免混淆 Farming 自有可变状态，也避免错误占有外部开发资源。

## 用户故事

- 用户可以用不同 Config 目录同时启动两套 Farming Server。
- 同一 Config 目录启动第二个 Server 时，必须在初始化 Agent 和其他 Config 自有 Runtime 之前失败。
- 通过软链接与真实路径访问同一 Config 时，两者属于同一个实例。
- 复制 Config 状态，不能让副本获得停止原实例进程的权限。
- 两个实例可以像普通外部客户端一样打开同一个项目或 Provider Home。Farming 不能虚构机器级独占权，排斥编辑器、Git 命令、Provider 工具或其他软件。

## 实例边界

canonical Config 目录就是 Farming 实例身份。Farming 会解析已存在的软链接；对于尚未创建的子目录，则以最近的已存在祖先为基础做规范化。canonical 路径的稳定指纹只用于紧凑命名，权威身份仍是 canonical 路径本身。

资源分为四类：

| 资源类型 | 隔离机制 |
| --- | --- |
| Farming 自有持久化状态 | 存放在 canonical Config 目录下 |
| Farming 自有 Runtime 命名空间 | 从 canonical Config 指纹派生 |
| Farming 自有子进程 | 精确进程身份加 Config 指纹 |
| 外部项目、Git 状态、Provider Home 与 Session | 作为普通外部资源共享；冲突由资源所属系统和权威重读处理 |

Farming Package Root 不属于本契约。共享安装目录的更新协调是另一项独立的生命周期问题。

## Server Owner 状态机

Config Owner 只有三个有业务意义的状态：

- **Unowned**：不存在已发布的 Owner Claim。
- **Owned**：完整 Claim 指向一个精确存活的 Server 进程。
- **Uncertain**：Claim 存在，但无法安全验证其中的进程身份。

启动时先准备完整 Claim，其中包含 canonical Config 身份和操作系统级精确进程身份，然后一次性原子发布。发布过程不会主动覆盖已有 Claim。

已有 Claim 时：

- 精确存活的 Owner 会拒绝新启动；
- 精确死亡或已证明 PID 复用的 Owner 可以先隔离再回收；
- 无法读取、格式损坏、身份不完整或权限结果不明确的 Owner 一律 fail closed，需要运维者检查。

这里没有 Heartbeat，也没有 TTL。时间久不能证明 Owner 已经死亡。正常停止会先在精确身份验证后发送 `SIGTERM`，经过有界宽限期后，仅当同一进程身份仍然存活时才发送 `SIGKILL`；它只会释放仍与目标 Server 精确匹配的 Claim，并先隔离该 Claim，再让共享 Owner 路径重新可用。崩溃后由下次启动执行同样的证明和恢复。

## Runtime 与鉴权隔离

Config 自有 Registry、Browser Profile、Computer Owner Label 与名称、native PTY Socket 身份、Runtime Dependency 状态、Token 和浏览器 Cookie 都服从同一个 Config 边界。因此，即使两套 Server 属于同一个操作系统用户，不同 Config 仍会得到不同的可变存储和 Runtime 命名空间。

浏览器 Cookie 包含 Config 指纹，因为 Cookie 不按 TCP 端口隔离。机器客户端使用 Bearer 鉴权，不依赖共享的浏览器 Cookie 名称。旧 Cookie 只保留只读迁移兼容。

持久化 ACP Process Record 同时保存精确进程身份与 Config 身份。清理 live Process 之前必须先验证 Config Scope。旧记录如果没有 Config 身份，只能使用 live Process Environment 的精确证据；证据不可用或有歧义时，清理必须显式失败。

## Runtime Base Path 契约

live Server 是浏览器 Base Path 的权威所有者。Server 必须在应用模块加载前，
通过入口文档注入 `window.__FARMING_BASE_PATH__`。React 应用的同源 HTTP、
WebSocket、页面导航与静态资源路径，只能通过 `src/lib/base-path.ts` 中的
`appPath` 和 `appWsUrl` 解析。功能代码不得自行读取 Vite `BASE_URL`、消费该
注入全局变量，或再实现一套 Base Path Helper。

最小状态模型如下：

- **权威所有者：** Server 进程及其配置的 `FARMING_BASE_PATH`；
- **初始化触发：** 浏览器解析 Server 生成的入口文档；
- **守卫：** 任何浏览器 Transport 启动前，先规范化注入路径；
- **效果：** 所有同源 Route 都与同一个规范化路径拼接；
- **Fallback：** 只有在没有 Runtime 路径时，例如独立开发或静态预览构建，
  才使用 Vite 的构建时 Base；
- **失败：** 绕开或缺失共享 Resolver 必须被持续测试拦截，不能静默请求 Origin Root；
- **恢复：** Base Path 变化必须重新加载入口文档，从而建立新的不可变浏览器路由快照。

构建和启动脚本还必须传递相同的默认 Base Path，作为纵深防御；但运行时
正确性不能依赖构建路径与 Server 路径恰好一致。测试必须覆盖“产物按 `/`
构建、live Server 运行在 `/farming`”的情况，因为安装包、Desktop、预览和
远程部署本来就会使用不同的构建 Profile。

## 正确性证明

安全性依赖以下不变式：

1. 同一个 canonical Config 路径最多发布一个有效 Owner Claim。
2. Server 只有拿到 Claim 后才能初始化 Config 自有 Runtime 状态。
3. Config 自有可变资源都由 canonical Config 路径或其指纹寻址，因此不同 Config 身份不会冲突。
4. 只有同时证明精确进程身份和 Config 归属后，才允许向持久化记录中的进程发送信号。
5. 外部资源不会因为被某个 Farming 实例打开，就被当作该实例独占。

在文件系统和进程检查能力正常的前提下，活性成立：空闲 Config 可以启动，已证明失效的 Owner 可以回收，每次 Claim 都会在有界时间内成功或给出可见失败。如果操作系统无法证明归属，系统有意优先保证安全，等待运维者处理，而不是猜测。

## 恢复与失败语义

- 重复启动会报告当前占用 Config 的 live Server。
- 精确失效的 Owner 不依赖超时即可回收。
- 未知 Owner 永远不会被自动删除。
- Config 副本不能利用持久化 ACP 元数据停止原实例的 live Process。
- 外部 Project 或 Provider 冲突继续通过底层文件系统、Git 或 Provider 行为暴露，并通过权威重读收敛；Farming 不承诺这些资源的跨进程事务。

## 验证策略

持续测试应覆盖：同 Config 并发启动、失效与未知 Owner、软链接等价、不同 Config 的两个 live Server、Config 自有路径与 Runtime Namespace 不相交、Cookie Scope 与 Bearer Client、native PTY 身份、Browser 与 Computer Owner、ACP Cleanup Fence。至少一个集成测试应真正同时运行两套 Server，并验证 Settings、Token、Cookie 与 Runtime Identity 相互独立。
