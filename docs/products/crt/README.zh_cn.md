# Farming CRT

> English version: [README.md](./README.md)

CRT 是 Farming 的第一个皮肤：一个复古终端风格的控制台，用来观察和指挥 CLI agent。

CRT 并不比 Farming Code 更低级，也不是被丢弃的历史版本。它是一种不同的启动形态，更偏轻量监控和控制台操作。Farming Code 是当前默认的 coding workbench 皮肤；当用户想要最初的 terminal / CRT 体验时，应显式选择 CRT。

CRT 保留了最初的顶部状态栏、agent 布局、侧边栏、扫描线效果，以及终端控制台式的交互语言。顶部状态栏同时显示服务端系统的主 IPv4 地址和本地时间。

桌面侧边栏在 Main Agent 上方显示紧凑的 Farming CRT 标志。三个终端窗格共同构成抽象的 `F`：主窗格代表 Main Agent，青色与琥珀色窗格代表项目 Agent。只有存在实时会话时窗格才持续点亮，终端预览确实变化时才短暂增强辉光；首次通电动画遵循系统的减少动态效果偏好。

CRT 现有的可交互界面支持统一的方向键导航。方向键可以在 Agent 卡片、Main Agent、可用的侧栏操作、New Agent 选项和 Settings 控件之间移动反色选择，Enter 激活当前控件，Escape 关闭当前浮层或清除主页选择。主页和 New Agent 的方向导航到达边界后会按空间位置循环到另一侧最接近同一行或同一列的控件。New Agent 打开时会直接选中设置里的默认启动 Agent，从工作区步骤返回时也会恢复这项选择；Agent 创建成功后，主页键盘选择会自动切换到这张新卡片。打开终端后，普通 Escape 仍交给终端应用自身处理，并继续使用 `Ctrl+Escape` 关闭终端。

History 与 Farming Code 保持相同能力范围，不另建 CRT 专属归档模型。它合并 Farming 运行记录、已归档的实时 Agent 和未被主页占用的 provider session，并按相同会话身份去重。后端只为 Farming 明确支持的 Coding Agent 读写运行历史，shell 和未知命令不会进入 History；每一行都会同时标明 Coding Agent 名称和工作区。按 `H` 打开 History，上下方向键移动选择，Enter 执行主要的 Continue、Open 或 Resume 操作，Escape 返回 Agent 主页；已归档 Agent 还提供 Restore。每页数量会跟随列表可用高度调整，上下方向键越过页首页尾时连续翻页，左右方向键则整页切换。Continue 与 Resume 复用现有 New Agent 和 provider session 流程，CRT 不额外推断完成状态，也不增加 History 专属搜索和筛选。

实时浏览器入口是 `<base-path>/crt/`。CRT 的入口、应用逻辑和效果文件独立放在 `frontend/skins/crt/`，只与其他皮肤共享 terminal/session bridge。所有效果限定在 `#farming-crt` 根节点内，并通过 CRT 专属的 `settings.crtSkinEffectsEnabled` 保存，因此调整 CRT 不会改变 Farming Code。

Agent 卡片使用全部剩余正文高度显示统一可读字号的实时终端末端，并从底部对齐，保证新输出字符始终可见；内容过多时从顶部裁掉，不压缩字体。标题与 Farming Code 使用相同优先级：用户重命名、provider 会话标题、有意义的终端标题、友好的 provider 名称；打开 session 后继续使用同一标题，并在单行内省略。只有终端状态当前确实为 working 的 Agent 才闪烁，近期有输出本身不会触发动画。打开 session 时默认使用 xterm.js，短暂等待与当前窗口尺寸一致的后端屏幕，恢复这份完整序列化屏幕后再追加增量输出。Qoder、OpenCode 这类全屏 TUI 不能从任意截断的 ANSI 尾部正确重放。设置页的 Display 区域可以在 10–20 像素之间按 1 像素调整打开终端的正文字号；拖动立即生效且无需保存，同时不改变 Agent 缩略预览的密度。Ghostty Web 仅通过显式的 `localStorage.farmingTerminalEngine = 'ghostty'` 调试开关保留。New Agent 的工作空间步骤会直接展示近期项目空间，并保留方向键选择。视觉只参考 cool-retro-term 的 Monochrome Green：CRT 界面框架使用采用 OFL 许可证的 Departure Mono；终端正文和 Agent 预览使用共享的中英文等宽字体栈，避免拉丁字体与中文回退字体的字格宽度不一致。屏幕底色由纯黑改为极深的荧光绿。静态纹理使用单色三像素扫描线且不再压暗屏幕四周；带噪声调制的长拖尾通过合成层按原 Shader 约 6.7 秒一轮运行，已扫描区域会在本轮结束前保持轻微增亮，并让增亮边界与唯一可见的扫描锋面严格重合。缩略预览变化时只创建一帧约 0.6 秒衰减的事件驱动余晖；打开终端的输出路径不再执行任何视觉处理，全屏噪声纹理也保持静态，以优先保证打字延迟。动态扫描层在页面进入后台时暂停，并遵循系统的“减少动态效果”偏好。数字快捷键保留绿色荧光底和深色文字，不增加额外描边。动态热力默认关闭，此时所有 Agent 卡片使用统一绿色边框和稳定尺寸；开启后才挂载活动等级样式类。Session runtime 由后端管理，界面只显示 built-in runtime，不再提供已经失效的旧 remote engine 选择。

CRT 打开的终端与 Farming Code 对齐桌面端/移动端字号、紧凑内边距、5,000 行回滚缓冲和 xterm 原生输入路径。普通键盘与中文组合输入都直接交给 xterm，不再经过第二个隐藏输入框，也不再逐字符读取布局。Agent 缩略终端直接渲染后端终端快照里的 ANSI 前景色、背景色和强调属性，不会为每张卡片额外挂载一个 xterm。未读 Agent 卡片在原状态边框之外增加一层分离的高亮荧光框，不改变布局和热力状态；打开 Agent 会推进共享的 attention 已读游标并移除外框。UI Theme 设置也提供 Farming Code 入口，可返回 `<base-path>/code/`。

主页缩略预览属于监控摘要，不按交互终端的实时性处理。CRT 客户端把变化卡片合并为每秒最多一个视觉更新批次，并且只更新发生变化的卡片。打开终端后，主页 DOM 更新暂停，服务器不再向该客户端发送后台预览快照，原始终端流也只发送当前 Agent。关闭终端时主动请求一次最新状态与预览，再进行一次合并后的主页重绘。

CRT 与 Farming Code 使用相同的页面可见性生命周期：标签页不可见时关闭 WebSocket 并取消重连，但后端 Agent 和 PTY 继续运行；重新回到页面时只建立一个新连接，恢复最新状态，并在继续增量输出前重新同步已打开的终端。

## 文档

- `base_layout.zh_cn.md` - 通用布局模型和视觉规则。
- `pc_layout.zh_cn.md` - 桌面端布局规则。
- `mobile_layout.zh_cn.md` - 移动端布局规则。
