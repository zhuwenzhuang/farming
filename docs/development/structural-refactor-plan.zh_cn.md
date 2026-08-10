# 结构性重构策略

> English version: [structural-refactor-plan.md](./structural-refactor-plan.md)

本文定义 Farming 在产品功能持续进入 `main` 的同时，如何降低结构性债务。它负责
目标边界、依赖顺序、协作规则和完成标准，不是进度日志，也不维护逐文件实现清单。
当前任务分配、Base SHA 和临时分支状态应放在活跃 Issue 或协调看板中。

## 目标结果

目标不是让文件变短，而是缩小改动的影响范围：

- 每份权威状态都有一个具名所有者；
- 产品界面展示状态，不自行重建后端事实；
- Runtime 和 Provider 差异位于有类型的边界之后；
- 高风险状态转换无需启动整个产品即可测试；
- 功能与重构可以作为小而可验证的变更独立合入。

如果一次重构只是搬代码、引入庞大的 Host 接口、复制生产路径，或把一个大文件
换成多个相互强耦合的文件，就没有实现这个目标。

但行为中立的纯物理拆分仍然可能有价值：它保持生产代码量与控制流基本不变，不新增
可变状态或跨模块 API，并沿已经存在的 Component、纯函数或渲染 Surface 边界移动。
它可以降低 Review、Merge Conflict 和 Coding Agent 的上下文成本。这类工作只建立
物理 Owner，不能宣称已经完成状态架构重构。

宿主文件变短、聚焦测试通过或状态机更显式，都不能单独证明重构成功。审查还必须
确认系统总代码知识、状态身份数量和跨模块推理成本下降。已经确认存在复杂度回归的
领域，应先完成收敛，再开始新的大型提取。

## 不变量

每个重构切片都必须保持以下条件：

- **行为保持。**HTTP 路由、WebSocket 协议形状、UI 交互、视觉样式、产品文案、
  持久化、恢复和清理语义保持不变；另行批准的产品变更除外。
- **一条产品路径。**新旧实现不能长期作为两条并行生产路径。一个有界切片序列应
  建立边界、切换调用方并删除被替代的路径。
- **一个状态所有者。**提取后的代码必须拥有一个内聚状态机，或者是纯策略；不能
  镜像其他位置拥有的可变状态。
- **状态与转换规则同属一个领域。**Registry 和 Store 可以保存权威身份与数据，但
  不能与 Domain Service 同时解释同一个 Operation 的成功、失败或不确定结果。
- **复杂度有预算。**审查同时比较宿主职责、新增生产代码、Port/API 数量、
  Map/Generation/Revision/Latch 数量和测试专用导出。宿主少量减行、系统大量增行的
  提取默认不成立，除非新增代码关闭了无法用更小模型表达的明确安全缺口。
- **精确身份。**跨越任何边界时，Agent、Runtime epoch、Config instance、
  Workspace、Provider Home 和外部资源所有权都必须保持精确。
- **有界结果。**取消、超时、不确定的变更结果、重启、重连和过期完成都保留明确的
  终止路径。
- **当前门禁。**迭代时运行最小聚焦检查，合入前运行与风险相称的全部仓库门禁。

各子系统的 canonical 契约继续由其所属文档负责，包括
[ACP Runtime](../products/code/acp-runtime.zh_cn.md)、
[Terminal 状态协议](../products/code/terminal-state-protocol.zh_cn.md)和
[Agent 列表状态协议](../products/code/agent-list-state-protocol.zh_cn.md)。

## 目标边界

```text
浏览器视图
  React 布局与渲染
          |
          v
应用 Controller 与纯 Reducer
  Session inventory / Project / Settings / Chat / Terminal attachment
          |
          v
有类型的 HTTP 与 WebSocket Client
          |
          v
Server Bootstrap
  auth / middleware / static mounting / router 与 WS 注册
          |
          v
应用 Service
  Agent lifecycle / Composer / Fork / Worktree / projection
          |
          v
Runtime Port 与 Provider Policy
  native PTY host / ACP host / provider adapter
```

依赖方向只能向下。下层不能导入 UI Controller 或更高层应用 Service。兼容形状
只能停留在 HTTP、WebSocket、持久化和 Runtime Host 边界。

### 后端所有权

