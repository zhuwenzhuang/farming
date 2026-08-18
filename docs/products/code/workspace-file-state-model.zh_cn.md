# Workspace File 状态模型

> English version: [workspace-file-state-model.md](./workspace-file-state-model.md)

本文定义 Project 文件打开、查看和编辑的正确性与性能模型。它是用于推导和验证的
状态模型，并不要求实现一套通用状态机框架。

Project Files 的实现保持成熟编辑器式的简化分层：文件系统访问与传输方式解耦；
每个资源由唯一文件模型负责；Editor Group 负责 preview 与 pin；Explorer 负责目录
呈现。Farming 只在其上增加产品特有的 Project 挂载依赖，以及 Browser 侧最新打开
意图的提交准入。

## 所有权

文件路径由四类 owner 组合：

1. **Workspace Access** 执行有界的 tree、read、write、watch 和 Git 请求。Transport
   Result 与 watch event 不拥有编辑器状态。
2. **Workspace File Model** 拥有已解析快照、working copy、每个资源唯一的 pending
   resolve，以及最近使用 clean model 的有界保留。Model key 是 canonical workspace
   与 normalized path。
3. **File Open Coordination** 拥有最新用户意图和可选 Project 挂载依赖。它可以立即
   选择已有 model，但只有当前 intent 才能提交导航、焦点、reveal 或 preview 状态。
4. **Editor Group 与 Explorer** 是互相独立的投影。Editor Group 拥有 active、preview、
   pinned 和 Tab 顺序；Explorer 拥有展开、选择、键盘焦点、目录快照和 reveal。

文件 intent 中的 source Agent 只提供 workspace 访问上下文；它无权激活该 Agent 的
Terminal 或 Chat、展开 Agent 列表，也无权替换 editor surface。Agent reveal request
是一次性导航事件；每个 request identity 只能被消费一次，因此后续 Agent inventory
刷新或 Project section remount 都不能重放旧 reveal，覆盖用户手动收起的选择。Reveal
request 只在对应 Agent Terminal 是可见主 surface 时有效；进入 editor 会撤销并清除它。

不建立一个包办四类职责的 Project Files 总协调器，也不把可以从 owner 推导出的状态
复制到其他 owner。

## Resource 与 Resolve 模型

资源模型可以是 absent、resolving、ready、dirty、saving、conflicted 或 failed。这些
名称描述可观察的转换；实现可以继续使用现有 record、Promise 和 request guard 表达。

| 当前状态 | 触发 | 效果与下一状态 |
| --- | --- | --- |
| absent | open | 启动一次有界读取，进入 resolving。 |
| resolving | 再次打开同一资源 | 加入已有读取，并合并最新 open target。 |
| resolving | 打开其他资源 | 撤销旧 UI intent；共享读取可以完成，但不能提交旧 intent。 |
| ready | select 或 reopen | 不发传输请求、不新建 editor model，立即激活。 |
| retained watched clean | reopen | 立即激活，随后由 watch ready 异步权威校验。 |
| retained unwatchable | reopen | 保留权威 read 路径，并在可行时复用 editor model。 |
| ready | watch invalidation | 合并并排队一次有界权威 reload。 |
| dirty | watch invalidation | 保留 draft；权威版本不同时进入 conflicted。 |
| dirty | save | 捕获 revision 与 baseline，进入 saving。 |
| saving | 出现更新编辑 | 保留新 draft；save 完成只能提交其捕获的 revision。 |
| saving | 冲突或结果不确定 | 保留 draft；先从权威状态 reconcile，再允许 retry 或 overwrite。 |
| 任意状态 | rename、move 或 delete | reconcile 资源 identity，并使受影响的 retained snapshot 失效。 |

资源快照缓存不是文件系统权威，它只用于让最近导航立即发生。首次成功 read 本身已经
是权威结果，所以初次 watch-ready 确认不能马上重复读取同一文件。重新打开 retained
watched model 时可以立即绘制，并通过 watch readiness 异步 revalidate；重连后的
readiness 必须 revalidate 所有已打开 watched file，因为断线期间可能丢失事件。新的
invalidation 会取代旧的后台 reload；preview 被关闭或替换后，没有 open-file owner 的
reload 必须取消。clean stale model 可以先显示并在后台做有界 reload，但 dirty model
绝不能被该 reload 覆盖。没有该 watch 契约的 global、external 和 symbolic-link 资源
在 reopen 时继续执行权威 read，但仍可保留并复用 editor model。

同一物理路径可能通过不同 access owner 到达，例如 global root 与已挂载 Project，或
两个嵌套 Project。retained content snapshot 不能跨越 owner 边界；新 owner 必须执行
权威 read，并建立自己的 watch 与 authorization 语义。完成 read 后，Editor Group
仍可复用已有 Tab 和 Monaco model。

## File Open Transaction

文件打开 intent 可以是 selected、resolving、waiting-for-mount、committed、cancelled
或 failed。必须满足以下不变量：

