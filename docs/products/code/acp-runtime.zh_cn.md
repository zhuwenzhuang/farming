# ACP 后端 Runtime

> English version: [acp-runtime.md](./acp-runtime.md)

Farming 现在提供一条面向 Codex、Claude Code、OpenCode 和 Qoder 的 Agent Client Protocol runtime。后端生命周期与前端展示刻意分离：后端负责 Agent 进程、ACP Session 生命周期、统一状态和控制 API，`src/components/code/acp/` 则只描述 ACP Chat 行为。

## Provider 连接

- Codex 使用锁定版本的 `@agentclientprotocol/codex-acp` adapter。一份版本锁定的 `patch-package` 增量只增加可协商的 `_codex/session/steer` 扩展及其 `turn/steer` 转发；如果上游包与审阅过的 patch 不再匹配，打包会直接失败。打包随后把精确的已打补丁 adapter 复制进发行包，并锁定其 SHA-256；安装后的运行时只启动这个不可变产物，不依赖安装后修改依赖。单文件 CLI 通过内部进程入口打包该 adapter，原生产物 Smoke 必须经该入口完成 ACP `initialize` 握手。
- Claude Code 使用锁定版本的 `@agentclientprotocol/claude-agent-acp` adapter。
- OpenCode 使用自身的 `opencode acp --cwd <workspace>` 命令。
- Qoder 使用自身的 `qodercli --acp` 命令。Qoder 可能在 `session/load` 返回之后继续发送历史尾部，因此 Farming 会等待 replay stream 稳定后再暴露恢复完成的 Session。
- 四者都通过官方 `@agentclientprotocol/sdk`，在子进程 stdio 上使用按行分隔的 JSON-RPC 通信。

Adapter 包使用精确版本的 production dependency。Farming 启动 Agent 时不会执行 `npx latest`。

## Session 语义

实时 Codex adapter 可以在标准 ACP capability 之外声明带版本的 `_codex/session/steer` 扩展。Farming 只根据 initialize 响应启用它，不会仅凭 provider 名称推断能力。

只要 Agent 声明对应 capability，runtime 就支持 ACP 的 `initialize`、`authenticate`、`logout`、`session/new`、`session/load`、`session/resume`、`session/list`、`session/fork`、`session/delete`、`session/close`、`session/set_mode`、`session/set_config_option`、`session/prompt` 和 `session/cancel`。New、load、resume、fork 与 list 请求会保留标准的附加目录作用域；new、load、resume 与 fork 还会在 Adapter 边界保留客户端提供的命令型或 HTTP MCP Server 定义。统一的 WebSocket 与 Control HTTP Agent 启动接口都接受这两项标准 Session 输入，Chat/Terminal 或权限重启也会把它们带到 replacement ACP binding。这些输入不会进入浏览器可见的 Agent state，只保存在权限为 `0600` 的 Farming 私有 Session 记录中，以便崩溃恢复时重连相同作用域。Farming 不会为 Agent 未声明的可选方法伪造支持。

初始化时，Client 只声明 Farming 真正实现的 ACP 文件系统、Terminal、Terminal 认证、布尔配置、Plan、表单 elicitation、URL elicitation 与 Terminal 输出能力。Agent 对应请求分别由有边界的工作区文件访问、托管 Client Terminal、显式权限卡片、认证 UI 与 elicitation 表单处理。没有 `sessionId` 的 elicitation 会保持 request scope，包括 Session 创建前的认证输入；主 Session 与子 Session 请求也会分别保留自己的来源。文本、Reasoning、Plan、Tool Call、Diff、Terminal、Resource Link、图片、音频、Usage、Command、配置和子 Session 元数据等更新都归并到同一条有序 Session 模型。这与 Zed 的 capability 协商型 Client 模式一致：功能以实时 initialize/session 响应为准，而不是根据 Provider 名字猜测。