- 重构期间，`AgentManager` 保持公开 Facade 和权威 Agent Registry 的角色。它
  拥有精确 Agent 身份和顶层生命周期准入，并通过窄 Port 委托内聚领域工作。
- Domain Service 拥有自己的内部状态和后置条件，不能仅为了随意调用方法而接收
  完整 Manager。
- Stateful Extraction 必须把权威 State Cluster 连同解释它的全部 Transition、
  Recovery、Dispose 与精确 Cleanup 规则一起迁走。方法移出但 Mutable Map 仍留在
  Host，只算物理拆分，不算 State Ownership。
- Callback Port 只传递事实或调用窄 Effect，不能把 Host 的 Decision Tree 藏进构造
  闭包。评审看语义知识而不是固定的 Callback 数量或行数阈值：只要闭包仍裁决
  Identity、Ordering、Retry 或 Outcome，责任就仍在 Host。
- Fork 已由一个 Coordinator 拥有：输入、效果、回滚和不确定结果都通过窄的
  Worktree、生命周期持久化和 ACP Runtime Port 明确表达。Manager 剩余领域遵循
  同样的 Port 纪律。
- 单 Agent 生命周期互斥由一个 Coordinator 统一拥有。Operation Token、替换 Agent
  接管、同 Key 合并、冲突操作排序、停机准入和 Drain 可见性都属于它；Manager 只
  提供生命周期 Effect，不再暴露或修改其 Map。
- Agent 启动准入由独立 Owner 管理 Create Request 幂等、运行中 Workspace 归属、
  停机 Drain 可见性和精确 Token 释放。Project 删除只能按 Workspace 查询 Pending
  Operation，不能检查准入 Map。
- Project Mutation 准入统一拥有 Request Key 幂等和 Workspace Key 互斥，包括排队
  删除与停机 Drain 可见性。Agent 启动只询问其 Workspace 是否与已准入删除相交。
- Runtime 停止证明与临时 Exit Event 抑制由同一个 Tracker 管理。已验证退出、重启
  Cleanup、事件过滤、精确 Forget 和 Dispose 不会再因 Manager 中两套 Set 而分叉。
- Provider Session Mutation 按 Provider、Home 和精确 Session Identity 采用中立排序。
  Codex Archive 仍是 Adapter Effect；排队、同操作合并、失败释放和 Drain 不是
  Codex 专属状态机。
- Terminal Provider Control 排序同样保持 Provider 中立。每个 Runtime 只尝试一次的
  Identity Resolution 与单 Agent Profile Mutation 串行化进入共享 Owner；Codex 的
  Preview 解析以及 `/status`、`/model` 命令仍属于 Provider Policy 与 Effect。
- ACP Transcript Projection 在一个 Service 中统一拥有 Prepared Cache Identity、按需
  Read 合并、序列化、失效、优先级和精确 Agent Cleanup。Manager 只保留 Live Agent
  准入和面向 Transport 的委托。
- Terminal Projection 去重把最后发布的 Status 与 Provider Profile 放进同一个 Weak
  Key Tracker。Event Handler 计算当前事实，但不再拥有平行 Projection Cache。
- Provider Adapter 提供有类型的权限重启、Terminal 身份/启动约束、空闲稳定和会话
  Fork 策略；通用生命周期代码不解释 Provider 名称。共享 Terminal Startup
  Coordinator 拥有可变的排序和就绪状态；Adapter 只提供无状态的资源作用域和就绪策略。

### ACP 所有权

- Farming Server 只通过 ACP Host Runtime 契约访问 ACP。
- `AcpRuntime` 继续作为 ACP Host 进程内部的执行引擎；目标是删除
  Server/AgentManager 的进程内 fallback，而不是删除 Host 引擎。
- 引擎 Session 状态与 ACP Host Controller/Operation 状态属于不同所有者。二者
  保持独立，通过显式 Projection 连接，不能合并为一个含义模糊的状态形状。

### Terminal 所有权

- Checkpoint 安装、有序 Output、序列缺口、Resize 转换和 Attachment generation
  共同构成一个顺序模型。
- Touch physics 与 IME/DOM 集成可以是独立策略或 Adapter；Checkpoint 和 Resize
  不能成为互相竞争的状态机。
- 浏览器 Session Registry 应显式且可注入；迁移期间保持现有公开 Singleton API
  稳定。

### 前端所有权

