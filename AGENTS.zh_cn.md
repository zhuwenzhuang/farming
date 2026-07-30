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

面向多个 Agent 同时运行时的进度观察、介入和管理，帮助用户区分长期与短期任务、热点与低活动任务。

### 产品构成

- **内核**：一套 AI Agent 的使用方法论
- **架构**：前后端分离，后端提供共享能力，前端支持多个独立浏览器皮肤
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

代码库结构或行为变化时，只更新与变化相关的文档：

- `README.md`：面向用户的产品总览、主要安装方式与首次使用入口
- `AGENTS.md`：面向 Agent 和贡献者的开发边界与工程约束
- `docs/products/*`：具体产品的设计、架构与验证说明

README 是产品入口，不是实现历史。只有顶层产品承诺、主要安装方式或首次使用路径发生变化时才更新；状态机、Cache Directory、依赖准备、Bug 修复细节和发布记录不得堆入 README，应放在对应的产品文档、工程指南或 Release Notes。

`docs/README.md` 是公开文档入口，只直接链接真实的任务页和产品页。只有已有足够内容、
确实值得多一层导航时，才新增分类页。每个 `docs/products/*/README.md` 都只是简短的
产品入口页，不是完整设计记录。

**对话记录更新边界：**

- `conversation-log.md` 已迁入内部归档分支，当前工作树不再维护公开对话记录文件
- 普通问答、临时排查、实现过程记录和日常状态同步不写入公开文档
- 重要产品、架构或交互设计决策同步到面向对应读者的 `AGENTS.md` 或 `docs/products/*`；只有顶层产品承诺、主要安装方式或首次使用路径才进入 `README.md`

新增模块、调整架构、更新依赖或测试结构并不自动触发 README 修改；应先判断哪份文档真正面向这项变化的读者。

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

- **统一类型门禁**：`npm run typecheck` 必须同时检查 React 前端、由 `tsconfig.backend-runtime.json` 管理的严格后端与 Browser Resource TypeScript、由 `tsconfig.backend.json` 管理的剩余后端 checked JavaScript、逐文件检查的 classic browser TypeScript、共享协议 TypeScript、构建脚本 TypeScript、由 `tsconfig.tests.json` 管理的后端测试结构类型，以及 usage scanner。后端和 Browser Resource runtime 权威源码使用 `.cts`，领域类型与实现放在一起，删除被替代的 `.js`，运行时只加载生成的 `.cjs`；`npm run build:backend-runtime` 生成这些 CommonJS 产物。classic browser 与共享协议权威源码使用 `.ts`，`npm run build:classic-runtime` 在不破坏 UMD/global 行为的前提下生成原路径 `.js` 兼容产物。后端测试使用 `.ts` 并始终纳入测试类型门禁；动态测试夹具可以使用独立于生产 runtime 严格配置的测试配置，但不能绕过检查。发行包携带运行时 JavaScript，不直接执行 TypeScript。不能为了让门禁变绿而给文件加 `@ts-nocheck`，也不能用 `any` 替换领域类型。
- **核心功能必须有测试**：Main Agent 验证、心跳检测、状态同步等
- **后端测试位置**：`backend/tests/` 目录
- **展示效果 E2E 位置**：`tests/e2e/` 目录，使用 Playwright Test 覆盖真实页面、真实 WebSocket / native pty session / xterm.js terminal 渲染链路
- **测试命名**：`test-[功能].ts`
- **E2E 命名**：`*.spec.ts`
- **测试覆盖**：每个核心功能至少有一个测试用例
- **复杂真实场景优先**：简单合成夹具只用于首轮 Smoke。非平凡 UI 或运行时改动进入验收前，必须选取信息丰富的真实或生产形态场景，组合覆盖相关界面与状态，例如长 Agent 对话、工具过程、Markdown、代码、图片、实时 xterm 输出、主题切换和生命周期转换。优先用少量有代表性的复杂场景暴露交互问题，而不是堆积互不关联的玩具 case；发现的每个缺陷仍需补充可重复的确定性回归测试。
- **Codex ACP patch 能力**：锁定版本的 patch 必须同时声明审阅过的 `_codex/session/steer` 扩展，以及由 Codex `thread/fork` 支撑的标准 `session/fork`；任一协商能力消失时发行 Smoke 必须失败
- **ACP 子进程持有的 Fork**：当 provider 的 Fork Session 在子会话第一次 Prompt 前只存在于创建它的 adapter 进程时，必须让新的子 Agent 在自己的隔离 adapter 中加载经过 revision fence 的源 Session、执行 Fork、关闭该进程临时加载的源 Session，并继续承载精确的子 Session 身份。启动时还必须私下传递经过 fence 的精确 binding checkpoint（包括有界的子会话 transcript 与已提交的 patch decision），并在 Fork 成功后以返回的子 Session 身份安装它，避免 provider replay 延迟把用户点击时的 transcript revision 替换掉或丢失工具状态。第一次 Prompt 前若进程丢失，必须显式失败而不能静默重新 Fork；启动回滚也必须先证明子进程已经停止，才能删除精确 Fork 身份；provider 删除失败时则必须保留并报告该精确身份，供操作者清理，不能只返回不含身份的通用错误
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
- **应用内更新只支持 npm 安装**：源码、App Bundle 与独立 CLI 安装使用各自的手动部署路径；Server 不得把 GitHub Releases 当作更新源
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

新的交互式 agent 默认由 `NativeSessionEngine` 托管，node-pty 进程运行在独立 native pty host 中，Farming 服务重启后通过本地 socket 重新挂回仍存活的 terminal。Farming Server 采用 crash-only 生命周期：SIGINT 和 SIGTERM 保持立即退出语义，不能安装调用 `AgentManager.dispose()`、等待 Agent Operation 或发布半关停状态的 Server Signal Handler。人工停止、部署重启和升级都先校验精确 Server Process Identity，再发送 SIGKILL，只等待进程退出与端口释放。Signal 返回 `EPERM` 或 `EACCES` 说明进程可能仍存在：此时不得修改包目录，必须提示用户由拥有该进程的系统账号或管理员重启 Farming 后再重试升级。正确性由启动恢复和对账负责，而不是退出前 Drain。活跃 Provider Turn 可以被中断并由 Provider 自己 Resume；Farming 只持久化并恢复 Farming 自有状态。native pty host 默认会跨 Farming server 进程丢失保留；当没有 live session 和 client 后会在空闲宽限期后退出。server 与 host 连接时必须交换 runtime 代码指纹；应用升级或指纹不一致时执行 Transactional Controlled Rotation：阻止新 Mutation，Drain 并 Freeze Reducer 的精确状态切面，序列化所有仍为 Live 的 Terminal，只有携带匹配 Preparation Token 才能关闭旧 Host，并在新 PTY Epoch 中恢复序列化 Screen。序列化失败必须恢复旧 Host 并终止轮换；已经接受用户输入但还没有精确 provider Session ID 的 Codex Terminal 同样不可重启，此时必须终止轮换并恢复旧 Host，不能在同一个 `agent_*` 记录下启动全新的 Codex 进程。Host 意外崩溃属于进程丢失，不能伪装成成功恢复。过时 Host 只能在共享 Socket 路径仍指向它自己的 Active Listener 时删除该路径；同一 Config 的启动或关闭发生重叠时，绝不能删除 Replacement Host 的 Socket。每个 Host 保留一个 Private Listener 路径；重新连接的 Server 只有在恰好找到一个匹配的 Live Private Listener 时才能恢复缺失的公开链接，多个匹配项必须显式失败，不能任意选择。只有希望 host 在每次 server 进程丢失后退出时才设置 `FARMING_NATIVE_PTY_HOST_PERSIST=0`。`LocalSessionEngine` 仅保留为 `FARMING_SESSION_ENGINE=local` 调试路径；产品 runtime 工作应面向 native pty host。

