# Farming 验收与 Dogfood 方案

> English version: [acceptance-dogfood-plan.md](./acceptance-dogfood-plan.md)

本 Runbook 定义如何验收 Farming 这套真实 Multi-Agent Workspace。自动化证明可重复契约；
Dogfood 证明组合后的产品在生产形态使用中是否可理解、响应及时且可恢复。

## 验收问题

每轮必须回答：

1. 用户能否从桌面与手机打开本机或远端 Workspace，并监督多个 Agent？
2. Chat、Terminal、Files、Review、History、Browser、Computer、Settings 与 Update 是否对
   Agent/Session 权威状态达成一致？
3. Reconnect、Restart、Cancel、Archive、Process Exit、弱网与结果不确定是否可见且可恢复？
4. Agent 与 Session 数量增长时，性能是否仍可接受？
5. 界面是否降低注意力成本，而不是制造重复或误导状态？

## 测试层级

| 层级 | 常见频率 | 目标 |
| --- | --- | --- |
| Static、Unit 与 Protocol Test | 每次改动 | 状态转换、Validation、Ownership、Reducer |
| 确定性 Browser Test | 受影响 UI 改动 | 使用 Fake Agent 重复验证用户路径 |
| Production-shaped Integration | 非平凡 Runtime/UI 改动 | 组合 Backend、Browser、Files 与 Lifecycle |
| Real-provider Smoke | 合并或发布前 | Login、真实 CLI/ACP、Resume、Runtime Switch |
| Long Soak 与 Scale | 显式或夜间 | Duration、Reconnect、Memory、Navigation、Many Agents |

## Behavior-first 开发契约

User-visible 工作先用可观察的 Given/When/Then 条件描述 Scenario。修复 Regression 时，先增加
能最小复现失败的 Behavior Test，再修改实现；缺陷跨越 UI 或子系统边界时，还要新增或更新一条
确定性 Browser Journey。Gherkin 或独立 BDD Framework 不是必需条件；Scenario 必须清晰且结果
必须可执行验证。

使用三条互补 Test Seam：

1. Pure State-transition Test 不经过 Rendering，验证 Ordering、Guard、Retry、Cancel 与 Recovery；
2. Public Boundary Test 驱动 Exported Service、HTTP Protocol 或 Rendered Control，并断言 Output
   或 Accessible UI State；
3. Playwright Journey 通过可见用户操作验证关键 Cross-surface Behavior，以及最终 Effect、Persistence
   与 Restoration。

读取 Production Source 并搜索 Identifier 的测试，只能用于狭窄的 Architecture 或 Packaging Boundary，
不能作为 UI Behavior Evidence。State Transition、Rendering、Navigation、Focus、Pagination 或
Recovery 不得新增 Source-text Assertion；相关区域发生修改时，应逐步替换为 Imported State Test、
Public-boundary Test 或 Browser Journey。

关键产品承诺登记在 `tests/behavior-contracts.json`。每条 Contract 都有稳定 ID、可观察 Promise、
所属设计文档和可执行 Evidence。UI Contract 必须指向一条同时带有 `@critical-behavior` 与自身
Contract ID 的 Playwright Journey；Contract Validator 会拒绝缺失、未登记或以 Source Inspection
冒充的 Evidence。CI 除完整的分片 Browser Suite 外，还会把这些场景作为独立命名的
**Critical behavior** Gate 执行，使重构不能靠宽泛但绿色的结构测试掩盖已知产品回退。如果某个
Scenario 失败会静默改变持久的 Cross-surface Interaction 或 Lifecycle Guarantee，就应将它提升为
这份 Registry 中的 Contract。

真实 Provider Test 必须显式、低频且隔离；不得 Reset Quota、改写 Provider Login/Default，
也不得启动无关的大型任务。

## 目标环境

至少使用：

- 开发平台，用于快速迭代；
- Linux Host 或 Container，用于安装、远端与 Runtime 验证；
- Phone-size Browser Viewport，用于监督与短介入；
- Electron 或 Native Integration 变化时的 macOS Desktop。

记录 Farming Revision 与 Installation Form、操作系统、Node/npm 版本、Provider Executable Path
与版本、Config Directory、Base Path、Authentication Mode，以及 Local/Remote 类型。

私有 Host、Token 与用户内容不得进入已提交报告。

## 隔离与清理

每个自动化或 Agent-driven Story 使用独立的：

- Config Directory 与 Browser Context；
- Workspace 与 Port；
- Server Log 与 Artifact Directory；
- 在不能使用用户 Existing Session Store 的场景中，独立 Provider Home。

