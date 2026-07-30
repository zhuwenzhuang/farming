# Farming Code 扩展模型

> English version: [extension-model.md](./extension-model.md)

状态：内部 Viewer 基础和基于 agent-browser 的 Browser Resource MVP 已经实现，但尚不是公开的第三方 Extension API。

## 已实现的基础

Project Files 现在通过同一个内部 Viewer Registry 解析内置的 Markdown、SVG 和 HTML Viewer。这建立了第一条窄而明确的 Extension 边界，但没有引入 Package 安装、动态第三方代码或第二套 Editor Framework。

静态 HTML Viewer 复用现有文件 Tab 和 Source / Preview 交互。一个有界的内存 Preview Session 只授权所选 Project Root 下的资源，并通过 Farming 已有且受鉴权保护的 HTTP Service 提供文件，因此不会新增监听端口。浏览器在沙箱 iframe 中渲染当前未保存草稿，禁用 Script、Form 提交、嵌套 Frame 和主动网络 API，并且只通过同一 Preview Session 解析已授权的相对静态资源。点击相对 HTML 链接后仍留在同一个 Session 中，目标页面的 Workspace Root 相对资源也继续经过 Broker。关闭 Viewer 会删除 Session；过期时间与容量上限负责回收遗留 Session。

用户显式打开的已知 Project Root 之外的可读文件仍然只读。对于精确打开的外部 HTML，临时 Preview Session 只授权该 HTML 所在目录，以便加载相对资源；它不会把这个目录加入 Files 浏览、Search、编辑或 Git Scope。

Browser Extension 是第一种实时 Resource 实现，集成默认关闭。插件页只提供“自动”“已发现的本机 Chromium”和“隔离浏览器”；自动模式优先使用兼容的本机 Executable，否则使用已经准备好的隔离运行时。普通用户不再配置 CDP 地址。只有“已启用且当前可用”时，Extension 才贡献 Browser UI，并接受 Browser API、EventSource、Viewer WebSocket、CLI 或 MCP 操作。

每个存活 Agent 可以拥有多个身份稳定、可重命名的 Browser Row，并具有显式的 `stopped -> starting -> running -> stopping -> stopped` 生命周期；启动或运行失败进入 `failed`。Project Root 仍然是文件、上传和下载的隔离边界，但不再是 Runtime Owner。同一 Agent、同一 Browser Source 下正在运行的 Row，是一个共享 agent-browser Session 中的多个带标签 Tab；即使属于同一个 Project，不同 Agent 也绝不共享 Session、Profile、Cookie 或 Storage。Local Session 拥有 Chromium Process 与隔离 Profile；隔离 Session 则拥有当前 Browser Owner 的精确带 Label Docker Container Lease，内部回环 CDP 只是 Transport，不是用户配置。同一个 Browser 身份上的操作串行执行，Runtime Command 边界还会再次串行，因此服务 Viewer 的截图不能与 Agent Action 竞争。Stop 会先关闭新接收、排空已经接收的有界 Action，再关闭 Tab 与 Session；最后一个 Lease 结束后才停止隔离 Container。过期 Runtime 与 Viewer Generation 都会被拒绝。Agent 在 Chat/Terminal 间切换时保留 Resource；停止或归档 Agent 会停止 Browser Runtime 但保留 Row 与 Profile；恢复后只按需重新启动；删除 Agent 会删除其 Browser Resource、独立 Profile 与隔离 Browser Container。Farming 重启时，之前仍处于运行态的行会标记为失败，并在恢复前停止已经证明属于本实例的遗留隔离 Container。每次持久化变更都会同时递增 Row Revision 与 Collection Revision。后端先注册实时事件监听，再发送权威 Collection Snapshot；UI 按 Revision 归约 HTTP、EventSource 与 Viewer 更新，因此传输乱序不能让状态回退，也不能删除更新的状态。

三个来源复用同一个版本精确锁定的 `agent-browser` Runtime。安装与更新准备阶段会在旧 Server 仍可用时下载 package-lock 锁定的公共 npm Tarball，校验 Integrity，并只把选中平台 Entry 提取到 Farming 的不可变 Cache。旧 Linux 上只有这个依赖选择同一 Package 中静态链接的 musl Entry，Codex 与 Claude 仍使用正常平台 Entry；Active Manifest 按依赖记录该选择，Cache Prune 因而不会误删正在使用的 Artifact。Server 启动时先校验 Cache，再打开端口；只有全新安装或条目缺失、损坏时才修复，且不复用系统安装的 `agent-browser`。

准备隔离浏览器是插件页中唯一主要的 Browser 下载路径。用户显式操作后，Farming 拉取锁定的上游 `trycua/cuabot` 1.0.5 镜像（压缩后约 2 GB）。Farming 会并行、限时探测已审查的 Registry Name，再按实测延迟依次尝试；所有 Name 都必须指向同一精确 Digest。标准 Docker Daemon Mirror（包括账号级阿里云镜像加速器）可以承接这些 Pull，但不成为 Farming 自身配置。只有真实 Chromium/CDP Probe 成功后才进入 Ready；安装、更新和 Server 启动绝不会拉取它。