Browser Resource 模块位于 `extensions/browser`，默认关闭。Browser 在 ACP Session 创建边界已启用时，Farming 会通过 Provider Adapter 自动投影完整的 `browser_*` MCP Tool Catalog；Terminal 仍通过 CLI 按需访问。它唯一受支持的操作与 Viewer Runtime，是 Farming 启动依赖 Manifest 声明的精确版本 `agent-browser`。Farming 不得用原生 CDP 重写 Browser Automation，不得把 Playwright 或 Puppeteer 加入生产包，不得把 Chromium 随发行包交付，也不得加入 WebDriver 或保留静默的第二套实现。全新 Server 打开端口前，Farming Launcher 必须始终准备并使用已校验的不可变 `agent-browser` Cache 条目，不得复用或回退到系统安装。Chromium 是独立的显式可选依赖：普通安装、更新和启动绝不能下载它。只有用户在**插件 → 浏览器**中显式操作，才能开始受管 Chromium 安装。该操作并发探测经过审查的 Google Chrome for Testing 与 npmmirror Endpoint，按有界延迟排列可用源，并在一个源明确失败后继续下一个。Google 路径调用锁定版本的 `agent-browser install`；镜像路径直接下载匹配平台的 Archive。两条路径都使用 `<config-dir>/runtimes/chromium/<agent-browser-version>/<platform>/` 下的 Staging Directory 并重定向 HOME 与 XDG Path，绝不能调用 `--with-deps` 或修改全局系统 Package。受管 Chromium 安装只有一套权威 `absent -> installing -> ready | failed` 状态机；旧版本有效而当前版本缺失时派生 `updateAvailable`，并发请求必须合并，跨 Server 通过 Config-scoped Lock 串行，并且只有找到精确 Executable 且成功执行版本检查后才能原子发布。超时或无法证明 Installer Process 已退出时，必须保留 Ownership 证据，不能删除仍可能被写入的文件；只有证明 Installer 已退出后才能回收遗留 Staging。浏览器来源必须在**插件 → 浏览器**中选择，而不是要求用户配置启动环境；用户可以选择已发现的兼容 Chromium Executable、与当前 `agent-browser` 版本匹配的 Farming 受管 Chromium，或填写外部回环 CDP Endpoint；自动选择优先使用可用的系统 Executable，再使用已安装的受管 Chromium。切换来源时，必须先校验目标配置，停止所有由 Farming 拥有且正在运行的 Browser，清理成功后才提交新设置；清理失败时保留旧选择。Local Resource 由 Farming 把选中的 Chromium Executable 与隔离 Profile 交给 `agent-browser`；Farming 不再保留独立的 Chromium Launcher 或 Process Gate 实现。External Resource 则由 `agent-browser` 连接插件中选择的用户或 Agent 管理 Endpoint。外部 Endpoint 只允许回环地址；浏览器在另一台机器时由用户自行建立 Tunnel。Farming 不得访问 Docker Socket、选择或拉取镜像、管理容器、在受鉴权的插件设置界面之外暴露 Endpoint，也不得关闭外部 Owner 的浏览器进程。同一 Agent 与 Browser Source 下的 Resource 是一个共享 `agent-browser` Session 中的多个带标签 Tab。Local Session 拥有 Chromium Process 与隔离 Profile；External Session 只拥有连接与带标签 Tab，浏览器、容器、Profile 与 Endpoint 生命周期归外部 Owner。过期 Viewer Generation 必须被拒绝；受鉴权保护的 Viewer 代理 Runtime 的 JPEG WebSocket Stream，并把 Pointer、Keyboard、Wheel 与 Viewport Input 映射回同一个 Session。Browser Action 与 Runtime Command 都必须串行；Stop 先关闭新接收、排空已接收的有界 Action，再关闭对应 Tab；关闭最后一个 Tab 才关闭 Session，但绝不能关闭外部浏览器进程。支持的 Agent Surface 覆盖导航/等待、DOM 交互、结构化检查/JavaScript、Console/Error/Network 证据、Cookie/Storage、Frame/Dialog 和 Project 级 Upload/Download；Tab 映射为独立 Farming Browser Resource。Codex、Claude Code、OpenCode 和 Qoder 启动时从 `backend/farming-agent-bootstrap.zh_cn.md` 注入 Farming Bootstrap，并通过 `farming capabilities` 查询实时能力。已启用的 Browser Capability 还会自动投影到新建的 ACP Session；`farming browser` 是 Terminal 按需操作同一 Browser Identity 的 Bridge，`farming browser mcp` 是 Provider Adapter 与显式手工集成使用的 stdio Transport，`farming-browser` 只是 npm Bin 别名。CLI 发现必须保持渐进式：Farming 全局 Help 只披露 Browser 入口，Browser 顶层 Help 只披露起点和 Topic，Topic Help 展开一个能力域，只有 Command Help 才披露精确参数。

Terminal 展示恢复使用带 checkpoint 的状态机协议。native pty host 中的 headless xterm 是唯一权威归约器：每次 PTY 运行都有唯一 epoch；Output Transition 同时推进 `outputSeq` 和 `stateRevision`，Clear / Resize 只推进 `stateRevision`。序列化 checkpoint 必须携带该归约器实际提交的 epoch、序号、screen 与尺寸。WebSocket 合并不能抹掉单个 Transition 的索引；浏览器逐条校验合并消息里的索引，但把连续的 Output / Clear 作为一次 xterm Write Batch 提交。Resize 仍是有序的批次边界；提交后，浏览器等待后续重画短暂且有界地静默，再一次绘制整个 Burst，避免全屏 TUI 重画被逐块暴露。浏览器只允许在当前 epoch 上应用下一条连续 Transition；重复消息直接忽略，序号缺口、epoch 变化、页面隐藏恢复或断线重连都必须先安装权威 `/session-view` checkpoint，再继续归约 live output。禁止轮询 `/session-view`；Transport Failure 使用 Backoff 重试，重复响应持续违反同一 Checkpoint 不变量时必须停止并显式报错。已知落后于 Replay Target 的 Checkpoint 不得进入可见画面；安装完整 Checkpoint 时应抑制 xterm 的增量绘制，恢复过程一次显示最新 Screen，而不是重播历史。PTY 退出时必须等待 250 ms 尾部数据静默窗口、Drain Reducer，并保存精确 Final Checkpoint；若最终切面缺失或不精确，必须显式报告致命状态证明失败，不能把 Raw Output 伪装成权威 Screen。

Terminal 的浏览器 Attachment 是所有权状态机，不是 React Effect 生命周期。它的身份严格由 Agent id 与 Mount Element 组成。Effect Cleanup 先进入以一个 Microtask 为界的 `release-pending`；同一 Owner 立即重新获取时取消释放，不得 Detach、推进 Attachment Generation 或进入 Checkpoint Recovery。Agent 或 Mount 变化时先释放旧 Owner 再挂载新 Owner，旧 Lease 不能释放更新的 Owner。Session Pool 边界收到同一 Owner 的重复调用时也必须幂等。Callback、输入开关、光标抑制和 Bootstrap 数据属于独立更新的 Live Options，不能参与 Attachment 所有权。

Terminal Input 保持直接的 Raw PTY Stream：不要增加逐输入 ACK、去重、自动重放，也不要在 xterm `onData` 外增加按时间猜测的 Textarea Fallback。多个 Code / CRT Viewer 共享同一份权威 Display，并且都可以输入；AgentManager 的输入队列按服务端到达顺序串行写入 PTY。浏览器侧不再存在 Controller Lease、Takeover UI、Renderer ACK 协议，也暂不展示 Viewer 数量。传输结果不确定时不得自动重放 Input。Geometry 只表示 Display Dimensions（`cols` 与 `rows`）。所有由浏览器 Layout 触发的 Geometry 变化都必须以完整 `cols + rows` 为单位做尾部合并，使一次持续窗口拖动不会反复触发 xterm Reflow 和全屏 TUI 重画。不能再按 Renderer Buffer 类型或 Output 长度分支这套行为，因为 TUI Alternate Screen 会让这种分类失真。显式 Attach、Recovery 与 Force Fit 仍然立即执行。后端最多保留一个 In-flight Resize 和一个 Latest Pending Size。只有 Reducer Backlog 可以通过 High / Low Watermark 暂停 PTY；慢浏览器应由 WebSocket Backpressure 单独隔离，不能冻结共享 PTY。Native PTY Host 的 Controller Generation 仍作为服务端进程切换边界：先关闭旧 Admission，Drain 已经接收的 Mutation，再发布新 Server Generation；它不是浏览器 Ownership。

