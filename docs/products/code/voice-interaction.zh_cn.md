# 语音交互架构

> English version: [voice-interaction.md](./voice-interaction.md)

本文是 Farming 语音的实现契约。第一条 Codex Realtime 直达链路与可见的 Codex
Voice Main Agent 路径已经实现；provider-neutral 本地引擎和隐藏 Voice Supervisor
仍在规划中。

## 产品决策

Farming 语音在可插拔音频引擎之上提供两种对话模式：

- **直达**：把语音 Turn 发送给开始时明确选定的 Agent。本地文本引擎通过 Composer
  提交最终转写；Codex Realtime 则把实时语音对话挂到准确的 Codex Session。两条路径
  都不会额外经过一个 Supervisor 模型。
- **总管**：把转写发送到一个由系统拥有的隐藏语音会话。Voice Supervisor 可以读取
  Farming 状态并跨 Agent 调用类型化动作，实际代码工作仍由 coding Agent 负责。

Supervisor 复用 Farming Main Agent 的 attention-steward 工作契约，但不复用它的可见
会话。语音闲聊、工具结果和简短播报不能污染 coding Session，也不能要求用户必须一直
运行一个可见的 Main Agent。

Codex Realtime 引擎在用户设备上采集和播放音频，由 Codex 完成端点检测、识别、对话和
语音生成。媒体通过浏览器到 Codex 的 WebRTC 连接传输；Farming 只承载 SDP 信令以及
有界的状态/转写事件。未来的 provider-neutral 本地引擎会在设备端完成识别与合成，只把
最终文本送入 Farming。

## 架构

```text
麦克风
   |
   v
Voice Controller
采集 -> 引擎 adapter -> 播放 / 转写
                       |
             +---------+---------+
             |                   |
             v                   v
       Codex Realtime         本地语音引擎
        WebRTC 媒体           设备端 STT/TTS
             |                   |
             +---------+---------+
                       |
                 +------------+------------+
                 |                         |
                 v                         v
              直达模式                   总管模式
        现有 Composer admission        隐藏语音会话
                 |                         |
                 +------------+------------+
                              v
                   类型化 Voice Action Gateway
                              |
                              v
                    Farming 后端权威状态
                              |
                              v
                 Codex / Claude / OpenCode / ...
```

Desktop renderer 拥有麦克风采集和 Voice Controller。Electron shell 只允许精确匹配
Desktop loopback gateway origin 的页面获得麦克风权限；renderer 不获得 Node.js 能力
或上游凭据。普通浏览器可以在可信 HTTPS 或 localhost origin 上复用同一运行时。

## 当前 Codex Realtime 切片

锁定版本的 Codex ACP adapter 会声明带版本的 WebRTC 能力，并把 Farming 的
`_codex/session/realtime/start` 与 `stop` 扩展映射到 app-server 的
`thread/realtime/start` 与 `stop`。浏览器创建 offer，后端通过准确的实时 ACP Session
转发信令；SDP、转写、错误和关闭通知则经现有 Farming WebSocket 返回。这些瞬时通知
不会进入持久化 ACP transcript。

Farming 会为该 Session 开启 Codex 的 `realtime_conversation` feature，但上游服务仍
可能拒绝尚未获得 Realtime voice 权限的账号。该拒绝会明确显示，不能静默替换成浏览器
听写。其他 provider 在协商出的本地引擎可用前继续使用现有 Web Speech adapter。因为
仍需浏览器采集麦克风，页面必须运行于 Desktop loopback、`localhost` 或可信 HTTPS
origin。

Realtime 启动会显式请求 v3 协议与 `gpt-live-1-boulder-alpha`，并要求 Codex 从当前
thread 构造原生的有界启动上下文；Farming 不自行拼装或复制这份上下文。Farming 不会
自动重试旧 v1 路径：较旧的 Codex executable 会得到升级提示；v3 请求仍返回 403 时，
才视为账号、灰度或工作区权限问题。

第一版 Main Agent 实现中，选择 **Restart > Codex Chat** 会直接启动 Chat/ACP。打开该
Main Agent 并点击麦克风后，Realtime 会挂到同一个可见 Main Agent Session，因此语音
模型可以获得有界的最近 thread 上下文，并继续使用 Main Agent 已有指令和工具协调工作。
Realtime handoff 会成为同一个 Codex thread 上的普通 turn，权限与工具活动则保留在
普通 Chat 审计记录中。此路径不会创建规划中的隐藏 Supervisor Session。

当选中的 Codex Chat 声明 Realtime 能力时，Composer 使用圆形声波控件替代听写麦克风：
连接阶段以呼吸效果提示，实时阶段动态显示声波，再次点击即可结束会话。不具备 Realtime
能力的语音输入仍保留普通麦克风与单次听写语义。

后端继续拥有 Agent 身份、生命周期、运行状态、attention、消息、权限和 mutation 的
权威状态。语音层不能通过解析终端文本推断这些事实。

### Codex Realtime 连接状态