- React 布局组件不拥有请求竞态、Retry generation、分页调和或过期响应淘汰。
- Controller 按产品领域组织，而不是每个 `fetch` 一个 Wrapper。每个 Controller
  同时拥有请求生命周期和对应 Reducer。
- 在收窄 UI Props 之前，先由纯 Reducer 定义 Session inventory、分页、Project
  Operation 等状态转换。

## 当前收敛判断

本轮已经形成一批健康边界：Server Transport、Worktree/Git Effect、Provider
Session Identity、Usage、Adaptive Title、Settings、部分 WebSocket Delivery，
以及 Fork 的 Durable Admission/Reconcile（含共享、no-replay 的重启收敛）、
统一的 Fork Child-start 落定规则、Domain Coordinator 之上的薄 Resume Transport。
它们要么删除了旧生产路径，
要么成为一个明确状态或副作用的唯一 Owner。

当前需要优先返工的结构问题是：

1. `CodeWorkspace` 的一部分 Controller 复制后端 Truth，或只包装 Reducer/Fetch；
2. Terminal Link/Resize/Attachment 存在重叠的 Operation Identity；
3. Attention/Unread Transition 已有 Tracker，但 Persistence/Recovery Projection
   与 Facade Wrapper 仍和 Manager 分担同一组知识；
4. Stylesheet 已有物理 Owner，但 Selector Hash 与 Manifest 不能单独证明跨 Owner
   Cascade 等价。

Resume 保留两张内部 Admission Map，因为 HTTP Resume 是完整 Operation，而
Direct/Auto Resume 是 Effect 级入口；二者能否合并为一个 Admission 尚未证明，
不能当作已知缺陷。Launch 保持小型组合边界：Provider Adapter 声明 Provider
行为，Executable Discovery 负责选择机制，Manager 拥有唯一的 Shell Environment
Cache 并组装 Launch Request。除非更小的 Owner 能删除已证明的重复真相，否则
不要再创建大型 Launch Service 或 Port Surface。

在这些问题收敛前，不继续新的大型状态提取。未提交 Prototype 只是证据；如果它
需要不断增加 Ledger、Registry、Generation、Latch 或补偿 Flag 才能通过 Review，
应缩回更小状态机或直接丢弃。

领域状态机拥有转换规则；底层 Registry/Store 负责精确身份和可靠持久化，Effect
Executor 只报告已经发生的事实。不能把同一个判断拆成“Coordinator 判一次、
Lifecycle 层判一次、Manager 再判一次”。

### 巨型宿主的目标角色

- `agent-manager.cts` 最终只保留精确 Agent Registry、公共 Facade、Service
  Composition 和事件出口。Recovery/Start/Restart/Archive/Kill 属于同一个 Agent
  Lifecycle 领域；Fork 与 Project/Worktree 是独立领域，不能继续以内联大段形式留在
  Manager，也不能只套一层无状态 Wrapper。
- `CodeWorkspace.tsx` 最终只保留页面布局、当前选择、浏览器本地 Workspace Surface
  和子组件组合。Composer 可以拥有 Draft/Menu/Attachment Preview；Project
  Membership、Agent Lifecycle 和持久 Mutation 结果必须直接投影后端权威状态。
- `terminal-session-pool.ts` 最终只保留 Registry、Bootstrap、Attach/Detach 和稳定
  Public API。Checkpoint/Output/Reconnect 形成一个 Replication 能力，Selection/
  Context Menu/IME/Touch 形成一个 Interaction 能力；两者都使用同一个 Attachment
  Operation Identity。
- CRT `app.ts` 按真实产品面拆成 Shell、Agent List、History/Search、Workspace Launch、
  Billing、ACP Chat 和共享 Terminal 接入。不得把一个连续大块搬成更大的 Controller
  后就宣称完成。
- `workspace-file-service.cts` 保持 Facade，内部按 Path Policy、File Read/Mutation、
  Search、Git 和 Watcher 五种执行能力拆分；这些执行器不拥有产品业务状态。
- `acp-runtime.cts` 只沿 Runtime Process Pool 与 per-Agent Session Binding 两个真实
  权威边界收敛，不按每个 ACP 方法建立 Service。
- `AgentTranscriptPane.tsx` 与 `CodeSidebar.tsx` 优先按已有 React Component 边界做
  行为中立移动，不新增 Controller 或异步状态。