来源选择是普通持久化产品设置，不需要重启 Farming。Local Resource 由 Farming 把选中的 Chromium Executable 与独立 Profile 交给锁定版本的 `agent-browser`。隔离 Resource 的 Docker 创建、精确 Label 和回环 CDP Relay 由 Computer Extension 管理，Endpoint 只在内部交给同一个 `agent-browser`。它是一台独立的 Agent-owned Browser Container，而不是完整 Computer Desktop Container，因为经过审查的桌面镜像不包含 Chromium。Browser 仍只有一套 Automation 与 Viewer 实现。旧的受管 Chromium 与外部 CDP 设置只保留读取兼容，不再是普通插件选项。

受鉴权保护的 Viewer 代理 Runtime 的 Session-scoped WebSocket Stream。Frame 使用 JPEG 保持交互响应速度，Viewport、Pointer、Wheel、Keyboard 与 Text Input 则通过同一个 Session 返回。Viewer 按 Frame 上报的 CSS 尺寸绘制；Client 较慢时会丢弃已经被新 Frame 取代的内容。Agent Command 与人的输入因此操作同一个 Browser Identity，Farming 不再携带第二条原生 CDP Action Path。

Browser 插件在 ACP Session 创建边界处已启用时，Farming 会通过现有 Provider Adapter，把完整且细粒度的 `browser_*` MCP Tool Catalog 挂载给 Codex、Claude Code、OpenCode 与 Qoder。`browser_open` 负责创建、挂载和启动当前 Agent 拥有的 Resource；其他工具分别保留生命周期、导航、交互、检查、诊断、状态与文件契约。CLI 是 Terminal 访问同一份能力 Contract 的 Transport，不是第二套实现。已经运行的 ACP Session 如果之后才启用 Browser，需要明确重启 Chat Runtime 后才能获得这些 Schema。

每个受支持 Agent 也会在 Terminal 进程或 ACP Session 的创建与恢复边界收到同一段简短的 Farming 启动提示，但 Farming 不修改 Project 或 Provider 自己的 Instruction 文件。这段提示说明 Farming 把 `agent-browser` 封装成 Agent 的结构化操作入口和用户可见的共享 Viewer，让 Agent 更好地操作网页，也让用户在 Farming 中理解进展并随时接管。提示要求 Agent 通过 `"$FARMING_CLI_BIN_DIR/farming"` 这一实例精确入口查询 Capability，不依赖登录 Shell 可能重排的 `PATH`，也不能假设能力存在。工具选择以整体效率、可靠性、可验证性和任务适配度为准；对于本身不依赖交互界面的任务，当前 Agent 自带的能力、环境中已有的 CLI、项目工具和服务专用 Connector 能更直接、更快或更可靠地完成时，应优先使用。当任务本身必须依赖浏览器或完整桌面交互且对应 Farming 能力可用时，Agent 优先使用 Farming Browser 或 Computer，让用户与 Agent 关注、操作并按需接管同一个共享 Resource。用户明确指定工具时仍以用户选择为准。Terminal Agent 用 Browser `list` 发现自己拥有的 Resource；Browser 顶层 Help 只披露起点，`help workflow` 给出标准流程，Topic Help 展开单个能力域，最后由 Command Help 披露精确参数。`farming-browser` 继续作为 npm Bin 别名，`farming browser mcp` 则是 Provider Adapter 和显式外部调用方共用的标准 stdio 入口。完整支持合同见 [Farming Browser Agent CLI](./browser-agent-cli.zh_cn.md)。

Farming Code 后续应通过 Extension 扩展能力，而不是把每一种新资源和 Agent 能力直接加入核心产品。浏览器是当前最明确的例子，但不应因此在核心中形成一套一次性的浏览器子系统。

Farming Code 通过统一的插件页面呈现这些能力。左上角的紧凑拼图按钮和空白欢迎页上的大型“插件”入口进入同一个页面；插件生命周期与配置归属这里，不再堆进通用设置。进入插件页本身只读，启用或停用仍是显式操作。

Farming 随发行包提供一个默认可选的 HTTPS 公共镜像。只有有界的精确版本元数据查询返回相同版本与 SRI时才使用镜像；否则，或镜像下载随后失败时，Farming 都使用 Manifest 中的权威 npm URL。`FARMING_RUNTIME_NPM_MIRROR` 可以覆盖包内候选，或设为 `off` 关闭。

## Resource 与 Viewer 模型

Extension 可以贡献一种有类型的 Resource，以及用于展示该 Resource 的一个或多个 Viewer。Farming 负责外围的 Workspace、Tab 和布局行为；Extension 负责该 Resource 特有的渲染和生命周期语义。

Files 已经体现了这一基础思想：文本、Markdown、图片、PDF、Diff 等文件类型使用不同 Viewer，但仍处在同一个 Workspace 上下文中。浏览器可以沿用同一模型，把页面视为一种实时超文本 Resource。它的 Viewer 可以展示本地或远端页面，但 Farming 应把它当成另一种可打开 Surface，而不是把浏览器行为硬编码到 Agent 和文件 UI 的各个位置。