从 Live Farming Agent 内启动测试时，不能继承父 Farming Config。每个 Story 必须清理自己创建
的精确 Process、Socket、Temporary File、Container、Browser/Computer Resource 与 Provider
Session，包括失败路径。不得使用宽范围 Recursive Cleaner 补偿。

## 场景矩阵

### Startup、Connection 与 Update

验证首次启动、Authenticated URL、Base Path、Port Conflict、Duplicate Config Ownership、
Local/Remote Connection、Reconnect、Update Prepare、Restart、Rollback 与 Missing Dependency
显式失败。Partial 或 Uncertain Start 不能创建第二个 Daemon，也不能丢失 Last Known Good Installation。

手机回到前台、`pageshow`/Back-forward Cache 恢复和 `online` 事件必须通过有界的
Business-health Probe 对账当前 WebSocket。健康的 Open Socket 保持不变；只有 Probe 或首次连接
Deadline 失败且仍属于同一 Socket Generation 时才替换连接。Authentication 与 Protocol Close
Code 保持终止态。Composer Draft 跨恢复保留；结果不确定的 Input 必须由用户显式重试，Browser
不能自动重放。如果 Browser 把保留的 Socket 标为 Closing 或 Closed 却遗漏 Close Event，回到
前台时仍必须通过同一条有界 Close 路径替换它。

### Agent Lifecycle 与 Configuration

验证 Executable Discovery、精确 Agent Home Selection、New Agent、Duplicate Request、Title、
Permission Change、Model/Reasoning/Speed、Config Override Persistence、Unsupported Option
Fallback、Archive、Delete、Restore 与 Process Cleanup。

Agent 与 Provider Identity 必须跨 Restart 与 Chat/Terminal Replacement 保持稳定。Unsupported
Control 不能只因 Provider 名称出现。

### Structured Chat

验证 Connection、Prompt、Queue/Steer、Cancel、Permission、Form、Authentication、Config、
Attachment、Media、Tool、Patch、Plan、Child Session、Fork 与 Failure Recovery。

History 与 Live Update 使用同一有序 Transcript。Checkpoint/Delta Gap 必须触发 Replacement，
不能丢内容。Reload 恢复语义阅读位置，同时不为所有 Inactive Chat 保留完整 DOM。结果不确定的
Prompt 绝不能自动重放。

### Terminal

验证 Native/Packaged PTY、Direct Typing、Enter、Paste、中文与 IME、Scroll Stability、URL 与
File Location、Resize、Mouse Mode、Full-screen TUI、Multi-viewer、Hidden-page Resume、Server
Restart、Host Rotation、Exit 与 Renderer Failure。

Recovery 后 Terminal 只显示一份权威 Screen；Input 恰好到达一次，慢 Viewer 不能阻塞其它 Viewer。

### Project、Files、Review 与 History

验证 Project Membership、Empty Project、Git Worktree、Order、Pin、Search、Pagination、Files、
Deep Tree、Reload Restore、Symlink、Edit、External Change、Uncertain Mutation、Git History、
Line Changes、Review Revision、Reviewed State、Comment 与 History Resume。

Agent 出现、重排、归档或消失时，Files 始终由 Workspace 拥有。Working Tree 后续变化不能改变
历史 Review Evidence。
Session 渐进展示必须覆盖连续多次“显示更多”和“显示较少”，不能只验证 Pagination Control 存在。

### Browser、Computer、Extension 与 Desktop

验证 Fresh Capability Read、Agent Home Scope、Resource Ownership、Browser/Computer Isolation、
Human/Agent Shared Control、Handoff、Stop/Delete、Reconnect、Restart 与 Uncertain Action。ACP
与 Terminal 必须访问同一 Capability Contract。

Desktop Story 只使用可见控件：Local Launch、Remote Enrollment、Cancel、Backend Switch、
Tunnel Loss、Startup 期间 Quit、Relaunch、Files、History、Terminal Input 与 Focus/Fullscreen。
打开 Extension Source File 必须在 Files 中自动定位；Workspace 前进/返回必须恢复此前 Plugins
Tab、Home、Kind、Detail 与 Scroll Location。

### Usage、Notification、Mobile 与 Accessibility

验证 Provider-backed Usage、No-data/Failure、Completion Notification、Unread、Keyboard Focus
Restore、Menu Dismiss、Accessible Name、Phone Navigation、Software Keyboard、Refresh 与 Remote
Reconnect。缺失 Telemetry 应省略或解释，不能虚构。