- `main.css` 与 `code-dark.css` 按渲染 Surface 迁移；每次必须证明全局 Cascade，不能
  仅用文件内 Hash、Selector Prefix 或 Import Manifest 自证。

## 持续集成模型

`main` 是唯一集成时间轴。重构在独立 Worktree 中施工，但完成的切片持续合入最新
`main`，不建立长期重构 Integration Branch。

### 实现与审查责任

- 由一个持续工作的实现 Owner 贯穿连续切片并保留上下文。它可以委托边界明确的
  调查，但必须对同一个内聚方案和 Worktree 负责，不能把每次返工交给新的 Writer。
- 实现 Owner 可以挑战本文方案并提出更简单的边界。只要新设计删除了更多重复知识、
  保持全部不变量并提供更强证据，就应采纳，而不是机械执行原计划。
- 独立的集成 Reviewer 控制目标、范围、过程和最终 Commit。聚焦测试全绿只是审查
  输入，不等于已经获得合入授权。
- Review 必须明确接受、拒绝或纠正一个切片。被拒绝的设计应在违反不变量的 Owner
  边界上缩小或替换，不能通过不断增加 Map、Generation、Latch、Flag 和兼容分支
  无限修补。
- 最终 Diff Audit 与 Commit 由集成 Reviewer 执行，质量责任不能转交给实现 Owner。

### 切片契约

Agent 开始切片前，协调记录必须写明：

- 目标和明确不做的内容；
- 精确 Base SHA；
- 独占热点文件与允许新增的文件；
- 权威状态所有者与依赖方向；
- 证明行为等价的测试或契约；
- 聚焦检查和最终门禁；
- 预计合入窗口。

一个热点文件同时只有一个活跃写入者。只有文件所有权确实不相交时才允许并行。
功能变更必须触碰同一热点时，功能优先；重构应在功能合入后 Rebase，或者先合入
一个功能可以直接使用的小型稳定边界。

### 过期预算

- 一个切片应在一个工作日内合入；如果两天内仍无法保持可审查，就必须继续拆分。
- 每次工作开始、`main` 上相关热点变化后、以及最终验证前都要 Rebase。
- 分支落后 `main` 超过十个提交，或者独占热点发生语义变化时，停止扩展并先调和。
- 如果调和需要重新设计而不是机械 Rebase，应在当前 `main` 上重放小型意图。旧
  Prototype 是证据和测试来源，不是第二个 Merge Base。
- 合入后及时删除 Worktree 和分支，保持所有权清晰。

### 合入形状

实际可行时优先采用以下顺序：

1. 为现有行为补 Characterization Test 或 Contract Test；
2. 引入纯 Policy、Reducer 或窄 Port；
3. 切换一个调用方并删除其旧实现；
4. Rebase 当前 `main`、运行所需门禁并立即合入。

一个切片通常包含一到三个可审查提交。一条 Track 是这种切片的队列，而不是一个
长期分支。

## 依赖方案

本方案使用依赖门禁，而不是 Big-bang Wave。Foundation 完成后，互不冲突的 Lane
可以并行。

### Foundation —— 契约护栏

`shared/` 中的 Agent state snapshot/delta 线协议契约、HTTP Route Manifest 和
有类型的 WebSocket Dispatch 已经作为护栏就位。移动其余高风险所有者前，仍需对应
护栏：覆盖 Server 可见行为、恢复、不确定 Prompt/Cancel 结果和精确 Runtime 身份
的 ACP Host 契约测试；以及先固化待移动状态的顺序、过期完成、重连和 Generation
行为。

这些是契约护栏，不是新的兼容层。

### Lane F1 —— Transcript 纯逻辑

可独立测试的 Transcript 逻辑——文件链接解析与位置规范化、Fetch Retry Policy、
Reading Anchor 捕获与恢复——应位于纯模块中。在后续变更证明另一个稳定所有者
之前，渲染和 Live Transcript 编排继续留在组件中。

### Lane F2 —— Workspace 应用 Controller

`CodeWorkspace` 已把若干领域迁到 Controller，但当前 Controller 数量和生产总代码的
增长超过了宿主职责下降。下一阶段不是继续提取，而是先分类现有 Owner：

1. 保留真正拥有浏览器本地状态的 Composer、Workspace Surface 和 Session View
   Owner；
