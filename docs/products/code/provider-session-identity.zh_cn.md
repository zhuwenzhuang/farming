# Provider Session 持久身份

> English version: [provider-session-identity.md](./provider-session-identity.md)

Provider Session 是用户真正恢复、置顶到主页，并在 Chat 与 Terminal、Code 与 CRT
之间、以及重启前后都能认出的工作单位。它的身份是这个精确三元组：

```text
(provider, providerHomeId, sessionId)
```

`providerHomeId` 始终属于身份本身。同一个 `sessionId` 在两个 Agent Home 下是两个
不同的 Session；默认 Home 会被显式写出，而不是靠"缺省即默认"来暗示。

## 所有权

`shared/provider-session-identity.ts` 是这套编码的唯一所有者。Backend、Farming
Code 与 Farming CRT 都通过它解析身份，因此同一个三元组在任一界面生成的 key 都逐字节
相同。CRT 以经典脚本方式打包、无法 import shared 模块，因此内联了一份镜像实现；由测试
断言它与 shared codec 输出逐字节一致，而不是信任这份拷贝。

其他模块不得通过拼接或按 `:` 切分来构造或解析这些字符串。

## History 收敛

删除以 Provider History 为准。Agent Lifecycle 恢复完成后，只有在可用 Provider Home
的一次完整、稳定 Inventory 中确认某个三元组已不存在，Farming 才能移除保存的 Provider
Session 记录。扫描失败、加载期间源发生变化、达到完整性上限或 Provider Home 不可用，都不
构成删除证据。Live 或过渡中的 Agent、尚未物化的身份、未完成 Lifecycle Operation 或无法
验证的结构化 Runtime 也会阻止删除。确认删除后会移除过期的主页成员关系与 Farming Session
元数据；Run History 仍作为审计记录保留，但不属于可恢复的 Provider History。

## 编码形态

有两种持久字符串承载这个身份。

**provider session key** 用于持久成员关系、权威 Session 记录、前端 handle、DOM key
以及浏览器本地状态：

```text
agent-session:<provider>:~2~<providerHomeId>~<sessionId>
```

**resumed source** 记录某个 Agent 是通过恢复一个精确 Session 启动的：

```text
<provider>-history:~2~<providerHomeId>~<sessionId>
<provider>-history-fork:~2~<providerHomeId>~<sessionId>
```

fork 会开启一个新的 Provider Session，因此 fork source 永远不认领源 Session。从 fork
source 读出源三元组只是展示用途，由一个显式的非认领解析器负责；所有认领、handle 与别名
辅助函数遇到 fork source 都解析为空。

`~2~` 是版本标记，`~` 分隔各段。段内 `%` 写作 `%25`、`~` 写作 `%7E`，这两个大写转义就是
全部语法。只有当把解码结果重新编码能逐字节复现原段时该段才被接受，因此每一段都能精确
往返，任何载荷都不可能包含分隔符；而任何写入方产生不出的写法——裸 `%`、`%2F`、小写
`%7e`、不完整或结尾孤立的 `%` 序列、双重转义、带首尾空白的段——都会 fail closed，而不是
原样解码后又被规范化成另一个字符串。sessionId 合法地允许包含 `:`，且无需转义。

provider 与 Agent Home id 在编码与解码两侧都按权威字符集校验——`[a-z][a-z0-9_-]*`
与 `[A-Za-z0-9._-]+`，与恢复边界、设置边界执行的类别相同——因此非法字段既进不了持久
key，也不会从持久 key 中被读出来。sessionId 在这里保持不透明，由
`isSafeProviderSessionId` 在接受它的边界上负责校验。

外层 `agent-session:<provider>:` 前缀被保留，因为已有边界依赖它：设置校验、Session
索引，以及前端搜索目标。

## 版本标记为何存在