已有历史 Session 会在配置目录下保存 Farming 自有的 reducer checkpoint。其 identity 包含 provider、Agent Home、provider session id 和工作区；写入会压缩、同步文件与目录并原子替换。checkpoint 同时携带主 reducer、子 Session reducer、patch decision fence 和上一代浏览器 revision。发送 prompt 前 Farming 会持久化 dirty 标记。ACP 当前既没有 provider 自有的 opaque revision，也没有 conditional `session/resume`，因此比较时间戳不能证明本地状态精确；Farming 会 fail closed 到 `session/load`，checkpoint 只用于保留 revision/reset fence，避免浏览器继续保留已废弃 reducer 的旧 entry。bare resume 和提交结果不确定的 prompt 失败会一直保持 dirty，绝不能产生精确恢复 checkpoint。只有未来 provider 提供与工作区绑定的新鲜度 token 和条件恢复证明时，才可启用不重放的本地 resume。

这个区别很重要：ACP load 会在请求返回之前通过 `session/update` notification 重放完整对话，而 resume 只恢复上下文、不返回旧消息。Farming 会先注册 Session reducer 再发出 load，确保不会漏掉提前到达的历史 notification。重放更新归约进同一条有序流，不会逐条广播浏览器失效信号；恢复完成后客户端只收到一份稳定 snapshot。若 reader 的 `sinceRevision` 高于重建后的 reducer，或落在 reset fence 之前，后端会返回完整替换，而不是会错误保留旧内容的空 delta。

从历史恢复的 Chat 会一直保留稳定的同步界面，直到第一份非空且稳定的分页内容到达。连接阶段或过早进入 idle 的空 snapshot 不得替换已经可见的 transcript；可恢复的主页面 Agent 行也会先统一物化，再逐个准备大 transcript binding。

后端会缓存完整的受支持历史元数据窗口，并通过稳定 cursor 向 Farming Code 分页返回。滚动接近项目列表底部时加载下一页；项目里的“显示更多”仍只控制已加载页面内的本地展示。Agent Search 会查询后端完整历史窗口，而不是只过滤浏览器已经加载的页面。匹配不区分大小写，并有意只搜索可见的 Agent 或 Session 标题，以及 Project 名称和路径；provider 元数据、Session id 和 transcript 正文暂不参与搜索。后端返回的 Session identity 会被前端视为权威搜索命中，因此未来扩大范围时不会再被前端的标题过滤器丢弃。恢复历史时会在后端完整窗口内解析 provider 元数据，因此较老的 Session 在 Terminal 与 Chat 之间切换时仍能保留原工作区。Qoder 历史发现只把项目级 transcript 文件视为 Session；嵌套的子 Agent transcript 属于重放细节，不会再生成重复历史行。

ACP update 一方面以有界且限制单条大小的诊断数据保留，另一方面归约到一条与 provider 无关的有序 entry stream。历史重放和实时更新使用同一个 reducer；相邻且 message id 兼容的 message chunk 合并，但 Codex phase 元数据会保留，并阻止 commentary 跨越 `final_answer` 边界合并。tool update 按 id 原位更新最初的 tool-call entry，plan entry 原位更新。usage、mode、command 和 config option 等 Session 元数据不混入对话流。runtime notification 只携带轻量失效信息。Transcript 读取使用单调递增的 revision，只替换受影响的 entry 后缀。首屏只携带有界 inline detail、patch 统计、媒体引用与 terminal id 组成的紧凑有序 tool envelope；准确 raw input/output 和 patch 仍保存在后端 checkpoint 中，通过 tool-detail endpoint 按需读取。

## Farming Code 展示

能力协商成功后，Codex 活跃 turn 期间提交的输入会作为 steer 发送，并保留在同一 turn 的原始有序位置，包括原生媒体 block。没有该扩展的 provider 继续显示排队 follow-up。

较短的 Chat transcript 从阅读区域顶部开始，不再被压到贴近底部 Composer 的位置。长历史在读者停留于尾部时仍然跟随最新内容；读者查看较早内容时会保留明确的阅读位置，并在脱离尾部后显示跳转到最新位置的控件。