浏览器可见的 Agent 状态有四个明确领域边界。`runtimeBinding` 是带标签的 Runtime 契约（`terminal`、`acp` 或 `json`）；旧的扁平 Runtime 字段只作为后端内部持久化兼容形态，不能重新泄漏给客户端或新增业务代码。持久化的实验性 Codex `app-server` binding 必须在此边界迁移为 ACP，绝不能重启 App Server 进程。`runtimeObservation` 是后端唯一维护的当前 Runtime 分类，供 UI 消费；前端不得再从 Terminal 文本重复推断，Server 停止、重启或升级也不得把它用作 Lifecycle Guard。Provider 专属的可执行文件、Session 规划、Runtime 支持、Home 环境与规范化 Capability 必须进入 `ProviderAdapter`，通用 Lifecycle/UI 只能读取 Capability，不能维护 Provider 名单。Project Files 的 HTTP API 使用 `WorkspaceRoot.rootId`，旧 `agentId` 仅为读取兼容 Adapter。Code 与 CRT WebSocket 在处理消息前必须协商并校验共享版本化浏览器协议。WebSocket ping/pong 只证明传输存活，可以用于终止死连接；用户可见的后端健康状态必须来自一个有界的 request/ack，并完整经过浏览器协议校验、正常消息分发、启动恢复以及 AgentManager 权威状态读取。Terminal Input 继续明确排除在命令 ACK/重放语义之外。

Agent 的 Create、Update、Delete、Archive 与 Fork 使用私有 `agent_*` 元数据记录中的 Lifecycle Journal 作为 Write-ahead 元数据历史。必须先持久化操作意图，再执行外部副作用，并在最后持久化终态；冲突操作只能串行等待或加入同一操作，所有外部 Mutation 都要等待启动恢复结束。Runtime 已确认的 Create 先进入 `membership-pending`，再提交首页 Membership。Fork request id 持久化在源 Agent，子 Agent 私有记录保留同一 request id；响应丢失时只能从唯一匹配子记录对账。Codex Archive 在 `provider-archive-pending` 阶段仍未终结；Provider 失败必须保持 blocked 并允许重试，不能在本地成功后只写日志。重启恢复负责消费未到终态的 Journal，不能启动重复 Runtime。ACP 进程只有在精确 Process Group Identity 已持久化后才能越过启动 Gate，清理时必须证明该 Identity 已退出。升级恢复必须兼容尚未持久化 Process Identity 的旧 ACP 记录：新 Farming Server 接管启动后，应通过正常 ACP Load 路径恢复其精确 Provider Session，不能要求用户逐个确认。新启动的 ACP 进程必须立即持久化后续清理所需的精确 Process Group Identity。JSON CLI Chat 只保留只读的旧兼容路径：不能再声明为受支持 Runtime，也不能接受新的 JSON Agent Create 或切换目标。

浏览器 HTTP 命令使用局部 Admission 与请求 Ownership，不建立共享事务框架：第一次异步边界之前捕获 Agent、Workspace Root、文件、Dialog 打开 generation 或 Session generation，只有同一个 Owner 才能提交 Loading、数据、焦点或错误。首页 Provider Session membership 只能通过原子 add/remove 命令修改；通用 Settings 写接口必须拒绝这一兼容投影，Settings 客户端只提交实际变化字段。永久 Worktree Create 与 Farming Worktree Delete 把有界私有 Operation 存在拥有 Project Membership 的同一份 Settings Snapshot 中；Git 结果必须用精确目录、Branch 与 `git worktree list --porcelain` 对账，终态和 Membership 在同一 Snapshot 提交，UNKNOWN 绝不自动重放。后端长转换在对应资源 Owner 上串行：Review Refresh 按 Review ID，Codex Archive/Unarchive 按 Agent Home 与 Provider Session，Worktree 删除按 canonical Workspace。删除 Worktree 时只关闭目标 Workspace 的新启动、有界 Drain 该 Workspace 已接纳的启动、证明所有 Agent 已停止，最后才删除目录。Workspace Watcher 初始化和每条 WebSocket Watch 命令都使用 Single-flight Ownership；被取消、断连或替换的初始化即使已经创建 Watcher 或订阅，也必须先关闭，不能发布到 Map。

Project Files 使用“文件系统权威 + 乐观工作副本”模型。浏览器草稿携带单调递增的 revision；一次进行中的保存只有在该 revision 仍是当前版本时才能把工作副本标记为 clean，否则只能更新磁盘基线，并把更新后的草稿继续保留为 dirty。Dirty 草稿经过短暂 debounce 后写入有界的浏览器本地备份，并在 page hide 时强制落盘；再次打开同一文件时恢复该草稿，如果磁盘已经是相同内容则直接清理为 clean。后端按规范化 workspace 串行执行修改，在队列内重新校验文件内容版本，以唯一名称独占创建临时文件，close 前尝试 `datasync`，写完后再原子 rename 到目标；相同期望内容的重复保存可重入。目录项携带由文件系统元数据派生的 version，rename、move、delete 可以要求该版本仍然匹配；新建文件使用 create-if-absent。浏览器 Create、Rename 和 Delete 在开始时捕获单调 generation，并在发起请求前同步占住它，因此连续 Enter 或点击不能重复提交同一次操作。取消、被新操作替代、Files 根身份变化或组件卸载只会撤销旧 generation 的 UI 所有权；迟到响应仍可刷新它的权威目录并传播已经证明的 move/delete 效果，但不得清理新 UI、展示旧错误、打开文件或抢焦点。Mutation 请求等待 15 秒后停止并把超时视为结果不确定；收敛必须使用新的有界权威读取，绝不能自动重放 mutation。重读权威父目录后，Create 只有在精确预期路径已经存在且类型与请求一致时才能收敛为成功；Delete 可以在源对象已不存在时收敛为成功；Rename 可以在源对象已不存在且预期的同类型目标已经存在时收敛为成功。这只证明文件系统当前已达到期望状态，不证明是哪一个进程完成了操作。Watcher 永远只作为失效提示，不能成为权威状态。上述保证只覆盖同一 Farming 服务进程发起的操作；其他 Farming 服务与任意外部写入者都是串行域外的普通独立文件系统客户端，必须依靠冲突检测和重新读取文件系统收敛，不能宣称跨进程事务、exactly-once 操作归因或断电持久性。`datasync` 只是 best-effort，父目录不会执行 sync。

常规的单 Agent Terminal 元数据变化必须走协议白名单限定的 `agent-update` Patch，不得广播完整 Workspace State。该 Patch 通道对任意 Agent 字段关闭，只允许 Terminal Input、Shell 状态、Terminal 状态与 Runtime Observation 元数据；重连和首次 Hydration 仍使用权威完整 State。

Code 与 CRT 的产品 Terminal 统一使用 xterm.js WebGL Renderer，并且只支持这一条渲染路径。WebGL 初始化失败或不可恢复的 Context Loss 必须显式停止并报错，不能在 Live Terminal 中静默切换到 DOM Renderer。Ghostty Web 只作为显式 Debug Renderer 存在，不是产品 Fallback。

