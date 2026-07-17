# AGENTS.md - AI Agent 开发指南

> English version: [AGENTS.md](./AGENTS.md)

> 本文档专为 AI Agent 设计，包含 Farming 项目的开发原则、架构理念和代码规范。

---

## 项目简介

**Farming** 是一个 AI Agent UI 产品，关注用户在指挥 AI Agent 工作过程中的注意力和体验。

浏览器在同一个后端上提供两套实时 UI：`<base-path>/code/` 是 Farming Code，`<base-path>/crt/` 是原始 CRT UI，base path 根路径继续作为 Code 的兼容入口。两套 UI 观察和操作同一批后端 session；Code 启动或渲染失败时，应在有限的错误详情浮层后显露仍然实时运行的 CRT UI，不得重启或复制 Agent 进程。

**Farming Net** 是一套独立、轻量的部署目录，使用自己的 Base Path、配置目录、Token、Cookie 和 Ed25519 签名身份。登记后的目标把绑定目标、短时、一次性的签名通行证兑换成自己正常使用的 Cookie；门户绝不能保存或暴露目标 Token。真实部署注册表属于私有运维配置，不得提交到仓库。

### 产品定位

该产品本质上是一个 AI Agent UI，关心 AI Agent 用户（人类）的注意力，让用户在指挥 AI Agent 工作的过程中感到快乐，让用户成为更好的"监工"。

### 核心价值

解决当前 AI Agent 使用中的核心痛点：**多个 agent 的进度观察、介入和管理**。当前的 AI Agent panel 主要是 chat sessions，根本无法把握重点，无法分辨长期任务和短期临时任务，热点任务和冷任务。

### 产品形式

将"放置类游戏"和"模拟经营类游戏"的乐趣和 UI 移植到 AI Agent 使用的流程体验中。

### 产品构成

- **内核**：一套 AI Agent 的使用方法论
- **架构**：前后端分离，后端实现方法论，前端可横向扩展（类似游戏皮肤概念）
- **形态**：多平台（Android、iOS、macOS 等），前期通过 NodeJS+HTML5 快速出原型

---

## 设计哲学

### 人类认知特征

- 注意力有限
- 没有真正的多线程处理能力
- 不喜欢被催，但喜欢被汇报
- 会在监督下属忙碌工作的过程中产生快感
- 能从观察事物发展和养成体验中感受到快乐

### 产品原则

**反对：**
- 复杂和大量的数据信息堆砌
- 把所有事项都铺在界面上
- 小红点等催促提示
- 界面总是没动静

**提倡：**
- 自动帮用户筛选并直观展示该关注的工作项
- 将 AI Agent 的工作拟人化或拟物化来表现工作项正在被推进
- 用符合用户口味的 UI、动画、交互来实现
- **所有操作都能用键盘完成**（类似 Vimium 插件设计）

---

## 开发原则

### 1. 文档同步原则

**当代码库结构发生变化时，必须同步更新以下文档：**

- `README.md` - 更新代码库结构、开发状态、功能说明
- `AGENTS.md` - 更新代码库结构、开发原则、技术细节

**对话记录更新边界：**

- `conversation-log.md` 已迁入内部归档分支，当前工作树不再维护公开对话记录文件
- 普通问答、临时排查、实现过程记录和日常状态同步不写入公开文档
- 重要产品、架构或交互设计决策优先同步到 `README.md`、`AGENTS.md` 或对应 `docs/products/*` 文档

**触发更新的场景：**
- 新增/删除/重命名文件或目录
- 新增功能模块
- 修改技术栈或架构
- 更新依赖包
- 修改测试结构

### 2. 代码简洁原则

- **避免过度抽象**：一期原型优先简单实现，避免过早优化
- **函数职责单一**：每个函数只做一件事
- **命名清晰**：变量和函数名要能清楚表达意图
- **注释适度**：代码即文档，必要时才添加注释
- **先设计状态转换**：非平凡功能在实现前，应从已知业务需求推导最小状态机，确定权威状态所有者，并明确每条转换的触发条件、guard、effect、失败结果，以及重试、取消、并发和恢复语义
- **同时证明安全性和活性**：安全性要求非预期坏状态不可达、每条转换保持关键不变量；活性要求在明确的外部假设下，每个暂态都有成功、失败、取消、超时或恢复出口，期望的好状态最终可达
- **正确后再评价设计品味**：先合并等价状态、删除无业务意义的中间态、保持单一事实源并拒绝非法转换；正确性成立后，再检查是否易于证明、高内聚低耦合、接口难以误用，以及 UI 是否清楚表达状态、动作和恢复路径
- **测试能力决定受支持路径**：持续测试预算有限。除非一条 Fallback 能与主路径按同一验收标准持续运行，否则不要把它加入产品状态机。未经持续覆盖的 Fallback 不是韧性，而是未受支持行为；优先保留一条明确路径，并让失败有界且可见。同一受支持实现内部可以恢复和重试，但不能因此选择第二套实现；诊断用替代实现必须手动启用，并处于产品支持契约之外。确实需要替代路径时，要么让它取代主路径，要么先投入同等级持续测试能力再发布。

### 3. 测试覆盖原则

- **核心功能必须有测试**：Main Agent 验证、心跳检测、状态同步等
- **后端测试位置**：`backend/tests/` 目录
- **展示效果 E2E 位置**：`tests/e2e/` 目录，使用 Playwright Test 覆盖真实页面、真实 WebSocket / native pty session / xterm.js terminal 渲染链路
- **测试命名**：`test-[功能].js`
- **E2E 命名**：`*.spec.ts`
- **测试覆盖**：每个核心功能至少有一个测试用例
- **按状态转换派生测试**：不能只验证 happy path 的最终结果；应覆盖合法转换、危险的非法事件序列、安全性不变量，以及暂态的有界推进和恢复，并按风险纳入并发、乱序、重试、取消、断连和重启
- **测试是证据而非全部证明**：测试、日志、代码检查和浏览器观察都只对声明的场景与 revision 提供证据，绿色测试套件不能单独替代安全性与活性推理
- **视觉回归**：关键桌面/移动端展示状态应维护 Playwright 截图基线；只有 UI 展示确实变化时才运行 `npm run test:e2e:playwright:update`

### 4. 错误处理原则

- **用户输入验证**：所有用户输入必须验证（如 Main Agent 命令验证）
- **错误消息友好**：错误消息要清晰，告诉用户如何修正
- **错误日志记录**：后端错误记录到 `server.log`
- **有边界地失败**：可选能力只有在备用路径也能持续测试时才允许降级；Terminal 等核心路径应显式报错，不能切到未经持续覆盖的 Fallback

### 5. 安全原则

- **不硬编码密钥**：敏感信息通过环境变量或配置文件
- **输入过滤**：防止命令注入
- **Codex transcript/chat 净化**：所有用户可见的 Codex transcript/chat 文本必须经过后端共享 sanitizer，过滤 Codex 内部注入上下文；Codex 更新内部上下文格式时，必须同步更新 sanitizer 和回归测试
- **进程隔离**：每个 agent 独立进程，避免相互影响
- **权限最小化**：agent 进程只拥有必要权限

### 6. 性能原则

- **避免阻塞**：使用异步操作，避免阻塞主线程
- **状态同步优化**：使用 WebSocket 实时推送，避免轮询
- **重接口缓存**：usage、session history、model catalog 等磁盘/CLI 重接口应使用 stale-while-refresh 缓存，避免首屏和交互点击被同步扫描拖慢
- **资源清理**：及时清理僵尸进程和过期数据
- **输出缓冲**：限制 agent 输出缓冲区大小（当前 10KB）

### 7. 用户体验原则

- **全键盘操作**：所有操作必须能用键盘完成
- **视觉反馈**：每个操作都要有明确的视觉反馈
- **选项菜单紧凑原则**：短选项、语言/模式/操作类菜单默认按内容宽度收缩，只设置必要的 min/max-width；不要为了统一而固定成大宽度或撑满容器
- **键盘选中可见原则**：可滚动菜单、补全列表和候选项列表在方向键/Home/End 改变 active 项时，必须自动滚动到边界内，不能出现“选中了但用户看不到”的状态
- **状态清晰**：用户能一眼看出当前状态
- **错误友好**：错误提示清晰，告诉用户如何修正
- **核心体验禁止降级 fallback**：Agent terminal / PTY / 输入输出这类核心链路必须保持一致行为；依赖不满足时直接失败并给明确错误，不用低质量替代实现假装可用
- **样式保持**：功能修复默认不得改变既有视觉风格、颜色、层级、交互气质；除非用户明确要求调整 UI，否则应优先通过更精确的作用域、局部覆盖和结构修复来解决问题，避免“顺手改样式”
- **文案与页面表达变更需先确认**：未经用户明确同意，不得主动新增、删除或改写页面文案、提示语、说明文字，以及会改变页面表达方式的信息层；如确需调整，必须先与用户确认

---

## 技术架构

### 三层架构

```
┌─────────────────────────────────────────────────┐
│              表现层（可扩展UI主题）              │
│         文明主题 | 种田主题 | 未来更多主题       │
└─────────────────────────────────────────────────┘
                        ↕
┌─────────────────────────────────────────────────┐
│              方法论层（后端核心）                │
│  主Agent管理 | 任务调度 | 状态判定 | 数据持久化  │
└─────────────────────────────────────────────────┘
                        ↕
┌─────────────────────────────────────────────────┐
│              执行层（Agent实例）                │
│   Native PTY Host | CLI Code Agent | Shell Session │
└─────────────────────────────────────────────────┘
```

新的交互式 agent 默认由 `NativeSessionEngine` 托管，node-pty 进程运行在独立 native pty host 中，Farming 服务重启后通过本地 socket 重新挂回仍存活的 terminal。同一代码版本内，native pty host 默认会跨 Farming server 重启保留；当没有 live session 和 client 后会在空闲宽限期后退出。server 与 host 连接时必须交换 runtime 代码指纹；应用升级或指纹不一致时执行 Transactional Controlled Rotation：阻止新 Mutation，Drain 并 Freeze Reducer 的精确状态切面，序列化所有仍为 Live 的 Terminal，只有携带匹配 Preparation Token 才能关闭旧 Host，并在新 PTY Epoch 中恢复序列化 Screen。序列化失败必须恢复旧 Host 并终止轮换；Host 意外崩溃属于进程丢失，不能伪装成成功恢复。只有希望 host 跟随每次 server 关闭一起退出时才设置 `FARMING_NATIVE_PTY_HOST_PERSIST=0`。`LocalSessionEngine` 仅保留为 `FARMING_SESSION_ENGINE=local` 调试路径；产品 runtime 工作应面向 native pty host。

