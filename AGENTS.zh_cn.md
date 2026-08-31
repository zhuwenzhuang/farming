# AGENTS.md - 仓库开发指南

> English version: [AGENTS.md](./AGENTS.md)

本文档为参与 Farming 开发的 AI Agent 与贡献者提供仓库级说明。

## 本文档的边界

本文档应保持精简、稳定，并适用于仓库中的大多数改动。这里只放：

- 支撑工程决策所需的产品目标；
- 仓库级架构与所有权边界；
- 跨模块的工程、文档与验证规则；
- 指向正式详细文档的索引。

不要在这里放功能规格、字段清单、精确状态机、发布操作手册、临时调试记录或
已完成工作的历史。这些内容应分别进入对应的产品或开发文档、代码与测试、
Release Notes 或 Issue。只适用于某个子目录的规则，应优先写进该目录更近的
`AGENTS.md`。

公开文档默认使用英文。本文档与 `AGENTS.md` 的语义必须保持一致。

## 产品目标

Farming 是一个在浏览器中监督 AI Coding Agent 的工作空间。它的首要设计约束是
人的注意力：用户应能发现重要工作、理解当前状态并及时介入，而不必反复切换
Terminal、Editor、Browser 与监控页面。

Farming Code 是默认界面；Farming CRT 是连接同一组后端 Session 的另一套实时
界面；Farming Net 是用于打开可信 Farming 实例的独立部署目录，必须与主运行时
的配置和凭据隔离。

优先选择：

- 清晰的 Project 与 Agent 分组；
- 紧凑控件与稳定、不跳动的布局；
- 每个操作都有可见反馈；
- 重要操作均可通过键盘完成；
- 明确且有界的失败，而不是静默降级到低质量路径；
- 帮助用户监督工作的界面，而不是尽可能堆满状态的界面。

修复行为时保留现有视觉风格和产品文案，除非需求本身有明确的视觉或文案理由。

Code UI 工作遵守 [UI 设计协议](docs/development/ui-design-protocol.zh_cn.md)。先确定语义
家族，复用其字排、图标、几何、状态和响应式公共规格。公共规则应在共享所有者处修改，并
验证受影响的同类使用者；页面局部样式差异必须有明确记录的产品理由，不能只保证颜色
Token 相同。

交互状态样式是产品级契约，不是局部组件细节。Selected、Active、Focused、Hovered、
Pressed、Loading、Disabled、Success、Warning 与 Error 等状态，必须在相关的行、列表、
Tab、菜单、Editor 与不同外观主题之间使用一致的视觉语言。接受局部样式改动前，应检查
组合后的完整界面及同时出现的状态；相同语义状态应共享 Token 与视觉层级，除非有明确且
已记录的产品理由需要区别处理。

不得用左侧线、色条、边框、轨道或等价的边缘标记表达行的 Selected 或 Active 状态。
应使用共享的选中表面、文字或图标处理，并避免在同一项上叠加多个相互竞争的选中提示。

同一组可选的 Project、Agent、文件或 Tab 中，Hovered 与 Selected 项使用相同的表面颜色。
不得仅为了区分鼠标悬浮与选中状态而引入第二种填充色。

视觉上连续的控件或状态表面必须使用同一套外轮廓圆角。它的基础层、Hover 或 Selected
填充层、覆盖层与操作层都必须保持相同的外侧圆角；除非是明确设计的组合控件，否则不能
一端为方角、另一端为圆角。

## 先阅读正式上下文

修改子系统前，先阅读它当前的代码、测试与正式文档。入口是
[开发文档](docs/development/README.zh_cn.md)。主要文档包括：

- [ACP Runtime](docs/products/code/acp-runtime.zh_cn.md)
- [Codex Runtime](docs/products/code/codex-runtime.zh_cn.md)
- [Terminal State Protocol](docs/products/code/terminal-state-protocol.zh_cn.md)
- [Extension 与 Resource Model](docs/products/code/extension-model.zh_cn.md)
- [Project Files Design](docs/products/code/project-files-section-design.zh_cn.md)
- [Package 安装与更新生命周期](docs/development/package-installation-lifecycle.zh_cn.md)
- [Config 实例隔离](docs/development/config-instance-isolation.zh_cn.md)
- [Farming Net 指南](docs/products/net/guide.zh_cn.md)
- [验收与 Dogfood 计划](docs/products/code/test/acceptance-dogfood-plan.zh_cn.md)

这些文档是各子系统契约的所有者。持久的产品、架构、交互或验证契约发生变化时，
更新拥有它的文档；不要再把详细规则复制回本文档。

## 架构边界

```text
Browser 界面
  React / Vite / Monaco / Terminal Renderer
          |
          | HTTP 与版本化 WebSocket 协议
          v
Farming Backend
  Auth / Lifecycle / Session / Files / History / Configuration
          |
          | Native PTY Host 与 Provider Adapter
          v
执行环境
  Shell / Coding Agent / 可选 Browser 与 Computer Resource
```