对于 Codex、Claude Code、OpenCode 和 Qoder，Farming Code 的结构化 Chat runtime 使用 ACP。Codex 以锁定版本的 `@agentclientprotocol/codex-acp` 作为唯一结构化 Chat 主链路，并通过一份小型、版本锁定的 Farming patch 声明 `_codex/session/steer`，再转发到 Codex `turn/steer`；Codex 差异只能停留在这个 adapter 边界，不能形成第二套生命周期或 UI。打包前必须 fail-closed 地应用 patch，把审阅过的 adapter 复制为同时锁定版本和 SHA-256 的发行运行时产物；运行时只启动该产物，不得修改已安装依赖。单文件 CLI 自身不是通用 Node 解释器，因此必须通过内部进程入口打包同一份 adapter；原生产物 Smoke 必须经过该入口完成 ACP `initialize` 握手。上游提供等价的可协商 ACP 能力后应删除 patch。Chat / Terminal 控件会把 Agent 重启到 ACP 或 native PTY runtime，并恢复同一个 provider Session；它不是单纯切换画面。新建 OpenCode Terminal 时，先通过一次性 ACP `session/new` 创建 provider Session，校验并持久化返回的稳定 ID，再让 native PTY runtime 使用这个精确 ID 恢复启动。唯一标识创建或一次性进程清理失败时必须显式终止 Terminal 启动。回滚时必须先证明一次性 ACP 进程树已经退出，然后才能删除精确 provider Session；如果无法证明进程退出，就保留私有精确 ID 而不删除，若删除本身失败则携带该 ID 供生命周期所有者安全重试。Terminal 创建报错属于结果不明确：必须先按 ID 幂等停止 runtime，并确认 engine 报告 Session 已退出或不存在，然后才能删除 provider Session。新建 Codex Terminal 则直接启动 native PTY，并暂时使用关联 ID，因为 Codex 不会在 `session/new` 时立即持久化新 rollout。稳定的 Farming `agent_*` 记录负责 Project 归属、置顶、标题与恢复元数据，临时 provider ID 不负责这些状态，也不得进入首页 provider Session 成员关系；native host 恢复临时 Agent 时，必须使用 `agent_*` 的 `visibleOnMainPage` 意图，不能重新构造临时 provider key。只有 provider History 在有界启动窗口内返回唯一一个同 Agent Home、canonical Workspace、具有可信 `createdAt` 且尚未被占用的候选项时，Farming 才能把临时 Codex ID 替换为精确 ID；时间只用于限定候选资格，绝不能按时间挑“最近”的一个。提交绑定时还必须同步复查占用关系，防止并发 Agent 抢到同一个 rollout。存在歧义、仅关联 Git worktree、过旧、只有 `updatedAt` 或位于未来窗口之外的候选时，必须继续保留临时 ID，且绝不能使用 `--last`。确认精确 provider ID 后，要把它映射到原来的 `agent_*` 记录，并用于 runtime 切换、Fork 与恢复。仍带临时 ID 且尚未收到用户输入的 Terminal，可以直接切换成新的 ACP Chat；Fork 必须等待精确 provider ID。提交用户 Terminal 输入时，要在等待 PTY 返回前先记录“已使用”，因为响应失败不能证明 PTY 没有收到输入。一旦 Terminal 已经提交过输入，Chat、权限重启和 Fork 都必须保留可恢复 Session 校验，不能因历史缺失或候选歧义而静默丢掉对话。标准 ACP `additionalDirectories` 与 `mcpServers` 属于 Session 启动边界，必须跨 runtime replacement 与恢复保留，且不得进入浏览器可见 Agent state；若需持久化，只能写入私有 Session 记录。出站媒体只有在实时 Agent 声明对应 prompt capability 时才能原生发送，否则必须提供明确可读的降级。旧 JSON CLI Chat 只保留兼容读取。

Codex steer 一旦被接受，就属于 Farming 自己负责的 transcript 状态转换，不能依赖 adapter 是否回显。精确 steer 请求成功后，ACP runtime 使用生成的 client message id，把用户内容记录在该请求被接纳时对应的位置；adapter 回显若早于响应到达，则阻止本地重复插入，若晚于响应到达，则按同一个 id 与本地 optimistic entry 对账。被拒绝或结果不明确的 steer 不能生成这条已接受 transcript entry。

发行包携带审阅过的精确 Codex 与 Claude ACP JavaScript Runtime，但不得携带 `@openai/codex-*` 或 `@anthropic-ai/claude-agent-sdk-*` 传递引入的平台 Agent CLI。Codex CLI、Claude Code CLI 与 `agent-browser` 都是启动依赖，而不是生产 Package 依赖。一份随版本检入的 Manifest 根据精确的 package-lock 记录固定每个支持平台的 Artifact、来源 URL、Integrity、Executable Entry 与预期版本。启动 Artifact 必须来自公共 npm Registry Tarball；不支持直接使用 GitHub 或厂商 Release URL。安装与更新准备必须在旧 Server 仍运行时下载、校验、Staging 并原子启用缺失的 Cache 条目，成功后才可进入重启窗口；没有独立准备阶段的全新安装可以在第一次启动前完成同样工作。每次 Server 启动都必须在打开端口前重新校验精确 Cache，并可把缺失或损坏条目作为安全门修复，但正常升级不得把下载推迟到停机后的重启窗口。全新 Launcher 可以复用版本精确匹配的系统 Codex 或 Claude Executable；`agent-browser` 必须始终从锁定的 npm Package 提取到 Farming 已校验的不可变 Cache 并从那里启动。准备完成的环境通过 `CODEX_PATH`、`CLAUDE_CODE_EXECUTABLE` 与 `FARMING_AGENT_BROWSER_BIN` 交给运行时。并发准备共用一把锁；损坏 Cache 不得成为 Active；准备失败必须让当前 Server 与 Package 保持不变并返回可操作错误。npm、Bundle 与源码部署必须在停止旧 Server 前执行新版本自己的依赖准备，成功后才可进入 `ready-to-restart`。只有新 Server 已经成功监听后，才能清理其 Active Manifest 未选中的依赖 Cache；清理失败必须可见，但不能把健康的 Server 启动改判为失败。Package Smoke 必须证明 Release 中不存在平台包时，两份 Vendored Adapter 仍能完成 ACP `initialize`。

实时 Codex Terminal 的模型修改必须跟随 CLI 实际渲染的 `/model` 与推理菜单，并在放行后续 Composer 输入前确认底部状态。不要用固定延时自动操作 TUI，也不要假设模型目录索引等同于可见菜单索引。`/fast on|off` 是非交互命令：完整输入被 PTY 接受后立即放行后续 Terminal 输入，确认过程在输入队列之外继续。当前 runtime 目录未宣告 Fast / Ultra 时，控件保持可见但禁用。

ACP 历史重放和实时更新必须归约到同一条有序 entry stream，不要在后端为 ACP 重建 `Turn -> Item` 模型。面向用户的结果/过程分组属于 ACP 前端的注意力投影：必须可逆、保留 entry 顺序与 tool 详情，并在不删除可见 automation 通知的前提下隐藏 Codex 内部 heartbeat/context 活动。

Provider adapter 必须把 provider 历史转换成标准 ACP content block。Farming reducer 不得重新打开 provider rollout JSONL 来重建 transcript 正文或媒体；provider 未提供的内容必须明确保持不可用。直接解析 provider 历史只允许用于有界的元信息发现或 usage 统计，直到有权威 provider API 可以替代。

Codex 协作活动是证据，不是子 Agent 生命周期状态。锁定版本的 adapter 负责通过 app-server spawn-edge 查询与权威子 turn 结果对账全部后代，再发布带版本的 snapshot/delta metadata 供 Farming reducer checkpoint。前端可以把 `subAgentActivity` 放进对应子 Agent 的折叠区，但绝不能根据活动动词或父 tool-call 完成来推断子 Agent 正在运行、已完成、已中断或失败。

Farming Code 必须把“已打开 Agent”的逻辑顺序与有界前端视图缓存分开。Chat DOM 和池化 xterm 共用一份最多二十个 Agent 的 LRU 工作集：激活 Agent 会把它移到最近使用端，当前活跃 Agent 绝不能被逐出；打开第二十一个需要保留的视图时，只释放最久未使用的非活跃 Chat DOM 或 xterm 实例，不停止后端 ACP 或 PTY 进程。在缓存命中的 Agent 之间切换，或暂时打开 Search、History、文件时，只隐藏而不逐出这些视图。命中的 Chat 先展示原 transcript 与阅读状态，再按 revision 校准 ACP 增量；被逐出的 Chat 重新加载权威 transcript，被逐出的 Terminal 从权威 session-view checkpoint 重建。关闭、归档或终止 Agent 时立即移除视图，runtime replacement 则映射保留身份。