Terminal 展示恢复使用带 checkpoint 的状态机协议。native pty host 中的 headless xterm 是唯一权威归约器：每次 PTY 运行都有唯一 epoch；Output Transition 同时推进 `outputSeq` 和 `stateRevision`，Clear / Resize 只推进 `stateRevision`。序列化 checkpoint 必须携带该归约器实际提交的 epoch、序号、screen 与尺寸。WebSocket 合并不能抹掉单个 Transition 的索引。浏览器只允许在当前 epoch 上应用下一条连续 Transition；重复消息直接忽略，序号缺口、epoch 变化、页面隐藏恢复或断线重连都必须先安装权威 `/session-view` checkpoint，再继续归约 live output。禁止轮询 `/session-view`；Transport Failure 使用 Backoff 重试，重复响应持续违反同一 Checkpoint 不变量时必须停止并显式报错。已知落后于 Replay Target 的 Checkpoint 不得进入可见画面；安装完整 Checkpoint 时应抑制 xterm 的增量绘制，恢复过程一次显示最新 Screen，而不是重播历史。PTY 退出时必须等待 250 ms 尾部数据静默窗口、Drain Reducer，并保存精确 Final Checkpoint；若最终切面缺失或不精确，必须显式报告致命状态证明失败，不能把 Raw Output 伪装成权威 Screen。

Terminal Input 保持直接的 Raw PTY Stream：不要增加逐输入 ACK、去重、自动重放，也不要在 xterm `onData` 外增加按时间猜测的 Textarea Fallback。多个 Code / CRT Viewer 共享同一份权威 Display，并且都可以输入；AgentManager 的输入队列按服务端到达顺序串行写入 PTY。浏览器侧不再存在 Controller Lease、Takeover UI、Renderer ACK 协议，也暂不展示 Viewer 数量。传输结果不确定时不得自动重放 Input。Geometry 只表示 Display Dimensions（`cols` 与 `rows`）。所有由浏览器 Layout 触发的 Geometry 变化都必须以完整 `cols + rows` 为单位做尾部合并，使一次持续窗口拖动不会反复触发 xterm Reflow 和全屏 TUI 重画。不能再按 Renderer Buffer 类型或 Output 长度分支这套行为，因为 TUI Alternate Screen 会让这种分类失真。显式 Attach、Recovery 与 Force Fit 仍然立即执行。后端最多保留一个 In-flight Resize 和一个 Latest Pending Size。只有 Reducer Backlog 可以通过 High / Low Watermark 暂停 PTY；慢浏览器应由 WebSocket Backpressure 单独隔离，不能冻结共享 PTY。Native PTY Host 的 Controller Generation 仍作为服务端进程切换边界：先关闭旧 Admission，Drain 已经接收的 Mutation，再发布新 Server Generation；它不是浏览器 Ownership。

Code 与 CRT 的产品 Terminal 统一使用 xterm.js WebGL Renderer，并且只支持这一条渲染路径。WebGL 初始化失败或不可恢复的 Context Loss 必须显式停止并报错，不能在 Live Terminal 中静默切换到 DOM Renderer。Ghostty Web 只作为显式 Debug Renderer 存在，不是产品 Fallback。

对于 Codex、Claude Code、OpenCode 和 Qoder，Farming Code 的结构化 Chat runtime 使用 ACP。Chat / Terminal 控件会把 Agent 重启到 ACP 或 native PTY runtime，并恢复同一个 provider Session；它不是单纯切换画面。刚打开且尚未收到用户输入的 Terminal，可以在 provider 还没落盘历史记录前直接切换成新的 ACP Chat；一旦 Terminal 已经收到输入，就必须保留可恢复 Session 校验，不能因历史缺失而静默丢掉对话。旧 JSON CLI Chat 只保留兼容读取，Codex App Server 继续作为独立实验路径。

实时 Codex Terminal 的模型修改必须跟随 CLI 实际渲染的 `/model` 与推理菜单，并在放行后续 Composer 输入前确认底部状态。不要用固定延时自动操作 TUI，也不要假设模型目录索引等同于可见菜单索引。`/fast on|off` 是非交互命令：完整输入被 PTY 接受后立即放行后续 Terminal 输入，确认过程在输入队列之外继续。当前 runtime 目录未宣告 Fast / Ultra 时，控件保持可见但禁用。

ACP 历史重放和实时更新必须归约到同一条有序 entry stream，不要在后端为 ACP 重建 `Turn -> Item` 模型。面向用户的结果/过程分组属于 ACP 前端的注意力投影：必须可逆、保留 entry 顺序与 tool 详情，并在不删除可见 automation 通知的前提下隐藏 Codex 内部 heartbeat/context 活动。

ACP 只有在 Farming reducer checkpoint 已精确且原子落盘，并且 provider、Agent Home、Session、工作区与 provider 新鲜度仍一致时，才可以跳过完整 `session/load`。发送 prompt 前必须先把 checkpoint fence 为 dirty；缺失、dirty、过期、损坏或无法校验的状态必须明确进入有界 load/repair 路径。Transcript 页面只携带紧凑有序 tool envelope，准确 raw tool detail 仍由后端持有，并按 tool-call id 懒加载。

Agent 进程不能直接完整继承 Farming server 的 `process.env`。后端应先解析用户 shell 环境，再只叠加 agent 需要的服务端变量，例如模型凭据、代理、SSH auth 和证书路径，最后统一规范化 `TERM`、`COLORTERM`、`TERM_PROGRAM` 等 terminal 变量，并移除 `NO_COLOR`、非交互式 `cat` pager、动态库覆盖和 Node heap flag 等 server/runtime shim。新增启动路径必须复用这套 resolver，不能重新复制 `process.env`。

Shell agent（`bash` / `zsh`）默认保留用户自己的交互启动流程和 prompt，行为与 VS Code 集成终端一致。Farming 通过不可见的 OSC busy / cwd marker 观测 shell，而不接管 `PS1` 或 `PROMPT`。需要紧凑受控 prompt 时显式设置 `FARMING_SHELL_CONTROLLED_PROMPT=1`；隐私截图可设置 `FARMING_ANONYMIZE_SHELL_PROMPT=1`。这些仅限 shell 的变量不能传给直接启动的 coding agent。

在 macOS 上，内置 bash / zsh 与 VS Code 的内置 profile 一致，默认以 login shell 启动。必须按目标 shell 分别解析环境，不能在 bash 和 zsh 之间传递继承的 `PS1`、`PROMPT` 或 prompt hook；终端外观只能由被启动 shell 自己的 startup 文件决定。

### 核心：主 Agent 机制

主 Agent 是用户启动的第一个 CLI code agent session，负责：
- **任务空间布局管理**：决定新任务在操作面板上的呈现位置
- **任务状态判定**：综合判断任务的热/冷状态（结合 agent 操作频率 + 用户点击频率 + 用户关注时间）
- **僵尸任务清理**：智能判断何时清理无响应的任务（非硬编码阈值，综合判断）
- **视觉细节决策**：决定任务的视觉呈现细节（需长期打磨）
- **导航决策**：决定操作面板的导航逻辑

---

## 代码库结构