浏览器 Voice Controller 同一时间只拥有一个前台 Realtime operation。每个 operation
在第一次异步麦克风步骤之前固定 `{ generation, agentId, operationId }`。每次 start、
stop、Agent 切换与组件销毁都会递增 `generation`。`getUserMedia`、SDP 创建、ICE 收集、
start 响应和远端 SDP 安装之后的每个 continuation，都必须重新核对这三个 owner 字段，
之后才可以发布状态或继续持有本地媒体资源。

浏览器把 start 结果与展示状态分开记录：

```text
not-sent -> uncertain -> accepted
                    \-> rejected
```

`not-sent` 可以只在本地取消。`uncertain` 表示请求已经跨过 mutation 边界，但尚未观察到
权威响应。`uncertain` 与 `accepted` 都必须执行幂等的 backend stop/reconcile；只清理本地
Peer 不够。超时、Peer 失败、远端 SDP 失败、Agent 切换和组件销毁都遵守这一规则。

Backend 是 `{ agentId, operationId }` 的顺序权威。若 stop 先于对应 start 到达，Backend
会在整个 ACP binding-owner 生命周期内保留 cancellation tombstone，使任意晚到的 start
都无法创建对话；只有权威 binding 终止才释放这些 tombstone。同一 Agent 的替换 start
必须等待旧 operation 完成 reconcile。旧 operation 的迟到 stop 是 no-op，不能停止
较新的对话。因此浏览器可以在 start 响应重排或结果不确定时重复 stop，而不会重放 start
mutation。

Browser protocol v4 在解析收到的 `acp-realtime` WebSocket event 时允许缺少
`operationId`，使共享 v4 schema 在分阶段部署期间保持可解析。这并不代表 Voice 可以连接
旧 Backend：没有下文所述的扩展 ACK，Voice UI 会保持禁用，Realtime event 也会被忽略。
新 Backend 始终发送非空 operation ID；完成协商后，Voice Controller 仍会对缺失或不匹配
当前 operation 的事件 fail-closed 忽略，因此格式错误或过期事件不能修改新的语音对话。
HTTP Realtime start/stop mutation 不提供这种向后兼容：两者都要求合法 operation ID，缺失
时必须在进入 Agent mutation 之前返回 `400`。这条 parser 兼容例外不改变任何 Terminal
或 Chat 协议字段。

Realtime event 还必须通过带版本的 `acp-realtime-v1` Browser protocol 扩展协商，
无需改变 protocol v4 本身。Server 初始 hello 通过 `availableExtensions` 声明 offer；
Client hello 通过 `requestedExtensions` 发出 request；Server 把两者交集写入当前 socket
后，再发送带 `negotiatedExtensions` 的第二个兼容 hello。Voice UI 只有收到该 ACK 后才
会启用。ACK 前产生的 event 会对该 socket 丢弃且不会补发。旧 Client 不请求扩展，因此
永远不会收到 Realtime event；新 Client 连接旧 Server 时收不到 ACK，因此 Voice 保持
禁用。socket 关闭即销毁协商集合，每次重连都必须重新协商。

Codex app-server 的 Realtime notification 本身不含 operation ID。因此，经过审核的
ACP adapter 会在转发 start 之前登记 operation owner，在每条 notification 到达时捕获
这个精确 owner，并把它写入交给 Farming 的 ACP event。stop 会继续保留旧 owner，直到
app-server 的 `thread/realtime/closed` 边界也已经发布给 Farming 后才返回；Backend 只有
在此之后才能发送替换 start。如果有界 stop 时间内无法观察到该边界，fence 将 fail
closed：在权威 ACP Session 被关闭或恢复之前，所有替换 start 都保持阻塞。

Backend operation owner 还包含 ACP binding generation，而不只是 Agent ID。旧 stop
closure 会把它捕获的 generation 交给 ACP runtime；如果该 Agent 当前已经使用替换
binding，这次 stop 就是 no-op，不能触达新 Session。Coordinator 只在旧 owner 已权威
终止的节点 reset：显式 Session close 成功、reconnect 的 `onProcessStopped` 边界、验证
完成的 unregister、kill 中精确停止已持久化的 ACP 进程组，以及验证完成的 ACP 启动
回滚。单纯 transport error 或对未证明退出的旧进程进行人工确认，都不是此类边界，
绝不能清除 poisoned fence。

有界终态为 `idle`、`failed` 与 `disposed`。临时的 `requesting-permission`、`connecting`、
`live` 与 `stopping` 始终保留精确 operation owner，或者经过 stop/reconcile 后退出。

## Voice Action Gateway

Voice、UI、CLI 和未来 MCP 工具应复用同一个类型化动作层，不能分别实现相互竞争的
mutation 路径。第一批动作是：

- `agent.list` 和 `agent.status.get`；
- `agent.message.send`，复用现有 Composer admission 和 request ID；
- `agent.interrupt`，绑定当前 runtime/turn；
- `attention.list`，使用稳定事件身份和 cursor。