ACP transcript 对账绝不能清空或回退已经可见的内容。每次前端读取都持有单调递增的 request generation，只有最新 generation 才能修改 transcript、loading 或 error 状态。同一个 provider Session 内，响应 revision 低于当前已展示 revision 时，即使 HTTP 请求成功完成，也必须把它视为过期响应并忽略；刷新和重连在对账期间必须继续展示当前 transcript。

ACP 只有在 Farming reducer checkpoint 已精确且原子落盘，并且 provider、Agent Home、Session、工作区与 provider 新鲜度仍一致时，才可以跳过完整 `session/load`。发送 prompt 前必须先把 checkpoint fence 为 dirty；缺失、dirty、过期、损坏或无法校验的状态必须明确进入有界 load/repair 路径。Transcript 页面只携带紧凑有序 tool envelope，准确 raw tool detail 仍由后端持有，并按 tool-call id 懒加载。外置 Transcript 媒体必须由客户端显式协商，并使用可安全滚动升级的不可变内容寻址 URL；过期 identity 必须 fail-closed。只有只读 Transcript GET 的传输失败可以做有界自动重试，绝不能重放 prompt、终端输入或任何其他写操作。

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

`backend/data/runtime-dependency-sources.json` 随发行包提供一个默认可选的 HTTPS 公共 npm 镜像，并保留权威 Registry。准备阶段只做一次有界的精确版本元数据查询：镜像记录的版本与 SRI都相同时才采用其下载 URL，否则使用权威 URL；后续镜像下载失败也会改从权威 URL 重试。`FARMING_RUNTIME_NPM_MIRROR` 可以覆盖包内候选，或设为 `off` 关闭镜像。镜像配置必须独立于不可变 Runtime Manifest，修改候选来源不能导致已校验 Cache 失效。不要加入延迟测速、竞速或持久化镜像选择状态。

Qwen Code 与其他受支持的 Coding Agent 共用由 ProviderAdapter 管理的 ACP Chat 与 Terminal 生命周期。它使用系统 `qwen` Executable 和 `QWEN_HOME`，注入 Farming Bootstrap，只扫描 `projects/*/chats` 下可恢复的根 Transcript；在实时 ACP Agent 协商出标准 `session/fork` 之前，不得宣称支持 Fork。

当前 Browser Ownership 与 Capability Projection 规则取代前文旧的 Project 共享和按需 MCP 表述：Agent 打开的 Browser 归属于稳定的 Farming Agent Record，`projectRootId` 只保留为 Workspace 隔离边界。同一 Agent、同一 Browser Source 的多个 Browser 可以作为独立 Tab 共享一个 `agent-browser` Session；不同 Agent 绝不能共享该 Session、Profile、Cookie 或 Storage。Chat/Terminal Runtime 切换保留 Browser Resource；停止或归档 Agent 会停止其 Browser Runtime，但保留 Row 与 Profile以便按需恢复；删除 Agent 会停止并删除精确归属的 Resource 与 Profile。侧栏默认把 Resource 隐藏在 **Agent → Resources → Browsers** 下；展开或收起任一层都不能改变 Runtime 或 Viewer 状态，没有 Resource 的 Agent 不显示按钮或 `0`。Browser 在 ACP Session 创建边界已启用时，Codex、Claude Code、OpenCode 与 Qoder 通过现有 Provider Adapter 获得完整且细粒度的 `browser_*` MCP Tool Catalog；`browser_open` 创建、挂载并启动 Agent-owned Resource。Terminal Agent 通过渐进披露的 `farming browser` CLI 访问同一份 Contract。ACP Session 启动后才启用 Browser 时，必须明确重启 Chat Runtime 后才能声明这些 Tool 可用。每次 Agent 操作都必须校验精确 Owner、Project Root、Resource Generation、Session Generation、Tab ID 与 Running State；过期调用明确失败。旧 Project-owned Row 可以继续持久化并作为 Project Resource 展示，但新的 Agent Workflow 不会静默共享它们。Browser 直接使用 Provider 的 Agent Session 权限模式，不再增加独立的插件权限策略。Provider 发起询问且用户为当前 Session 允许某个 Browser 请求后，Farming 会复用该授权，避免同一 Origin 上的后续 Browser Tool 重复询问；新 Origin 仍会再次询问。Provider 的 Full access / skip-permissions 可以跳过普通 Browser 批准。当前 Agent 的 Chat 可以固定尺寸叠放最新运行 Browser 的轻量只读预览；该预览只允许消费画面，绝不能发送 Viewer Input 或 Viewport Message、调整内容尺寸或影响 Browser 生命周期，关闭预览只隐藏当前 Generation。

