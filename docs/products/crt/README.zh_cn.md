# Farming CRT

> English version: [README.md](./README.md)

CRT 是 Farming 的第一个皮肤：一个复古终端风格的控制台，用来观察和指挥 CLI agent。

CRT 并不比 Farming Code 更低级，也不是被丢弃的历史版本。它是一种不同的启动形态，更偏轻量监控和控制台操作。Farming Code 是当前默认的 coding workbench 皮肤；当用户想要最初的 terminal / CRT 体验时，应显式选择 CRT。

CRT 保留了最初的顶部状态栏、agent 布局、侧边栏、扫描线效果，以及终端控制台式的交互语言。顶部状态栏同时显示活跃/总 Agent 数、最近五分钟终端输出的 token 估算速率、服务端系统的主 IPv4 地址和本地时间。

桌面侧边栏在 Main Agent 上方显示紧凑的 Farming CRT 标志。三个终端窗格共同构成抽象的 `F`：主窗格代表 Main Agent，青色与琥珀色窗格代表项目 Agent。只有存在实时会话时窗格才持续点亮，终端预览确实变化时才短暂增强辉光；首次通电动画遵循系统的减少动态效果偏好。

CRT 现有的可交互界面支持统一的方向键导航。方向键可以在 Agent 卡片、Main Agent、可用的侧栏操作、New Agent 选项和 Settings 控件之间移动反色选择，Enter 激活当前控件，Escape 关闭当前浮层或清除主页选择。Agent 网格采用稳定的控制室机位：1–4 个 Agent 从左上开始占用预留的 `2 x 2` 矩阵，5–6 个使用 `3 x 2`，7–9 个使用 `3 x 3`，更多时每 9 个一页；小窗口会先减少可用行列，避免卡片低于最小可读尺寸。当前 CRT 可视窗口始终作为固定一页，不压缩卡片，也不会让半张卡片越过底部边框；只有确实超过一页时才显示 `PAGE`。在最后一行继续按向下键会进入下一页并尽量保持原列，在第一行按向上键则按相同规则返回上一页，不增加额外翻页键；侧栏和 Main Agent 始终固定。主页的其他边界以及 New Agent 的方向导航仍按空间位置循环到另一侧最接近同一行或同一列的控件。New Agent 打开时会直接选中设置里的默认启动 Agent，从工作区步骤返回时也会恢复这项选择；Agent 创建成功后，主页键盘选择会自动切换到这张新卡片。打开终端后，普通 Escape 仍交给终端应用自身处理，并继续使用 `Ctrl+Escape` 关闭终端。

打开 New Agent 时，前端会绕过浏览器和代理缓存，后端对用户 shell 环境与可执行程序发现最多复用 3 秒；真正启动进程时使用同一份有界结果，超过窗口就重新解析。打开 History 采用相同规则：3 秒内的请求共享一次 provider session 扫描，结果超过窗口后则等待刷新完成，而不是返回供被动读取使用的 stale-while-refresh 快照。

原先禁用的 Task List 位置现在是 Search。按 `[F] SEARCH` 会打开荧光查询终端：当前项目 Agent 在前端本地匹配，可恢复的 Codex、Claude Code、OpenCode 与 Qoder 记录则复用 Farming Code 的有界 Agent session 搜索接口。搜索范围包括标题、配置后的项目名和工作区路径；实时 Agent 排在 provider session 之前，已经被实时 Agent 占用的 session 会被去重。查询框保持键盘焦点时，上下方向键移动记录，Enter 打开或恢复当前记录，Escape 返回 Agent 主页。

按 `[$] BILLING` 打开的是 CRT token 遥测控制台，而不是金额账单页。默认 Days 视图把最近 120 天的对数日柱图和一条紧凑的 52 周活跃带组合起来，并以堆叠方式区分 cache 与非 cache，让 B 级峰值和 processed-token 总量的来源都保持清晰。固定 Y 轴明确标注每日 Token 的对数尺度，柱图区横向滚动时自适应量级刻度仍保持可见；X 轴以本地日期标出首尾、月初和月中，选中日期有贯穿图面的定位线。顶部汇总今天、近 7 天、近 30 天、52 周、活跃日、B 级日期和峰值日。数据会归集所有已配置 Codex、Claude Agent Home，并读取经过 sanitize 的 OpenCode session export；每条事件按本地日期归集，跨午夜 session 会正确拆到不同日期。这里的总量是 provider 报告的 processed tokens，包含 cache read，不代表金额或额度消耗。鼠标或方向键选中日期后，会同时展示当天精确总量和 `K`/`M`/`B` 缩写读数、输入、输出、缓存读取和缓存写入，以及带明确线性坐标轴的 24 个本地小时 total/cache 曲线和 Codex、Claude、OpenCode 归属占比；选中日接口直接复用日事件缓存，不会每次点击都重新扫描 provider 历史。今天明确标记为未结束的 partial day。Codex 历史首次归集优先使用 ripgrep 做有界扫描；没有 ripgrep 时只读取有界文件尾，并把响应标为 partial，避免把不完整历史冒充精确值。OpenCode export 按 session 更新时间缓存。Qoder 本地 session 文件没有模型 Token 字段，因此界面会把它明确标为不可用，而不会用终端输出量估算。按 `[L] LIVE` 仍可查看最近 60 分钟、30 个时间桶的 Canvas 示波器、最近五分钟 provider 速率、额度窗口和重置时间。被动 LIVE 读取最多复用后端结果 15 秒并保留 stale-while-refresh 保护，较重的日汇总最多复用 5 分钟；打开 Billing 或按 `R` 会强制刷新两层数据，页面可见期间每 30 秒请求一次更新。没有额度遥测时会明确说明，但仍继续展示本机实际观察到的 token 活动。