v2 之前的编码把 Agent Home 折叠进 sessionId：当 Home 不是 `default` 时写成
`agent-session:<provider>:home:<homeId>:<sessionId>`。由于 sessionId 合法地允许包含
`:`，这种写法是有歧义的：默认 Home 下的 Session `home:work:x` 与 Agent Home `work`
下的 Session `x` 会产生完全相同的字符串。resumed source 与前端 handle 有同样的歧义。
于是两个不同的 Session 可能共享同一个持久身份、同一条主页条目和同一次认领。

`~` 不在任何合法的 provider、Agent Home 与 v2 之前的 sessionId 字符集内。因此 `~2~`
载荷对任何 v2 之前的写入方都不可达，版本识别是精确的，而不是启发式的。`%` 没有这层保证：
它不是分隔符，不透明的 sessionId 可以包含它，转义它只是为了让转义映射保持单射。

## 兼容策略

所有新写入都是 v2。解码同时接受 v2 与两种 v2 之前的写法。

由于版本标记对 v2 之前的写入方不可达，带该标记的载荷就是 v2 载荷。格式损坏的 v2 载荷
属于损坏数据而不是 legacy，解码必须 fail closed：绝不退化为按 v2 之前的写法解释，否则
会编造出 `~2~…` 这样的 sessionId，并把持久状态绑定到任何写入方都不可能产生的三元组上。

v2 之前的载荷确实存在歧义，解码不做猜测：`home:<segment>:` 前缀优先，这正是旧解码器
采用的解释。因此在 v2 之前已持久化的身份仍然解析为它此前解析出的同一个三元组，不会
编造无法证明的解释。由此这条写法归 Home 作用域的那个三元组所有：只有当 v2 之前的别名
能解码回同一个三元组时才会为查找而复现它，因此碰撞的默认 Home Session 没有别名，也就
无法接管另一个 Session 的状态。

在关键路径上身份解析都是三元组精确的。活跃认领、成员顺序、未认领 Session 列举与去重
都比较解码后的三元组或规范 v2 key，绝不比较冒号拼接的字符串。v2 之前的 key 或 source
仍然认领它自己的三元组；仍持有 v2 之前 key 的客户端仍能解析、置顶与移除同一个 Session。

## 迁移

权威 Session 存储在读与写两侧都做规范化：

- 持久主页成员关系在写索引时按三元组规范化并去重，包含启动时的一次。v2 之前的别名与
  它的 v2 key 会合并为一条，因此迁移不会产生重复条目。
- Session 记录向调用方交出规范 key，下一次规范写入会把它持久化。磁盘上 v2 之前的写法
  被替换，而不是长期共存。
- 记录查找、成员移除与 Agent 绑定接受任一写法，并解析到同一条记录。

持久索引里可能同时存在同一三元组的两种写法。合并结果不能取决于持久化的键顺序，因此优先
级是显式的：v2 写法优先于 v2 之前的别名，因为只有 v2 构建会写出它。当两个同等权威的写法
指向不同记录时，该绑定被丢弃，由启动时的对账过程从权威记录重建；当两条记录认领同一个
三元组时，启动直接失败，而不是任选其一。

浏览器本地状态以 handle 为键，因此存储的 v2 之前 handle 会在加载时升级（Session 展示
状态），或通过既有别名机制解析（Composer 草稿）。更换 handle 不会丢掉用户的置顶或草稿。
存储的展示状态里可能同时存在同一三元组的 v2 之前别名与 v2 key，因此加载时按三元组分组而
不是按属性顺序处理，并采用同样显式的优先级：v2 写法优先；两个同等权威但互相冲突的写法会
丢弃该置顶或归档 override，而不是让最后一个属性取胜，从而让该 Session 停留在权威状态上。

handle 是不透明的。URL 参数、DOM 属性与 React key 的形态可以随版本变化，产品行为不可以。

### 回滚

Session 索引与设置里的 key 列表保持既有形态与版本，因此旧构建仍能解析这些文件；但它无法
解析 v2 key：它没有版本标记的概念，会把整个 `~2~<providerHomeId>~<sessionId>` 载荷读成
一个不透明的默认 Home sessionId。该 id 含 `~`，恢复边界的 sessionId 字符集会拒绝它，因此
那条成员条目指向旧构建找不到的 Session，其自动恢复会被跳过而不是把 Session 恢复回来。在
该构建上这个 Session 既没有主页行也没有记录绑定，而真实 Session 会作为未认领的历史
Session 重新出现。

