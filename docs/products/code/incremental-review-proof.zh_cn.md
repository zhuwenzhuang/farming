# 增量正确性证明式 Review

> 状态：产品方向与未来工作。本文不表示这些能力已经完整发布。

## 产品出发点

Farming Review 不应该把一轮 Agent 修改、一个 patch 或一次单文件编辑当成主要审阅单位。真正需要持续存在的单位，是一个不断演进的变更，以及围绕这个变更逐轮建立“为什么它已经足够正确、可以集成”的过程。

第一次 Review 可能会看到很多文件和大量 Diff。此时人的注意力更应该用来发现架构错误、代码坏味道、边界破坏、遗漏场景，以及判断某部分是否应该推翻重来，而不是逐行读完所有代码。后续 revision 可能仍然包含很多最终 Diff，但 Reviewer 默认应该看到的是：相比上次审阅真正改变了什么、之前的问题如何处理、是否出现新风险，以及哪些证据已经失效。只有当设计和行为逐步收敛后，具体实现细节和小范围改进意见才更值得占用注意力。

这个过程既要支持逐步改进，也要允许推翻或替换实现。无论走哪条路径，都不能丢失之前的 Finding、判断、revision 历史和正确性证据。

目标不是“把 Diff 看完”，而是为当前 revision 建立一条有证据支撑的正确性说明，证明要求覆盖的行为和场景已经成立。重要场景应先通过定向验证建立证据，随后再用集成和回归测试完成 Review 收口。

## 以状态转换为核心的正确性

在业务需求已经明确之后，功能设计首先应该确定状态及其转换，而不是直接进入页面、接口或代码结构。这里的状态不是任意堆叠的 UI flag，而是足以解释业务行为的最小权威状态；每条转换都应该说明触发条件、前置条件、状态效果、失败结果，以及重试、取消、并发、恢复和重复执行时的语义。

状态机应尽量简化：合并行为上无法区分的状态，删除没有业务意义的中间态，避免同一事实由多个模块分别维护，并让非法转换在系统边界被明确拒绝。状态越少、转换越明确，正确性越容易证明，运行时也越不容易进入无法解释的组合状态。

Review 的核心任务，是证明这套状态转换对于当前 revision 是正确的。正确性至少包含两类义务：

- **安全性（Safety）**：非预期的坏状态不可达。每条合法转换都必须保持关键不变量，过期响应、重复请求、并发操作、局部失败、进程重启和恢复流程都不能把系统带入静默丢数据、错误归属、越权、状态互相矛盾或无法恢复的最终状态。
- **活性（Liveness）**：在明确写出的外部前提和调度假设成立时，期望的好状态最终可达。每个 loading、pending、switching、recovering 等暂态都必须有成功、失败、取消、超时或恢复出口；系统不能永久等待，也不能只能依赖用户刷新或重启来偶然前进。

因此，一个重要功能的 Review 不应只问“最终画面或返回值对不对”，还要能回答：

1. 谁拥有权威状态，最小状态集合是什么？
2. 哪些事件允许触发哪些转换，guard、effect 和终止结果分别是什么？
3. 必须始终成立的安全性不变量是什么，哪些坏状态必须证明不可达？
4. 每个暂态靠什么持续推进，期望状态在什么假设下最终一定可达？
5. 并发、乱序、重试、取消、断连、重启和部分失败会产生哪些反例序列？
6. 当前 revision 的代码检查、测试、日志和真实交互分别为哪些证明义务提供证据？

测试是证明链中的证据，不等于单独完成证明。测试设计应从状态转换表和不变量派生，既覆盖合法路径，也覆盖非法转换和可能破坏安全性或活性的事件序列；对于无法穷举的状态空间，还需要明确推理、边界约束和保守的失败行为。相关转换发生变化时，对应证据应失效并重新验证。