2. 合并或删除只包装 Reducer、Fetch 或 Backend Truth 的 Resource、Catalog、Project
   Mutation 层；
3. 让 Project/Agent Mutation 直接投影后端权威结果，删除前端平行 Admission、
   Deadline 和 Reconcile Truth；
4. 完成收敛后再围绕剩余 Owner 收窄组件 Props。

### Lane F3 —— Terminal 浏览器 Runtime

浏览器 Runtime 已具备可注入 Session Registry；一个 Attachment Coordinator 拥有
Checkpoint 顺序与准入、Ordered Output、Gap 和 Attachment Generation；并有 Code/CRT
共享 Replay、Renderer、Link、Input 和 Recovery Owner。Session Pool 目前仍拥有
Checkpoint 安装副作用、请求重试和 DOM 写入完成。同一所有权 Lane 内的剩余
范围：

1. 先把 Link、Resize 与 Renderer 使用的身份收敛为一个 Attachment Operation；
2. 删除重复 Commit Latch、Revision 和仅服务于 E2E 的常驻生产 Projection；
3. 再按实际能力把 Replication（Checkpoint/Output/Reconnect）与 Interaction
   （Selection/Context Menu/IME/Touch）从 Session Pool 迁出；
4. Pool 最终只保留 Registry、Bootstrap、Attach/Detach 和稳定公开 API。

每个切片都必须运行 Code 与 CRT 的 Terminal 协议 E2E。

### Lane B1 —— Server Transport 边界

`server.cts` 已是 Bootstrap，并具备 Route Manifest、有类型的 WebSocket Dispatch，
以及 Session inventory 与 Search、Settings、Agent 与 Project Mutation、Agent
Lifecycle、ACP Interaction 的 Domain Router 与 WebSocket Handler 分组。Agent State
Broadcast Scheduler 已是本 Transport Lane 的 Owner，并作为 Agent 状态 Delta 变更
意图的合并与调度的唯一所有者；权威 Projection 与 Tracker 仍在其之外。

Per-client 的 Agent 状态 Snapshot 下发已有自己的连接级 Owner
`WebSocketAgentStateSnapshotController`。它拥有每个 Client 的 Cut Serial、分页与
Backpressure、延迟下发、重启与溢出处理、有界失败与清理，以及 Activity/ACP/Preview
完成屏障：该屏障把这些后续恢复下发挡在该 Client 权威 Snapshot Cut 完成之前，待该
Cut 完成后再放行。权威 Projection 与 Broadcast Scheduler 仍在该边界之外。

剩余范围：

- 抽取其余有界 Bootstrap 领域：ACP Agent HTTP Operation、Usage 与 Update
  Operation、Auth/Share/Static 分组，仅在分离确有价值时进行。

不要每种 Message 一个文件。每个切片保持 Route Manifest、Middleware 顺序、
Response Shape 和连接级状态不变。

### Lane B2 —— Agent 应用 Service

触碰 `agent-manager.cts` 的切片继续串行。Usage、Adaptive Title、Worktree/Git、
Composer Admission、Fork 的 Durable Admission/Reconcile 与 Resume Coordination
以及跨 Runtime 的 Per-Agent Input Ordering 均已有 Owner。Provider-neutral Terminal
Resize 的 Latest-value Coalescing 与 Drain 状态也已有唯一 Owner，并与 Engine Resize
Effect 分离。Shell Environment Resolution 也在 Manager 外拥有 Provider、Bounded
Cache、Expiry 与 Cleanup；Activity Timestamp 与 Throttled Activity Publication 也归
一个 Tracker 所有。ACP Settled-Turn Finalization 也把 Per-Agent Admission/Tail、Runtime
Fence、Durable Convergence、Attention Publication、Drain 与精确 Cleanup 作为一套状态机
共同拥有。Manager 内部直接调用 Attention Tracker，不保留会形成第二个伪 Owner 的重复
Facade Wrapper。Worktree Refresh 的 Coalescing 与 Generation Fence 也已共同归一个 Owner，
因此 Delete/Reuse 会同时淘汰 Pending 和已开始的旧 Observation。Provider-neutral Terminal Startup Ordering 也已有唯一 Owner，由类型化
Adapter Policy 激活，而不是由 Provider Name 分支激活。Launch Composition 保留在
Manager，并组合 Provider Adapter 与 Executable Discovery 边界。剩余范围：

