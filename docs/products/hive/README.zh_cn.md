# Farming Hive

> English version: [README.md](./README.md)

Farming Hive 是一个拟议中的新产品皮肤：用 Farming 的方式复刻 Gas City 有价值的能力，但不继承 Gas City 那套难懂概念。

它不是另一个普通 agent session 皮肤。Farming Code 是 Codex / Claude / shell live session 的工作台；Farming Hive 是托管任务控制台。主角不是 agent terminal，而是“人交出去、系统应该持续推进、并且尽量少消耗人注意力”的任务。

## 产品定位

Farming Hive 要复刻的是 Gas City 的能力模型：

- 可持久化的托管任务；
- 可分派的 worker；
- 任务进展和多次尝试；
- 需要人注意的提醒；
- 任务消息；
- 成果和验收；
- 系统健康和事件历史。

但皮肤不应该把 `city`、`rig`、`bead`、`sling`、`formula` 这类 Gas City 词暴露成用户导航。它们可以留在 adapter 或实现层。用户看到的概念要少、直白、稳定。

## 蜂巢隐喻，工厂效果

蜂巢隐喻仍然是对的。它给 Farming 一个安静、有生命感、可观察的表面：很多小工人在后台移动，人只在需要注意时巡看，完成的成果可以被收集。

软件工厂是这个系统实际产生的运转效果，不是默认词汇。当 Farming Hive 做对时，底下应该像一座软件工厂：

- 任务进入可持久化队列；
- 工蜂领取或接收工作；
- 工作流把任务推过可重复步骤；
- 测试、review、judge 形成质检门；
- 成果被收集、验收、归档。

但用户可见概念仍然要尽量是人话。`项目`、`任务`、`工蜂`、`进展`、`提醒`、`成果` 是信息架构。`工蜂` 和 `收蜜` 可以保留为少量隐喻。`工厂`、`产线`、`工位`、`质检门` 可以出现在高级解释里，但默认 UI 不应该要求用户再学习一套工厂术语。

## 概念模型

Farming Hive 只保留六个主概念：

| 用户概念 | 含义 | Gas City 对应 | 工程对应 |
| --- | --- | --- | --- |
| 项目 | repo / workspace 边界。 | City / rig scope | Workspace / project scope |
| 任务 | 交给系统托管的工作项。 | Bead | Managed task |
| 工蜂 | 能干活的 agent 或 session。 | Agent | Worker / agent session |
| 进展 | 任务推进过程中发生了什么。 | Run / activity | Attempt timeline |
| 提醒 | 需要人类注意或决策的信号。 | Mail / blocked / needs-you / health signal | Attention signal |
| 成果 | 可以检查、接受、合并或归档的产物。 | Output / close result / artifact | Artifact / result |

允许保留两个轻量养蜂词：

- **工蜂**：用于表达 agent / worker。
- **收蜜**：可以作为验收成果的气质化动词。

但不要让养蜂词承担完整信息架构。蜂巢可以作为皮肤和空间隐喻存在，但不要让用户把蜂箱、蜂房、蜂巢、蜂群、蜂鸣这些相近词都当成独立产品概念。产品结构先用人话，养蜂只做气质和动效。

## Gas City 映射

这个皮肤本质上是 Gas City-like 机制的 Farming 化门面。

| Gas City 概念 | Farming Hive 用户概念 | 说明 |
| --- | --- | --- |
| Supervisor | 系统状态 | 放在 Health/Admin，不作为主导航。 |
| City | 项目 | 顶层托管工作空间。 |
| Rig | 项目 / worker 分组 | 只有在过滤或路由需要时暴露。 |
| Bead | 任务 | 最核心的工作单位。 |
| Sling | 派工蜂 | 是一个动作，不是需要用户学习的名词。 |
| Agent | 工蜂 | 可运行的 AI/session worker。 |
| Formula | 工作流模板 | 高级配置，不进入核心导航。 |
| Formula run | 一次尝试 / 进展记录 | 出现在任务详情的进展里。 |
| Mail | 提醒 / 消息 | 只有升级后才成为提醒。 |
| Activity | 进展 / 系统事件 | 用户任务进展和管理员事件历史要分开。 |
| Health | 系统状态 | 保留，但不抢托管任务主屏。 |