当安全性和活性已经建立，Review 才进入第二层设计判断：状态是否还能更少、正确性是否更容易证明、职责是否高内聚低耦合、接口是否让非法使用难以表达，以及人机交互是否清楚呈现当前状态、可用动作和恢复路径。这些不是正确性的替代品，而是让正确实现更简单、更可信、更容易长期维护的设计质量。

## 稳定的 Review 身份

一个 Review 应该跨越多轮 Agent turn、多个 revision 和多个参与 Agent。Agent turn 是 revision 的来源和 provenance，不是产品边界。

Review 自身需要持有：

- 变更意图、base、作用域和当前 revision；
- revision 历史与贡献来源；
- Finding 及其生命周期；
- 必须证明的 Correctness Case 和不变量；
- Evidence，以及它所属的 revision 和新鲜度；
- 尚未解决的决策、已接受风险和 readiness 状态。

同一个 Review 可以经历小 patch、多 Agent 批量修改，或一套替代实现。只要产品意图没有发生根本变化，推翻重写也应该成为这个 Review 内的新 revision lineage，而不是丢掉之前的审阅上下文。

## 两种比较承担不同职责

每个 revision 都应该保留两种视图：

- **Final change**：原始 base 到当前 revision，表示最终准备集成的完整变化，是权威结果。
- **Review delta**：上一次已审阅 revision 到当前 revision，表示本轮真正需要消耗注意力的增量，是下一轮 Review 的默认入口。

Final change 在多轮修改后仍可能很大。如果每次 Agent 回答后都要求人重新阅读它，不仅浪费注意力，还会掩盖这轮真正需要判断的变化。未变化区域应继续作为上下文随时可查，但不应自动回到默认注意力队列。

## 跨 Revision 的 Finding

Finding 表示一个持续存在的审阅问题，不是永久绑定在某一行号上的 comment。它可以指向文件、hunk、symbol、场景或架构区域，但代码移动或 revision 更新后，Finding 的身份不能随之消失。

最小生命周期包括：

- **Open**：仍然需要修改或决策；
- **Addressed**：Agent 声称某个 revision 已经处理；
- **Verified**：人或被接受的验证策略确认问题已经解决；
- **Reopened**：新证据或回归让问题重新成立；
- **Accepted risk**：问题已经理解，但明确决定不修改。

Agent 可以提出“已经处理”，但不能静默关闭人的审阅问题。跨 revision 无法可靠重新定位时，Farming 应保留 Finding 并请求确认，而不是把它丢掉。

## Correctness Case 与 Evidence

Correctness Case 描述这项变更必须满足的一个行为、场景或不变量。例如：切换 runtime 时保留同一个 session、拒绝覆盖更新的文件编辑、server 重启后恢复仍在运行的进程。

每个 Case 应包含：

- 要证明的 claim 及作用域；
- 风险或失败影响；
- 相关代码路径或组件；
- 要求的证据；
- 当前证据及其 revision；
- 未证明、部分证明、当前 revision 已证明、被挑战或已失效等状态。

测试、日志、浏览器观察、代码检查和人的推理都是 Evidence，但任何一种都不是无条件证明。一个成功结果只对声明的场景和 revision 有效。相关代码变化后，Farming 应保守地把受影响证据标为 Stale，并把对应 Case 放回注意力队列。

因此 readiness 应表达为“Revision 4 上要求的 8 个场景都有当前有效证据”，而不是声称代码绝对正确，或给出一个含义模糊的置信度百分比。

## 面向注意力的 Review 体验

默认 Review 页面首先应该回答：**现在还有什么需要人判断？**

它应该优先展示：

- 新出现的高风险 Finding；
- 等待验证的既有 Finding；
- 有争议的 Agent 回复或待决策事项；
- 缺失证据或证据失效的 Correctness Case；
- 可能推翻之前判断的实质性 revision 增量；
- 最能推进当前 Review 的下一个动作。

文件、hunk、raw diff、Agent turn 和命令输出仍然是可下钻的证据，但不能仅仅因为容易枚举，就支配默认页面。

一个紧凑状态可以是：