Farming Code 会保留每一个已打开 Agent 的前端视图，直到该 Agent 被关闭、归档、终止或替换。切换 Agent 行时，旧 Chat 只会隐藏，不会卸载它的 transcript、展开状态或精确滚动位置；Terminal 使用语义对等的 xterm 池化生命周期。Search、History 和文件编辑器只隐藏 Agent 工作区，不会逐出这些已打开视图。非活跃 Chat 不请求 transcript；再次选中时先展示保留视图，再使用保留的 revision 只请求发生变化的 ACP 后缀。

ACP 在 `src/components/code/acp/` 下拥有独立的 composer、草稿命名空间、权限卡片、Session 控件、动态命令菜单和 transcript adapter。Terminal 继续使用 `CodeComposer` 与 PTY 输入路径，不加入 ACP 分支。ACP client terminal 使用内嵌 xterm 承接真实逐键输入、选择、输出、尺寸同步和停止操作；这个组件不会与 Terminal 页面共享。

Composer 展示当前 ACP Session 协商出的 mode、model、reasoning、boolean option、usage 和 available commands。现有 Chat UI 设计保持不变：adapter 把 canonical ordered entries 投影到原有的用户/结果/过程 view model，不修改 composer 或 transcript 的组件层级。Codex 标记为 `final_answer` 的 message 是权威可见结果，即使历史重放随后又发出 reasoning entry 也不会被塞回过程区；没有等价标记的 provider 继续使用兼容的尾部判断。此前的 commentary、thought、tool 和 plan 仍进入原有可逆的“执行过程”折叠区。Turn 执行期间，这个区域默认保持收起，但会显示一条接近 VS Code 的紧凑工具轨迹：默认最多保留四个非失败动作，更早动作合并成计数，中间失败不进入默认阅读面，每个可见 Tool 都有自己独立且可逆的详情开关，同时把最新一条非空 commentary 转成有界的纯文本阶段预览。预览不再通过裁掉富 Markdown 来缩短，因此被视觉隐藏的链接不会残留在键盘 Tab 顺序中；完整 Markdown 仍可在 Process 中查看。Reasoning、更早 commentary 和失败 Tool 证据只在完整“执行过程”中保留，不会继续堆叠在默认阅读面上。运行中的 terminal Tool 只有在经过 500 ms 缓冲且 Farming 确认已经产生真实输出后才会自动展开；快速命令和刚报告的失败动作都默认保持收起，只有此前因实时输出已经打开的 terminal 在失败后继续保持展开。展开区只保留一条命令标题，不再重复显示协议状态。实时交互终端使用与卡片一致的深色、按内容限制在四到八行的 xterm；Tool 进入终态时，Farming 会立即禁用旧 terminal 的输入和停止控制，再刷新权威 terminal detail，并把 xterm 原子替换成紧凑只读输出和准确退出信息。如果有界刷新仍拿不到终态，UI 会在只读证据上显示明确的同步失败与“重试”操作，而不是继续伪装成运行中。若 raw output 只有同一个 exit code 或 signal，视觉投影会去重，但复制 Tool 准确详情时仍会保留。紧凑工具轨迹已经表达当前工作时，不再追加通用的“Agent 仍在工作”占位，底部时长条成为唯一实时状态。后续流式更新不会覆盖用户对单个 Tool 的显式展开选择；切换到完整 Process 时，包含已展开 Tool 的外层 group 也会同步打开，避免用户选择被另一层折叠遮住。顶层过程仍会在 Turn 结束时收起，让最终结果恢复视觉焦点。打开顶层过程后可按 ACP 原始顺序恢复完整证据，并且只有在这里才自动展开最新流式思考。顶层摘要和紧凑动作行都保持单行末尾省略，紧凑动作行使用本地化的 provider Tool title，并移除重复的协议状态标签。成功生成的图片或音频会从 tool entry 提升到默认可见的结果媒体区域，而对应的工具元数据仍可在“执行过程”里展开追溯。Codex 历史图片即使被 adapter 降级成本地 Markdown 链接，也会在同一条有序 message entry 上有界恢复为 ACP image block；注入的附件路径和包装文本不会进入用户可见请求。Mermaid 代码围栏会在解析前只解码一次 Markdown 字符引用，因此 `&lt;id&gt;` 这类协议文本能作为预期的图表源码渲染。包含 ACP `diff` block 的 tool update 会在不丢失协议结构的前提下投影为文件修改结果卡：折叠状态显示去重后的文件数和行数统计，第一次展开列出本轮涉及的文件，每个文件还可以按需展开当时准确的 ACP patch。独立的 Review 操作只捕获 Agent 工作区内的这些路径，不再混入整个工作区的其它改动；工作区外 patch 仍可在卡片里准确查看。Tool 的 raw input/output、带上下文的紧凑 patch、terminal 和 location 仍可展开。ACP 子 Session 始终嵌套在父 Tool 条目下；预览可以进入专注查看，运行中的子 Agent 可以单独停止，子 Agent 发出的权限或补充输入请求则在父 Chat 控件中回答。大详情不会塞进 transcript 页面，而是在用户展开或复制该条目时按 tool-call id 获取。ACP Chat 首次只投影最近 20 个 turn，用户向上滚动时再按每页 20 个 turn 加载更早历史。ACP transcript 跟随共享状态 WebSocket 的 Session 更新信号，只请求发生变化的后缀。Codex 内部 context 与 heartbeat 活动按 segment 隐藏，但真正需要通知用户的 automation 结果仍作为 assistant message 保留。