1. 保持共享 Fork Child-start Settlement 的窄边界；Worktree 与 Provider Session
   Rollback 继续按资源分别拥有。除非 Retained-resource 语义被证明相同，否则不要
   再造通用 Rollback Executor；
2. 只有拿到具体的重复真相证据（例如同一请求被两种 Signature 定义分别裁决）才再动
   Resume；只有更小的边界能明确删除 Provider 或 Executable 知识，而不是把它们包装
   成 Port 时，才移动 Launch Composition；
3. 围绕现有 Tracker 收敛 Attention/Unread Persistence、Recovery Projection 与
   Facade Delegation，再让 Runtime/Record Type 随 Owner 移动；
4. Facade 最终只保留精确 Agent Registry、公共入口、Service Composition 与事件出口。

行数不是验收标准。只有当一个 Service 减少 Manager 的系统知识，并能在不构造完整
Manager 的情况下测试时，提取才算成功。

### Lane B3 —— ACP Host 收敛与 Provider Policy

本 Lane 与 B2 共享 AgentManager 热点，因此与冲突的 B2 切片串行，但不必等待所有
提取完成：

1. 让 ACP Host Runtime 契约成为 Server 唯一默认访问路径；
2. 把依赖直接进程内 fallback 的测试改为显式 Runtime Fake 或 Host Harness；
3. 删除 AgentManager 的 fallback 构造，同时保留 Host 进程内部的
   `AcpRuntime`；
4. 定义并测试 Engine Session State 到 Host Controller/Operation State 的
   Projection；
5. 把 Provider 特例逐步吸收到有类型的 Adapter Policy 中。

每次触及 Provider Runtime 行为后，都必须为受影响的全部 Provider 运行隔离、低量
Real-provider Smoke。

### 辅助 Helper

不要建立通用 Backend Utility 集合。只在重复边界已经被证明时使用聚焦模块共享，
例如 Record Guard、Bounded Wait 或 Process Execution。集中化会增加耦合时，简单
重复可以保留。

## 后续推进优先级

剩余工作按以下依赖顺序继续拆成小切片。本列表记录未完成的架构结果，不记录临时
Branch 或逐文件进度：

1. 先审计并收敛 `CodeWorkspace` 与 Terminal 的既有 Owner，或沿已可见的组件边界
   做严格行为中立的物理拆分。前端删除 Backend Truth 镜像与 Wrapper-only
   Controller；Terminal 统一 Attachment Operation Identity 后再迁出 Replication
   与 Interaction。
2. AgentManager 下一步围绕现有 Tracker 收敛 Attention/Unread；Fork 的资源回滚继续
   保持精确且分离。没有具体重复真相证据时，不继续 Resume 与 Launch。
3. 重新评估未提交 Stylesheet 与 CRT Prototype。只有当生产边界真实、系统总代码
   合理且一次性旧/新行为证据成立时才合入；否则缩小或丢弃。
4. 完成剩余 Server Transport 与 ACP 工作。在保持 Auth、Middleware 顺序、Route
   Shape 和连接级状态不变的前提下抽取其余有界 HTTP 与 Bootstrap 领域；并收敛到
   Server 只经过 ACP Host 的路径：确定性 Host Fake 或 Harness 覆盖恢复与
   Prompt/Cancel 不确定结果后删除进程内 Fallback，通过显式 Projection 分离
   Engine State 与 Host Operation State，并运行要求的 Real-provider Smoke。
5. 持续退役已经失效的兼容代码。Compatibility Alias、Adapter、Fallback、Parser
   Branch 或旧 State Shape 只有在全仓调用分析和边界测试证明没有受支持的 Client、
   Protocol Version、持久化数据、Extension 或 Public API 继续依赖时才能删除。用一个
   行为中立的小切片同时删除失效路径及仅服务于该路径的测试；不能因为它曾支持旧实现
   就保留不可达代码，也不能仅凭静态 Import 就把仍处于系统边界的 Adapter 判为死代码。
6. Stylesheet 继续拆分前必须证明全局 Cascade，而不只证明每个分区内部的 Selector
   Hash。其余产品 Domain 从主样式表和 Dark Skin 样式表拆出时，必须同时提供
   Cascade、Specificity 与 Import 顺序证据。