可见的 Code 变更还要在 Linux Chromium 上为 Light、Dark、Paper 三种外观生成确定性的
Base/Head 截图，并覆盖 Settings、Search、History 与 Plugins 视图。Computed Style 断言保护
语义角色与对比度；跨外观截图保护那些即使单个 CSS 值都合法，组合后仍可能出错的构图、
层级、间距、边框及其他视觉关系。

只有在截图前后，具名场景都保持权威且稳定时，验收截图才能写入证据。Journey 必须证明场景
特定的 Runtime 或 UI 状态、必要的可见控件，以及会影响结果位置的交互表面；Capture 还要
跨越截图边界比较 Visual Viewport、页面滚动和声明为稳定的几何状态。Identity、Readiness、
Visibility、Scroll 或 Geometry 任一发生变化，都必须丢弃临时图片且不得写入 Manifest。
重试必须重新运行完整场景，不能把 Proof 已失败的 Capture 提升为有效证据。

### Scale 与 Soak

运行大量 Live 与 Historical Agent；目标子系统面向该规模时，至少执行一次 100+ Session 场景。
测量：

- Backend 与 Provider Process Count；
- Backend、Browser 与 Provider Runtime 的 Memory/CPU；
- Chat/Terminal Navigation Latency；
- Transcript 与 State Wire Volume；
- Visible/Inactive View 的 DOM 与 Render Work；
- Reconnect、Restart 与 Cleanup Time。

不能通过设置固定并发上限让 Scale Test 通过。如果发现不在授权范围内的非 Chat/ACP 瓶颈，
应记录 Design Proposal 与 Evidence，不要静默扩大实现。

## Real-provider Smoke 规则

只使用极短 Prompt 或隔离 Workspace 中的极小文件修改。启动前确认 Login 与 Runtime。验证
Resume 或 Chat/Terminal Switch 时保留精确 Provider Session Identity，并记录成本敏感 Model。

真实 Provider Gate 只声明一个固定低成本 Model 与 Reasoning Level，任何 Turn 都不得计费到
其他 Model；仅为验证在线切换而被选中的 Model 不得收到任何 Prompt。由于新启动或 Resume 的
Provider Session 会继承自身配置，每个 Surface 必须先从 Provider Truth 确认声明的 Model，
必要时通过产品路径切回，再发送第一个 Prompt。该保证不得依赖执行者本机的 Provider 配置。

Login 或 Capability 缺失可以产生明确 Blocked Result；除非产品契约显式允许，不能自动切换到
另一个 Agent、Model、Permission Mode 或 Runtime。

## Evidence 与 Report

每个失败记录：

- Revision、Environment、Installation Form 与隔离 Config；
- 用户可见 Step、Expected、Actual 与 Last Stable State；
- Owner Lifecycle State 与 Outcome 是否 Known/Uncertain；
- 可见问题的 Screenshot 或 Video；
- 相关 Trace 与有界 Log Excerpt；
- Cleanup Result。

按 Severity 分类，并区分 Product Defect、Test Defect、Environment Limitation 与 Improvement
Proposal。Green Test 只是其声明场景的 Evidence，不是整个产品的证明。

## 通过标准

- 没有未解决 P0/P1。
- 受影响 Surface 的必要确定性检查通过。
- Real Provider 完成要求的 Smoke，或给出可操作且归属正确的失败原因。
- Mobile 与 Remote Supervision Path 可用。
- Restart/Reconnect 不丢失或重复已接受工作。
- 创建的所有 Resource 都被精确清理。
- 每个已接受 P2+ 问题都有持久 Evidence 与 Owner/Follow-up。

## 常用入口

迭代时运行最小相关检查，再按风险扩大：

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run test:behavior
npm run test:e2e:playwright
```

`test:behavior:contracts` 还会校验源码检查的归属。产品行为测试必须执行真实产品路径，
不得通过读取生产源码并断言私有字符串来证明行为。仅允许少量且有文档说明的静态契约检查：
架构边界、包组装、生成产物或安全约束。既有的实现文本债务冻结在
`tests/source-inspection-allowlist.json` 会区分允许的静态 allowlist 与既有行为测试债务。
Allowlist 仅限架构边界、包组装、生成产物或安全约束；既有债务条目不代表新测试可获准使用。
每项都有精确计数和 Owner。迁移时必须移除或降低对应条目；所有基线变更都需要 Review。

Purpose-built Release 或 Remote Smoke Command 应记录在所属子系统旁。未实现 Runner 不应先写进
本 Runbook；命令真正存在且可持续使用后再加入。