History 与 Farming Code 保持相同能力范围，不另建 CRT 专属归档模型。它合并 Farming 运行记录、已归档的实时 Agent 和未被主页占用的 provider session，并按相同会话身份去重。后端只为 Farming 明确支持的 Coding Agent 读写运行历史，shell 和未知命令不会进入 History；每一行都会同时标明 Coding Agent 名称和工作区。按 `H` 打开 History，上下方向键移动选择，Enter 执行主要的 Continue、Open 或 Resume 操作，Escape 返回 Agent 主页；已归档 Agent 还提供 Restore。每页数量会跟随列表可用高度调整，上下方向键越过页首页尾时连续翻页，左右方向键则整页切换。Continue 与 Resume 复用现有 New Agent 和 provider session 流程，CRT 不额外推断完成状态，也不增加 History 专属搜索和筛选。

实时浏览器入口是 `<base-path>/crt/`。CRT 的入口、应用逻辑和效果文件独立放在 `frontend/skins/crt/`，只与其他皮肤共享 terminal/session bridge。从已打开 Agent 的 Farming Code 设置切换皮肤时，会把当前 Agent id 带到 CRT，并在共享后端状态到达后直接打开对应 CRT session；Agent id 不存在或已失效时则回到主页。所有效果限定在 `#farming-crt` 根节点内，并通过 CRT 专属的 `settings.crtSkinEffectsEnabled` 保存，因此调整 CRT 不会改变 Farming Code。

CRT 浏览器入口使用方形终端电脑图形、醒目的屏幕字母 `F` 和 `CRT` 字标作为专属 favicon。这个为小尺寸简化的组合让 FARMING CRT 品牌在浏览器标签页中仍然容易辨认。

Agent 卡片使用全部剩余正文高度显示统一可读字号的实时终端末端，并从底部对齐，保证新输出字符始终可见；内容过多时从顶部裁掉，不压缩字体。标题与 Farming Code 使用相同优先级：用户重命名、provider 会话标题、有意义的终端标题、友好的 provider 名称；打开 session 后继续使用同一标题，并在单行内省略。只有终端状态当前确实为 working 的 Agent 才闪烁，近期有输出本身不会触发动画。打开 session 时使用 xterm.js，短暂等待与当前窗口尺寸一致的后端屏幕，恢复这份完整序列化屏幕后再追加增量输出。Qoder、OpenCode 这类全屏 TUI 不能从任意截断的 ANSI 尾部正确重放。CRT 产品路径严格要求 xterm WebGL renderer 和 WebGL2，不做静默降级；可选 Ghostty renderer 只作为非严格 bridge 使用方的源码级调试设施保留。设置页的 Display 区域可以在 10–20 像素之间按 1 像素调整打开终端的正文字号；拖动立即生效且无需保存，同时不改变 Agent 缩略预览的密度。New Agent 的工作空间步骤会直接展示近期项目空间，并保留方向键选择。CRT 界面框架使用采用 OFL 许可证的 Departure Mono；终端正文和 Agent 预览使用共享的中英文等宽字体栈，避免拉丁字体与中文回退字体的字格宽度不一致。屏幕使用主页和打开终端共用的平面 `#000d06` 荧光粉暗底，不增加曲面扭曲或四周暗角。静态三像素栅格只调制表面明暗，不在内容上画醒目的白线。一条 300 像素高的合成长拖尾以 6.8 秒连续扫过整个 CRT 界面，峰值只有百分之四且没有独立高亮线头，因此打开终端后也保留效果而不影响阅读。噪点纹理本身保持静止，只在宽拖尾经过时产生很轻的对比度变化。缩略预览变化时只创建一帧约 0.6 秒衰减的事件驱动余晖。打开终端继续保留 ANSI 实际颜色，同时优先保证 xterm 原生 WebGL 的输入与绘制路径：framebuffer 保持可丢弃，并且字符 render 后不再由 CRT 层复制整张终端 canvas。动态内容余晖暂时不启用，直到能够证明它不会与输入延迟竞争。动态效果遵循系统“减少动态效果”偏好。数字快捷键保留绿色荧光底和深色文字，不增加额外描边。动态热力默认关闭，此时所有 Agent 卡片使用统一绿色边框和稳定尺寸；开启后才挂载活动等级样式类。Session runtime 由后端管理，界面只显示 built-in runtime，不再提供已经失效的旧 remote engine 选择。

