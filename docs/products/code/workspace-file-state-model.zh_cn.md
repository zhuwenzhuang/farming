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

1. **Workspace Access** 执行有界的 tree、read、write、watch 和 Git 请求。HTTP
   响应与 watch 事件不拥有编辑器状态。
2. **Workspace File Model** 拥有已解析快照、working copy、每个资源唯一的 pending
   resolve，以及最近使用 clean model 的有界保留。Model key 是 canonical workspace
   与 normalized path。
3. **File Open Coordination** 拥有最新用户意图和可选 Project 挂载依赖。它可以立即
   选择已有 model，但只有当前 intent 才能提交导航、焦点、reveal 或 preview 状态。
4. **Editor Group 与 Explorer** 是互相独立的投影。Editor Group 拥有 active、preview、
   pinned 和 Tab 顺序；Explorer 拥有展开、选择、键盘焦点、目录快照和 reveal。

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

资源快照缓存不是文件系统权威，它只用于让最近导航立即发生。打开文件的 exact-path
watch 及其 ready handshake 提供失效通知：clean stale model 可以先显示并在后台做有界
reload；dirty model 绝不能被该 reload 覆盖。没有该 watch 契约的 global、external 和
symbolic-link 资源在 reopen 时继续执行权威 read，但仍可保留并复用 editor model。

## File Open Transaction

文件打开 intent 可以是 selected、resolving、waiting-for-mount、committed、cancelled
或 failed。必须满足以下不变量：

- 一个 canonical resource 同时最多存在一个 transport resolve；
- 较新的不同资源 intent 不会被较旧结果覆盖；
- 同一资源的重复 intent 共享 resolve，最新 cursor、focus、view 与 reveal target 生效；
- 同一事务内以及 Tab 保持打开期间，pin 只能升级不能降级；
- 已挂载 Project 不在文件打开关键路径上重复执行 mount mutation；
- 同一缺失 Project 的并发 waiter 共享 mount mutation，取消一个 waiter 不取消公共 mutation；
- transport cancel 只是优化，latest-intent lease 才是最终提交条件。

Preview 是 Editor Group 创建 Tab 时的选择。选择已有 pinned Tab 不得将其重新变为
preview。替换 clean preview 只移除其 Tab 投影；有界的 resource model 和 editor model
可以继续保留，以便快速返回。

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
- retained model 同时受条目数量和近似内容字节数限制；
- directory、search、Git、preview 和文件内容工作都按需且独立有界。

观测应分别记录 user intent、cache lookup、transport read、optional mount、state commit
和 editor paint；路径与文件内容不能成为 telemetry 字段。只有取得代表性 baseline 后，
才引入数值 latency gate。

## 恢复与验收

断线与重连不需要 Terminal 式 checkpoint 或 delta 序列。File watch message 只是
invalidation hint。重连后恢复 exact watch，ready handshake 安排权威 reload，再由当前
version 决定 clean content 是否更新或 dirty draft 是否冲突。

测试至少从上述转换推导以下场景：

- 单击、双击以及同文件 click/double-click 重叠；
- 慢旧文件之后打开快新文件，包括跨 Project；
- 选择 pinned Tab 不发生 preview 降级；
- 同文件重复首次打开只有一次 transport read；
- preview 替换后立即从 cache 返回，同时异步 revalidate；
- 取消一个 Project mount waiter 时公共 membership 仍完成；
- clean、dirty、saving、closed、renamed、deleted 资源的 watch invalidation；
- 有界 model 淘汰后按普通权威路径重新打开。