```text
Review: ACP Chat runtime
Revision 4 · Final change 共 23 个文件

需要你的判断
  1 个新设计风险
  2 个 Finding 等待验证
  1 个 Correctness Case 已失效

相比上次 Review
  4 个 Finding 已处理
  7 个文件发生实质变化
  新增 2 项场景证明
```

这是一条注意力队列，不是高密度项目管理 Dashboard。产品应该渐进展示细节，并始终让尚未解决的关键决策保持可见。

## Chat 与 File Changes 的职责

Chat 用于讨论意图、要求 Agent 修改、路由反馈，以及接收简洁进展。它不应该要求用户检查每个 turn 的文件列表。

一次 Agent 代码修改应推进或贡献到一个持续存在的 Review。Chat 中可以只显示：

```text
Review 已推进到 Revision 4
Final change 共 23 个文件 · 4 个 Finding 已处理 · 2 项证明失效
```

主要动作应该是继续 Review 或查看本轮 Review delta。单轮文件和准确 Diff 继续作为 provenance 保留，但不再定义主要产品模型。

## 集成 Readiness

集成与广泛回归测试负责收口证明链，不能替代设计 Review 和定向场景推理。

只有满足以下条件时，Review 才进入可集成状态：

- 阻塞 Finding 已验证、明确接受，或已被替代设计消除；
- 要求的 Correctness Case 对候选 revision 都有当前有效证据；
- 后续编辑导致失效的重要证据已经刷新；
- 未解决决策保持可见，并得到明确处理；
- 已按风险所需的层级检查完整 base-to-current 变化；
- 要求的集成与回归检查在同一个候选 revision 上通过。

集成失败会产生新 Evidence，并可能重新打开 Finding 或 Correctness Case。Readiness 只对一个具体 revision 有效，不是永久标签。

## 未来工作

当前不可变 review revision、final-change 与 fixes 比较、file-first Diff 加载、reviewed state 和 comments 是有价值的基础。长期产品仍需要：

1. 把最小状态集合、权威状态所有者、转换表、安全性不变量和活性义务纳入 Review 的一等正确性模型。
2. 跨多轮和多 Agent 保持稳定的 Review identity。
3. 明确表达增量 patch、多 Agent 批量修改和替代实现的 revision lineage。
4. 具有稳定身份、重新定位、回复、验证、Reopen 和 Accepted Risk 状态的 Finding。
5. 把 Correctness Case 做成一等对象，并保存有作用域和 revision 新鲜度的 Evidence。
6. 以新风险、未决事项、Review delta 和失效证明为中心的默认注意力队列。
7. 不假设单 Agent、单轮修改，可以批量路由到合适 Agent 的反馈机制。
8. 保守判断 revision 后哪些 Finding 和 Evidence 可能失效的规则。
9. 明确设计推理、状态转换验证、定向场景证明、集成与回归验证顺序的 readiness policy，而不是把测试成功当作 Review 全部。
10. 在 Chat 中汇报 Review 进展，不再让单轮 File Changes 成为主要交互。
11. 覆盖大 revision、整体重写、多 Agent 并行贡献、代码移动、Finding Reopen、Evidence 刷新失败，以及并发、乱序、重试、取消、断连和恢复的产品验证。

这些能力应该增量建设。在 Review、Finding、Correctness Case 和 Evidence 的稳定身份正确之前，不应引入一个全局“证明分数”，不应自动关闭人的 Finding，也不应先构建高密度流程 Dashboard。

## 非目标

- 每轮 Agent 修改后都要求重新检查每一行 Diff。
- 把一次绿色测试结果当作完整正确性证明。
- 没有明确状态转换和证明义务，就用 happy path 的最终输出推断功能正确。
- 用增量摘要隐藏完整 base-to-current 变化。
- 实现推翻重写后丢失之前的 Review 历史。
- 因为 Agent 声称已经修复，就自动解决人的 Finding。
- 把 Review 做成通用 Issue Tracker 或项目管理系统。