7. 持续集成。每个可审查切片都 Rebase 到当前 `main`，先运行聚焦状态机测试，再运行
   完整 Typecheck、Lint、Test 及适用的 Server、Terminal、Playwright 或 Provider
   门禁后合入。不能把这些优先项重新积累成长期 Integration Branch。

### Stylesheet 所有权

超大应用 Stylesheet 是一条可独立推进的辅助 Lane，可以在代码热点被占用时拆分。
Git History、Composer、Plugin、Settings、Share 和 Pet Surface 已有各自的样式
Owner；主样式表与 Code Dark Skin 样式表仍需完成其余产品 Domain 拆分。拆分
必须按产品 Domain 和渲染 Surface，而不是按任意行数。每个切片同时迁移该 Domain 的
基础规则、Dark Skin Override、Responsive Rule、Animation 和样式契约测试，并保持
运行时 Import 顺序、Cascade、Specificity 和视觉行为不变。Theme Token 与独立 Skin
继续作为不同 Owner。源码契约测试应读取声明式 Style-source Manifest，而不是假设所有
Selector 都位于一个巨型文件中。只有当组件源码与真实渲染 DOM 都证明受支持状态、
Extension 和响应式布局不会再产生某个 Selector 时才能删除它；可见样式切片必须完成
聚焦的桌面、Dark 和窄布局验证。

## 验证

每个切片根据状态模型定义聚焦门禁。默认最终门禁为：

```bash
npm run typecheck
npm run lint
npm test
```

另外：

- Server Router 或 WebSocket 变更使用 `FARMING_INCLUDE_SERVER_TESTS=1` 运行 Server
  Lifecycle 与 Protocol 测试。
- Terminal 变更运行 Code 与 CRT 的 Checkpoint、Reconnect、Resize、IME、TUI 和
  Multi-viewer 场景。
- Agent Lifecycle、Worktree、Fork 或 ACP 变更覆盖取消、并发、不确定结果、重启、
  恢复和精确清理。
- 可见前端变更在存在对应交互时运行桌面和窄布局的聚焦 Playwright 场景。
- ACP Host 与 Provider Policy 变更在确定性测试通过后运行隔离、低量
  Real-provider Smoke。

代码移动时，测试可以随之移动或改变直接 Import，但不能仅为了适应提取而削弱行为
断言。

## 完成标准

满足以下全部条件时，本策略完成：

- Server Bootstrap 主要挂载 Middleware、Router 和 WebSocket Domain Handler，
  Route 契约保持不变。
- `AgentManager` 成为具名所有者之上的 Facade，不再包含 Provider 行为决策或内嵌
  Worktree/Attention 实现。
- Farming Server 只通过 Host 契约访问 ACP；Host 保留执行引擎和权威 Operation
  Journal。
- Terminal Checkpoint、Output、Gap、Resize 和 Attachment 顺序拥有一个浏览器
  Coordinator 和一个可测试 Registry。
- `CodeWorkspace` 展示 Domain Controller 状态，不再拥有原始分页、过期响应或
  Project Mutation 状态机。
- Transcript Parsing、Retry Policy 和 Reading Anchor 是有独立测试的纯模块。
- 系统边界上的共享线协议契约只有一个定义。
- 上述任一领域的普通功能只需修改一个所有者和对应测试，而不是多个无关巨型文件。

## 拒绝的模式

- 长期 Integration Branch 或最终 Big-bang Merge；
- 同一切片混合重构和产品行为变化；
- 每个请求一个 Wrapper，或每种 WebSocket Message 一个模块；
- 只是隐藏 Provider 名称 Switch 的 Capability Flag 泛滥；
- 包含无关 Helper 的通用 `utils` 模块；
- 把完整 Manager 传给每个提取后的 Service；
- Checkpoint 与 Resize 各自拥有重叠顺序状态；
- 保留两条没有等价测试的生产实现作为 Fallback；
- 把减少行数当成架构改善的证据；
- 为通过下一条 Review 意见持续叠加 Ledger、Registry、Generation、Revision、Latch
  或动态 Error Flag，却不重新检查 Owner 边界；
- 生产模块暴露仅由测试消费的 API，或用源码字符串与同源 Manifest 作为核心正确性
  证据。

CRT/Code 统一、广泛 tsconfig 修改和无关产品重设计仍不在本次范围内。它们需要独立
契约和验收计划。