- 一个 canonical resource 同时最多存在一个 transport resolve；
- 较新的不同资源 intent 不会被较旧结果覆盖；
- 同一资源的重复 intent 共享 resolve，最新 cursor、focus、view 与 reveal target 生效；
- 由 open-file owner 而不是可能过时的 render snapshot 决定 intent 是选择已有 model
  还是启动 resolve；
- 同一事务内以及 Tab 保持打开期间，pin 只能升级不能降级；
- 已挂载 Project 不在文件打开关键路径上重复执行 mount mutation；
- 同一缺失 Project 的并发 waiter 共享 mount mutation，取消一个 waiter 不取消公共 mutation；
- transport cancel 只是优化，latest-intent lease 才是最终提交条件。

Preview 是 Editor Group 创建 Tab 时的选择。选择已有 pinned Tab 不得将其重新变为
preview。替换 clean preview 只移除其 Tab 投影；有界的 resource model 和 editor model
可以继续保留，以便快速返回。

指针双击以第一次 click 命中的文件为准。打开该 preview 可能在第二击前移动虚拟列表
行；若原生 double-click 仍处于有界时间和指针距离内，但第二击落在空白或另一个文件
行，Explorer 必须拦截这个错位命中，并把 pin intent 提交给第一次命中的文件。无关
click、目录以及超出边界的手势不做恢复。

主指针手势由 pointerdown 开始时命中的文件行拥有。虚拟滚动、preview 渲染完成或
sticky Agent inventory 变化可能在 pointerup 前移动内容，但不得把该手势重新定向到
Agent 行或其他导航 surface。文件行通过 pointer capture 保持该所有权；行内按钮仍
保留各自普通的 button 行为。

## Directory 与 Mutation 模型

目录快照继续由 Explorer owner 管理 absent、loading、ready、failed。相同目录读取
合并；workspace 改变使旧结果失效；展开意图不依赖读取完成。目录缓存不成为文件内容
model。

Create、save、rename、move 和 delete 继续使用版本校验。timeout 或 response loss 表示
结果不确定，不能直接当作失败：必须重新读取文件或父目录进行 reconcile，不能盲目
重放。成功 mutation 通过现有 owner 刷新或失效相关目录快照、retained resource model、
open working copy、Tab 与 reveal target。

## 性能契约

在根据真实数据制定数值预算前，先保证以下定性 fast path：

- 选择 open model 是同步操作，不产生文件系统请求；
- 返回 retained watched clean model 时，不等待网络即可绘制；
- 同一资源的并发首次打开只读取一次；
- 文件切换复用现有 editor instance，并在存在时复用 retained Monaco model；
- watch burst 按 exact resource 合并，绝不递归刷新整个 Project；
- editor model 自动发起的 Language Server 工作必须遵守 Monaco cancellation；已被替代的
  semantic tokens、inlay hints、document symbols 请求必须释放浏览器 transport slot，
  不能占用连接直到 Language Server timeout 并阻塞下一个文件内容读取；
- retained model 同时受条目数量和近似内容字节数限制；
- directory、search、Git、preview 和文件内容工作都按需且独立有界。

观测应分别记录 user intent、cache lookup、transport read、optional mount、state commit
和 editor paint；路径与文件内容不能成为 telemetry 字段。只有取得代表性 baseline 后，
才引入数值 latency gate。

## 恢复与验收

断线与重连不需要 Terminal 式 checkpoint 或 delta 序列。File watch message 只是
invalidation hint。重连后恢复 exact watch，ready handshake 安排权威 reload，再由当前
version 决定 clean content 是否更新或 dirty draft 是否冲突。
watch 恢复期间若暂时无法验证 cached snapshot，则保留当前可见快照，并由连接健康
状态继续负责恢复；真实文件系统 invalidation 发生后仍无法读取，则保留可见文件错误。

测试至少从上述转换推导以下场景：

- 单击、双击以及同文件 click/double-click 重叠；
- Language Server 缓慢或不可用时，跨足够多文件和目录快速随机切换，使共享 Workspace
  Transport 的 Background Lane 达到饱和；
- 慢旧文件之后打开快新文件，包括跨 Project；
- 选择 pinned Tab 不发生 preview 降级；
- 用户手动收起 Agent 列表后，文件打开和 Agent inventory 刷新都不得自动展开；显式
  的后续 Agent 导航仍可 reveal；
- 文件 pointerdown 后、pointerup 前发生 sticky Agent 布局变化时，文件仍应打开，
  Agent 仍保持未激活；
- 首次 preview 导致指针下方行移动的双击，包括第二击落到空白和其他文件两种情况；
- 同文件重复首次打开只有一次 transport read；
- preview 替换后立即从 cache 返回，同时异步 revalidate；
- 取消一个 Project mount waiter 时公共 membership 仍完成；
- clean、dirty、saving、closed、renamed、deleted 资源的 watch invalidation；
- 有界 model 淘汰后按普通权威路径重新打开；
- 同一物理文件从 global/external owner 切换到 mounted Project 时，必须在重新绑定
  Tab 前执行新的权威 read；
- 跨多目录和多文件类型、可用 seed 重放的 cold/warm 类人操作，包含单击、双击、
  文件树滚动与展开收起、Tab 拖动、侧栏调整，并保存操作日志和最终截图。
