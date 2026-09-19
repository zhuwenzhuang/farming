# Codex Runtime 模式

> English version: [codex-runtime.md](./codex-runtime.md)

Farming 对用户提供两种 Codex Surface：

- **Chat** 使用受支持的 ACP Runtime。
- **Terminal** 在 Farming Native PTY Host 中运行 Codex CLI。

用户选择的是 Chat 或 Terminal，不是私有 Transport 实现。旧 History Format 可以继续只读，
但不能成为 Live Runtime Path。

## Executable 所有权

Terminal 与 ACP 是相互独立的 Executable Ownership Boundary：

- Terminal 优先使用可用的系统 Codex，并只按 Native Terminal 版本策略选择经过校验的
  Farming 自有 Executable。
- ACP 独立使用 Farming 自有、版本锁定的 Adapter 与 Runtime Artifact，不继承 Terminal 选择。

新建 ACP Chat Session 按精确 Codex Agent Home 使用版本锁定的 Managed Executable；
Plugins 不提供 Custom Executable 选择。Terminal Discovery 继续独立，已有 Session 保留
持久化 Launch Identity，包括精确恢复所需的旧 Custom Binding。

这两个策略分离后，Native CLI 体验和确定性的 ACP 行为可以独立演进，不会互相静默改变。

## Provider Adapter 边界

通用 Chat Lifecycle、Transcript、Config、Permission 与 Recovery 归共享 ACP Runtime；Codex
Adapter 只拥有 Codex 特有的 Launch、Executable、Capability 与可选 Extension 行为。

Capability 以 Live ACP Handshake 和 Session State 为准。Live Steer 等 Codex Extension 必须
带版本且经过协商；UI 不能只因为 Agent 名称是 Codex 就启用。

Codex 的 Media、Tool、Diff、Terminal、Permission、Config 与 Child Activity 都保持为类型化
Protocol Data。Provider 特有展示 Hint 在 Adapter 边界归一化，不能变成通用 ACP 语法。
来自 Live 或恢复 History 的 Codex Host-directed HTML Visualization 在该边界归一化。
绝对路径允许指向 Farming 后端可读的任意 HTML，不受 Workspace、Provider Home 或 Session
目录限制。仅文件名的引用按来源 Session 的实际 Codex Home 解析。指令保留可选 `title`、
`mode: "wide"` 和 `resourceRoot`。普通 HTML 链接不会启用脚本执行。

已认证 Owner 为规范 HTML 路径及依赖目录创建有界预览租约，默认依赖目录是 HTML 的父目录。
显式资源根目录必须包含 HTML，且不能是文件系统根。相对 JS、ES Module 导入、CSS、字体、
图片和 JSON 请求在此目录解析；目录穿越与符号链接越界被拒绝。HTML 必须为 UTF-8，且不超过
2 MiB。文件系统错误明确展示；不跨机器迁移文件，也不创建历史快照。Fork 与恢复保留路径，
原始文件必须仍然可读。

Preview ID 是该依赖目录的短期不可猜测读取凭据。只有资源 GET 接口不依赖登录 Cookie，使用
不携带凭据的 CORS 支持不透明源 iframe；普通 Preview 不能使用此接口。直接导航资源时禁止
脚本并强制沙箱。只读分享不能创建此类凭据。iframe 仅启用 `allow-scripts`，不启用同源、
表单或顶层导航。CSP 仅开放该预览依赖 URL 和支持的可视化 CDN，不开放 Farming API。

后端拥有租约；挂载的 Renderer 拥有加载与续租。加载有截止时间，最终进入可展示或具体失败。
重试取消旧视图，迟到响应释放自己的租约；卸载删除租约。服务重启或租约过期明确提示重试。
不同视图使用独立租约。资源或脚本失败保留已有内容并显示诊断，不能静默当作成功。

Farming 为片段提供随产品版本打包的兼容层：字体、主题变量、基础控件、Tabs、Tooltip 和
Lucide 图标。完整 HTML 保留自己的样式。Light、Dark、Paper 更新不重新运行脚本。可选
Widget State 仅保留本地展示状态，不作为 Agent 上下文；追问通过 Composer 完成。

图表布局由原始 HTML 负责；Farming 不重写图表结构、坐标标签或分栏断点。普通内联内容
最大宽度为 640px，`wide` 内容可达 1,024px，让普通图表保持阅读宽度，多面板布局则显式选择。
全屏移除宽度上限。宿主兼容性验收必须使用相同源文件和相同 iframe 宽度，不能用应用窗口
宽度代替图表宽度。浏览器 ResizeObserver 延迟投递通知仅保留在控制台，不作为资源加载
失败；验收仍需确认布局最终稳定。

内联图表无额外卡片边框，高度随内容测量。离屏条目仍须更新尺寸，不能依赖浏览器可能
暂停的 iframe 动画帧。消息通道仅接受精确 iframe 的尺寸、主题/状态和
诊断消息。普通图表跟随聊天页面滚动，由已有阅读锚点和跟随底部逻辑负责位置。超长内容提供
明确展开入口，不使用内部滚动条。Wide 指令放宽消息宽度。原生全屏保留同一个 iframe 和交互
状态；不支持原生全屏的平台在页面内展开。续租不重载图表。