在旧构建上手动恢复这条历史 Session 是一次写入，并不能靠"再升级回去"抵消：旧构建看不到已
存在的 v2 记录，于是会为同一个三元组再写出一条 v2 之前写法的记录。回到 v2 构建时，启动会
发现两条记录认领同一个三元组并直接失败，而不是任选其一，需要人工决定保留哪一条。在旧构建
上置顶或归档受影响的 Session 同样会写出需要 v2 构建对账的 v2 之前状态。

因此，操作者让既有 Config 直接降级时，只支持"读取"受影响的实例，不支持在其上做变更。
只读降级不会破坏任何东西，v2 构建再次运行时会从同一批记录解析出成员关系与绑定；而在降级
期间恢复或重新置顶受影响 Session 的情形，需要先人工对账。若操作者把旧构建直接指向已经由
新构建提交的状态，Farming 不承诺无条件恢复。

事务化远端部署不是这种直接降级。它在激活新 image 前为已停止的 Config 建立 checkpoint，
新 image 只迁移工作副本。激活失败时同时恢复旧 image 与 activation 前的 Config checkpoint，
因此旧 image 不会读取失败部署期间生成的 v2 状态；readiness 成功后才提交工作副本并删除
checkpoint。

Farming 不会为了让旧构建读到 v2 状态而额外写出 v2 之前的别名。那种写法本身有歧义，双写
会重新引入这套身份要消除的碰撞。

## 验收

身份 codec 拥有以下验收标准：

- 精确碰撞对——默认 Home 的 Session `home:work:x` 与 Agent Home `work` 下的 Session
  `x`——生成不同的 key、source 与 handle，且各自精确往返回自己的三元组。
- 任意 sessionId 都精确往返，包括含 `:`、`~`、`%` 以及伪造 `~2~` 前缀的取值；字段中含
  字面 `%` 或 `~` 的身份在解码后重新编码逐字节相同；非法的 provider 或 Agent Home id
  在编码与解码时都被拒绝，不会进入持久 key。
- 段内出现任何写入方产生不出的百分号序列——裸 `%`、`%2F`、小写 `%7e`、不完整或结尾孤立
  的 `%` 序列、双重转义、带首尾空白的段——在每个解码器（含 CRT 镜像）中都 fail closed，
  而不是被规范化成另一个字符串。
- 带版本标记但解析不成 v2 的载荷在每个解码器（含 CRT 镜像）中都 fail closed。
- 两种 v2 之前的写法都解码为其历史三元组，fork source 解码为 forked；有歧义的 v2 之前
  别名只提供给历史上拥有它的那个 Home 作用域三元组。
- CRT 输出与 shared codec 逐字节一致。
- 同一三元组的前端 handle 等于 Backend key。
- 启动迁移把 v2 之前的成员条目改写为 v2 且不产生第二条；remember 与 remove 接受任一
  写法。
- 索引中同一三元组的两种写法，无论持久化键顺序如何都解析到 v2 写法的绑定；同等权威且
  互相冲突的写法被丢弃；两条记录认领同一三元组时启动失败。
- v2 之前的 key、v2 之前的 source，以及 provider/session/home 字段，各自只认领自己的
  三元组，绝不认领碰撞的那个。
- pending fork——一个只带 fork source、尚未拥有自己 provider session id 的活跃 Agent——
  在 Code 与 CRT 中都不认领任何东西：没有主页 handle、不认领 Session 行、不产生指向源
  Session 的 Composer key 或别名，源 Session 仍在列表中且可恢复；fork 行仍可通过显式的
  非认领解析器展示源 id。
- 浏览器本地展示状态在两种持久属性顺序下加载结果相同：v2 之前的别名与它的 v2 key 合并为
  一条 promoted 条目，置顶/归档 override 由 v2 写法决定，两个同等权威且互相冲突的写法则
  丢弃该 override。