ACP Composer 保留所有不依赖 PTY 输入的日常消息框行为：草稿与上下键历史、Enter/Shift+Enter 与中文输入法、文件选择、粘贴媒体预览、删除附件、语音输入、Agent 命令与 Skill、Goal/Plan 请求模式、排队的 follow-up、中断、存在精确 Codex 数据时的上下文窗口，以及 Agent 提供的权限和配置控件。`+` 菜单包含附件、目标和计划，并且只有 Agent 声明 ACP logout 时才出现退出登录；Agent 命令通过 `/` 搜索，`$` 则搜索 Agent 实际宣告的 Skill 子集。只有实时 Agent 声明对应 prompt capability 时，上传图片或音频才会作为原生 ACP content block 发送；否则 Farming 会把它转换成与现有文本降级一致的可读本地路径上下文，避免不支持的媒体类型被静默丢弃。文本文件仍嵌入消息。

对 Codex，Farming 会把选中的启动配置映射到 ACP adapter 的 `CODEX_CONFIG` 和 `INITIAL_AGENT_MODE`。因此 Terminal 与 Chat 之间切换时，会继承模型、推理强度、速度层级和对应的初始权限模式，不再静默回到 adapter 默认值。

在实时 ACP Session 中切换 Codex 模型时，Farming 会先让 adapter 选择兼容的推理强度回退值，再刷新模型目录并重新应用标准 config option。这样即使长时间运行的 Session 建立于 provider 或代理刷新模型元数据之前，Fast 等模型专属 capability 仍以当前真实值为准。模型与推理强度可以作为一组 profile 原子更新。对于同时提供 Sol、Terra、Luna 的模型家族，Composer 默认提供一个可跨模型和普通推理强度连续拖动的平面、一根开启时会自动下拉的点击式红色 Ultra 摇杆，以及独立显示 `Fast OFF` / `Fast ON` 的速度按钮；**Advanced** 会连续变形回原有的逐级推理、模型与速度控件，并保留当前 profile。所有 provider 的 ACP 配置写入都会按实时 Session 串行执行；重复设置同一个目标值是幂等操作，Agent 返回的 config option 还必须明确确认目标值。浏览器在事务期间只保留一次乐观更新，忽略更早发起的旧刷新，之后再用确认后的 Session snapshot 校准，失败才回滚。Ultra 与 Fast 的位置在 capability 刷新前后保持稳定；实时 Session 没有宣告的控件会保留为灰色禁用态，而不是让菜单突然跳动。