验收覆盖多 Home 与 Fork 路径、本地模块和 JSON、目录越界、过期删除、加载取消、完整文档
和片段、动态增高缩短、主题/全屏切换保留状态，以及桌面和窄屏的 Light/Dark/Paper 展示。

Native Terminal 的启动排序不是一套 Codex Lifecycle State Machine。共享的 Terminal
Startup Coordinator 拥有有界串行、就绪、失败与清理；Codex Adapter 只声明无状态约束：
共享同一精确 Agent Home 的 Native Start 必须串行到 TUI 发出就绪信号，因为这些进程共享
该 Home 的本地 Store。其他 Provider 继续并发，除非其 Adapter 声明等价的资源约束。

Provider Terminal Control 还负责 Codex 的延迟 Session Identity Probe，以及 Native Model、
Reasoning 与 Speed Transaction。通用 Agent Manager 负责有序 Input、Runtime Fence 与 State
Publication，但不识别 Codex，也不解释其 Menu。

Native Profile Transaction 同时支持直接选择 Model/Effort 的菜单，以及通过 **All models**
进入完整目录的 Quick Picker。事务按明确的 Model 与 Reasoning Identity 选择，不接受 Quick
默认值或名称相近的模型。活动 Picker 即使保留旧 Profile Footer，也不属于 Idle Composer。
各次转换及 Escape 清理共用一个有界 Deadline；取消或输入结果不确定时退出预期菜单层级，
不重放选择。只有 Picker 关闭且请求的 Profile 可见后，才确认变更完成。可见 Model Row
可能只是滚动窗口；多位编号或窗口外目标必须逐次等待 Highlight 确认后继续导航。只有完整
Cursor Cycle 才证明目标不存在；Highlight 缺失或停止推进时沿用同一 Deadline 明确失败。

## Session 连续性

Provider Session ID 是 Codex Conversation 的权威身份。Chat/Terminal 切换是真实 Runtime
Replacement，只有在证明可恢复时才保留该身份。

全新 Chat 可以在 Provider Session ID 物化前先展示 Connecting Shell。在该权威身份发布前，
Transcript Projection 必须保持明确的 Pending 状态；打开、归档或替换 Connecting Shell 时，
不得把正常的 Identity Pending 窗口变成失败的 Request。
加载更早的 Transcript Page 时必须保持读者当前可见位置；在顶部插入历史记录本身不得导航到
Conversation 开头。

全新 Terminal 可以在用户输入物化 Provider Conversation 前切换；一旦收到输入，切换、权限
重启、恢复与 Fork 都需要已验证的可恢复身份。Terminal Presentation 不得从任意 Output Text
推断该身份。

因此，全新 Codex Terminal 先使用仅属于 Farming 的 Temporary Identity，而不是猜测 Resume
ID。精确 Runtime 进入 Idle 后，Codex Terminal Control 通过有序 Input Path 执行一次有界
`/status` Probe，且不把它标记为用户输入。写入结果不确定时只从渲染出的 Status 对账，绝不
重放。只有结构化 Status Panel 可以确认真实 Session ID，并且确认受同一 Agent 与 Runtime
Epoch Fence 保护。在确认成功前，History Lookup、Recovery 与 Fork 都继续把该身份视为
Temporary。

配置遵循共享 ACP 规则：用户没有确认显式 Override 前，使用 Provider 与 Agent Home 默认值；
已确认的 Model、Reasoning、Speed 与 Permission Choice 在受支持的 Runtime Replacement 后保留。
已保存的模型未能恢复时，继续保留持久化选择，并显示警告、阻止 Prompt 和 Steer，直到重连
恢复成功或用户确认其他模型；Farming 不得静默使用 Provider 默认模型提交请求。

Composer 模型矩阵使用运行时公布的模型目录及顺序，跨模型代际展示。身份配色不参与目录
过滤：Astra 使用蓝白星光色，Sol 使用橙色，Terra 使用绿色，Luna 使用紫色，未知身份使用
中性色。行数随目录增长，长名称在单元格的无障碍标签中保留完整身份。矩阵使用运行时提供的
推理选项；Advanced 保留完整配置控件入口。Ultra 轨道与矩阵等高，其点击区域、滑块行程和
能量填充随行数一起自适应，在所有外观与视口下保持一致。

Codex Chat 声明支持 Active-Turn Conversation Fork。版本锁定的 Adapter 捕获当前 Codex Turn
ID，并把它作为 app-server 的 `beforeTurnId` Boundary 发送；因此 Child 排除尚未完成的 Turn，
同时 Source 继续运行。在 Codex 尚未分配该 Turn ID 的短暂窗口内，Fork 仍不可用。

## 失败与恢复

Adapter 或 PTY 失败必须可见。Farming 可以在证明旧 Runtime Ownership 后恢复同一 Provider
Session，但绝不重放结果不明确的 Prompt 或 Terminal Mutation。Chat/Terminal 切换失败时，
应尽量恢复原 Runtime，并明确报告失败。

## 验收标准

验证必须覆盖：Executable Policy 分离、协商 Capability、Provider Identity、同 Home Native
Start 串行、不同 Home 并发、Config 连续性、Chat/Terminal 切换、Restart、Disconnect、
Media 与 Tool 展示、声明支持时的 Live Steer，以及受支持 ACP 与 Native Terminal Path 的
低频真实 Codex Smoke。
