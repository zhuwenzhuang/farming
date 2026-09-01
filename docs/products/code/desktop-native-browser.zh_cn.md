# Desktop 原生 Browser 视图

> English version: [desktop-native-browser.md](./desktop-native-browser.md)

Farming Desktop 可以通过 Electron 原生 web contents 视图呈现 Agent 拥有的
Browser Resource。这是现有 Browser Resource 合同的 Desktop 呈现/运行时适配器，
不是第二个 Browser 权威。

## 所有权

- Farming 后端仍然权威地拥有 Browser Resource 身份、Agent 和 Project 所有权、
  Session 绑定、租约、生命周期、工具授权与持久化资源状态。
- Desktop adapter 只拥有它已租用的准确 Resource generation 的 Electron 原生
  tab、view、原生输入、导航表面和操作系统集成。
- 共享 Browser Resource 协议仍是唯一的 Agent 工具合同。Chat 和 Terminal 使用
  同一个按实例定位的 Farming CLI。原生路径不根据 provider 名称选择。
- Web 客户端继续使用已有的流式 Browser Viewer 和远程 Browser Resource 语义，
  用于其既有的 Browser source。若它打开一个明确租给 Desktop 的 Resource，会得到
  明确的“仅原生视图”状态，而不是低质量的流式 fallback。

创建原生 Resource 时选择准确的 Desktop adapter 身份。如果有多个可用 Desktop
adapter 且未指定准确 adapter，创建会显式失败，而不是任意附着到某个 Desktop。
Desktop-native Resource 永不静默降级到 system、isolated 或 Connector Browser。
adapter 身份属于一个 Desktop user-data profile，而不属于某一个 Renderer Document。
因此 Renderer Reload 和后续 Desktop Relaunch 都会重新注册同一个准确 adapter；但
Relaunch 前的原生 tab 仍是丢失的 lease，绝不会通过猜测被接管。
Desktop Renderer 会在新的 WebSocket 上注册 adapter 前先对账后端权威的 server epoch。
在这项对账成功前，后端不能把新命令路由到保留的原生 view。
后端会确认注册成功后 Desktop 才刷新 Browser capability inventory，因此首次可见的
Desktop 可用性来自权威读取，而不是 Renderer 对启动时序的猜测。

## 原生 Tab 与 View 状态

后端 Resource 生命周期与 Desktop 呈现生命周期彼此独立：

```text
Backend Resource:
  stopped -> starting -> running -> stopping -> stopped
                         |              |
                         +-> failed <---+

一个准确 Resource generation 的 Desktop tab/view：
  absent -> creating -> hidden | visible -> closing -> absent
                 |                 |
                 +----> failed <---+
```

`visible` 表示原生 view 已挂载在匹配的 Desktop Browser Viewer viewport 上方。
`hidden` 保留准确的原生 tab，因此用户检查其他 Farming 表面时 Agent 仍可继续工作。
view 的 mount、resize、focus 或 unmount 只改变呈现，不会创建 Browser Resource、
改变 Agent 所有权或改变 Browser Session 绑定。
Desktop Viewer 在挂载 tab 前会请求后端选择该准确 Resource binding；原生 IPC 会拒绝
挂载尚未选中的 tab。因此呈现不会绕过后端 Session queue，也不会让一个 tab 可见而
后端认为另一个 tab 处于 active。

Desktop adapter 仅在 adapter 身份、Browser Resource id、generation 和当前 lease
全部匹配时接受命令。它拒绝过期、歧义、已停止或已替换的命令。后端继续通过已有
Resource session action queue 串行 Browser 操作；迟到的 adapter 结果不能更新
较新的 generation。

## 控制与操作

原生工具栏提供地址输入、后退、前进、刷新或停止、标题/URL/loading/error 反馈、
tab 选择与关闭、缩放以及正常键盘焦点。Browser 导航仅接受 `http`、`https` 和
`about:blank`；不安全 scheme 会以明确错误拦截。

控制是按 Resource 存储的显式状态，并带有单调递增的 `controlEpoch`：

```text
agent / epoch N -- 接管 --> user / epoch N + 1
user  / epoch N -- 归还 --> agent / epoch N + 1
```

启动新的原生 generation、tab 退出、stop 和重启恢复都会把控制复位给 Agent 并推进
epoch。Agent Action 在进入 Browser Session Queue 前记录 owner 与 epoch，在真正执行
前再次验证二者。若中间发生 handoff，排队的 Agent Action 会以 stale 明确失败，绝不
重放。人工工具栏 Mutation 通过相同的后端 Queue 以 `user` 身份准入。React Viewer
不会直接导航或修改 Electron 内容；它的直接原生 IPC 只用于呈现的 mount、unmount、
focus 和 backend-epoch reconciliation。已认证的 Desktop adapter transport 只执行带有
准确 Resource、Session、generation 与 control admission 的后端定址命令；它不能自行
选择该权威。

