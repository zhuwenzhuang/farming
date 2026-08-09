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

## 不变量

每个重构切片都必须保持以下条件：

- **行为保持。**HTTP 路由、WebSocket 协议形状、UI 交互、视觉样式、产品文案、
  持久化、恢复和清理语义保持不变；另行批准的产品变更除外。
- **一条产品路径。**新旧实现不能长期作为两条并行生产路径。一个有界切片序列应
  建立边界、切换调用方并删除被替代的路径。
- **一个状态所有者。**提取后的代码必须拥有一个内聚状态机，或者是纯策略；不能
  镜像其他位置拥有的可变状态。
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
- 在 Worktree、生命周期持久化和 ACP Runtime Port 足够窄之前，Fork 继续作为
  编排存在。之后才能提取输入、效果、回滚和不确定结果均明确的
  `ForkCoordinator`。
- Provider Adapter 提供有类型的权限重启、Terminal 身份、空闲稳定和会话 Fork
  策略；通用生命周期代码不解释 Provider 名称。

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

## 持续集成模型

`main` 是唯一集成时间轴。重构在独立 Worktree 中施工，但完成的切片持续合入最新
`main`，不建立长期重构 Integration Branch。

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

移动高风险所有者前先合入以下护栏：

1. 把 Agent state snapshot/delta 线协议契约集中到 `shared/`，并为后端 Projection
   和浏览器 Reducer 增加一致性测试。
2. 在抽取 Router 前增加 HTTP Route Manifest 测试，覆盖 Method、Path、注册顺序
   和关键 Middleware/Error Shape。
3. 用有类型的 Dispatch Table 取代 WebSocket Switch 的隐式完备性，并验证每种
   已协商 Client Message 恰好有一个 Handler。
4. 增加 ACP Host 契约测试，覆盖 Server 可见行为、恢复、不确定 Prompt/Cancel
   结果和精确 Runtime 身份。
5. 在移动 Terminal 逻辑前，固化 Checkpoint/Output/Resize 顺序、过期完成、重连
   和 Attachment generation 行为。

这些是契约护栏，不是新的兼容层。

### Lane F1 —— Transcript 纯逻辑

从 `AgentTranscriptPane` 小步提取可独立测试的逻辑：

1. 文件链接解析和位置规范化；
2. Transcript Fetch Retry Policy；
3. Reading Anchor 捕获与恢复。

在后续变更证明另一个稳定所有者之前，渲染和 Live Transcript 编排继续留在组件
中。已有 Prototype 必须调和到当前 `main`，不能通过旧 Integration Branch 合入。

### Lane F2 —— Workspace 应用 Controller

按领域重构 `CodeWorkspace`：

1. 把 Session inventory 和 `mainPageSessionKeys` 调和提取为纯 Reducer，并覆盖
   非法顺序；
2. 引入拥有分页、取消、Generation Check 和请求错误的 Session Inventory
   Controller；
3. 仅在每个领域确有内聚生命周期时，引入 Project Operation、Settings/Catalog、
   Resume/Share Controller；
4. 所有权迁出后再收窄组件 Props。

不要建立一组只把 `fetch` 搬到另一个文件的无状态 `api-*` Wrapper。

### Lane F3 —— Terminal 浏览器 Runtime

在一个所有权 Lane 内依次执行：

1. 提取并测试 Touch-scroll Physics；
2. 在小型 Adapter 后隔离 IME 与 DOM Input 集成；
3. 把模块级 Session Map 包装为可注入 Registry，同时保持当前 Exported API；
4. 提取一个 Terminal Attachment Coordinator，统一拥有 Checkpoint Install、
   Ordered Output、Gap、Resize 和 Attachment Generation；
5. 生产状态所有者稳定后，再移动 Diagnostic 和 Test Bridge。

步骤 3、4 完成后都必须运行 Code 与 CRT 的 Terminal 协议 E2E。

### Lane B1 —— Server Transport 边界

保持 `server.cts` 为 Bootstrap，每次只抽一个领域：

- Session inventory 与 Search；
- ACP Agent HTTP Operation；
- Agent 与 Project Mutation；
- Settings、Theme、Usage 与 Update Operation；
- 其余适合分离的有界 Auth/Share/Static Bootstrap Group。