同一组控件也会更新空闲的原生 Codex Terminal，而不再只修改下一次启动的 profile。Farming 会通过 CLI 的交互式 `/model` 选择和幂等的 `/fast on` 或 `/fast off` 命令应用修改：等待真实模型与推理菜单出现，选择其中实际宣告的条目，再以底部状态确认结果；它不再猜测远端渲染需要多少毫秒。模型菜单确认期间不会提交后续输入。Fast 不同，它是单条非交互命令；完整命令被 PTY 接受后立即放行后续输入，确认过程在输入队列之外继续。Terminal 正在执行 Turn 时这些控件保持禁用，因为普通 TUI 输入可能排队成为任务输入，而不是立即执行配置命令。新 Terminal 选择 Standard 时会显式收到 `service_tier="default"`，因此用户 Codex 配置里的 Fast 值不会再造成 Farming 控件与真实 runtime 不一致；实时 Terminal 确认成功后再持久化启动 profile，避免展示未经验证的选择，也保证 Agent 重启后配置一致。这些 PTY 命令绝不会注入 ACP、旧 JSON、shell、Claude、OpenCode、Qoder 或其他非 Codex Terminal Session。

ACP 的边界保持明确：

- 基础 ACP 没有并发 prompt/steer 操作。实时 Codex adapter 声明 Farming 的带版本 steer 扩展后，Agent 工作时输入的新消息会在独立 steer 通道串行发送，并指向当前活跃 Codex turn。明确的 turn 结束或不可 steer turn 拒绝会回退到普通下一轮 prompt 队列；不明确的传输失败不会自动重放。没有该能力的 provider 继续使用可见、可丢弃的排队 follow-up。草稿为空时仍提供中断。
- Goal 和 Plan 是与 Terminal 一致的显式 Composer 请求模式。Provider Session 的 mode、model、reasoning、speed 等 runtime 设置，仍只展示 Agent 实际宣告的 ACP mode 或 config option。
- Context window 百分比需要已用 token 和最大 token。Codex 有精确 provider-session token event 时显示百分比；只提供累计 usage 的 ACP Agent 仍只显示 token 数。
- Composer 接受图片和音频，但两种原生 block 分别按实时 capability 协商。收到的 Embedded Resource 与 Resource Link 可以渲染，但 Composer 暂不提供任意 Resource Link 的主动构造控件。
- “编辑旧问题、按仓库检查点回滚并截断后续 Turn”不属于基础 ACP。Farming 不会把这种可选客户端能力伪装成协议已支持。

## 权限与失败行为

`full` 权限模式会自动选择 Agent 提供的 allow 选项；`ask` 会自动选择 reject 选项；普通审批模式会暴露完整的 ACP permission request，并等待后端 API 的明确回答。

ACP 启动、初始化、历史恢复、prompt、协议和 adapter 退出错误都会成为明确的 runtime error。有界控制请求会在超时后给出可操作错误；正常的长时间 prompt 不设置人为总时限。Farming 不会把用户指定的 ACP Agent 静默降级成 Terminal 或 JSON CLI。Agent 正在执行时拒绝 Chat / Terminal 切换。尚未收到用户输入的新 Terminal，在 provider 历史尚未落盘时可以直接建立新的 ACP session；Terminal 一旦收到输入，切换就必须确认保存的 session 仍可发现。空闲后切换会停止旧进程并启动目标 runtime，如果目标启动失败，会立即用原 runtime 恢复同一个 provider Session，并明确报告切换失败。

## 后端 API