```
farming/
├── README.md              # 英文项目说明（给人类看的）
├── README.zh_cn.md        # 中文项目说明
├── AGENTS.md              # 英文 AI Agent 开发指南
├── AGENTS.zh_cn.md        # 本文件（中文 AI Agent 开发指南）
├── LICENSE                # Farming 本体 MIT License
├── .gitattributes          # 源码归档 export-ignore 规则
├── config/
│   ├── farming.deploy.env.example # 源码远程部署配置模板
│   └── farming.install.env.example # app bundle / tarball 安装配置模板
├── releases/              # 本地 release 输出目录；不提交到源码仓库
├── reference/             # 外部项目源码、工具链和调研 walkthrough；不作为 Farming 运行时依赖
├── docs/
│   ├── products/
│   │   ├── code/          # Farming 2 产品介绍、Farming Code 皮肤截图、Linux 一键部署、架构、License 与验收 dogfood 说明
│   │   │   ├── farming-agent-human-story.md       # Farming Agent 英文验收故事
│   │   │   ├── farming-agent-human-story.zh_cn.md # Farming Agent 中文验收故事
│   │   │   ├── files-editor-user-stories.md       # Files / Editor 英文用户故事
│   │   │   ├── files-editor-user-stories.zh_cn.md # Files / Editor 中文用户故事与类人验收脚本
│   │   │   └── test/      # Farming 2 验收 dogfood 测试方案
│   │   ├── crt/           # Farming CRT 皮肤布局文档
│   │   │   ├── base_layout.md          # CRT 英文跨平台通用布局概念与视觉规则
│   │   │   ├── base_layout.zh_cn.md    # CRT 中文跨平台通用布局概念与视觉规则
│   │   │   ├── mobile_layout.md        # CRT 英文手机端布局说明
│   │   │   ├── mobile_layout.zh_cn.md  # CRT 中文手机端布局说明
│   │   │   ├── pc_layout.md            # CRT 英文桌面端布局说明
│   │   │   └── pc_layout.zh_cn.md      # CRT 中文桌面端布局说明
│   │   └── net/           # Farming Net 中英文部署门户说明
├── package.json           # Node.js 依赖配置
├── package-lock.json      # 依赖版本锁定
├── pkg.config.cjs         # 平台 CLI 应用打包配置（@yao-pkg/pkg + legacy pkg）
├── playwright.config.ts   # Playwright E2E / 视觉回归测试配置
├── .gitignore             # Git 忽略文件配置
├── bin/
│   └── farming            # 开发态 Farming 产品 CLI；发布后二进制也叫 farming
├── scripts/
│   ├── sync-ghostty-vendor.js # 将 ghostty-web 浏览器资源同步到 frontend/vendor/
│   ├── deploy.sh             # 远程 Linux 部署 / 启动 / 停止脚本
│   ├── bundle-cli-runtime.js # release CLI 后端 bundle 入口；处理 packaged runtime 的动态 require 边界
│   ├── package-cli-release.sh # 生成按平台发布的 farming CLI 应用；先 esbuild bundle/minify 后端，再交给 @yao-pkg/pkg / legacy pkg
│   ├── smoke-cli-release.sh   # 平台 CLI 冷路径 smoke：干净 HOME、自动配置、token、agent 控制链路
│   ├── package-release.sh     # 生成可解压运行的 app bundle tarball，包内根目录自带 ./farming
│   ├── install-release.sh     # app bundle / tarball 本地安装、启动、停止脚本
│   ├── install-remote-release.sh # 本机打包、上传 tarball 并远程安装启动
│   ├── compute-node-heap-mb.sh # 按 cgroup / 系统内存计算 Farming server Node heap
│   ├── start-playwright-server.js # Playwright 本地临时测试服务入口
│   ├── capture-product-screenshots.js # 使用匿名 demo workspace 重建 docs/products/code 产品截图
│   ├── e2e.js                # 可重复端到端测试（本地 / 远端 / 手机视口）
│   └── e2e-workspaces.js     # Main/New Agent workspace 行为 E2E 测试
├── backend/               # 后端代码
│   ├── server.js          # Express + WebSocket 服务器
│   │   - 静态文件服务
│   │   - WebSocket 连接管理
│   │   - 消息路由和处理
│   │   - /api/executables 端点（命令补全）
│   │
│   ├── auth.js            # Token 认证模块
│   │   - 首次鉴权启动生成短语式随机 token，并在重启/升级时复用 token 文件
│   │   - HTTP Cookie / query token 校验
│   │   - WebSocket 握手认证
│   │   - `FARMING_DISABLE_AUTH=1` 时关闭 HTTP / WebSocket token 校验
│   │
│   ├── haiku-token.js     # 按时区自动选择中文/日文俳句或英文短语 token
│   │   - 使用模板槽位与 crypto.randomInt 生成可读短语 token
│   │   - 保持至少 85 bit 随机熵
│   │
│   ├── control-api.js     # Main Agent / CLI 使用的 agent 生命周期控制 API
│   │   - 启动子 agent
│   │   - 列出 / 读取 / 输入 / 终止 agent
│   │   - 复用现有 Token 认证与 AgentManager
│   │
│   ├── farming-app-cli.js # 产品 CLI 入口
│   │   - `farming start/daemon/status/stop/logs/url`
│   │   - 默认端口 6694、base path `/farming`、配置目录 `~/.farming`
│   │   - 同时转发 Main Agent 控制命令到 `farming-cli.js`
│   │
│   ├── farming-net-server.js # Farming Net 独立 HTTP/Token 服务
│   ├── farming-net-registry.js # 私有部署注册表校验与浏览器安全投影
│   ├── farming-net-pass.js # Farming Net 短时签名通行证与目标信任校验
│   │
│   ├── farming-cli.js     # Main Agent 控制 CLI 的参数解析与 HTTP 调用逻辑
│   │   - 读取 FARMING_CONTROL_URL / FARMING_TOKEN_FILE
│   │   - 给 Main Agent 提供 spawn/list/output/send/kill/memory report 命令
│   │
│   ├── main-agent-skills.js # Main Agent Farming 技能说明与内置记忆文件
│   │   - 声明“记忆读取总结”“牧场除虫计划”等 Main Agent 技能
│   │   - 以 AGENTS.md 作为 canonical skill 文件
│   │   - 维护 CLAUDE.md / QWEN.md 完整内联兼容入口
│   │   - 支持 `farming skills` 输出同一份能力说明
│   │
│   ├── agent-memory-report.js # Farming 记忆日报/周报生成
│   │   - 只读扫描 Claude/Qwen/Codex 本地历史线索
│   │   - 支持 today / yesterday / week / 自定义时间段
│   │   - 不依赖 Farming server 和外部服务
│   │
│   ├── network.js         # 本机内网 IPv4 探测
│   ├── executable-discovery.js # CLI agent 可执行项发现
│   │   - Codex 优先使用 `FARMING_CODEX_BIN` / `/Applications/Codex.app/Contents/Resources/codex` / process.env.PATH 中兼容 session `cli_version` 的可执行文件
│   │   - 测试可用 `FARMING_CODEX_BIN` 指向 fake Codex
│   │   - 通过 X_OK 判断可执行文件
│   │
│   ├── workspace-discovery.js # Claude/Qwen/Codex 历史 workspace 候选发现
│   │   - 仅读取本地元数据中的 cwd / 项目目录名线索
│   │   - 不读取对话正文，不接管外部 agent session
│   │
│   ├── async-cache.js     # 重接口 stale-while-refresh 缓存
│   │   - usage / agent session history / workspace discovery / Codex model catalog 复用最近结果
│   │   - 过期但可用时立即返回旧值并后台刷新
│   │
│   ├── codex-models.js   # Codex 模型目录裁剪
│   │   - 调用 `codex debug models` 获取实际可选模型
│   │   - 生成 UI 使用的模型 / 智能 / 速度三段式选项
│   │   - 过滤隐藏模型，不暴露 base instructions 等内部字段
│   │
│   ├── claude-settings.js # Claude settings 摘要读取
│   │   - 只读读取 `~/.claude/settings.json` 中的模型 / effort 配置
│   │   - 仅暴露非敏感摘要，不返回 token、base URL 或完整 env
│   │
│   ├── slash-command-discovery.js # Composer slash command / skill mention 动态补全
│   │   - 只读发现 Claude workspace/home skills、custom commands 与 Codex repo/user/system/plugin skills 的安全名称
│   │   - Codex skills 以 `$skill` / `$plugin:skill` mention 暴露，Claude skills/custom commands 以 `/...` 暴露
│   │   - 不读取 skill/command 正文，不暴露 token、base URL 或完整配置
│   │
│   ├── codex-session-history.js # Codex session 元数据读取
│   │   - 只读读取 `~/.codex/session_index.jsonl`
│   │   - 合并 `.codex-global-state.json` 的 pinned/unread/workspace hints
│   │   - 扫描 `sessions/` 与 `archived_sessions/` 前部元数据，不读取对话正文
│   │   - 暴露 session `cli_version`，供 resume 前判断 Codex CLI 是否过旧
│   │
│   ├── agent-session-history.js # Codex / Claude session provider 统一层
│   │   - 合并 Codex `session_index` / rollout 元数据与 Claude `projects/*/*.jsonl` 元数据
│   │   - 输出统一 provider/sessionId/title/workspace/model/capabilities 结构
│   │   - 生成 `codex resume -C <cwd> <id>` / `claude --resume <id>` 恢复命令
│   │
│   ├── usage-monitor.js # Codex / Claude usage 与 quota 只读采集
│   │   - 读取 Codex rollout `token_count.rate_limits` 与 token usage
│   │   - 读取 Claude `projects/*/*.jsonl` assistant usage 字段
│   │   - 暴露 agent 输出速率估算和 CPU/MEM 状态，不执行 reset
│   │
│   ├── workspace-file-service.js # Project/Agent workspace 轻量文件服务
│   │   - workspace root 安全边界
│   │   - 目录树 / 文本读取 / 版本校验保存 / 新建 / 重命名 / 删除 / 移动
│   │   - ripgrep 搜索（优先系统 rg，缺失时使用 npm ripgrep fallback）/ git diff / git blame / 可选有界 chokidar 文件变化事件
│   │
│   ├── workspace-file-router.js # `/api/files/*` 编辑后端路由
│   │
│   ├── agent-manager.js   # Agent 生命周期管理器
│   │   - Session engine 路由
│   │   - Main Agent 心跳检测
│   │   - 状态聚合与同步
│   │   - 输入输出转发
│   │   - 进程清理和回收
│   │
│   ├── cli-agents.js      # CLI agent 白名单与元数据
│   │   - supported / interactive / category
│   │   - preferredEngine 路由提示
│   │
│   ├── session-engine.js  # Session engine 抽象接口
│   ├── session-engine-bridge.js # Session engine bridge（router + 事件桥接）
│   ├── packaged-node-pty.js # packaged runtime 下提取 node-pty pty.node / spawn-helper 的薄包装
│   ├── native-session-engine.js # 默认 engine；通过独立 native pty host 托管 node-pty 进程，支持服务重启后恢复
│   ├── native-pty-host.js # 独立 pty host 进程，负责真实 PTY 生命周期、输出、resize、恢复
│   ├── native-pty-host-client.js # server 到 native pty host 的本地 socket 客户端
│   ├── local-session-engine.js # 备用本地 engine；必须使用 node-pty，native PTY 不可用时直接启动失败；截图/测试可用 FARMING_ANONYMIZE_SHELL_PROMPT=1 隐去真实 user/host/path prompt
│   ├── shell-busy-integration.js # 可拔除的 bash/zsh busy/idle marker 注入与过滤模块
│   ├── terminal-screen-state.js # 本地 terminal 屏幕状态层（headless xterm snapshot / preview / title）
│   ├── terminal-screen-worker.js # terminal screen worker 主线程桥接
│   ├── terminal-screen-worker-pool.js # 预热 terminal screen worker 池，降低 session preview 冷启动成本
│   ├── terminal-screen-worker-thread.js # terminal screen worker 线程入口
│   ├── session-engine-router.js # Agent -> engine 路由器
│   │
│   ├── config-manager.js  # 配置管理器
│   │   - ~/.farming 目录创建
│   │   - settings.json 读写
│   │   - 工作空间配置
│   │
│   └── tests/             # 后端测试
│       ├── test-final.js  # 完整测试套件
│       │   - Non-tty rejection
│       │   - Main Agent creation
│       │   - Input processing
│       │   - Second agent creation
│       │   - Main Agent kill
│       │   - Other agent preservation
│       ├── test-agent-card-task-display.js # 子 Agent task 展示静态测试
│       ├── test-agent-manager-fork.js # Agent fork / git worktree 行为测试
│       ├── test-agent-manager-interrupt.js # Agent interrupt fallback 行为测试
│       ├── test-agent-manager-rename.js # Agent 自定义显示名行为测试
│       ├── test-agent-session-history.js # Codex / Claude session provider 统一测试
│       ├── test-async-cache.js # stale-while-refresh 缓存语义测试
│       ├── test-usage-monitor.js # Codex / Claude usage 与 quota 只读采集测试
│       ├── test-codex-models.js # Codex 模型目录裁剪与三段式选项测试
│       ├── test-code-composer-message.js # Composer 附件 / slash mode 消息格式化测试
│       ├── test-code-composer-submit.js # Composer -> terminal 单 chunk 提交语义测试
│       ├── test-code-focus-retry.js # Code-style focus retry 调度 helper 测试
│       ├── test-code-main-page-session.js # Codex / Claude 主页面 session membership helper 测试
│       ├── test-code-menu-position.js # Code context menu 定位 helper 测试
│       ├── test-code-workspace-file-view.js # workspace file path / open file view helper 测试
│       ├── test-claude-settings.js # Claude settings 模型/effort 摘要与敏感字段过滤测试
│       ├── test-slash-command-discovery.js # Claude slash command / skill 名称只读发现测试
│       ├── test-codex-session-history.js # Codex 历史 session 元数据合并测试
│       ├── test-code-workspace-derived.js # CodeWorkspace agent/session/project 派生状态 helper 测试
│       ├── test-code-workspace-files.js # Code-style workspace 结构与接线测试
│       ├── test-codex-agent-working-state.js # Codex / Claude 当前 turn active 状态判断测试
│       ├── test-session-engine-bridge.js # Session engine bridge 测试
│       ├── test-session-engine-routing.js # Session engine 路由测试
│       ├── test-supported-coding-agents.js # Coding agent 白名单测试
│       ├── test-auth-token-file.js # Token 文件位置测试
│       ├── test-haiku-token.js # 多语言短语 token 生成器测试
│       ├── test-control-api.js # Farming CLI control API 测试
│       ├── test-project-files-section.js # Project Files section / editor 前端接线测试
│       ├── test-workspace-file-service.js # workspace 文件服务安全读写/search/diff/watch 测试
│       ├── test-workspace-file-router.js # `/api/files/*` 路由测试
│       ├── test-workspace-path-completion.js # New Agent workspace 路径补全接线测试
│       ├── test-farming-cli.js # Farming CLI 参数解析测试
│       ├── test-farming-app-cli.js # Farming 产品 CLI 默认配置 / packaged fallback 测试
│       ├── test-main-agent-skills.js # Main Agent 技能说明 / 记忆文件测试
│       ├── test-agent-memory-report.js # 记忆日报/周报扫描与格式化测试
│       ├── test-agent-manager-control-env.js # Main Agent 控制环境注入测试
│       ├── test-executable-discovery.js # PATH 可执行项发现测试
│       ├── test-config-manager-workspaces.js # Main/New Agent workspace 配置测试
│       ├── test-workspace-discovery.js # workspace 候选发现测试
│       ├── test-workspace-options.js # Main/New Agent workspace 候选规则测试
│       ├── test-agent-manager-session-text.js # session modal 文本源测试
│       ├── test-agent-manager-session-view.js # session view model 测试
│       ├── test-agent-manager-session-stream.js # session 实时流测试
│       ├── test-agent-preview-format.js # agent 文本预览格式测试
│       ├── test-session-modal-helpers.js # session modal 前端逻辑测试
│       ├── test-session-input-helpers.js # terminal 输入路由 helper 测试
│       ├── test-terminal-screen-state.js # headless terminal 屏幕状态测试
│       ├── test-terminal-screen-worker.js # terminal screen worker 测试
│       ├── test-terminal-screen-worker-pool.js # terminal screen worker 预热池测试
│       ├── test-terminal-preview-layout.js # terminal snapshot 卡片布局测试
│       ├── test-workspace-history-helpers.js # workspace 历史去重/截断测试
│       ├── test-agent-manager-workspace-defaults.js # 主/子 agent 默认工作目录测试
│       ├── test-backend-connection-status.js # 后端连接断开 / 心跳缺失页面提示接线测试
│       ├── test-session-terminal-input-e2e.js # terminal 输入浏览器级 E2E 测试
│       ├── test-session-modal-bridge-files.js # session modal bridge 测试
│       ├── test-server-input-routing.js # session 输入路由优先级测试
│       ├── test-local-session-engine-shells.js # shell/login 启动规范测试
│       ├── test-frontend-bridge-files.js # terminal/skin bridge 骨架测试
│       ├── test-session-bridge-files.js # session bridge 骨架测试
│       └── test-ghostty-vendor.js # ghostty vendor 资源测试
│
│   ├── theme-manager.js   # 主题管理器
│   │   - 自动扫描 frontend/themes/ 目录
│   │   - 加载主题配置和样式
│   │   - 提供主题切换 API
│   │   - 管理主题特定设置（默认值 + 用户覆盖）
│
├── tests/
│   └── e2e/                # Playwright 展示效果 E2E / 视觉回归测试
│       ├── fixtures.ts     # 临时 workspace、页面启动和 terminal fixture helper
│       ├── display-flows.spec.ts # 桌面/移动端真实展示流程测试
│       └── display-flows.spec.ts-snapshots/ # Playwright 截图基线
│
├── frontend/              # CRT 皮肤、共享浏览器 bridge 与 vendored 资源
│   ├── farming-net/       # Farming Net 独立静态门户
│   ├── skins/
│   │   └── crt/           # 独立 CRT 入口、应用逻辑与效果文件
│   ├── *.js               # 多皮肤共享的 terminal/session bridge
│   ├── vendor/
│   │   └── ghostty-web/   # vendored Ghostty 浏览器资源
│   │       - ghostty-web.js / ghostty-vt.wasm / 配套运行文件
│   └── themes/
│       └── terminal/
│           └── theme.json # Terminal 主题元数据与默认设置
│
└── src/                   # 当前 React + Vite 前端
    ├── main.tsx           # 前端入口
    ├── App.tsx            # 顶层 UI 调度（CodeWorkspace views / Dialog）
    ├── components/
    │   ├── CodeWorkspace.tsx # Web 版 Farming Code 主工作台状态编排（agent/session/search/editor/composer 状态与事件接线）
    │   ├── code/        # Code-style 皮肤模块
    │   │   ├── CodeSidebar.tsx # 左侧导航、Project/Agent/session 列表与 Files section 挂载
    │   │   ├── CodeMainArea.tsx # 主区域 view 切换（Search/History/Editor/Terminal/Composer）
    │   │   ├── CodeComposer.tsx # 输入框、权限/模型/智能/速度/语音与发送控件
    │   │   ├── CodeOverlays.tsx # Agent/Project/session 右键菜单、rename/kill dialog、copy toast
    │   │   ├── agent-kind.ts # Agent command -> provider/kind 识别 helper
    │   │   ├── agent-working-state.ts # Codex / Claude terminal 当前 turn active 状态判断 helper
    │   │   ├── main-page-session.ts # Codex / Claude 新建/恢复后进入主页面的 session membership helper
    │   │   ├── capabilities.ts # Agent 能力归一化（provider、composer 控件、菜单动作）
    │   │   ├── composer-message.ts # Composer 附件 / mode prefix / 剪贴板消息格式化 helper
    │   │   ├── composer-submit.ts # Composer 消息转换为 terminal input chunk 的 helper
    │   │   ├── focus-retry.ts # menu/dialog focus retry 调度 helper
    │   │   ├── composer-profile.ts # Composer 模型 / 权限 / launch profile 归一化 helper
    │   │   ├── HistoryPanel.tsx # History 视图
    │   │   ├── menu-model.ts # 右键菜单 declarative entry 模型与清理 helper
    │   │   ├── menu-position.ts # 右键菜单尺寸估算与 viewport clamp helper
    │   │   ├── SearchPanel.tsx # Search 视图
    │   │   ├── model.ts # Code-style workspace/session 分组与展示 helper
    │   │   ├── session-display.ts # Agent session 展示状态、promotion 和项目内裁剪 helper
    │   │   ├── workspace-derived.ts # agent/session/project/search/editor dirty 派生状态 helper
    │   │   ├── workspace-file-view.ts # workspace file path / open editor file 视图 helper
    │   │   └── types.ts # Code-style 共享类型
    │   ├── AgentTerminalPane.tsx # 极简嵌入式 agent terminal pane，操作入口保留在左侧 Agent 行 / 右键菜单
    │   ├── files/         # Project 下 Files section 与 Monaco 编辑器
    │   ├── TopBar.tsx
    │   ├── Sidebar.tsx
    │   ├── MapView.tsx
    │   ├── AgentCard.tsx
    │   ├── InputDialog.tsx
    │   ├── SessionModal.tsx
    │   └── TerminalSnapshotPreview.tsx # 只读 terminal 缩略图组件（cell snapshot 渲染）
    ├── hooks/
    │   ├── useWebSocket.ts # 状态与 session-output 订阅
    │   ├── useWorkspaceFiles.ts # Project Files section 目录树和文件变化状态
    │   ├── useKeyboard.ts  # 全键盘交互
    │   ├── useTerminal.ts  # terminal renderer 生命周期
    │   └── useIMEBridge.ts # 文本输入与 IME bridge
    ├── lib/
    │   ├── ghostty.ts      # ghostty-web renderer 封装
    │   ├── file-icons.ts   # Material Icon Theme manifest + 精选 SVG 文件类型 icon 映射
    │   ├── terminal-preview.ts # terminal snapshot cell 渲染 / 缩放 helper
    │   ├── terminal-keys.ts # terminal-first 键位策略
    │   ├── workspace-files.ts # `/api/files/*` 前端 API client
    │   ├── workspace-options.ts # Main/New Agent workspace 候选与默认值规则
    │   ├── format.ts       # 展示格式化
    │   └── theme.ts        # Code 主题运行时外观；不读取 CRT 皮肤效果设置
    ├── styles/
    │   ├── tokens.css      # 主题 token（颜色、边框、效果变量）
    │   └── main.css        # 基础布局与组件样式
    └── types/
        ├── agent.ts        # Agent / AppState / SystemStats 类型
        └── messages.ts     # WebSocket 消息类型
```

---

## 配置管理

### 配置文件

**全局配置**：`~/.farming/settings.json`

**自动创建**：服务首次启动时自动创建

**默认配置**：
```json
{
  "workspace": "/Users/用户名/.farming",
  "lastMainWorkspace": "/Users/用户名/.farming",
  "workspaceHistory": [],
  "mainPageSessionKeys": [],
  "theme": "terminal",
  "appearance": "light",
  "heartbeatInterval": 1000,
  "dangerouslySkipAgentPermissionsByDefault": false,
  "defaultLaunchAgent": "codex",
  "agentLaunchProfiles": {
    "codex": {
      "approvalMode": "approve",
      "model": "gpt-5.5",
      "reasoningEffort": "xhigh",
      "serviceTier": "default",
      "modelPreset": "gpt-5.5:xhigh"
    },
    "claude": {
      "permissionMode": "default",
      "model": "config",
      "effort": "config"
    }
  },
  "codexApprovalMode": "approve",
  "codexModel": "gpt-5.5",
  "codexReasoningEffort": "xhigh",
  "codexServiceTier": "default",
  "codexModelPreset": "gpt-5.5:xhigh",
  "version": "2"
}
```

CRT 皮肤效果开关存储在 `~/.farming/settings.json` 的 `crtSkinEffectsEnabled` 字段中，只允许 CRT 入口读取；Farming Code 不得读取或应用该字段。动态热力开关使用 `crtDynamicHeatEnabled`，默认关闭；关闭时 CRT 不挂载 hot/warm/cool/cold 样式类，所有 Agent 使用统一绿色边框和稳定尺寸。打开终端的正文字号使用 `crtTerminalFontSize`，后端限定为 `10`–`20` 像素，默认 `15` 像素。

**前端主题样式分层（React 前端）：**

- `src/styles/tokens.css`：Farming Code 主题 token
- `src/styles/main.css`：Farming Code 基础布局和组件样式
- `frontend/skins/crt/styles/effects.css`：仅在 CRT 页面加载的静态扫描线、网罩、暗角和五分钟一次的短暂扫描光带

**远端部署入口：**

- 远程部署默认通过 `/farming` 访问，而不是直接挂在 `/`
- 远程部署默认首选端口为 `6694`；CLI 应用在未显式覆盖端口时会从 `6694` 起自动上探可用端口，用户或环境变量显式覆盖时严格使用指定端口
- 启动日志会打印保留 token 的入口 URL；token 保存在 `~/.farming/.session-token`，重启和升级必须复用，除非显式设置 `FARMING_TOKEN`；新 token 默认 `FARMING_TOKEN_LOCALE=auto`，中文时区生成中文 5-7-5 俳句式口令，日本时区生成日文 5-7-5 俳句式口令，其它时区生成英文 passphrase；也可显式设置 `FARMING_TOKEN_LOCALE=zh|ja|en`
- 短语 token 保持至少约 85 bit 随机熵，比旧的 256 bit 十六进制 token 更易读，但安全余量相应更低；仍只建议用于可信开发机入口，不应直接公网裸露
- 更新行为必须识别安装方式。npm 安装读取 `farming-code` registry 元数据并支持一键更新：旧服务运行期间先安装目标版本，安装成功后才重启，进度持久化到 config 目录，新服务启动失败时尝试回退。源码 checkout 通过 Git 更新，单文件 CLI 手动替换。标准 App bundle 的可信 HTTP(S) 目录或 manifest URL 保存为 `settings.updateUrl`，每个 bundle 必须匹配运行平台并提供 64 位 `sha256`。独立的 `linux-x64-legacy-glibc228` tar 是首次安装引导包：安装器只在需要时启用固定校验的 glibc 2.28 runtime，把包内应用安装到私有 `~/.farming/npm` prefix，并生成稳定兼容 launcher。后续应用版本直接走同一 prefix 的 npm 更新；只有兼容 runtime 本身变化时才需要新的引导包。
- 默认推荐发布形态是按平台生成的直跑 `farming` CLI 应用：`npm run release:cli` 输出当前 target 的 `releases/<release-version>/farming_<release-version>_<platform>_<arch>`、统一 `manifest.json` 和 `farming_<release-version>_checksums.txt`；`npm run release:cli:all` 默认一次生成 macOS arm64 与 Linux x64；最终用户拿到二进制后可直接改名为 `farming` 并执行 `./farming daemon`
- CLI 应用默认自配置：首选端口 `6694`、base path `/farming`、配置目录 `~/.farming`；首次启动自动创建 `settings.json`、token 文件和必要运行目录，不要求用户先写 env 文件
- CLI 应用默认使用 native pty host session engine；目标机需要能加载打包的 `node-pty` runtime。只有排查 native host 边界时才设置 `FARMING_SESSION_ENGINE=local` 使用进程内 node-pty engine。
- CLI 应用启动时按目标环境自适应：未显式设置时自动计算 server Node heap，清理 packaged self-spawn 的 `PKG_EXECPATH`，并让 server 使用最终 `HOME` 推导默认 `~/.farming`
- CLI 应用会把实际 daemon 端口写入 `~/.farming/farming-server.json`；用户终端不传端口执行 `farming list/spawn/output/send/kill` 时会自动读取该 state 文件找到当前实例
- CLI 应用同时保留 Main Agent 控制命令：用户终端可用 `farming start/status/stop/logs/url` 管理 server，agent 内仍可用 `farming list/spawn/output/send/kill/memory report`
- CLI 应用发布产物不包含仓库 `backend/`、`src/`、测试或脚本源码；服务端逻辑进入平台二进制，浏览器侧只包含 Vite 构建后的 `dist/` 静态资源；Farming 自身运行依赖尽量自包含，但目标机仍需要可执行的 shell，Codex / Claude agent 仍依赖目标机已有对应 CLI
- `scripts/package-cli-release.sh` 通过 `scripts/bundle-cli-runtime.js` 用 esbuild 将后端 runtime bundle/minify 为临时 `backend/farming-app-cli.pkg.js` 和 `backend/terminal-screen-worker-thread.pkg.js`，不生成 sourcemap；bundler 会把 Express 可选 view engine 动态 require 隔离为 runtime require，避免 pkg 误判；pkg 只接收这些临时 bundle 和静态 assets，脚本退出时必须清理临时 bundle
- Packaged native addon 提取必须比较已有字节并使用原子替换：node-pty 会多次调用 native loader，原地截断已经 mmap 的 Linux `.node` 文件会让第一次 `pty.fork` 直接崩溃，即使提取文件的 checksum 完全正确。
- `scripts/package-cli-release.sh` 统一使用 `@yao-pkg/pkg` 和 Node 22 target
- `scripts/package-cli-release.sh` 调 pkg 时使用 `--no-native-build`；`node-pty` native addon 和 `spawn-helper` 通过显式 assets 进入包，运行时由 `packaged-node-pty.js` 提取
- `scripts/package-cli-release.sh` 在 checksum 前会用 `strings` 扫最终二进制，命中源码路径、测试名或内部文档标记时必须失败；该检查是 release 质量门禁，不是强防逆向
- `scripts/smoke-cli-release.sh` 是平台 CLI 冷路径验收脚本：使用干净 `HOME` 启动二进制，验证自动配置、token auth、shell agent spawn/send/output/kill/stop；默认不传端口，覆盖端口占用时的自适应行为
- Linux 和 macOS release target 使用 Node 22；目标系统必须能加载对应的 Node.js 和 `node-pty` native runtime。
- terminal 能力默认依赖打包的 `node-pty` native addon；Darwin packaged runtime 会把 `pty.node` / `spawn-helper` 提取到 `~/.farming/runtime/node-pty/<platform-arch>/`。
- 本机临时调试可用 `FARMING_DISABLE_AUTH=1` 关闭 HTTP / WebSocket token 校验；关闭后 `/api/auth/status` 返回 `authRequired: false`，启动日志不打印 token，控制 CLI 不要求 `FARMING_TOKEN_FILE`
- 本机可信环境可用 `npm run start:no-auth` 快捷关闭 token 校验
- 远程 `scripts/deploy.sh up` / `npm run deploy:remote` 会执行 deploy + start，一步同步、构建、裁剪 dev 依赖并重启
- 远程 deploy 会排除 IDE 配置、历史对话、参考仓、测试结果和测试目录，避免把开发现场一起打到运行包里
- 远程 release 脚本会优先读取仓库根目录 `config/farming.deploy.env`（可从 `config/farming.deploy.env.example` 复制），用配置文件承载 `FARMING_REMOTE`、`FARMING_REMOTE_DIR`、`FARMING_REMOTE_PORT`、`FARMING_REMOTE_BASE_PATH` 等复杂部署参数；主路径保持 `npm run release:remote`
- 远程脚本不内置个人或公司机器默认值；必须通过 `config/farming.deploy.env` 或 `FARMING_REMOTE` 显式指定远程主机，`FARMING_REMOTE_DIR` 未指定时使用远端 home 下的 `farming`；旧 `.farming-release.env` 仅保留兼容，不再作为推荐入口
- 远程 `scripts/deploy.sh start` 默认启用 token 校验，并在 launcher 中清理 `FARMING_DISABLE_AUTH`；仅可信网络临时调试时可显式使用 `scripts/deploy.sh start --disable-auth` 或 `npm run deploy:remote:no-auth`
- 远程 `scripts/deploy.sh deploy` 会先检查 node/npm/git，使用跳过浏览器下载的 `npm ci` 按 lockfile 安装依赖，并在 `vite build` 后执行 `npm prune --omit=dev`，运行目录只保留后端服务需要的生产依赖
- 远程启动时会按目标机 cgroup / 系统内存自动设置 Farming server 的 Node heap；可用 `FARMING_NODE_MAX_OLD_SPACE_SIZE=<MB>` 覆盖，或设置为 `0` 使用 Node 默认值；该 `NODE_OPTIONS` 默认不会传给子 agent
- app bundle 方案使用 `npm run release:app` 或兼容别名 `npm run release:tarball` 生成 `releases/<release-version>/farming-<release-version>-<platform>-<arch>.tar.gz`，包内包含已经构建好的 `dist/`、production `node_modules/` 和根目录 `./farming` 启动脚本；无参数运行会直接 start，只有显式设置 `FARMING_BUNDLE_NODE_MODULES=0` 或包内缺依赖时才会先 install。`npm run release:app:legacy-linux` 会额外生成 Linux x64 的 `-legacy-glibc228.tar.gz`，用于 glibc 低于 2.28 的旧系统；该包必须引导到私有 npm prefix，并通过兼容 launcher 完成 server 与真实 native PTY agent smoke。
- `release:app` 只能从干净 worktree 打包，并通过 Git 跟踪文件白名单构建；它必须拒绝未提交或未跟踪内容，避免把本地 token、私有配置或测试数据带入发行包。
- `npm run release:remote` 会按 `FARMING_REMOTE_BASE_PATH` 打包、上传 tarball 到远程 Linux、执行 `scripts/install-release.sh install`，并以 token auth 启动真实服务
- release 远程安装可在 `config/farming.deploy.env` 用 `FARMING_REMOTE_CONFIG_DIR`、`FARMING_REMOTE_SERVER_HOME` 隔离配置目录和 Codex / Claude 历史扫描，适合产品截图、测试实例和多实例部署
- app bundle 本地安装脚本 `scripts/install-release.sh` 支持 `install/start/daemon/serve/stop/status/logs`，默认读取 `config/farming.install.env`（可从 `config/farming.install.env.example` 复制），通过 `FARMING_INSTALL_DIR`、`FARMING_PORT`、`FARMING_BASE_PATH`、`FARMING_CONFIG_DIR`、`FARMING_SERVER_HOME`、`FARMING_NODE_MAX_OLD_SPACE_SIZE` 控制目标目录、端口、base path、配置目录、server HOME 和 server heap 策略；旧 Linux 包还支持 `FARMING_USE_GLIBC_RUNTIME` 与 `FARMING_GLIBC_RUNTIME_ROOT`。应用内升级源在 Web Settings 中配置并写入 `settings.json`

**公开版本发布前门禁：**

- 从干净 worktree 开始。创建新 release tag 前必须同时更新 `package.json` 和 `package-lock.json` 版本号；不得移动或复用已有 `vX.Y.Z` tag。
- 先跑快速源码检查：`npm test`、`npm run typecheck`、`npm run lint` 和 `FARMING_BASE_PATH=/farming npm run build`。
- 对本次改动涉及的 UI 面跑聚焦 Playwright；迭代中优先小而快的浏览器检查，只有变更面足够大时再扩大验证。
- 每个 Release Candidate 在聚焦的确定性浏览器检查通过后，都必须运行一次 `npm run test:pre-release:codex-ui`。这个真实 Codex 跨皮肤复合 Case 是发布阻断项，必须保存与 Revision 绑定的结果和 Artifact；具体见 `docs/products/code/real-codex-release-case.zh_cn.md`。
- 每个 Release Candidate 都必须运行一次 `npm run test:pre-release:terminal-input`。这个确定性的 Loopback Gate 会切换已有 Agent、通过 xterm 连续输入和删除、拒绝由切换触发的完整 `state` Payload、要求已聚焦 Terminal 的 Preview 保持紧凑，并将按键到 PTY Output 的 p95 限制在 250 ms 以内。保存与 Revision 绑定的结果；失败时保留 Trace。远端 Dogfood 仍须单独做真人式 Smoke，不能用网络基准替代它。
- 为发布新增或更新 `release-notes/vX.Y.Z.md`。package 版本号、Git tag 和 release note 文件名必须严格一致；GitHub Release 正文应来自这个文件，而不是 workflow 里的泛化内联文案。
- Release workflow 还会发布 `farming-code@X.Y.Z` 到 npm。首个公开包尚不能配置 Trusted Publishing，先用只用于自动化发布的仓库 secret `NPM_TOKEN` 引导一次；首包存在后，在 npm 配置本仓库与 `.github/workflows/release.yml` 的 Trusted Publisher，删除 token secret，后续由 GitHub OIDC 带 provenance 发布。不得复用 npm 版本或已有 Git tag。
- push GitHub 前必须扫描完整待推送 diff，检查 secret、私网 host、token、个人机器路径、公司内部环境名、内部供应商/工具名。公开 release note 和文档不得出现私有部署机器或本地安全工具名称；这些信息只能留在已忽略的本地文件或私有交接说明中。
- 在本机 Mac 浏览器做类人 smoke：创建和切换 Codex / Claude / shell agent，通过 terminal 和 composer 输入，验证中文输入法、终端选择/复制、文件/路径链接点击、pin/unpin、archive、刷新/重连，以及明显 CPU/内存表现。
- 对 macOS release 产物，明确记录二进制是 ad-hoc 签名、Developer ID 签名还是已 notarize。未 notarize 时，必须验证并写清首次运行的安全允许行为，不能把手动允许后的 smoke 当成干净的首次运行体验。
- 在已配置的远程 Linux dogfood 环境用 token auth 做类人 smoke：agent 创建、terminal 输入输出、刷新/重连、archive 清理、native pty host 恢复、进程数量清理。
- 确认远程 Linux 只剩预期的 Farming service/listener，不得残留旧 Farming server、native pty host、bash、zsh、Codex、Claude 进程。
- 下载容器镜像或临时搭建新工具链之前，先检查已有 release 产物、本地缓存和已配置的 Linux 构建机。Linux 打包和 smoke 优先复用干净的物理机或远程 x86_64 Linux 环境，以及其已经准备好的 toolchain 或缓存构建容器；不要把宿主机默认编译器误当成指定构建器。只有确实没有合适的真实 Linux 构建机时，才退回 ARM 主机上的 x86 模拟方案。
- release 产物必须通过仓库 release 脚本或 GitHub release workflow 构建，不得提交生成出来的 bundle。
- 守住打包依赖：凡是改到打包相关文件时，必须和上一版 package contents 或 manifest 对比，避免用户升级后缺 production dependency、native asset、runtime file 或 install script。
- 对构建出的 CLI/app bundle 产物跑 smoke；不能只验证源码 checkout。
- 先 push release commit，再 push 新 `vX.Y.Z` tag；随后观察 GitHub Release workflow，确认 Linux/macOS 产物、checksum、manifest，以及使用 `release-notes/vX.Y.Z.md` 的 GitHub Release 页面都生成后，才算发布完成。

### 配置项说明

**全局配置（settings.json）：**

- **workspace**：Farming 内部默认工作空间（固定为 `~/.farming`）
- **lastMainWorkspace**：Main Agent 上次启动使用的工作空间；缺省时 UI 默认填 `~/.farming`
- **workspaceHistory**：New Agent 最近使用的工作空间历史，最多保留 5 条，供启动对话框下拉和方向键选择；不存在的目录不得进入历史记录，手动填错路径必须通过错误提示反馈给用户；不得包含 Farming 内部目录（如 `~/.farming`）
- **projectWorkspaces**：Projects 主页面的持久 workspace 成员清单；Agent、文件、恢复的 Project 会话和 Git worktree 入口都写入同一种 Project 身份，只有 Remove Project 才删除
- **theme**：UI 主题名称（默认：terminal）
- **heartbeatInterval**：心跳检测和系统监控间隔（单位：毫秒，默认：1000）
- **dangerouslySkipAgentPermissionsByDefault**：是否默认让支持的 coding agent（如 Codex、Claude、OpenCode、Qoder、Qwen、Aider、GitHub Copilot CLI、Amazon Q）使用各自最激进的权限绕过启动 flag
- **codexRuntimeMode**：`cli` 与实验性 `app-server` 的旧配置兼容默认值；Settings 面板不再提供这个选项。App Server 模式会为每个 Agent 创建短路径、专属的 runtime `CODEX_HOME`，链接所选 Agent Home 的身份/配置，同时隔离 Codex Desktop、其他 Agent 的 socket、session 与日志。
- **searchTimeoutMs**：Project Files 搜索与 Agent 历史搜索共用的超时时间，默认 15 秒。
- **defaultLaunchAgent**：New Agent 对话框默认聚焦的 agent provider（当前 `codex` / `claude`）；composer 不提供 Codex / Claude provider 热切换
- **agentLaunchProfiles**：按 provider 保存启动能力；Codex profile 会转换成 `codex --model`、reasoning/service tier 和 approval/sandbox 参数，Claude profile 会转换成 `claude --permission-mode`、`--model`、`--effort`
- **agentHomes**：管理 Codex、Claude、OpenCode、Qoder 的 agent home 元数据；每项只包含稳定 `id` 和配置目录 `path`，每个 provider 都保留不可删除的 `default` home，例如 `codex/default -> ~/.codex`、`codex/zwz -> ~/.codex.zwz`
- **agentLaunchProfiles.codex.approvalMode**：Codex 权限模式（`ask` / `approve` / `full` / `custom`）
- **agentLaunchProfiles.codex.model / reasoningEffort / serviceTier**：Codex 模型、智能和速度；UI 从本机 `codex debug models` 动态生成模型目录
- **agentLaunchProfiles.claude.permissionMode / model / effort**：Claude 权限、模型和 effort；`config` 表示沿用 Claude 自己的配置
- **codexApprovalMode / codexModel / codexReasoningEffort / codexServiceTier / codexModelPreset**：旧配置兼容字段，会与 `agentLaunchProfiles.codex` 自动镜像
- **version**：配置文件版本

**Farming Net 配置（默认 `~/.farming-net/`）：**

- `.session-token`、签名密钥对、`instances.json` 和 `farming-net-server.json` 必须与主 Farming Runtime 隔离，且都属于私有运行时文件。
- 浏览器可见的注册表只接受 HTTP(S) Endpoint，并移除 Credentials、Query 和 Fragment；不得通过注册表 API 暴露目标 Token。
- 联邦通行证必须使用 Ed25519、精确匹配 Instance ID 的 Audience、不超过 60 秒的有效期，并拒绝重放。目标通过 `~/.farming/farming-net-trust.json` 主动登记门户，把有效通行证换成自己的 HttpOnly Cookie 后立刻重定向到干净 URL。
- 端口、Host、Base Path、配置目录、固定 Token、通行证 TTL 和显式的本机无鉴权调试分别使用 `FARMING_NET_*` 环境变量。

**Agent session state（sessions/）：**

- Agent session 元数据存储在 `~/.farming/sessions/`，不属于 `settings.json`。
- Farming 自己的持久 Agent 记录使用稳定 `fsess_*` 文件名；live `agent-...` id 只表示当前 native pty runtime，Codex / Claude provider session id 作为外部关联字段保存。
- `sessions/index.json` 维护主页面真实 provider-session membership；`mainPageSessionKeys` 只是 API 兼容投影。Codex `tmp_uuid...` live id 不得进入这里；不在列表里的 Codex / Claude provider session 只出现在 History；Move to History / Move Project to History 会从这里移除对应 key，从 History 恢复会写回 key。
- 归档 run/history 存储在 `~/.farming/history/runs.json`，不属于 `settings.json`；其中可选的 `customTitle` 用于在恢复时保留用户明确重命名过的 Agent 名称，旧记录没有该字段也继续兼容。
- config 目录下后端自有文件路径统一由 `backend/storage-layout.js` 定义；新增 `settings.json`、`theme-settings.json`、`.session-token`、`sessions/`、`history/`、server pid/state/log、native pty host log 这类路径时，不要在功能模块里手写 `path.join(configDir, ...)`。Codex `~/.codex/sessions`、Claude history 等外部 provider 历史是只读集成，不属于 Farming 自有元数据。

**CRT 皮肤设置（settings.json）：**

- **crtSkinEffectsEnabled**：只控制 `/crt/` 的扫描线、网罩、暗角和五分钟一次的扫描光带；不得影响 `/code/`

### 配置代码位置

**全局配置：**
- 配置管理器：`backend/config-manager.js`
- 使用位置：
  - `backend/agent-manager.js` 的 `startAgent` 方法（workspace）
  - `backend/agent-manager.js` 的 `startHeartbeat` 方法（heartbeatInterval）

**CRT 皮肤设置：**
- 配置管理器：`backend/config-manager.js`
- API 端点：`GET/POST /api/settings`
- 前端使用：`frontend/skins/crt/app.js`；React Code 入口不读取该字段

### 配置修改方式

**方式一：直接编辑配置文件**

编辑 `~/.farming/settings.json`，修改 `heartbeatInterval` 值（单位：毫秒）：

```json
{
  "heartbeatInterval": 2000
}
```

编辑 `~/.farming/settings.json`，修改 CRT 皮肤设置：

```json
{
  "crtSkinEffectsEnabled": false
}
```

**方式二：通过 UI（当前 Code-style 工作台）**

启动能力配置由 composer 和 New Agent 对话框承载：
- Codex composer 配置当前 Codex CLI 的权限、模型、智能和速度
- Claude 启动能力通过 New Agent 选择与后端 profile 注入，不在单独 Settings 里重复展示

**注意事项**：
- 修改配置后需重启服务器生效
- 建议范围：500ms - 5000ms
- 过短间隔会增加系统负载
- 过长间隔会降低监控实时性

---

## 技术栈

### 后端

- **Node.js** - JavaScript 运行时
- **Express** - Web 服务器框架
- **WebSocket (ws)** - 实时双向通信
- **node-pty** - 默认 terminal session 执行与交互底座，由独立 native pty host 托管真实 PTY 生命周期
- **@xterm/headless + @xterm/addon-serialize** - terminal 屏幕状态、snapshot 和 preview 派生
- **worker_threads** - 将 snapshot/preview 解析放到后台线程，避免阻塞 live terminal 输入输出
- **可选有界 chokidar + 轻量文件头 sniff** - workspace 文件变化监听与文本/二进制保护；Project Files 默认不启用后台 workspace watch，只在展开目录、打开文件、搜索、diff/blame 时按需访问文件系统；如未来启用 watch，必须限制目录深度，避免巨型仓库递归监听拖垮 server
- **ripgrep / git** - 文件搜索与 diff 能力使用成熟工具；搜索优先系统 `rg`，运行环境缺失时使用 npm `ripgrep` fallback

### 前端

- **HTML5** - 页面结构
- **CSS3** - 样式（终端风格）
- **React + Vite** - 当前 Code-style 工作台和组件化前端
- **react-arborist** - Project Files section 的虚拟化 Explorer tree 行为层
- **material-icon-theme** - Project Files section 的文件类型 icon manifest 与精选 SVG 资产
- **Monaco Editor** - Project Files section 的代码编辑器
- **xterm.js + WebGL** - Farming Code 与 CRT 唯一受支持的产品 Terminal Renderer；初始化或 Context 恢复失败时显式报错，不切换到 DOM
- **ghostty-web** - 保留为显式调试 renderer，可通过 `localStorage.farmingTerminalEngine = 'ghostty'` 切换，但不作为产品 Fallback
- **Ghostty vendor 资源** - 调试 renderer 的 JS/WASM 固定到 `frontend/vendor/ghostty-web/`，运行时不再依赖 `node_modules` 暴露静态文件
- **reference 目录仅用于参考** - 不作为生产运行时依赖，也不作为部署前提

### 未来计划

- **React/Vue** - 如果 UI 复杂度增加
- **Electron** - 桌面应用打包

---

## 开发流程

### 1. 理解需求

- 仔细阅读用户需求
- 参考 PRD 文档

### 2. 设计方案

- 先思考技术方案
- 确认是否符合设计哲学
- 考虑用户体验和性能

### 3. 实现代码

- 遵循开发原则
- 保持代码简洁
- 添加必要的错误处理

### 4. 测试验证

- 编写测试用例
- 运行 `npm test`
- 确保所有测试通过

### 5. 更新文档

- 如有结构变化，更新 README.md 和 AGENTS.md

### 6. 提交代码

- 清晰的 commit message
- 遵循 git commit 规范

---

## 项目当前状态

### 已完成功能（v1.0 原型）

- ✅ **后端核心**
  - Express + WebSocket 服务器
  - 默认 native pty host session engine（local node-pty engine 仅保留为调试 fallback）
  - Main Agent 控制 CLI（`farming spawn/list/output/send/kill/memory report`）
  - Farming 记忆日报/周报（只读扫描本机 Claude/Qwen/Codex 历史线索）
  - Main Agent skills 记忆文件（Main Agent 在 `.farming` 身份工作区启动，读取 canonical `AGENTS.md`、`farming skills`、“记忆读取总结”和“牧场除虫计划”）
  - `/api/control/*` agent 生命周期控制 API
  - `/api/files/*` 轻量编辑后端（workspace 内文件 tree/read/write/create/rename/delete/move/search/diff/blame/watch）
  - `/api/attachments/image` 图片附件上传 API（composer 粘贴/选择图片时保存到 `~/.farming/attachments`，消息中插入远端 agent 可访问的图片路径；Farming 自动生成的图片附件默认保留 7 天后清理）
  - Agent 进程管理（默认 native pty host，local fallback 仅用于调试）
  - Main Agent 验证机制（pty 检测）
  - Main Agent 心跳检测（每 3 秒）
  - 进程状态监控和清理
  - 系统监控（CPU、内存等，每 3 秒更新）
  - 主题管理系统（支持多主题扩展）
  
- ✅ **前端基础**
  - Code-style Web 工作台（New Agent / Projects / Search / History / Search 主区域结果面板 / History 可从最近 workspace 启动 agent / `Ctrl/Cmd+数字` 从 terminal 区域切换 session / `Cmd+[`、`Cmd+]` 切换已打开 terminal / `Ctrl/Cmd+B` 折叠或展开侧栏 / `Escape` 返回 Projects / 搜索键盘打开 / Project 折叠 / Agent 列表键盘导航 / Project 与 Agent 行右键菜单 / terminal-first 快捷键作用域 / 可拖拽左侧栏 / 主区只显示一个 active terminal / 极简 terminal chrome / composer 能力栏）
- Project 下 Files section 与 Monaco 编辑器：普通 Project 以持久 workspace 身份挂载 Files，即使没有 live Agent 也保留；文件主键只由 workspace 派生，Agent 补水、排序或消失都不能切换该主键。`sourceAgentId` 只表示可选的返回 Agent 关联，不能成为文件主键；Main Agent 不挂载 Files。`react-arborist` 虚拟化 Explorer 树、Material Icon Theme 文件类型映射、轻量多文件 tabs、目录树懒加载、打开文本文件、图片/二进制/大文本只读预览、保存、新建/重命名/删除、内容搜索、`path:line` 跳转、gutter 右键行级 git blame、editor 正文右键菜单、外部变更提示，右侧主区域可在 terminal/editor 间切换；多 Project 文件监听互不覆盖
  - Agent terminal 输出支持点击 `path:line` 打开 Project 文件，也支持点击 `http(s)` URL 在新标签页打开；URL/path hit-test 必须处理 xterm 软换行
  - New Agent 默认沿用当前/最后活跃项目 workspace；Project 下直接新建 Agent，并预填对应 workspace；Main Agent 的 `.farming` 身份目录在 UI 中折叠回真实项目目录
  - 指定 Project 新建 Agent、关闭 terminal pane、终止 Agent 等低频操作收敛到左侧右键菜单；New Agent 会保留当前/最后活跃项目 workspace
  - Agent 行显示类似 Codex 侧栏的相对启动时间；右键支持 Pin/Unpin、Mark as unread/read、Move to History、Rename Agent、Copy working directory、Fork into same worktree，以及在 git 仓库中 Fork into new worktree 后启动同类 Agent；尚未真实实现的 Copy session ID、Copy deeplink、Open in new window 不出现在菜单里；这不是完整复制 Codex thread 上下文
  - History 统一展示为 History Agents，不再按来源拆分多个历史区块；Farming 的 archive 语义就是把对象移出主页面并放入 History，不代表额外特殊状态；Main Agent 不允许 Move to History
  - Agent deeplink 支持 `?agent=<agentId>`，新窗口打开后会自动选中对应 terminal
  - Codex / Claude 启动能力统一收敛到后端 profile 层：Codex 使用 approval/model/reasoning/speed，Claude 使用 permission/model/effort；composer 只展示当前 Codex CLI 可真实表达的权限、模型、智能和速度控件，不提供 Codex / Claude provider 热切换；New Agent 仍负责选择 Codex / Claude / bash / zsh，并按对应 profile 追加稳定 CLI 参数；启动入口不再展示 qwen
  - Codex / Claude 本地 sessions 通过统一 Agent Sessions provider 进入 Search / History；Projects 只展示当前 live agent、pinned/unread session，或用户显式打开/恢复过的 session。点击后分别用 `codex resume -C <cwd> <id>` / `claude --resume <id>` 启动并由 Farming 托管实时 terminal；Codex resume 会根据 session `cli_version` 避免启动过旧 CLI
  - `/` 聚焦左侧搜索，搜索框内可用 `↑` / `↓` 选择结果并用 `Enter` 打开 Agent；左侧 Projects 列表获得焦点时 `↑` / `↓` 或 `k` / `j` 在可见 Agent 间切换；用 `Cmd+[` / `Cmd+]` 在已打开 terminal panes 之间切换，普通 `[` / `]` 不作为全局快捷键
  - Agent 行展示的数字快捷键来自同一份全局 `keyMap`，必须与真实数字键打开行为一致
  - 左侧 New Agent / Projects / Search / History 导航都必须接真实功能；尚未真实实现的 Plugins / Automations 不出现在主导航；打开任一 Agent terminal 时回到 Projects 视图
  - Composer 支持文本附件、粘贴图片和选择图片；图片不会以内联 base64 塞进输入框，而是上传到 Farming 服务侧附件目录并插入路径；自动生成的图片附件默认保留 7 天后清理；`Ctrl/Cmd+Enter` 与普通 `Enter` 都发送，`Shift+Enter` 换行
  - 普通 `S`、数字键、`/`、`[`、`]` 等页面快捷键不会在 terminal 区域抢输入；`Ctrl/Cmd+数字` 可从 terminal 区域切换指定 session；`Ctrl/Cmd+B` 仅在非 terminal 区域折叠/展开侧栏
  - 非 Projects 主视图支持 `Escape` 返回 Projects
  - 桌面端 Projects 左侧栏可通过分隔拖拽条调整宽度
  - Agent terminal 作为嵌入式 pane 常驻显示，但主区一次只显示当前 active session；其他 session 保留在左侧列表里，不再依赖必须关闭的 modal 或顶部标签
  - 左侧 Project 行右键菜单提供 Open First Agent / Open First Session、New Agent in Project、Collapse/Expand Project、Move Project to History；左侧 Agent 行右键菜单提供 Open Terminal、Pin/Unpin、Rename Agent、Move to History、Mark as unread/read、New Agent in Project、Copy working directory、Fork into same worktree、Fork into new worktree、Close Terminal、Kill Agent 等真实操作；左侧 Agent session 行右键菜单仅提供 Open Session 和 Copy working directory；Close Terminal 不会终止 agent
  - terminal pane 可用浏览器 resize handle 调整大小，显性 terminal chrome 保持极简
  - 旧终端风格 UI、Agent 方块展示和 Session 弹窗组件保留为 legacy/reference 能力
  - 全键盘操作支持
  - Main Agent 死亡检测
  - Main Agent 作为 Projects 中的特殊 Agent 保留
  - 子 Agent 卡片展示 Main Agent 下发的 task 摘要
  - Projects 主视图不再显示额外标题栏或状态堆叠，终端和带真实权限、模型、语音和发送控件的 composer 保留主要操作空间
  - CRT 视觉效果仍可用于 legacy terminal 主题

- ✅ **测试覆盖**
  - 完整测试套件（65 个后端/静态测试文件，`npm test` 默认运行非 server-backed 测试）
  - Code-style workspace 结构与接线测试
  - Session engine 路由测试
  - Coding agent 白名单测试
  - session modal 文本源测试
  - session view model 测试
  - session 实时流测试
  - session modal 前端逻辑测试
  - terminal 输入路由 helper 测试
  - terminal 输入浏览器级 E2E 测试
  - Playwright 展示效果 E2E / 截图回归骨架
  - 测试通过率：100%

### 待开发功能

- 🚧 **Terminal 体验优化**（高优先级）
  - 当前：terminal renderer 与输入桥已切到“terminal 优先”路线，但复杂 TUI 的字符渲染、主题质感和输入法体验仍在收敛中
  - 目标：提供真正的 CLI agent 体验，完整清晰的信息展示
  - 问题：复杂终端 UI、CJK 输入法和浏览器级快捷键边界仍需要继续打磨
 
- 🚧 文明主题视觉细节（繁荣度动画、地域布局算法）
- 🚧 任务状态判定算法（热/冷判定、僵尸任务判定）
- 🚧 多主题支持
- 🚧 数据持久化（任务配置、历史记录）
- 🚧 更多 agent provider 集成
- 🚧 多平台支持

### 已知限制

1. **UI 简化**：当前使用简单的方块而非完整的文明主题视觉
2. **状态判定**：当前仅基于活动时间，未实现综合判定
3. **数据持久化**：尚未实现，重启后数据丢失
4. **Terminal 渲染**：浏览器内 terminal 仍在收敛中，复杂 TUI / CJK / 浏览器快捷键边界需要继续打磨

---

## 核心机制详解

### Main Agent 验证机制

**目的**：确保 Main Agent 是交互式 CLI agent（如 bash、python），而非瞬间命令（如 ls、cat）。

**实现方式**：
1. 用户输入命令
2. 后端通过 session engine 启动进程（默认由 native pty host 托管）
3. 等待 2 秒
4. 检查进程是否仍在运行
5. 如果运行 → 标记为 'running'，成为 Main Agent
6. 如果退出 → 删除进程，返回错误 "Process must stay alive (interactive tty required)"

**代码位置**：`backend/agent-manager.js` 的 `startAgent` 方法

### Main Agent 控制 CLI

**目的**：保留 Farming 内部 agent 生命周期 CLI，并作为 Main Agent “牧场除虫计划”的执行通道。除虫计划要求 Main Agent 先划分目标目录下的模块，确定模块边界、模块间协议、数据流、调用关系和共享约束，再为每个模块启动子 Agent 深挖潜在 bug。

**实现方式**：
1. 后端暴露 `/api/control/*`，默认复用现有 Token 认证与 `AgentManager`
2. `farming` 是合并后的产品 CLI：用户终端可用 `start/daemon/status/stop/logs/url` 管理 server，agent 内可用 `list/spawn/output/send/kill/memory report` 访问控制 API
3. 控制命令读取 `FARMING_CONTROL_URL` 和 `FARMING_TOKEN_FILE`；服务以 `FARMING_DISABLE_AUTH=1` 启动时跳过 token 读取
4. `AgentManager` 启动每个 agent 时把 CLI 所在目录注入 `PATH`；源码态是仓库 `bin/`，packaged runtime 是 `farming` 二进制所在目录
5. `AgentManager` 同时注入 `FARMING_AGENT_ID`、`FARMING_IS_MAIN_AGENT`、`FARMING_PARENT_AGENT_ID`
6. 子 agent 环境会剥离服务进程自己的 `LD_LIBRARY_PATH` 和 `NODE_OPTIONS`，避免部署 shim 或 server heap 设置污染 agent 运行时
7. Main Agent 启动目录固定为 Farming 身份工作区：用户选择的目录若不是 `.farming` 结尾，则实际进入 `<选择目录>/.farming`；Code-style 前端在 Projects 分组和 Project 下新增 Agent 时会把 Main Agent 的 `.farming` 身份目录折叠回真实项目目录
8. Farming 在身份工作区维护 canonical `AGENTS.md`、`FARMING_MAIN_AGENT_SKILLS.md`，并把完整 Main Agent 身份与技能内联写入常见 coding CLI 兼容入口；Claude 启动时还会通过 `--append-system-prompt` 注入同一份 bootstrap，避免只依赖 memory 文件自动发现；Main Agent 也可运行 `farming skills` 查看技能
9. Main Agent 可用 `farming memory report` 只读总结本机近期 agent 记忆
10. Main Agent 可用“牧场除虫计划”先只读梳理目录结构与模块协议，再用 `farming spawn` 为每个模块启动子 Agent；子 Agent 必须聚焦自己的模块，同时检查与相邻模块的协议违约、边界条件、错误处理、并发/状态一致性和测试缺口
11. Main Agent 用 `farming list/output/send/kill` 监督子 Agent，汇总发现、去重分级，并推动可验证修复；高风险写操作、破坏性操作或大范围重构需要先向用户确认

**示例**：
```bash
farming spawn --workspace /repo --task "检查这个模块的潜在 bug，并修复可验证的问题" -- claude
farming list --parent "$FARMING_AGENT_ID"
farming output agent-xxx --tail 2000
farming send agent-xxx "继续跑相关测试"
farming kill agent-xxx
farming memory report --period today
farming memory report --period week
```

**代码位置**：
- 后端 API：`backend/control-api.js`
- CLI：`bin/farming`、`backend/farming-app-cli.js`、`backend/farming-cli.js`
- Skills：`backend/main-agent-skills.js`
- 记忆报告：`backend/agent-memory-report.js`
- 环境注入：`backend/agent-manager.js` 的 `buildAgentEnv` 方法

### Main Agent 心跳检测

**目的**：实时监控 Main Agent 是否存活，死亡时通知用户重启。

**实现方式**：
1. 后端每 3 秒执行心跳检测
2. 尝试向 Main Agent 的 stdin 写入空字符串
3. 如果写入失败（进程已死）→ 标记 status 为 'dead'
4. 前端检测到 status === 'dead' → 自动弹出 "Start Main Agent" 对话框
5. 其他 agent 不受影响，新 Main Agent 接管管理

**代码位置**：
- 后端：`backend/agent-manager.js` 的 `startHeartbeat` 方法
- 前端：`frontend/skins/crt/app.js` 的 `checkMainAgentStatus` 方法

### Agent 状态同步

**通信协议**：WebSocket（JSON 格式）

**消息类型**：
- `start-agent`：启动新 agent
- `input`：向 agent 发送输入
- `focus-agent`：聚焦某个 agent
- `kill-agent`：终止 agent
- `state`：后端推送当前状态（所有 agent 列表）
- `error`：错误消息

**状态数据结构**：
```javascript
{
  mainAgentId: 'agent-xxx' | null,
  agents: [
    {
      id: 'agent-xxx',
      command: 'bash',
      cwd: '/path/to/project',
      output: '...',  // 最近 2000 字符
      status: 'running' | 'stopped' | 'dead' | 'pending',
      isMain: true | false,
      activityLevel: 'hot' | 'warm' | 'cool' | 'cold',
      lastActivity: 1234567890
    }
  ]
}
```

**Activity Level 判定**（当前简化版）：
- `hot`：最近 2 秒内有活动
- `warm`：最近 10 秒内有活动
- `cool`：最近 30 秒内有活动
- `cold`：超过 30 秒无活动

**代码位置**：
- 后端：`backend/agent-manager.js` 的 `getState` 和 `calculateActivityLevel` 方法
- 前端：`frontend/skins/crt/app.js` 的状态渲染逻辑

---

## 快速开始

### 1. 启动开发环境

```bash
# 安装依赖
npm install

# 启动服务器
npm start

# 单独启动 Farming Net 部署门户
FARMING_NET_PORT=6693 FARMING_NET_BASE_PATH=/farming-net npm run start:net

# 服务器运行在 http://localhost:3000
```

按产品路径 `/farming` 做本机冒烟验证时，推荐一行启动，确保 build 和 server 使用同一个 base path：

```bash
PORT=6695 FARMING_PORT=6695 FARMING_BASE_PATH=/farming FARMING_DISABLE_AUTH=1 npm start
```

如果 `6694` 已被已有实例占用，就换成 `6695` 或其他空闲端口。不要只给后端设置 `FARMING_BASE_PATH=/farming` 却用普通 `npm run build` 的产物；分开执行时必须先运行 `FARMING_BASE_PATH=/farming npm run build`，再运行 `FARMING_BASE_PATH=/farming node backend/server.js`。否则 `dist/index.html` 会引用 `/assets/...`，在 `/farming/` 页面下 JS/CSS 404，表现为白屏。

### 2. 运行测试

```bash
# 运行完整测试套件
npm test
npm run typecheck
npm run lint

# 运行 Playwright 展示效果 E2E / 截图回归
npm run test:e2e
npm run test:e2e:playwright

# UI 展示确实变更后更新截图基线
npm run test:e2e:playwright:update

# 运行旧 Puppeteer 可重复端到端冒烟测试
npm run test:e2e:local
npm run test:e2e:remote
npm run test:e2e:workspaces:local
npm run test:e2e:workspaces:remote
npm run test:e2e:legacy

# server-backed 旧测试需要已有 localhost:3000 服务时再显式运行
FARMING_INCLUDE_SERVER_TESTS=1 npm test
```

E2E 覆盖要求：
- `npm test` 默认使用 4 个相互隔离的 worker；串行排查时设置 `FARMING_TEST_CONCURRENCY=1`，CI 可在 1–16 范围内按容量调整。
- `npm test` 默认运行不依赖外部 server 的后端测试；固定 `localhost:3000` 的旧 server-backed 测试默认跳过，由 E2E 脚本覆盖真实浏览器流程。
- `test:e2e` 默认运行 Playwright 展示效果 E2E：构建前端、启动临时本地服务、使用临时 `FARMING_CONFIG_DIR`、关闭本地测试认证，并通过真实 React 页面、WebSocket、native pty session 和 xterm.js terminal 验证桌面/移动端操作流程。
- `test:e2e:playwright:update` 只在 UI 展示确实变更后运行，用于更新 `tests/e2e/*-snapshots/` 中的截图基线。
- Playwright E2E 会设置 `FARMING_E2E_FAKE_EXECUTABLES=1` 固定命令补全列表，默认使用 `tests/e2e/fixtures/fake-codex` 作为 `FARMING_CODEX_BIN`，并把 `tests/e2e/fixtures/` 放入 `PATH` 以使用 fake `claude`，避免自动化测试启动真实 Codex/Claude；实际 shell agent 启动仍走真实 `bash` session。
- 真实 Codex 跨皮肤发布门禁位于 `tests/e2e/internal/real-codex-release-case.spec.ts`；它必须与默认 Fake Agent Suite 隔离，并保持唯一、有序的状态链，不能增加自动 Fallback 分支。
- `test:e2e:local` 必须使用临时 `FARMING_CONFIG_DIR`，验证桌面端通过 UI 启动 `codex`、错误 workspace 会报错且不进入历史记录，以及手机视口通过底部输入框向 `bash` 发送命令。
- `test:e2e:remote` 默认连接远端 Farming 实例 `/farming?token=...`，验证远端 coding agent 启动和手机视口输入链路。
- `test:e2e:workspaces:*` 专门固定 Main/New Agent workspace 规则：Main 默认填 `~/.farming` 或 `lastMainWorkspace`，不展示 recent；New Agent 合并 recent + 快速扫描候选，去重并过滤 Farming 内部目录。
- E2E 默认只清理自己创建的 agent，不得杀掉测试开始前已经存在的用户 agent。
- 手机端 E2E 默认使用窄屏 viewport；只有需要排查 touch-specific 问题时才设置 `FARMING_E2E_TOUCH=1`。

### 3. 开发调试

```bash
# 查看服务器日志
tail -f server.log

# 检查当前 agent 状态（需要服务器运行）
# 使用浏览器开发者工具，在控制台查看 WebSocket 消息
```

---

## 常见问题

### Q: Main Agent 验证失败怎么办？

A: 检查进程是否满足 tty 要求：
1. 进程能成功启动
2. 进程能持续运行超过 2 秒
3. 如果失败，提示用户"Process must stay alive (interactive tty required)"

### Q: 远端部署地址为什么是 `/farming?token=...`？

A:
1. `/farming` 作为固定 base path，避免服务直接暴露在端口根路径
2. token 会保留在地址栏里，方便用户复制保存到其他设备；启动时按 `FARMING_TOKEN_LOCALE=auto` 根据时区生成中文俳句、日文俳句或英文 passphrase，长度短于旧十六进制串
3. HTTP 请求仍会写入 `farming_token` Cookie，WebSocket 也会优先从 URL query 读取 token 兜底

### Q: 如何处理僵尸进程？

A: 
1. Main Agent 心跳检测每 3 秒检查一次
2. 如果进程已退出，标记为 'dead'
3. 前端检测到 'dead' 状态，弹出对话框让用户重新启动 Main Agent
4. 其他 agent 不受影响，新 Main Agent 接管管理

### Q: 如何添加新的 UI 主题？

A:
1. 在 `frontend/themes/` 下创建新目录（如 `frontend/themes/mytheme/`）
2. 创建 `theme.json` 配置文件：
   ```json
   {
     "name": "mytheme",
     "displayName": "My Theme",
     "description": "Theme description",
     "version": "2",
     "author": "Your Name",
     "features": {
       "scanlines": false,
       "screenCurve": false,
       "textGlow": false
     },
     "colors": {
       "background": "#000000",
       "foreground": "#ffffff",
       "primary": "#00ff00",
       "secondary": "#00ffff",
       "warning": "#ff8800",
       "error": "#ff0000",
       "info": "#0088ff"
     }
   }
   ```
3. 创建 `style.css` 样式文件（完整的主题样式）
4. 重启服务器，新主题会自动被识别
5. 当前 Code-style 前端不通过 Settings 切换主题；主题切换使用配置文件或主题 API

**主题系统架构**：
- `backend/theme-manager.js` - 主题管理器，自动扫描 `frontend/themes/` 目录
- `backend/config-manager.js` - 存储用户选择的主题
- `frontend/theme-loader.js` - 前端主题加载器
- `GET /api/themes` - 获取所有可用主题
- `POST /api/themes/:id/set` - 设置当前主题

**注意事项**：
- 主题必须包含完整的 CSS，覆盖所有组件样式
- 主题切换可能需要重新加载页面
- 主题名称必须与目录名一致

### Q: 如何扩展新的 Agent 类型？

A:
1. 在 agent-manager.js 添加新的启动逻辑
2. 实现进程验证和监控
3. 添加测试用例
4. 更新文档

---

## 注意事项

### ⚠️ 重要提醒

1. **不要修改用户已确认的设计哲学**，除非有充分理由
2. **不要忽略文档更新**，代码变化必须同步文档
3. **不要过度设计**，一期原型优先简单可用
4. **不要破坏测试**，所有测试必须通过

### ✅ 最佳实践

1. **小步迭代**：每次改动小，易于验证
2. **快速反馈**：改动后立即测试
3. **文档先行**：复杂功能先更新文档
4. **用户视角**：始终从用户体验出发

---

## 联系方式

- 项目仓库：按实际发布渠道配置
- 产品介绍：[docs/products/code/README.md](./docs/products/code/README.md)
- CRT 皮肤文档：[docs/products/crt/README.md](./docs/products/crt/README.md)

---

**欢迎 AI Agent 参与开发！让我们一起打造更好的 AI Agent UI 产品。**