WebSocket Handler 按协议领域分组：Handshake/Health、Agent Lifecycle、Terminal、
ACP Interaction、Focus/Scope、Workspace Resource。不要每种 Message 一个文件。
每个切片保持 Route Manifest、Middleware 顺序、Response Shape 和 WebSocket 行为。

### Lane B2 —— Agent 应用 Service

触碰 `agent-manager.cts` 的切片必须串行：

1. 把 Usage-rate Accounting 提取为有界纯 Projection；
2. 把 Attention/Unread 提取为有文档状态机和窄 Host Port 的所有者；
3. 把 Worktree/Git Operation 和已证明的后置条件提取为 Service；
4. Runtime 与 Record Type 随其新所有者移动，不进行最后一次全仓 Type Shuffle；
5. 只有依赖 Port 足够窄且状态转换模型明确后，才提取 Composer 或 Fork 编排。

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

1. 完成 Terminal Attachment Coordinator。Checkpoint 安装、Ordered Output、
   Sequence Gap、Resize Transition 和 Attachment Generation 必须只有一个顺序
   Owner。已有 Registry、Resize、Input 和 Recovery Policy 只能作为下层协作者，
   不能形成相互竞争的状态机。完成时必须覆盖生产形态的 Code 与 CRT Reconnect、
   Stale Completion、Gap、Resize 和 Multi-viewer 场景。
2. 完成边界完整的 Workspace Controller。只有当各 Controller 能同时拥有
   Admission、Cancellation、Stale-response Rejection、Reconciliation 和终止失败
   时，才继续把 Project Mutation、Settings、Resume 和 Share 请求生命周期移出
   Layout Component；随后再围绕这些 Owner 收窄组件 Props。不能用无状态 API
   Wrapper 替换 Inline Request。
3. 完成剩余 Server Transport Domain。在保持 Auth、Middleware 顺序、Route Shape
   和连接级状态不变的前提下，继续提取 Agent/Project Mutation、ACP Agent
   Operation、Settings、Attachment，以及剩余的 WebSocket Agent Lifecycle 和 ACP
   Interaction 分组。依赖 AgentManager 或 ACP 内部状态的切片必须等对应热点只有一个
   Writer 后再开始。
4. 串行继续 AgentManager Service 提取。先提取有明确 Postcondition 的 Worktree 与
   Git Operation，并让 Runtime/Record Type 随 Owner 移动；只有当 Lifecycle、
   Persistence、Worktree 和 ACP Port 足够窄，可以明确表达 Rollback 与不确定结果
   时，才提取 Composer 或 Fork Orchestration，且不能把完整 Manager 传入 Service。
5. 收敛到 Server 只经过 ACP Host 的路径。确定性 Host Fake 或 Harness 覆盖恢复和
   Prompt/Cancel 不确定结果后，删除 Server 进程内 Fallback；通过显式 Projection
   分离 Engine State 与 Host Operation State，并把 Provider 决策移入有类型的
   Adapter Policy。每个受影响 Provider 都要运行要求的 Real-provider Smoke。
6. 持续退役已经失效的兼容代码。Compatibility Alias、Adapter、Fallback、Parser
   Branch 或旧 State Shape 只有在全仓调用分析和边界测试证明没有受支持的 Client、
   Protocol Version、持久化数据、Extension 或 Public API 继续依赖时才能删除。用一个
   行为中立的小切片同时删除失效路径及仅服务于该路径的测试；不能因为它曾支持旧实现
   就保留不可达代码，也不能仅凭静态 Import 就把仍处于系统边界的 Adapter 判为死代码。
7. 持续集成。每个可审查切片都 Rebase 到当前 `main`，先运行聚焦状态机测试，再运行
   完整 Typecheck、Lint、Test 及适用的 Server、Terminal、Playwright 或 Provider
   门禁后合入。不能把这些优先项重新积累成长期 Integration Branch。

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
- 把减少行数当成架构改善的证据。

CRT/Code 统一、广泛 tsconfig 修改和无关产品重设计仍不在本次范围内。它们需要独立
契约和验收计划。