实验性的 Computer 模块位于 `extensions/computer`，默认关闭，并与 Browser 相互独立。它使用 Farming 锁定的精确上游 `trycua/xfce-cua` Image Digest 与 Cua Driver 版本；Farming 不得维护自己的桌面镜像、静默替换其他镜像或 Driver，也不得把 Computer 当作 Browser Fallback。镜像拉取只能由用户在**插件 → Computer**中显式执行准备操作，绝不能成为安装、更新或启动依赖。旧 Docker seccomp 兼容模式只允许在明确的 Probe 失败后由用户显式启用。一个稳定 Agent Record 最多拥有一个 Computer Resource 和一台精确带 Label 的 Docker Container；不同 Agent 绝不能共享 Desktop、Driver Session 或 Viewer Credential。Chat/Terminal 切换保留 Computer；Agent 停止或归档会停止但保留它；删除 Agent 会删除经过精确校验的 Container 与 Resource。Server 不向 Container 暴露 Docker Socket，noVNC 只发布到回环地址，再通过带鉴权 Route 代理。Agent 在 ACP Session 创建边界获得锁定版本的完整细粒度 `computer_*` Catalog，Terminal 则使用渐进披露的 `farming computer` CLI。人工接管与 Agent 控制是互斥 Epoch；交还 Agent 后必须先重新观察再修改。Action 串行执行；Stop 先关闭新准入，再排空已接收的有界 Action；过期 Generation 明确失败；超时代表结果不确定且绝不自动重放。

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
│   ├── sync-ghostty-vendor.ts # 将 ghostty-web 浏览器资源同步到 frontend/vendor/
│   ├── deploy.sh             # 远程 Linux 部署 / 启动 / 停止脚本
│   ├── bundle-cli-runtime.ts # release CLI 后端 bundle 入口；处理 packaged runtime 的动态 require 边界
│   ├── package-cli-release.sh # 生成按平台发布的 farming CLI 应用；先 esbuild bundle/minify 后端，再交给 @yao-pkg/pkg / legacy pkg
│   ├── smoke-cli-release.sh   # 平台 CLI 冷路径 smoke：干净 HOME、自动配置、token、agent 控制链路
│   ├── package-release.sh     # 生成可解压运行的 app bundle tarball，包内根目录自带 ./farming
│   ├── install-release.sh     # app bundle / tarball 本地安装、启动、停止脚本
│   ├── install-remote-release.sh # 本机打包、上传 tarball 并远程安装启动
│   ├── compute-node-heap-mb.sh # 按 cgroup / 系统内存计算 Farming server Node heap
│   ├── start-playwright-server.ts # Playwright 本地临时测试服务入口
│   ├── capture-product-screenshots.ts # 使用匿名 demo workspace 重建 docs/products/code 产品截图
│   ├── e2e.ts                # 可重复端到端测试（本地 / 远端 / 手机视口）
│   └── e2e-workspaces.ts     # Main/New Agent workspace 行为 E2E 测试
├── backend/               # 后端代码
│   ├── server.cts         # Express + WebSocket 服务器 TypeScript 权威源码；运行时使用生成的 server.cjs
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
│   ├── farming-app-cli.cts # 产品 CLI TypeScript 权威入口
│   │   - `farming start/daemon/status/stop/logs/url`
│   │   - 默认端口 6694、base path `/farming`、配置目录 `~/.farming`
│   │   - 同时转发 Main Agent 控制命令到 `farming-cli.js`
│   │
│   ├── farming-net-server.js # Farming Net 独立 HTTP/Token 服务
│   ├── farming-net-registry.cts # 私有部署注册表校验与浏览器安全投影
│   ├── farming-net-pass.js # Farming Net 短时签名通行证与目标信任校验
│   │
│   ├── farming-cli.js     # Main Agent 控制 CLI 的参数解析与 HTTP 调用逻辑
│   │   - 读取 FARMING_CONTROL_URL / FARMING_TOKEN_FILE
│   │   - 给 Main Agent 提供 spawn/list/output/send/kill 命令
│   │
│   ├── main-agent-skills.js # Main Agent Farming 技能说明与内置记忆文件
│   │   - 声明“牧场除虫计划”等 Main Agent 技能
│   │   - 以 AGENTS.md 作为 canonical skill 文件
│   │   - 维护 CLAUDE.md / QWEN.md 完整内联兼容入口
│   │   - 支持 `farming skills` 输出同一份能力说明
│   │
│   ├── network.js         # 本机内网 IPv4 探测
│   ├── executable-discovery.js # CLI agent 可执行项发现
│   │   - Codex 优先使用 `FARMING_CODEX_BIN` / `Codex.app` 或 `ChatGPT.app` 内置 CLI / process.env.PATH 中兼容 session `cli_version` 的可执行文件
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
│   │   - Codex / Claude token usage 由独立 Worker 中的 TypeScript 扫描器解析，无 Python 运行时依赖
│   │   - SQLite 按源文件持久化字节偏移、解析状态和标准事件；未变化文件不读正文，追加文件只读新增字节
│   │   - Codex `token_count.rate_limits` 随同统计事件一次采集，但不计入 token 总量
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
│   ├── cli-agents.cts     # CLI agent 白名单与元数据
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
│       ├── test-final.ts  # 完整测试套件
│       │   - Non-tty rejection
│       │   - Main Agent creation
│       │   - Input processing
│       │   - Second agent creation
│       │   - Main Agent kill
│       │   - Other agent preservation
│       ├── test-agent-manager-fork.ts # Agent fork / git worktree 行为测试
│       ├── test-agent-manager-interrupt.ts # Agent interrupt fallback 行为测试
│       ├── test-agent-manager-rename.ts # Agent 自定义显示名行为测试
│       ├── test-agent-session-history.ts # Codex / Claude session provider 统一测试
│       ├── test-async-cache.ts # stale-while-refresh 缓存语义测试
│       ├── test-usage-monitor.ts # Codex / Claude usage 与 quota 只读采集测试
│       ├── test-codex-models.ts # Codex 模型目录裁剪与三段式选项测试
│       ├── test-code-composer-message.ts # Composer 附件 / slash mode 消息格式化测试
│       ├── test-code-composer-submit.ts # Composer -> terminal 单 chunk 提交语义测试
│       ├── test-code-focus-retry.ts # Code-style focus retry 调度 helper 测试
│       ├── test-code-main-page-session.ts # Codex / Claude 主页面 session membership helper 测试
│       ├── test-code-menu-position.ts # Code context menu 定位 helper 测试
│       ├── test-code-workspace-file-view.ts # workspace file path / open file view helper 测试
│       ├── test-claude-settings.ts # Claude settings 模型/effort 摘要与敏感字段过滤测试
│       ├── test-slash-command-discovery.ts # Claude slash command / skill 名称只读发现测试
│       ├── test-codex-session-history.ts # Codex 历史 session 元数据合并测试
│       ├── test-code-workspace-derived.ts # CodeWorkspace agent/session/project 派生状态 helper 测试
│       ├── test-code-workspace-files.ts # Code-style workspace 结构与接线测试
│       ├── test-codex-agent-working-state.ts # Codex / Claude 当前 turn active 状态判断测试
│       ├── test-session-engine-bridge.ts # Session engine bridge 测试
│       ├── test-session-engine-routing.ts # Session engine 路由测试
│       ├── test-supported-coding-agents.ts # Coding agent 白名单测试
│       ├── test-auth-token-file.ts # Token 文件位置测试
│       ├── test-haiku-token.ts # 多语言短语 token 生成器测试
│       ├── test-control-api.ts # Farming CLI control API 测试
│       ├── test-project-files-section.ts # Project Files section / editor 前端接线测试
│       ├── test-workspace-file-service.ts # workspace 文件服务安全读写/search/diff/watch 测试
│       ├── test-workspace-file-router.ts # `/api/files/*` 路由测试
│       ├── test-workspace-path-completion.ts # New Agent workspace 路径补全接线测试
│       ├── test-farming-cli.ts # Farming CLI 参数解析测试
│       ├── test-farming-app-cli.ts # Farming 产品 CLI 默认配置 / packaged fallback 测试
│       ├── test-main-agent-skills.ts # Main Agent 技能说明 / 记忆文件测试
│       ├── test-agent-manager-control-env.ts # Main Agent 控制环境注入测试
│       ├── test-executable-discovery.ts # PATH 可执行项发现测试
│       ├── test-config-manager-workspaces.ts # Main/New Agent workspace 配置测试
│       ├── test-workspace-discovery.ts # workspace 候选发现测试
│       ├── test-workspace-options.ts # Main/New Agent workspace 候选规则测试
│       ├── test-agent-manager-session-text.ts # session modal 文本源测试
│       ├── test-agent-manager-session-view.ts # session view model 测试
│       ├── test-agent-manager-session-stream.ts # session 实时流测试
│       ├── test-agent-preview-format.ts # agent 文本预览格式测试
│       ├── test-session-modal-helpers.ts # session modal 前端逻辑测试
│       ├── test-session-input-helpers.ts # terminal 输入路由 helper 测试
│       ├── test-terminal-screen-state.ts # headless terminal 屏幕状态测试
│       ├── test-terminal-screen-worker.ts # terminal screen worker 测试
│       ├── test-terminal-screen-worker-pool.ts # terminal screen worker 预热池测试
│       ├── test-workspace-history-helpers.ts # workspace 历史去重/截断测试
│       ├── test-agent-manager-workspace-defaults.ts # 主/子 agent 默认工作目录测试
│       ├── test-backend-connection-status.ts # 后端连接断开 / 心跳缺失页面提示接线测试
│       ├── test-session-terminal-input-e2e.ts # terminal 输入浏览器级 E2E 测试
│       ├── test-session-modal-bridge-files.ts # session modal bridge 测试
│       ├── test-server-input-routing.ts # session 输入路由优先级测试
│       ├── test-local-session-engine-shells.ts # shell/login 启动规范测试
│       ├── test-frontend-bridge-files.ts # terminal/skin bridge 骨架测试
│       ├── test-session-bridge-files.ts # session bridge 骨架测试
│       └── test-ghostty-vendor.ts # ghostty vendor 资源测试
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
├── frontend/              # CRT 皮肤、浏览器 bridge 与 vendored 资源
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
    │   └── InputDialog.tsx
    ├── hooks/
    │   ├── useWebSocket.ts # 状态与 session-output 订阅
    │   ├── useWorkspaceFiles.ts # Project Files section 目录树和文件变化状态
    │   └── useKeyboard.ts  # 全键盘交互
    ├── lib/
    │   ├── ghostty.ts      # ghostty-web renderer 封装
    │   ├── file-icons.ts   # Material Icon Theme manifest + 精选 SVG 文件类型 icon 映射
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
- 更新行为必须识别安装方式。npm 安装读取 `farming-code` registry 元数据并支持一键更新：旧服务运行期间先安装目标版本，安装成功后才重启，进度持久化到 config 目录，新服务启动失败时尝试回退。源码 checkout 通过 Git 更新；单文件 CLI 与标准 App Bundle 手动替换，不提供可配置的 Server 端更新源。独立的 `linux-x64-legacy-glibc228` tar 是首次安装引导包：安装器只在需要时启用固定校验的 glibc 2.28 runtime，把包内应用安装到私有 `~/.farming/npm` prefix，并生成稳定兼容 launcher。后续应用版本直接走同一 prefix 的 npm 更新；只有兼容 runtime 本身变化时才需要新的引导包。
- 默认推荐发布形态是按平台生成的直跑 `farming` CLI 应用：`npm run release:cli` 输出当前 target 的 `releases/<release-version>/farming_<release-version>_<platform>_<arch>`、统一 `manifest.json` 和 `farming_<release-version>_checksums.txt`；`npm run release:cli:all` 默认一次生成 macOS arm64 与 Linux x64；最终用户拿到二进制后可直接改名为 `farming` 并执行 `./farming daemon`
- CLI 应用默认自配置：首选端口 `6694`、base path `/farming`、配置目录 `~/.farming`；首次启动自动创建 `settings.json`、token 文件和必要运行目录，不要求用户先写 env 文件
- CLI 应用默认使用 native pty host session engine；目标机需要能加载打包的 `node-pty` runtime。只有排查 native host 边界时才设置 `FARMING_SESSION_ENGINE=local` 使用进程内 node-pty engine。
- CLI 应用启动时按目标环境自适应：未显式设置时自动计算 server Node heap，清理 packaged self-spawn 的 `PKG_EXECPATH`，并让 server 使用最终 `HOME` 推导默认 `~/.farming`
- CLI 应用会把实际 daemon 端口写入 `~/.farming/farming-server.json`；用户终端不传端口执行 `farming list/spawn/output/send/kill` 时会自动读取该 state 文件找到当前实例。`farming stop` 必须校验记录的精确 Server Identity 并发送 SIGKILL，只有在 Server 进程已经退出且记录端口可以重新 bind 后才能删除匹配的控制元数据并返回成功；有界等待超时必须保留元数据并显式失败。走 Native PTY 路径的 Release Smoke 必须关闭 Host 持久化、显式终止精确的 Smoke Agent，并证明 Server、Host 与子 Shell 进程都已退出
- CLI 应用同时保留 Main Agent 控制命令：用户终端可用 `farming start/status/stop/logs/url` 管理 server，agent 内仍可用 `farming list/spawn/output/send/kill`
- CLI 应用发布产物不包含仓库 `backend/`、`src/`、测试或脚本源码；服务端逻辑进入平台二进制，浏览器侧只包含 Vite 构建后的 `dist/` 静态资源；Farming 自身运行依赖尽量自包含，但目标机仍需要可执行的 shell，Codex / Claude agent 仍依赖目标机已有对应 CLI
- `scripts/package-cli-release.sh` 通过 `scripts/bundle-cli-runtime.ts` 用 esbuild 将后端 runtime bundle/minify 为临时 `backend/farming-app-cli.pkg.js` 和 `backend/terminal-screen-worker-thread.pkg.js`，不生成 sourcemap；bundler 会把 Express 可选 view engine 动态 require 隔离为 runtime require，避免 pkg 误判；pkg 只接收这些临时 bundle 和静态 assets，脚本退出时必须清理临时 bundle
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
- app bundle 本地安装脚本 `scripts/install-release.sh` 支持 `install/start/daemon/serve/stop/status/logs`，默认读取 `config/farming.install.env`（可从 `config/farming.install.env.example` 复制），通过 `FARMING_INSTALL_DIR`、`FARMING_PORT`、`FARMING_BASE_PATH`、`FARMING_CONFIG_DIR`、`FARMING_SERVER_HOME`、`FARMING_NODE_MAX_OLD_SPACE_SIZE` 控制目标目录、端口、base path、配置目录、server HOME 和 server heap 策略；旧 Linux 包还支持 `FARMING_USE_GLIBC_RUNTIME` 与 `FARMING_GLIBC_RUNTIME_ROOT`。App Bundle 不提供应用内自更新，升级时应走对应的手动部署路径