后续受保护的动作是：

- `agent.create`；
- `agent.archive`；
- `permission.list` 和 `permission.respond`；
- elicitation 及其他用户动作响应。

每个动作都在执行时校验精确 Agent 身份。mutation 必须携带 request ID。传输超时或
断线属于不确定结果，绝不自动重放。Supervisor 获得有界结构化结果，并单独生成简短
播报。

当前 control API 还不能直接充当这个 gateway：其中的 `send` 路径是原始 Terminal
输入，并且会拒绝结构化 ACP Agent。第一个后端切片必须增加由
`AgentManager.sendComposerMessage` 支撑的 provider-neutral 消息动作，同时把原始
Terminal 输入保留为明确不同的操作。

## 语音 Turn 状态模型

一个 controller 同时最多拥有一个前台语音 Turn：

```text
idle
  -> requesting_permission
  -> listening
  -> transcribing
  -> routing
  -> dispatching
  -> speaking
  -> idle
```

每个瞬态都必须有一条有界路径进入 `idle`、`cancelled` 或可见的 `failed` 结果。开始
新的按住说话 Turn 会停止当前播报，但不会重放、取消或替换结果不确定的 mutation。

直达模式在开始监听时快照 `{ backendId, agentId }`，并在发送前重新校验。其间 UI
焦点变化不能悄悄改变转写目标。总管模式只能根据权威 action result 解析其他目标；
指代不明确时只问一个简短澄清问题。

## 权限与安全

Voice Supervisor 不能直接编辑文件或执行 shell 命令，只能调用被公布的 action
catalog。

语音绝不自主批准 permission request。只有一句允许或拒绝能精确对应到一个 Agent 的
一条当前 request 时才能执行；执行前 Farming 会简短复述目标和风险。过期 request
ID、多条匹配或 Agent/runtime 已替换都必须 fail closed，并要求用户消歧。

UI 始终展示最终转写、解析后的目标、动作状态和播报内容。语音是第二呈现通道，不是唯一
审计记录。

## 交付顺序

### 切片 1：共享动作

增加并测试 provider-neutral 的 list、status、message 和 interrupt 动作。让
`farming send` 对 ACP 与 Terminal Agent 都使用 message action。保留 Composer
request 幂等性和不确定结果处理。

### 切片 2：可用的本地语音

允许可信 Desktop origin 获得麦克风权限。增加一个小型 Voice Controller，支持按住
说话、转写预览、直达/总管选择、取消和设备 TTS。现有 Web Speech 路径作为能力有界的
adapter 保留，但不能是唯一引擎。

### 切片 3：隐藏 Voice Supervisor

运行一个独立隐藏语音会话，使用 Main Agent 的 attention-steward prompt，并且只暴露
第一批 Voice Action Gateway 工具。回复默认限制为一句适合播报的话；转写与工具结果
显示在可收起的语音活动面板中。

### 切片 4：attention 与受保护动作

先增加带 event ID 和 cursor 的持久化类型化 attention stream，再支持主动播报完成和
阻塞事件。只有精确 request 确认契约通过测试后才加入 permission response。

### 切片 5：可靠的免手持音频

加入本地神经 STT/TTS、VAD/Turn 结束检测、流式播放和 barge-in。模型下载必须明确、
可缓存、可取消，不能成为静默降级。只有跨 backend attention 订阅能用 backend 与
Agent 联合身份标识每个事件后，Desktop 才将非 active backend 纳入语音总管。

## 验证

当前 Codex 路径的两半都有聚焦自动化覆盖：

```bash
npx tsx backend/tests/test-codex-acp-realtime.ts
npm run test:voice-main-agent
```

协议测试验证经过审核的 Realtime v3 请求，包括原生启动上下文、SDP、转写与关闭顺序。
显式真实 Codex 用例会创建本地合成麦克风 track、完成上游 WebRTC SDP 交换，再向可见
Main Agent 提交 Realtime handoff 形态的 turn，并证明它创建出的 Farming 子 Agent 具有
准确的 parent、task 与 workspace。该用例需要已登录且支持 Realtime v3 的 Codex binary；
可用 `FARMING_REALTIME_CODEX_BIN` 覆盖自动发现。

第一个 production-shaped 验收场景使用 Farming Desktop 通过 SSH 连接远程后端：

1. 远程后端不需要 HTTPS 也能按住说话，因为音频采集发生在 Desktop loopback origin。
2. 即使转写完成前 UI 焦点变化，直达模式也只向录音开始时选中的 Agent 发送一次文本。
3. 总管模式能报告所有当前 Agent 状态，并向明确解析的 Agent 发送一条消息；播报不泄露
   opaque ID。
4. 发送后断线产生可见的不确定结果，不会重发消息。
5. barge-in 立即停止播报，但不会取消已经被 Agent 接受的工作。
6. permission response 在零条、多条、过期或 runtime 已替换匹配下均被拒绝且没有副作用。