未来一个 Extension Package 可以贡献：

- Resource 类型和稳定 Resource 身份；
- Viewer、Command 和上下文操作；
- 实时 Resource 所需的后端 Runtime 或连接 Adapter；
- Agent Tools 及其使用指引；
- Capability、Permission 和 Health 元数据。

内置 Extension 和外部安装的 Extension 应使用同一份 Contract。内置只应影响分发方式和默认信任级别，不应产生第二套接入架构。

## Agent Capability 投影

Extension 应通过一份由 Farming 定义的 Capability Contract 发布 Agent Tools。Extension 不应分别实现 Codex、Claude、OpenCode 和 Qoder 接入。

Farming 启动或恢复 Agent 时，会通过 Provider Adapter 在每个 Terminal 进程和 ACP Session 边界注入简短的 Farming 启动提示：Codex 使用 Developer Instructions，Claude Code 使用追加的 System Prompt，OpenCode 使用进程内 Instructions 文件，Qoder 使用追加的 System Prompt。实时可用性不写死在提示词中：`farming capabilities` 会报告 Browser 是 Disabled、Unavailable 还是 Available。Browser 在新建 ACP Session 的边界已启用时，同一个 Provider Adapter 还会自动投影完整的 `browser_*` MCP Tool Catalog。Terminal Agent 按需使用渐进披露的 `farming browser` CLI；`farming browser mcp` 继续作为显式手工集成使用的 stdio Transport。Tool Identity、Schema、Ownership、Permission Policy 和 Result Semantics 仍由 Farming Extension Contract 定义。

预期关系是：

```text
Extension Runtime 与 Viewer
          |
          | Farming Extension Contract
          v
Farming Resource UI + Agent Capability Registry
          |
          | 启动提示 + ACP MCP 或 Terminal CLI
          v
Codex / Claude / OpenCode / Qoder
```

Agent 仍然可以保留 Provider 原生或用户自行安装的工具。Farming 不会静默替换这些工具。Tool Ownership 和名称冲突必须显式处理，当前 Agent 也应能发现哪些 Capability 来自 Farming、哪些来自 Provider 自身。

## Browser Extension 示例

Farming 的 Browser Extension 拥有每个 Browser Resource 身份，以及 Viewer 和 Agent Tool 共用的页面 Target。同一 Agent 与 Browser Source 下的 Resource 共享一个 agent-browser Session，不同 Agent 保持隔离。Local Session 拥有 Chromium Process 与隔离 Profile；隔离 Session 拥有 Computer Extension 管理的精确带 Label Browser Container 的一个 Lease。旧 External CDP Session 只拥有连接和创建的 Target，不拥有外部浏览器、Profile 或 Endpoint 生命周期。

MVP 有意只支持一套操作实现：锁定版本的 `agent-browser` Command 与 Stream Protocol，通过系统浏览器 Executable 或隔离 Browser Container 的私有回环 CDP Endpoint 进入。旧受管 Chromium 和 External CDP 设置只保留读取兼容。结构化 Agent Surface 已覆盖导航与等待、DOM 交互、检查与 JavaScript、Console/Error/Network 诊断、Cookie/Storage、Frame/Dialog 和 Project 级 Upload/Download。它不暴露浏览器原生窗口框架、Extension、下载界面、DevTools Window、任意桌面交互或 Computer Use。这些属于独立产品能力，不是隐藏的 Fallback Path。

每个 Browser 都有持久唯一 ID、一个 Agent Owner，以及用于文件隔离的 Project Root。在侧栏中它默认隐藏在 **Agent → Resources → Browsers** 下；展开或收起这两层都不会改变 Runtime 或 Viewer 状态。Browser 仍可通过 `browser` URL Query Parameter 直接打开。删除系统浏览器 Row 时必须先停止精确 Runtime，再删除独立 Profile；删除某 Owner 最后一条隔离 Row 时会停止并删除经过精确校验的 Container；删除旧 External CDP Row 时只关闭 Farming 创建的 Target。

Viewer 地址栏接受完整 HTTP(S) URL 或裸 Host。裸公网域名默认补全为 HTTPS；回环地址、IP 字面量、单段内网 Host 和显式非默认端口默认使用 HTTP。Farming 不会猜测 `www` Host。导航失败会明确显示；下一次导航开始时会清除旧错误，成功后也不会残留上一次失败提示。Viewer 键盘输入通过隐藏文本代理接收，因此已提交的输入法文字和粘贴内容可以进入页面；普通 ASCII 按键仍走低延迟的流式通道。

## 待确定问题

第一版实现必须解决以下问题，之后才能把 Extension API 视为稳定 Contract：

- 未来如何通过显式 Handoff 把 Agent-owned Resource 提升为 Project-shared Resource；
- 如何展示 Tool 名称冲突和 Provider 原生等价能力；
- Extension UI 在 Farming 页面内如何隔离和授权；
- Farming Core 对实时 Extension Runtime 要求哪些生命周期与恢复保证。

当前已经明确的架构约束是：Resource 展示和 Agent Tools 属于同一个 Extension；Provider 特有的翻译继续留在现有 Provider Adapter 边界。