打开终端的正文字号默认是 15 像素，并继续支持在 10–20 像素之间调整。

CRT 打开的终端与 Farming Code 对齐桌面端/移动端字号、紧凑内边距、5,000 行回滚缓冲和 xterm 原生输入路径。普通键盘与中文组合输入都直接交给 xterm，不再经过第二个隐藏输入框，也不再逐字符读取布局。Agent 缩略终端直接渲染后端终端快照里的 ANSI 前景色、背景色和强调属性，不会为每张卡片额外挂载一个 xterm。未读 Agent 卡片在原状态边框之外增加一层分离的高亮荧光框，不改变布局和热力状态；打开 Agent 会推进共享的 attention 已读游标并移除外框。UI Theme 设置也提供 Farming Code 入口，可返回 `<base-path>/code/`。

ACP、JSON CLI 和 Codex App Server 这类结构化 Agent 在 CRT 中不会再伪装成 PTY 终端。打开任意 session 后，会用全屏 CRT 会话界面取代 Agent 网格；对话或终端与 Composer 因而具有稳定的荧光底色，不再像一块透明屏幕叠在另一块屏幕上。全屏边缘使用一圈窄而不发光的深色机壳口沿和一条低亮度屏幕开口线，不增加荧光窗口框、圆角遮罩或四角暗化。视口级扫描线纹理继续覆盖整个全屏会话。当前对话最多每秒刷新一次，只有 terminal runtime 才挂载 xterm。恢复错误会直接显示并禁用结构化输入框；已退出的 terminal session 则明确以只读 xterm 打开。

结构化输入区直接从草稿开始，不再用冗余提示符占据横向空间。草稿默认展示两行，并随多行内容自动增高；达到限定高度后才在输入区内部滚动。Enter 发送，Shift+Enter 换行，中文输入法确认不会被误判成提交。光标位于草稿末尾时，按向下键进入底部控制条；左右键切换控制，Enter 或向下键在控制条下方就地展开选项，上下键移动选项，Escape 逐层返回草稿。对话溢出时，原生滚动条会缩减为一根轨道透明的荧光位置细条，同时保留更宽的不可见命中区；状态行此时才提示 `[TAB] SCROLL`。Tab 聚焦对话记录，上下键按一屏滚动，Shift 配合方向键跳到对应首尾，Enter 返回最新消息，Escape 返回草稿。在 session 根层，Escape 和 Ctrl+Escape 都可以关闭 Chat；terminal 仍会正常接收自己的 Escape 键。配置选项采用渐进展开：第一层只展示配置类别和当前值，选中某一类别后，才在限定高度的列表中展示该类别的候选值。复制粘贴由输入区原生处理，不再被终端全局监听抢走。ACP session 还会复用现有后端能力展示可用斜杠命令、模式/模型配置、token 用量、文件或粘贴图片上下文、权限请求和中断操作，不另建第二套协议。

Codex、Claude Code、OpenCode 和 Qoder session 会在 CRT session 标题栏使用复古的 `MSG` 与 `TTY` 控件表示结构化 Chat 和原始 Terminal。切换时会把 Agent 重启到 ACP 或 native PTY runtime，而不是只在本地切换展示。已经落盘的 provider session 会恢复原会话；刚打开且尚未收到任何用户输入的 Terminal，如果 provider 历史还不存在，点击 `MSG` 会直接建立新的 ACP session。一旦 Terminal 已收到输入，历史缺失仍会明确报错，不能静默丢弃已有工作。replacement Agent 准备期间浮层持续显示重启或错误状态，完成后自动跟随新的 Agent id。标题栏显式展示的 `[ALT+M]` 执行相同切换，并会按物理 `KeyM` 在终端输入之前被捕获，因此 macOS Option 键产生的 `µ` 也绝不会发送到 PTY。

主页缩略预览属于监控摘要，不按交互终端的实时性处理。CRT 客户端把变化卡片合并为每秒最多一个视觉更新批次，并且只更新发生变化的卡片。打开终端后，主页 DOM 更新暂停，服务器不再向该客户端发送后台预览快照，原始终端流也只发送当前 Agent。关闭终端时主动请求一次最新状态与预览，再进行一次合并后的主页重绘。

CRT 与 Farming Code 使用相同的页面可见性生命周期：标签页不可见时关闭 WebSocket 并取消重连，但后端 Agent 和 PTY 继续运行；重新回到页面时只建立一个新连接，恢复最新状态，并在继续增量输出前重新同步已打开的终端。

扩展管理属于待支持事项，当前尚未实现。侧栏中禁用的 `[E] EXTENSIONS` 是预留入口，未来应接入与其他皮肤共享的扩展界面，用于展示 Skills、MCP Server 和 Computer Use 集成等已安装能力。在 Farming 具备跨 Provider 的统一扩展发现和生命周期管理之前，CRT 必须保持该入口不可交互，也不能自行安装或推断扩展。

## 文档

- `base_layout.zh_cn.md` - 通用布局模型和视觉规则。
- `pc_layout.zh_cn.md` - 桌面端布局规则。
- `mobile_layout.zh_cn.md` - 移动端布局规则。