## 导航结构

第一版可以用这个结构：

```text
项目
任务
工蜂
提醒
成果
健康
```

默认首页应该是项目级指挥视图：

```text
项目：odps_src

需要查看        3
正在推进        7
等待验收        2
安静等待       12

重点提醒
最近成果
活跃工蜂
```

这个页面要快速回答四个问题：

1. 现在什么需要我看？
2. 什么正在动？
3. 什么可以验收？
4. 哪些工蜂卡住、空闲或过载？

## 核心用户故事

### 创建托管任务

用户创建一个任务，需要填写：

- 目标；
- 项目；
- 上下文；
- 验收标准；
- 可选工蜂偏好；
- 优先级。

按钮应该叫 `新建任务`，不要叫 `New bead`。

### 派工蜂

用户可以在任务详情里分派或改派工蜂。

用户可见文案应该是：

- `派工蜂`；
- `换个工蜂试试`；
- `暂停`；
- `继续`；
- `停止`。

底层动作可以映射到 Gas City 的 `sling`，但这个词不应该出现在皮肤里。

### 查看进展

每个任务都有进展时间线：

- 创建任务；
- 已分派；
- 工蜂开始；
- 查看文件；
- 执行命令/测试；
- 卡住；
- 产生成果；
- 等待验收；
- 已接受/已归档。

terminal/session 输出可以从进展里打开，但 terminal 是证据，不是页面主角。

### 处理提醒

提醒是经过筛选的人类注意力事件：

- 工蜂提出问题；
- 需要权限或凭证；
- 测试多次失败；
- 等待 merge/review；
- 工蜂疑似卡住；
- 系统健康会影响任务推进。

提醒不是普通小红点。提醒要告诉用户现在可以做什么决策。

### 验收成果

成果是任务产物：

- diff；
- 测试输出；
- 报告；
- 截图；
- PR；
- 命令 transcript；
- 最终总结。

成果主操作：

- `查看`；
- `接受`；
- `要求修改`；
- `归档`。

`收蜜` 可以作为视觉气质或辅助文案，但必须保留 `接受成果` 这种直白表达。

## 数据模型草图

皮肤可以建立在这组模型上：

```text
Project
  id
  name
  workspacePath

Task
  id
  projectId
  title
  goal
  acceptanceCriteria
  status
  priority
  assignedWorkerIds[]
  currentAttemptId?
  resultIds[]
  alertIds[]

Worker
  id
  provider
  sessionId
  projectId
  state
  currentTaskId?

Attempt
  id
  taskId
  workerId
  status
  timelineEvents[]

Alert
  id
  taskId?
  workerId?
  severity
  reason
  requestedDecision

Result
  id
  taskId
  type
  status
  artifactRefs[]
```

Gas City adapter 可以这样映射：

- bead -> Task；
- agent/session -> Worker；
- formula run/order run -> Attempt；
- mail/attention/health signals -> Alert；
- close result/artifacts -> Result。

## 视觉方向

养蜂隐喻影响动效和质感，不主导词汇：

- 工蜂可以表现为任务卡附近的小型活跃单位；
- 任务卡可以按蜂巢感排列，但标签仍叫 `任务`；
- 提醒可以轻微脉冲，不使用催促感强的小红点；
- 成果可以有“收集/收蜜”的完成感。

整体仍然要像工作工具。避免过度可爱或游戏化，让严肃 coding work 显得像玩具。

## 第一版原型范围

第一版原型要证明：

1. 项目页能一眼看到托管任务健康状态。
2. 任务可以被创建并分派给工蜂。
3. 任务详情能展示进展、提醒、terminal 证据和成果。
4. 用户可以验收成果并归档任务。
5. 系统健康可见，但不成为主屏。

这和 Farming Code 故意不同。Farming Code 从 session 和文件出发；Farming Hive 从任务和注意力出发。