- `GET /api/agents/:agentId/acp-session` 返回归一化 Session 和协商出的 capability。控件与 usage 使用 `?includeEntries=0` 获取轻量 snapshot；只有协议调试需要 raw ACP update 时才添加 `?includeUpdates=1`。
- `GET /api/agents/:agentId/acp-transcript?maxTurns=N` 为现有 Chat UI 返回 canonical entry stream 的脱敏视图投影。实时读取添加 `sinceRevision=R`，只接收受影响的后缀。
- `GET /api/agents/:agentId/acp-tool-details/:toolCallId` 按需读取 Tool 的展开详情和准确的结构化 ACP patch。
- `GET /api/agents/:agentId/acp-sessions` 通过当前 provider 连接调用 ACP Session 列表。
- `PATCH /api/agents/:agentId/acp-session` 修改单个协商出的 mode/config option，也可以通过 `configOptions` 原子修改模型与推理 profile。
- `POST /api/agents/:agentId/acp-permission` 回答待处理的 permission request。
- `POST /api/agents/:agentId/acp-elicitation` 回答待处理的表单或 URL elicitation。
- `POST /api/agents/:agentId/acp-session/authenticate` 启动协商得到的认证方式，包括托管 Terminal 认证。
- `POST /api/agents/:agentId/acp-session/logout` 仅在 Agent 声明 ACP logout 时退出登录。
- `POST /api/agents/:agentId/acp-session/fork` 在 Agent 声明支持时 Fork Session。
- `DELETE /api/agents/:agentId/acp-sessions/:sessionId` 在 Agent 声明支持时删除 Session。
- `POST /api/agents/:agentId/acp-session/close` 在 Agent 声明支持时关闭当前 Session。
- `POST /api/agents/:agentId/acp-terminals/:terminalId/input|resize|kill` 控制 ACP client terminal。
- `POST /api/agents/:agentId/acp-subagents/:sessionId/cancel` 单独停止已知 ACP 子 Session，不取消父 Session。
- WebSocket `start-agent` 接受 `agentRuntimeMode: "acp"`、可选的 `acpHistoryMode: "load" | "resume"`，以及标准 `additionalDirectories` / `mcpServers` Session 输入；`POST /api/control/agents` 接受相同的 ACP Session 输入。
- WebSocket `acp-permission-response` 不经过 HTTP，也能回答同一条权限流程。

Farming Code 中 Codex、Claude Code 和 OpenCode 的 Chat 控件现在默认选择 ACP。Chat 与 Terminal 之间切换会重启 Agent runtime，并恢复同一个 provider Session；replacement 会保留当前已展开的 Composer，不会突然套用“新开 Terminal 默认收起”的偏好。旧 JSON Chat Session 仍然可以读取，但不再作为新 Chat 的启动入口。

新建 OpenCode Terminal 会先通过一个有界 ACP 进程创建精确的 provider Session，再启动原生 Terminal。新建 Codex Terminal 会立即启动并暂时使用关联 ID，用户元数据始终归稳定的 Farming Session 记录所有，native host 恢复时也一样。只有 Codex History 在有界启动窗口内出现唯一一个尚未占用、同时匹配 Agent Home 与 canonical Workspace、并带可信创建时间的候选项时，Farming 才确认该 ID；身份扫描只读取启动日期目录中的 rollout 头部，同一 Agent Home 的并发扫描共享一份 in-flight 结果。提交绑定时会再次同步检查占用关系，多个候选项或仅关联 Git worktree 的候选项会继续保持未解析。确认后的 provider ID 会挂接到同一份 Farming 记录，供后续 Chat/Terminal 恢复与 Fork 使用。提交 Terminal 输入时会先设置使用 fence，再等待 PTY 响应；fence 生效后，Chat、权限重启与 Fork 都必须等待精确 provider ID。如果 native host 运行时轮换时仍存在这种已使用但未取得精确 ID 的 Terminal，轮换必须终止并恢复旧 host，因为重新启动 `codex` 会静默替换原对话。

Terminal 模式继续使用 `NativeSessionEngine`。ACP 是新启动或重启 Agent 时选择的结构化 runtime，不会同时复制一份 Terminal 进程。

## 验证

`backend/tests/test-acp-runtime.js` 会运行一个真实官方 SDK client 和确定性的假 ACP 子进程，验证新 Session、load 完整历史重放、prompt、权限选择、稳定 tool update、Session 列表和归一化 Session snapshot。`backend/tests/test-acp-checkpoint-store.js` 验证 reducer round-trip、identity 隔离、dirty fence 和持久化原子替换；`backend/tests/test-acp-checkpoint-recovery.js` 验证冷/热场景 fail-closed load、revision reset、完整子 Session/patch fence 序列化、不确定失败 fencing、bare-resume fencing、工作区校验和 Agent Home 隔离。