一个 Browser Session 可以有多个原生 tab，但每个 tab 都有独立的 Browser Resource
身份与 generation。**新建标签页** 是后端中介操作：它先在现有 Session 中创建并绑定
准确 Resource，再授予 user control。关闭 tab 只 stop 该准确 Resource；其余绑定仍在
时 Session 保持可用。这使 Agent/Project Ownership 和 tab 的恢复、清理都可审计。
Agent 创建额外 Resource 时，会先完成绑定后才接受命令；它以 hidden 状态启动，绝不会
替换用户当前选中的原生 tab。

原生 adapter 执行与 Agent 相同的结构化 Browser 命令。因此用户输入和 Agent 工具
输入指向同一个原生 tab，并保留后端有序的 Browser Session 语义。人工输入不会成为
第二个权威，也不是尽力而为的页面镜像。
当 Agent 拥有控制权时，一个原生 input shield 会留在可见 web contents view 的上方，
吸收 pointer、wheel、touch、context-menu 和 keyboard 输入。只有后端提交新的 control
epoch 后，接管控制才会移除这个 shield，因此直接的原生点击不能绕过 handoff 边界。
handoff 会先 prepare 原生 tab：它阻止直接输入，并拒绝仍携带旧 owner/epoch 的迟到
命令；随后后端提交新的 owner 和 epoch，Electron 才 commit 可见的交接。归还给 Agent
会先安装 shield，再让 Agent 重新具备准入资格。commit 失败或结果不确定时，Resource
保持明确的 failed，而不会猜测哪一方拥有输入。
Electron 无法提供等价结构化操作时，adapter 必须 fail closed：它不会伪造空 network 或
console evidence、伪造 pointer success，也不会假装已经切换 frame 或 dialog。调用方会得到
有界的 `BROWSER_DESKTOP_OPERATION_UNSUPPORTED` 结果，并可显式选择具备该能力的
Browser source。

下载与文件选择仍属于 Project workspace 操作。原生 adapter 传输在后端 workspace
边界进行有界校验；adapter 不获得宽泛文件系统权力。页面每个 frame 都会在页面脚本
运行前通过 sandboxed preload 拦截人工文件选择器，并在页面 handler 收到事件前清空
任何已选择或拖入的主机文件。结构化 Agent upload 只读取准确 workspace 文件，把有界
bytes 传给原生 tab，不暴露任意主机路径。结构化 download 只准入准确匹配的 Electron
`DownloadItem`，在不取消传输的前提下先写入 adapter 私有临时存储，只有通过后端校验
后才发布到请求的 workspace 路径；未准入的页面 download 一律拒绝。原生页面
permission 与 basic-auth challenge 都明确失败；adapter 不会向页面内容转发主机凭据、
主机设备权限或通用 Electron/Node bridge。

## 替换、重启与不确定结果

Chat/Terminal 与权限替换通过已有的准确 Agent-owner transfer 保留 Browser
Resource。Desktop tab 关联的是 Resource id 与 generation，而不是短暂的运行时
Agent id。

Desktop 进程丢失、adapter 断开、原生 view 销毁和有界命令超时都是显式失败。超时是
不确定结果：Farming 重新读取权威 Resource 状态，绝不自动重放输入、导航、下载或
tab 或其他 mutation。命令响应和异步原生 metadata/loading/error event 仅在同一个
adapter connection、Resource、Session 和 generation 仍然匹配时才会被接受。
当 Desktop Renderer 的 adapter transport 关闭时，它会在 adapter 可以再次注册之前
作废并销毁所有保留的原生 lease。因此 Renderer reload 或连接替换后，后端的 failed
Resource 行绝不会静默重新附着到旧 Electron view。

后端重启后，前一个 backend generation 的原生 tab 不会通过猜测被接管。后端将
持久化 Resource 对账到 stopped 或明确的 failed 状态，adapter 移除过期原生 lease。
新的 start 创建一个新的准确 generation。Desktop 重启同样如此：原生 view 不会被
静默重建为仿佛先前操作已经完成。

停止或删除 Agent 遵循已有 Browser Resource 生命周期。仅在后端所有权证明选定
Resource 必须 stop 或 delete 后，adapter 才接收准确 tab 清理。Desktop adapter
不得在该清理后保留或重用 Agent 拥有的原生 tab。

删除同一准确 Desktop adapter/session 的最后一个 Resource 时，会先只清除该
Electron 持久 partition 的 storage、cache 和 authentication state。后端按准确
adapter/session key 串行最终删除判定，因此两个并发删除的 tab 不会都认为另一个 tab
会清理 profile。只有清理成功后，持久化 Resource 行才会删除。清理失败或 timeout
结果不确定时，Resource 会保持 stopped 并显示明确错误；Farming 不会删除该行，也不会
自动重试不确定的 profile 清理。

## 验收

原生 Desktop 验证包括人工浏览、Agent 多步 Browser 工具、人工接管、tab 创建/关闭/
恢复、Chat/Terminal 替换、Desktop 与后端 abrupt restart、timeout/error 对账、
并行 Desktop/Agent 隔离、下载、文件选择、权限、危险 scheme、认证，以及支持
Desktop 尺寸下的 Light、Dark、Paper。等价的仅 Web Browser 流程继续通过已有远程
Viewer 协议覆盖。