**公开版本发布前门禁：**

- 从干净 worktree 开始。创建新 release tag 前必须同时更新 `package.json` 和 `package-lock.json` 版本号；不得移动或复用已有 `vX.Y.Z` tag。
- 先跑快速源码检查：`npm test`、`npm run typecheck`、`npm run lint` 和 `FARMING_BASE_PATH=/farming npm run build`。
- 对本次改动涉及的 UI 面跑聚焦 Playwright；迭代中优先小而快的浏览器检查，只有变更面足够大时再扩大验证。
- 每个 Release Candidate 在聚焦的确定性浏览器检查通过后，都必须运行一次 `npm run test:pre-release:codex-ui`。这个真实 Codex 跨皮肤复合 Case 是发布阻断项，必须保存与 Revision 绑定的结果和 Artifact；具体见 `docs/products/code/real-codex-release-case.zh_cn.md`。
- 每个 Release Candidate 都必须运行一次 `npm run test:pre-release:terminal-input`。这个确定性的 Loopback Gate 会切换已有 Agent、通过 xterm 连续输入和删除、拒绝由切换触发的完整 `state` Payload、要求已聚焦 Terminal 的 Preview 保持紧凑，并将按键到 PTY Output 的 p95 限制在 250 ms 以内。保存与 Revision 绑定的结果；失败时保留 Trace。远端 Dogfood 仍须单独做真人式 Smoke，不能用网络基准替代它。
- 为发布新增或更新 `release-notes/vX.Y.Z.md`。package 版本号、Git tag 和 release note 文件名必须严格一致；GitHub Release 正文应来自这个文件，而不是 workflow 里的泛化内联文案。
- 把 GitHub Wiki 当作发布产物。打 tag 前必须对照 release notes 检查 Wiki 的 `Home` 与 `English` 页面；如果用户可见的产品定位、安装或升级步骤、支持的 Agent、架构、主要工作流或截图发生变化，必须先准备中英文 Wiki 草稿并验证所有页面与图片链接可访问。任何 Wiki push 之前，都必须由独立 Agent 对照 release notes、当前产品行为、中英文语义一致性、公开数据安全和线上链接/图片完成 Review；所有阻断项和重要问题修订完毕后才能推送。通过 Review 的 Wiki 只能在带版本号的 GitHub Release URL 创建后发布。如果 Wiki 内容无需变化，也要由独立 Reviewer 验证该判断，并在发布证据中记录 `Wiki: no change required`。经过 Review 的 Wiki 更新或无变化结论得到验证之前，不得宣布发布完成。
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
- **pinnedProjectWorkspaces**：有序的 Project 置顶队列；置顶 Project 整体排在普通 Project 前，新置顶项追加到已有置顶项末尾，取消置顶后恢复普通 Project 顺序
- **theme**：UI 主题名称（默认：terminal）
- **heartbeatInterval**：心跳检测和系统监控间隔（单位：毫秒，默认：1000）
- **dangerouslySkipAgentPermissionsByDefault**：是否默认让支持的 coding agent（如 Codex、Claude、OpenCode、Qoder、Qwen、Aider、GitHub Copilot CLI、Amazon Q）使用各自最激进的权限绕过启动 flag
- **browserExtensionEnabled**：默认关闭；启用后会把 Browser MCP Tool Catalog 投影到新建的 ACP Session，Terminal 仍通过 CLI 按需访问
- **browserSource / browserExecutablePath / browserExternalCdpUrl**：由插件界面选择的浏览器来源；外部 Endpoint 必须位于回环地址
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
- 新持久 Agent 使用稳定 `agent_*` ID：低频身份、产品、进程所有权与 Lifecycle 字段写入 `agent_*.json`，ACP/Attention/Read 状态和有界 Composer Admission 记录写入同名 `agent_*.state.json`，后者不能覆盖 Lifecycle 或进程身份。Composer 记录只保存 request id、内容 hash、状态、紧凑结果/错误和时间戳；Provider `onSubmitted` 是准入线性化点，重启后残留的 `intent` 只能转为 UNKNOWN，不能重放。旧 `fsess_*.json` 只读兼容；首次 Mutation 创建带 `legacyRecordId` 的 `agent_*` 后继记录，发现时隐藏已被接替的旧行。live `agent-...` id 只表示当前 native pty runtime，Codex / Claude provider session id 作为外部关联字段保存。
- `sessions/index.json` v2 只维护主页面有序 provider-session membership；Provider Session 到 Agent Record 的映射通过扫描 Agent 记录派生，重复绑定必须 Fail Closed。v1 Index 继续可读，`mainPageSessionKeys` 只是 API 兼容投影。Codex `tmp_uuid...` live id 不得进入这里；不在列表里的 Codex / Claude provider session 只出现在 History；Move to History / Move Project to History 会从这里移除对应 key，从 History 恢复会写回 key。
- Farming 自有 JSON Snapshot 必须先构造并校验完整 Next Value，通过独占创建的 UUID 临时文件写入，执行 `fdatasync` 后原子 Rename，最后才发布新的内存引用。Settings、Run History、Review State、Agent Record、Sidecar 与 Session Index 都使用这条边界。Write、Sync 或 Rename 失败时，已提交文件和 Store 内存状态都必须保持旧值。该保证覆盖进程崩溃一致性；由于没有同步父目录，不能宣称 Power-loss Durability。
- 归档 run/history 存储在 `~/.farming/history/runs.json`，不属于 `settings.json`；其中可选的 `customTitle` 用于在恢复时保留用户明确重命名过的 Agent 名称，旧记录没有该字段也继续兼容。
- config 目录下后端自有文件路径统一由 `backend/storage-layout.js` 定义；新增 `settings.json`、`theme-settings.json`、`.session-token`、`sessions/`、`history/`、server pid/state/log、native pty host log 这类路径时，不要在功能模块里手写 `path.join(configDir, ...)`。Codex `~/.codex/sessions`、Claude history 等外部 provider 历史是只读集成，不属于 Farming 自有元数据。
- Codex / Claude usage 的 Farming 自有缓存位于 `history/usage-history-v2.sqlite3`，由独立 Worker 中的 TypeScript 扫描器通过 Node 内置 SQLite 维护，不依赖 Python。Codex 累计计数与复制前缀分类移植自锁定 commit 的 CodexBar 0.45.2；Claude assistant usage 提取及流式 message-id 去重移植自锁定 commit 的 cc-statistics 1.1.0。准确的来源版本、文件、移植范围与 MIT 许可证必须保留在 `backend/vendor/usage-parsers/` 和 `THIRD_PARTY_NOTICES.md`，产品包不携带两者的运行时。
- 扫描器持久化目录清单、Source Queue、前缀指纹、已提交字节偏移和累计状态。冷发现从 Scan Budget 内开始，目录任务可以落盘续跑，内存只保留一个目录与固定大小的 Source 批次，未完成时不发布部分 Provider 总量。稳态刷新复用未变化目录，只审计近期文件和固定大小的轮转批次，不再枚举、排序或 `stat` 每个 Session。追加只读已提交偏移之后的字节，Codex Archive/恢复改名按正式 Session 身份迁移 checkpoint；已提交前缀或边缘指纹证明发生破坏性改写时，只重建受影响 Source 的 Ledger。Codex Rollout 的第一条 `session_meta` 是叶会话身份；后续不同身份的 metadata 证明存在复制祖先，复制的累计前缀在当前会话边界前不计费。紧凑的显式 Fork 只采用可信的 last-token 增量，并保留对应原始累计基线，后续 total-only 样本不能重新计入祖先。CodexBar 的单调水位与有界累计值集合用于阻止 Ultra 高低谱系交错时重复计算缺口。长期数据按“源文件 / Session / 本地小时”聚合，近期窗口保留精确事件；Claude 只保留跨文件流式去重所需的紧凑 message identity，存储不得随 Codex 每条 token event 各增一行。不兼容 schema 必须删除数据库及 WAL/SHM 后重建，旧 `cc-statistics-usage-v1.sqlite3` 自动清理。刷新路径不得恢复全历史 `rg`、Python 子进程、双解析器、Codex 长期逐事件明细或整文件读取。

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
  - Main Agent 控制 CLI（`farming spawn/list/output/send/kill`）
  - Main Agent skills 记忆文件（Main Agent 在 `.farming` 身份工作区启动，读取 canonical `AGENTS.md`、`farming skills` 和“牧场除虫计划”）
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
  - 左侧 Project 行的眼睛按钮只隐藏或展示该 Project 的 Agent 列表，Files 保持独立；`...` 菜单提供 Pin/Unpin Project、Reveal in Finder、Create permanent worktree、Rename project、Mark all as read、Archive chats 和 Remove，Farming 生成的 fork worktree 另提供永久删除；左侧 Agent 行右键菜单提供 Open Terminal、Pin/Unpin、Rename Agent、Move to History、Mark as unread/read、New Agent in Project、Copy working directory、Fork into same worktree、Fork into new worktree、Close Terminal、Kill Agent 等真实操作；左侧 Agent session 行右键菜单仅提供 Open Session 和 Copy working directory；Close Terminal 不会终止 agent
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
2. `farming` 是合并后的产品 CLI：用户终端可用 `start/daemon/status/stop/logs/url` 管理 server，agent 内可用 `list/spawn/output/send/kill` 访问控制 API
3. 控制命令读取 `FARMING_CONTROL_URL` 和 `FARMING_TOKEN_FILE`；服务以 `FARMING_DISABLE_AUTH=1` 启动时跳过 token 读取
4. `AgentManager` 启动每个 agent 时把 CLI 所在目录注入 `PATH`；源码态是仓库 `bin/`，packaged runtime 是 `farming` 二进制所在目录
5. `AgentManager` 同时注入 `FARMING_AGENT_ID`、`FARMING_IS_MAIN_AGENT`、`FARMING_PARENT_AGENT_ID`
6. 子 agent 环境会剥离服务进程自己的 `LD_LIBRARY_PATH` 和 `NODE_OPTIONS`，避免部署 shim 或 server heap 设置污染 agent 运行时
7. Main Agent 启动目录固定为 Farming 身份工作区：用户选择的目录若不是 `.farming` 结尾，则实际进入 `<选择目录>/.farming`；Code-style 前端在 Projects 分组和 Project 下新增 Agent 时会把 Main Agent 的 `.farming` 身份目录折叠回真实项目目录
8. Farming 在身份工作区维护 canonical `AGENTS.md`、`FARMING_MAIN_AGENT_SKILLS.md`，并把完整 Main Agent 身份与技能内联写入常见 coding CLI 兼容入口；Claude 启动时还会通过 `--append-system-prompt` 注入同一份 bootstrap，避免只依赖 memory 文件自动发现；Main Agent 也可运行 `farming skills` 查看技能
9. Main Agent 可用“牧场除虫计划”先只读梳理目录结构与模块协议，再用 `farming spawn` 为每个模块启动子 Agent；子 Agent 必须聚焦自己的模块，同时检查与相邻模块的协议违约、边界条件、错误处理、并发/状态一致性和测试缺口
10. Main Agent 用 `farming list/output/send/kill` 监督子 Agent，汇总发现、去重分级，并推动可验证修复；高风险写操作、破坏性操作或大范围重构需要先向用户确认

**示例**：
```bash
farming spawn --workspace /repo --task "检查这个模块的潜在 bug，并修复可验证的问题" -- claude
farming list --parent "$FARMING_AGENT_ID"
farming output agent-xxx --tail 2000
farming send agent-xxx "继续跑相关测试"
farming kill agent-xxx
```

**代码位置**：
- 后端 API：`backend/control-api.js`
- CLI：`bin/farming`、`backend/farming-app-cli.js`、`backend/farming-cli.js`
- Skills：`backend/main-agent-skills.js`
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

如果 `6694` 已被已有实例占用，就换成 `6695` 或其他空闲端口。不要只给后端设置 `FARMING_BASE_PATH=/farming` 却用普通 `npm run build` 的产物；分开执行时必须先运行 `FARMING_BASE_PATH=/farming npm run build`，再运行 `FARMING_BASE_PATH=/farming node backend/server.cjs`。否则 `dist/index.html` 会引用 `/assets/...`，在 `/farming/` 页面下 JS/CSS 404，表现为白屏。

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