- Backend 拥有 Lifecycle、Runtime、Auth、Session、Workspace、Usage 与
  Configuration 的权威状态。Frontend 负责呈现，不得从 Terminal 文本或过期 UI
  数据重新推断后端事实。
- 交互式 Terminal 的产品路径是 Native PTY Host；调试实现不是自动产品降级路径。
- Coding Agent 的结构化 Chat 通过 Provider Adapter 使用 ACP。Provider 特有的
  Discovery、Capability、Executable 与 Session 行为应留在该边界，不要把
  Provider 名称判断散落到通用 Lifecycle 或 UI 代码中。
- 性能、正确性、可靠性、恢复、资源隔离与可观测性等横切改进，必须通过
  Provider-neutral Contract 和等价验收标准同时适用于所有受支持的 Agent 与
  Provider。Provider 差异只能由 Adapter 吸收；只适用于单一 Provider 的实现
  不能视为已经完成的系统级优化。
- Executable 的所有权按 Runtime Mode 区分：Native Terminal 优先使用用户的
  系统 Executable，只有在 Farming 自有 Executable 的已验证版本更高时才选择
  自有版本；ACP 独立使用 Farming 自有且锁定版本的 Adapter/Runtime，不得继承
  Terminal 的选择结果。ACP Pin 必须保持足够新，并用选定 Provider 版本验证
  Chat/Terminal 切换。
- Browser 与 Computer 能力位于 `extensions/`，并组合共享的 Resource 与协议
  契约。不要为已经支持的能力再创建一套未经同等测试的实现。
- 声称展示当前 Capability、Inventory、Configuration 或 Health 的页面必须发起
  新的权威读取，并提供有界 Loading 与明确失败。后台 Prefetch 可以服务导航，
  但不能自动成为当前状态证据。
- 每个身份和状态迁移只保留一个事实来源。兼容数据形状应停留在系统边界，不得
  渗入新功能代码。
- 可关闭的 UI 区域共用 [UI 交互协议](docs/development/ui-interaction-protocol.zh_cn.md)。
  声明完整边界，将外部 Pointer 和 Escape 仲裁委托给共享交互层，不要在组件中新增独立的全局监听。

## 工程规则

- 改动范围应与需求一致，并保留工作区中无关的已有修改。
- 优先复用现有模式与本地 Helper。只有当前改动已经证明存在稳定、重复的边界时
  才增加抽象。
- 在边界校验输入，并返回可操作的错误信息。
- Server 路径使用异步 I/O。昂贵的文件系统和 CLI 工作必须有界；已有缓存模式时
  应继续复用。
- 不得硬编码 Secret、私有 Host、个人路径或机器特有假设。文件操作必须留在被
  授权的 Workspace 或 Config Root 内。
- 保持 Agent Process 与 Config Instance 隔离。修改或清理前，按精确身份解析
  Process、Workspace、Session 与外部 Resource 的所有权。
- Farming 只有一种主动 Stop 语义：直接杀掉该 Stop 选中的、由 Farming 拥有的全部进程。
  不得增加 Graceful Shutdown 或 Drain、Handoff、进程保留或复用，也不得增加另一种
  Stop Mode。这个单一的 Hard-stop 契约用于刻意简化状态管理；下次启动必须按进程突然
  丢失来恢复。这是状态机正确性约束，而不只是实现上的简化：Graceful Termination 会
  增加第二种终止场景，并可能隐藏只有突然终止才会暴露的问题。Recovery 与 Cleanup 的
  正确性必须以 Hard-stop 路径为准。`npm restart` 是完整停止 Farming 后全新启动。兼容的
  Server-only 重连属于故障恢复行为，不是 Stop 语义。
- 模糊的 Timeout 或 Transport Failure 属于结果未知。应从权威状态做 Reconcile；
  除非协议明确证明可安全重放，否则不得自动重试 Mutation。
- 每个非平凡功能在实现前都要写出最小状态迁移模型：权威 Owner、Trigger、Guard、
  Effect、终止失败、Retry、Cancellation、Concurrency 与 Recovery。
- 发现竞态时，必须先解释架构或代码为何允许它发生：是状态机不完整、Owner 或时序
  不清晰，还是使用了不严谨的 Fallback。应在该不变量的权威边界修正根因；不得用
  Retry、Fallback Value、额外 Flag 或补偿分支掩盖未知状态，导致状态机在未证明
  正确性的情况下继续复杂化。
- 同时建立 Safety 与 Liveness：非法状态必须被拒绝；每个瞬态都必须有一条有界
  路径到达 Success、Failure、Cancellation、Timeout 或 Recovery。
- 优先维护一条持续测试的产品路径。只有达到与主路径相同验收标准的 Fallback 才
  是受支持行为。
- 不得仅为通过检查而使用 `any`、`@ts-nocheck` 或等价方式削弱类型边界。
- 存在权威源码时，不要直接编辑生成的 Runtime 输出；应修改源码并运行对应构建
  脚本。

## 仓库地图

- `backend/`：Server、Lifecycle、Session Engine、Provider Adapter、Store 与后端测试。
- `src/`：Farming Code React 应用与共享 UI State。
- `frontend/`：Farming Net、CRT 与 Classic Browser Runtime 源码。
- `extensions/`：可选 Browser 与 Computer 能力。
- `shared/`：Browser 与 Backend 共用的协议契约。
- `tests/e2e/`：Browser、Interaction 与 Visual 测试。
- `scripts/`：Build、Packaging、Release、Smoke 与测试编排。
- `docs/`：用户、产品、开发、运维与验证文档。
- `docs-site/`：拥有独立依赖的公开文档站项目。
- `release-notes/`：按版本保存的公开 Release Notes。

`dist/`、`dist-release/`、`.tmp/`、`reference/`、`node_modules/` 等生成或本地专用
目录不得提交。

## 文档规则

行为或结构变化时，在同一个改动中更新文档：

- 文档改动必须保持最小化，并局限于需求涉及的行为。除非用户明确要求重新设计或
  重写，否则在增加功能说明或发布说明时，不得顺手重组信息架构、替换页面结构或
  视觉设计，也不得大幅改写既有内容。

- `README.md`：顶层产品承诺、主要安装方式和首次使用路径；
- `docs/README.md`：精简的公开文档索引；
- `docs/products/*/README.md`：精简的产品 Landing Page；
- `docs/products/` 与 `docs/development/`：持久的设计、架构、状态机、失败、恢复与
  验证契约；
- `CONTRIBUTING.md`：贡献者环境与日常贡献流程；
- `release-notes/`：已经发布、与版本绑定的用户可见变化；
- `AGENTS.md`：仅限仓库级开发说明。

公开文档默认使用英文，并提供同目录 `.zh_cn.md` 版本与双向链接。不得公开对话
日志、临时调查、私有部署细节，或更适合由代码和测试表达的实现琐事。

长期文档只描述架构元素、所有权边界、状态转换、失败与恢复语义、交互设计和验收
标准。不要维护逐文件变更表、类/函数清单、测试文件目录，或把当前控制流复制成
说明文字。这些细节应留在代码、测试、提交、Issue 或专门的执行 Runbook 中。
整篇文档如果只是在叙述当前实现，应直接删除；混合文档仍有价值时，只保留长期
设计契约并删除实现清单。

## 验证

迭代时先运行最小且有效的检查，再根据风险与受影响 Surface 运行所有必要检查。
常用 Gate 包括：

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run test:e2e:playwright
```

- Backend 测试位于 `backend/tests/`；Browser 与 Visual 测试位于 `tests/e2e/`。
- 从状态模型推导测试；相关时覆盖高风险非法序列、Concurrency、Cancellation、
  Reordering、Reconnect 与 Restart。
- 日常自动化使用确定性的 Fake Agent；真实 Provider Smoke 必须显式、低频且隔离。
- 每个测试与复现都必须清理自己创建的精确 Temporary Directory、Socket、Process、
  Container 与 Fixture，包括失败路径；不得用宽泛的递归清理器补偿。
- 小型合成 Fixture 适合首轮验证。接受非平凡 UI 或 Runtime 改动前，还应运行一个
  组合相关 Surface 的生产形态场景。
- 可见交互发生变化时，应验证真实 UI，并在适用时更新聚焦的 Playwright Screenshot。
- 对可见 UI 改动进行截图验收时，必须覆盖所有受影响且受支持的外观主题（目前为
  Light、Dark、Paper）。未覆盖全部主题时必须明确说明，不得称为完整视觉验收。
- 产品截图和录像必须通过已提交的脚本或聚焦的自动化场景生成，不能靠人工把握 UI
  时机。等待目标内容真实可见；交互录像保留鼠标移动和点击；校验产物尺寸与画面；
  每次运行后精确清理由本次任务创建的浏览器、资源、进程和临时状态。空白、残缺画面
  或遗留录制进程都属于自动化缺陷。

日常流程见[贡献指南](CONTRIBUTING.zh_cn.md)；子系统专用 Gate 见对应的正式开发与
产品文档。

## 公开与发布卫生

- 不得提交 Release Binary、Secret、Token、真实环境文件、内部 Host、私有链接、
  个人机器路径或私有 Registry。
- 配置示例保持通用。
- Screenshot 使用匿名 Demo Workspace 与示例 Hostname。
- 通过仓库脚本与 Workflow 构建和发布；不得提交生成的 Release Artifact。
