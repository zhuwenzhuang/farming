# 发布、测试反馈与问题调查效率改造方案

> English version: [release-pipeline-acceleration-plan.md](./release-pipeline-acceleration-plan.md)

状态：实施与计时验证中

本方案改造的是一条完整链路：维护者下令发布一个版本，系统检查精确候选，发现阻塞后定位并修复，
验证所有正式制品，确认 GitHub Release 已经公开可用，最后才发布 npm Package。

调查和修 Bug 的时间不从统计中排除。计时从接受发布请求开始，遇到失败或提交修复后不重置。

## 目标

- 正常端到端发布：不超过 10 分钟。
- 简单问题：拿到可操作失败证据后，3 分钟内完成归类、最小复现和最小修复。
- 复杂问题：3 分钟内完成归类并明确升级为根因调查，禁止无限猜测。
- 日常 CI 墙钟时间不能变慢。
- 日常 CI 不增加 LLM 或 Agent 轮询工作。
- 不减少现有平台、Package、Runtime、Provenance 和 Exact-SHA 验证要求。
- npm 是最后一个公开状态变更。在对应 GitHub Release 和必需资产确认公开可用之前，不得发布 npm。
- 最终发布的 npm Tarball 必须与 Package Smoke 实际通过的 Tarball 字节完全一致。

任何一次发布超过 10 分钟，完整耗时仍然计入。结果应记录为目标失败，并精确归因到调查、CI、
制品准备、正式发布、排队或外部服务，不能重新解释成开发时间。

## 三种运行场景

### 场景一：没有阻塞问题

精确候选没有发现新缺陷。完整 CI、Release Artifact Preparation 和 npm Package Smoke 并行运行；
GitHub Release 先公开并验证，最后发布 npm。整条链路必须在 10 分钟内完成。

### 场景二：遇到一个简单阻塞问题

Changed-area Fast Screen 与完整流水线同时运行，目标是在 2 分钟内暴露常见的 Metadata、
Test Oracle、Packaging Manifest 和 Focused Product Failure。Agent 在 3 分钟内完成归类、复现和
最小修复；修复后的候选再使用 10 分钟完成完整流水线。因此总目标是 15 分钟，计时不重置。

如果简单问题直到流水线后段才第一次暴露，本次发布记为未达标。必须把稳定 Failure Signature 和
Focused Reproduction 加入 Fast Screen，让同类问题以后能够提前发现。

### 场景三：某个领域存在较大的设计问题

这是常见情况。受影响领域进入 `blocked-design`，但整个发布 Campaign 不停止。所有相互独立的领域
继续 Build、Test、Fix 和收敛：

- 普通仓库检查；
- Browser 与 Interaction 行为；
- Linux 和 macOS Packaging；
- npm Package 构建与 Runtime Smoke；
- Release Metadata、Manifest 和 Publication Reconciliation。

Campaign 继续记录完整的设计问题解决时间；同时维护一份 Domain Ledger，记录每个领域的
`unknown`、`running`、`green`、`blocked`、`stale` 状态、已测试 SHA、Failure Signature 和证据。

阻塞领域解决后，所有受影响领域变成 `stale`，最终精确 SHA 重新运行完整并行流水线。旧领域结果
用于提前消除未知问题和预热确定性缓存，绝不能替代最终 Exact-SHA Evidence。从设计问题解决到
npm 验证完成，剩余发布必须在 10 分钟内完成。

## 强制发布准备门禁

测试属于计时中的完整 Release Campaign，不是发布计时开始前的可选活动。在所有必需准备证据收敛
之前，不得创建 Tag、公开 GitHub Release 或 npm Version。

锁定 Version、SHA、行为变化和选中场景后，所有可逆工作同时启动：

```text
Exact-SHA CI       平台制品            唯一 npm Tarball
自动化交互测试      真实 Provider 门禁   Computer Use Lanes
        \                 |                 /
         +------- Preparation Ledger ------+
                         |
                  公开 GitHub Release
                         |
                     公开验证
                         |
                     发布 npm
```

中间 Fan-out 的墙钟预算为 7 分钟。GitHub 公开、公开验证和 npm 发布保持串行，使用剩余预算。

Fan-out 开始前，Release Preflight 必须从公共 npm Registry 查询固定的 Codex/Claude ACP Adapter、
ACP SDK 和受管 Codex Runtime 的 `latest` 版本。Claude ACP 更新与 Codex 维护绑定：当两个受管
Codex Pin 都是最新版本时，新 Claude ACP 版本只作提示且不阻塞发布；当任一受管 Codex Pin 需要
更新时，必须在同一次维护中审查 Claude ACP 并将其更新到 `latest`。受管 Codex Runtime 更新只有
在该版本声明的所有平台包都已存在于公共 Registry 时才可执行；不完整的平台发布会被报告并继续
使用上一完整版本，因此不会触发 Claude 单独更新。Preflight 还会查询独立 Claude
Agent SDK 的最新版本，同时要求受管 Claude Runtime 与当前 Claude ACP Adapter 精确依赖的 SDK
版本一致；在 Adapter 采用新版 SDK 之前，独立 SDK 的结果仅作提示。Registry 查询失败或任一按
此策略必须更新的 Pin 与 `latest` 不一致时，必须在构建制品前 Fail Closed。维护者需要审查上游
变化，更新所有受影响的 Pin、已审查 Patch 与完整性 Hash，并重新运行必需的 Acceptance Evidence；
发现新版本本身并不能证明升级兼容。

### 候选提交触发的 Workflow 全覆盖

Release Coordinator 必须监控 Exact Candidate Push 创建的每个 Workflow，不能只盯 `CI` 和
`Release`。`scripts/watch-candidate-workflows.sh SHA` 负责发现这些 Push Run、记录状态，并在任一
Run 非成功结束时生成有边界的 Failure Bundle。

Candidate 触发的 Workflow 默认属于必需门禁，因为它的 Path Filter 已经证明本次 Push 修改了对应
领域。特别是 Candidate 触发 `Documentation` 时，GitHub Pages Deployment 必须成功，Release
Acceptance 才能变成成功，npm 才允许发布。其他 SHA 的历史失败必须作为仓库健康信息报告，但不能
误阻塞当前 Candidate。

GitHub Pages 正常会在数秒内离开 `deployment_queued`。Documentation Workflow 将该等待限制为
3 分钟，并使用当前 Node 24 版本的 `deploy-pages` Action。超时归类为 External Provider Failure，
完整计入发布耗时；不能通过重复执行完整文档构建或延长隐藏等待来掩盖。其他独立准备 Lane 继续
运行，Documentation Domain 保持 Blocked。

该规则来自 2026-08-06 的 Documentation `#18`：文档 Build 与 Artifact Upload 在 28 秒内完成，
但 Pages 在 `deployment_queued` 停满 Action 默认的 10 分钟。只重试 Deploy，以及重新执行一次
23 秒的新 Build，都复现了相同队列卡住。现在由 Candidate Workflow 总监控自动发现该领域，并由
Workflow 在 3 分钟内把外部故障变成明确的终态。

### 自动化交互与 Computer Use 分开

Playwright Human Story 和真实 Provider Browser Composite 属于自动化交互门禁。Computer Use 表示
Agent 通过 Computer Tool 操作真实 Desktop。二者的证据和调度不能混为一谈。

自动化门禁包括：

- 普通产品发布运行不超过 90 秒的真实 Codex 基线；
- 每个发生行为变化的领域运行 Owning Playwright 或 Product Smoke；
- 只有 Shared Lifecycle、Protocol、Provider、Session Identity 或 Cross-runtime 变化时，才运行
  真实 Provider Code/CRT/Terminal Composite。

Computer Use 使用远端 Linux 的 Isolated Docker Desktop 池。Release Coordinator 为每个独立场景
创建一个 Agent 和一个归其所有的 Computer Resource。每条 Lane 拥有隔离的 Desktop、Profile、
Workspace/Fixture 和 Evidence Directory。同一 Lane 内的操作串行，不同 Lane 并发。

Campaign 开始时，Coordinator 为 Candidate 创建唯一的 Commit Status Context，并将自动化/Computer
Use Acceptance 标记为 `pending`。`release.yml` 只准备并保留精确 Candidate 的 Artifact，不执行任何
公开 Mutation。所有必需 Interaction Lane 都 Green 后，Coordinator 标记 `success`，并使用精确
Candidate SHA、成功的 Preparation Run ID 和 Acceptance Context 调度 `publish-release.yml`。
Publication 只校验一次这三个身份，只下载该 Run 的 Artifact；门禁未就绪时直接 Fail Closed，不在
Hosted Runner 中等待，也不重新构建 Artifact。

Computer Use 分三层选择：

| 层级 | 使用方式 |
| --- | --- |
| Sanity | 在精确 Candidate 上完成一个普通可见操作；产品行为发布必须执行，除非更强场景已经覆盖 |
| Focused Domain | 每个变化行为执行从用户操作到最终状态的最短完整旅程 |
| Continuity Composite | Shared Lifecycle 或多个领域相互作用变化时，同一个 Session 连续经过所有受影响表面和状态转换 |

分享/权限、Chat/ACP、Terminal、CRT、Browser/Computer 和响应式外观可以拆成独立并发 Lane。
原生 macOS Desktop/LSP 行为必须使用 Mac Lane，不能由 Linux Container 替代。

每条 Lane 记录 Candidate SHA、Scenario、Agent 与 Computer Resource Identity、Container/Image
Identity、时间、Screenshot、Computer Action Trace、Backend/Provider Evidence、结果和 Failure
Signature。成功资源按精确 Identity 删除；失败 Desktop 只在有边界的调查期间保留。

### 失败收敛与失效规则

一条 Lane 失败不会重启整个 Fan-out。独立的 CI、Packaging、Automation 和 Computer Use Lane
继续执行。修复前必须保留首次证据，并把失败缩小到一个用户操作、权威状态 Owner、被破坏的不变量
和引入改动。

提交 Fix 后，最终 Exact-SHA CI、Artifact、npm Tarball Smoke 和真实 Provider Baseline 必须重跑，
因为其身份已经变化。只有 Journey、Input 或 Shared Contract 被修改的 Computer Use Lane 才变为
`stale`。未受影响 Lane 只能在记录原 SHA 和明确的 Diff-based Invalidation Proof 后沿用，绝不能
表示为 Exact-SHA Artifact Evidence。

### 2026-08-06 分层门禁组件计时验证

下一个精确版本发布前，分别实测了各层门禁：

| 组件 | 实测墙钟时间 |
| --- | ---: |
| 最终本地 `npm run check`，303/303 Tests Green | 1 分 51.03 秒 |
| Focused Sharing Playwright，包含本地 Build/Start | 15.20 秒 |
| 真实 Codex Baseline，包含本地 Build/Start | 15.43 秒 |
| 完整真实 Provider Code/CRT/Terminal Composite | 2 分 11.42 秒 |
| 4 个 Isolated Linux Desktop 并行启动到 Healthy | 12.809 秒 |

远端 Desktop 测量期间，已有 5 个 Computer Container 保持 Healthy；4 个计时 Container 随后均按
精确 Identity 删除。这个结果证明 Desktop Pool 的启动速度和并发容量，不代表多个 Agent 完成
Computer Use Journey 的时间。完整 Lane 时间必须在下一个 Exact Candidate Deployment 上实测，
并计入 Release Campaign。

### 2026-08-06 当前端到端现状

当前正常发布估算公式是：

```text
约 20 秒 Candidate 选择与调度
+ max(Exact-SHA CI、Artifact、自动化交互、Computer Use)
+ 约 2 分钟串行 GitHub 验证与 npm 发布
```

最近一次完整端到端发布 v2.2.45 用时 10 分 4 秒，其中 Exact-SHA CI 为 7 分 47 秒，全部 Artifact
在 4 分 26 秒内就绪。新自动化交互门禁低于这条关键路径：当前最重 Composite 实测为 2 分
11.42 秒。

如果最慢的并行 Computer Use Lane 能在 7 分钟内完成，正常发布预计仍为约 9 分 30 秒到 10 分钟。
这是当前运行估算，还不是新的完整端到端证明。必须在下一个 Exact Candidate 上实测完整的多 Agent
Computer Use Fan-out 与 Publication Path，才能认为 10 分钟目标已经得到验证。

## v2.2.41 基线

下午发布 Session 从 13:22 持续到 17:20。六次 CI 合计 90 分钟，两次 Release 合计 23 分钟，
本地审查、定位和修复约 127 分钟。

| 时间 | 事件 | 耗时 |
| --- | --- | ---: |
| 13:22–13:56 | 审查 32 个修改文件并形成首个候选 | 34 分钟 |
| 13:56–14:00 | CI 发现 5 个后端测试失败 | 4 分钟 |
| 14:00–14:08 | 修复 Package Image 校验 | 8 分钟 |
| 14:09–14:25 | CI 发现浏览器测试失败 | 17 分钟 |
| 14:25–14:31 | 修复 Transcript Focus 测试准备 | 5 分钟 |
| 14:31–14:48 | CI 发现 Persisted Anchor 失败 | 17 分钟 |
| 14:48–15:17 | 修改 Anchor 恢复和测试 | 29 分钟 |
| 15:18–15:35 | CI 成功 | 17 分钟 |
| 15:35–15:40 | Release 发现 Native CLI 漏打 Computer Schema | 5 分钟 |
| 15:40–15:46 | 修复 Native CLI Packaging | 6 分钟 |
| 15:47–16:04 | CI 再次暴露 Persisted Anchor 失败 | 18 分钟 |
| 16:05–16:44 | 修正测试生命周期和 Test Oracle | 39 分钟 |
| 16:44–17:01 | 最终 CI 成功 | 17 分钟 |
| 17:02–17:20 | 最终 Release 成功 | 19 分钟 |

最终成功的 Release Workflow 用时 18 分 39 秒：

| 阶段 | 实际耗时 |
| --- | ---: |
| 候选预检 | 8 秒 |
| macOS arm64 产物 | 2 分 40 秒 |
| macOS x64 产物 | 5 分 5 秒 |
| Linux 产物 | 9 分 22 秒 |
| npm Job | 6 分 59 秒 |
| 准备 GitHub Release | 1 分 42 秒 |
| 公开 GitHub Release | 5 秒 |

## v2.2.42 计时结果与第二轮发现

第一轮加速候选 SHA 为 `e4afb2fd261746cdf5baed3207911a4aab467ca6`。Exact-SHA CI 用时
9 分 17 秒；GitHub Release 在 16 分 8 秒时公开。最后 npm Job 失败并保持未发布，安全顺序生效。

| 关键路径 | 实测耗时 | 直接原因 |
| --- | ---: | --- |
| CI | 9 分 17 秒 | Chromium Shard 9 的测试执行 6 分 3 秒；iPhone WebKit 的 `npm ci` 用了 3 分 54 秒 |
| Linux 制品 | 10 分 21 秒 | CLI、标准 App 和 Legacy App 的 Build/Smoke 串行 |
| macOS x64 制品 | 7 分 12 秒 | CLI 与 App 串行 |
| macOS arm64 制品 | 13 分 55 秒 | `npm ci` 5 分 23 秒，App 解压与 Smoke 4 分 6 秒 |
| Stage GitHub Release | 1 分 37 秒 | 安装依赖 30 秒，Manifest 对大型资产重复 Hash |
| npm 发布 | 13 秒后失败 | npm 12 把缺少 `./` 的 Tarball 路径误判为 GitHub Package Specifier（`EALLOWGIT`） |

macOS arm64 日志证明主要问题不是 Runner 排队，而是安装阶段的无效工作：仓库 `npm ci` 执行了
Farming 面向正式安装的 Postinstall，向一次性工作区下载 Claude Code 和 agent-browser，生成约
846MB Runtime Seed；慢 Mirror 失败后又回退到公共 npm Registry。源码 CI 和 Release Build Checkout
不会消费这份 Seed。

因此第二轮将下列改造一次完成：

- 源码 CI 与 Release Preparation 跳过正式安装形态的 Runtime Seed 准备；
- Linux CLI、标准 App、Legacy App 拆成三个并行 Job；
- 每个 macOS 架构的 CLI 与 App 拆成两个并行 Job；
- App Smoke 直接测试精确保留的 Assembly Directory，不再刚压缩完又完整解压后测试；
- 已压缩制品使用 Artifact Compression Level 0；
- Manifest 复用已生成 Checksum，不再把全部大型资产 Hash 两遍；
- Chromium 使用 12 个文件级 Shard，只在失败时上传 Trace、Screenshot 和 Report；
- npm Publish 使用明确的相对 Tarball 路径。

## v2.2.43 计时结果与第三轮改造

v2.2.43 从接受精确候选到 npm 验证成功共 12 分 41 秒。Release Artifact Preparation 已不再是
关键路径：全部平台与 npm 制品在 4 分 52 秒内完成验证；剩余时间主要在 Exact-SHA CI 和发布尾段。

| 剩余工作 | 实测耗时或延迟 |
| --- | ---: |
| 全部可逆 Release Artifact Preparation | 4 分 52 秒 |
| Exact-SHA CI | 8 分 38 秒 |
| 实测账号 20 Job 上限导致 Chromium Shard 3 排队 | 2 分 5 秒 |
| 最慢 Chromium 测试执行 | 6 分 15 秒 |
| Stage GitHub Release | 1 分 23 秒 |
| npm Publish 与 `gitHead` 可见 | 1 分 15 秒 |

下一轮不再继续制造排队 Job，而是按实测远端容量配平：

- 9 个 Chromium Job 使用均衡单 Worker 分配；344 个测试分配为
  39/39/38/38/38/38/38/38/38；
- 删除专门占用 Hosted Runner 等待 CI 的 Job；
- Release Stage 在 CI 尾段同时下载并 Hash 已验证资产，只在创建 Tag/Draft 前检查 Exact-SHA CI；
- App Job 携带已验证的 `RELEASE.json` Sidecar，Manifest 不再重新读取四个大型压缩包；
- npm Publish 关闭 2 万文件 Notice 清单，并删除 Publication Job 中无必要的 npm 全局升级。

## v2.2.44 计时结果与第四轮改造

v2.2.44 在 9 分 48 秒时完成 GitHub Release 公开与验证，但 npm 在第 11 分 6 秒失败并保持未发布；
CI 仍用时 8 分 30 秒。

剩余原因已经精确定位：

- Playwright 内置 Fully-parallel Sharding 按测试列表的连续区间均衡数量。Shard 6 连续拿到 20 个
  Pet 慢测试，成为 6 分 50 秒 Job，而其他 Shard 提前完成。
- 删除 npm CLI 升级后使用了 Runner 自带 npm 10；它无法完成仓库当前 OIDC Trusted Publishing
  路径，50 秒后 Registry PUT 返回 404。因此 npm 12 是发布依赖，不是可以删除的准备浪费。

第四轮恢复 npm 12，并使用仓库脚本发现精确测试位置，把相邻 Location Group 条纹分散到 9 个
Shard。每个 Shard 仍然是单 Worker；共享同一源码位置的 Generated Test 保持原子分组。

## v2.2.45 计时结果与第五轮改造

修正后的 v2.2.45 Candidate 在 7 分 47 秒完成 Exact-SHA CI，GitHub 与 npm 全部发布完成用时
10 分 4 秒。所有发布制品在 4 分 26 秒内就绪，因此平台 Packaging 已经不是关键路径。包含第一
个失败 Candidate 的 Quick-fix Campaign 总耗时 15 分 24 秒。

最后超出的 4 秒来自两个明确尾部：

- Chromium Shard 4 虽然同样只有 38 个测试，仍执行了 6 分 10 秒。逐测试实测显示其中一个测试
  约 75 秒，另有多个测试耗时 12 到 21 秒，说明“数量均衡”不等于“时长均衡”。
- CI 结束后，GitHub 发布、公开验证和 npm 发布分别调度三个 Job。所有可逆工作已经结束后，仍
  重复承担 Runner 排队、Checkout 和 Setup 延迟。

第五轮按实测 Location Duration 使用 Longest-processing-time 分配，仍然只用现有 9 个单 Worker
Chromium Job，不增加 CI 工作量和远端并行度；预测每个 Shard 为 266 到 273 秒。同时把 Staging、
GitHub 发布、公开资产验证和 npm 发布合并到一个 Job。npm Setup 和已验证 Tarball 下载在等待
Exact-SHA CI 时完成；npm 仍严格位于 GitHub 公开验证之后，作为最后一步。

仓库新增 `scripts/release-snapshot.sh`，一次采集初始 Candidate 状态；新增
`scripts/watch-run.sh`，由脚本持续监控并在失败时生成有边界的 Failure Bundle，Agent 不再反复
手工轮询。

## v2.2.55 复盘与 Artifact 复用改造

v2.2.55 从收到请求到 npm 验证总计 6 小时 46 分 12 秒，而最终通过验收的 Candidate 从开始发布到
npm 完成只用了 7 分 40 秒。Candidate 准备和缺陷收敛占据了主要时间，但 Workflow 还存在一项明确
浪费：Candidate Workflow 或 Computer Use Acceptance 晚于 Publication Job 的有界等待时，后续重试
会重新构建全部平台和 npm Artifact。

两次发布尝试量化了这项浪费：

- 一次等待 Candidate Workflow 8 分钟后失败；
- 一次等待 Computer Use Acceptance 10 分钟后失败；
- 每次重试都重新调度并构建约 5 分钟已经验证过的 Linux、macOS 和 npm Artifact。

现在 Release Preparation 与 Publication 已拆成两个 Workflow。`release.yml` 只构建、验证、Smoke 并
保存一次精确 Artifact。`publish-release.yml` 只接受 Workflow Path 和 `head_sha` 都与完整 Candidate
SHA 匹配的成功 Preparation Run，从该 Run 下载 Artifact，对 Candidate Push Workflow 和 Release
Acceptance 做一次权威校验，然后继续保持“GitHub 公开验证完成后才发布 npm”的顺序。Acceptance
晚到或 Publication 重试时，因此直接复用已验证 Artifact，不再重复 Platform Fan-out。

仓库同时新增 `npm run release:fast-screen`，并行执行 Release Metadata、Dependency Policy、Browser
Lifecycle、ACP Replacement、Packaging Identity 和 Workflow Contract 等独立门禁。2026-08-20 本地
实测 8 个门禁用时 3.06 秒，明显低于 2 分钟早期反馈目标。

## 已确认的浪费来源

### Agent 调查

- 首次 Push 前，Agent 跑了 Typecheck、Lint、Build 和 npm Smoke，却没有跑普通 CI 实际使用的
  `npm run check`，因此 5 个本地可发现的后端错误被推迟到 CI 才发现。
- Persisted Anchor 场景本地先后执行了 3、10、10、15 次重复。重复执行替代了单次状态转换取证。
- 下午 Session 执行了 31 次 `gh run view`、14 次 `gh run list`、8 次 `gh run watch`、
  51 次 `git diff`、24 次 `git status`、7 次 Typecheck 和 7 次 Lint。
- 远端 CI 多次承担“提供下一条调查信息”的职责，而不是只认证一个本地已经理解的修复。

### CI 反馈

- Browser Shard 必须等待 `Check` Job 全部完成，但 Frontend Build 本身只用了 11 秒。浏览器测试
  被迫等待前面约 4 分钟的仓库检查。
- Chromium 2/6 的浏览器执行约 10 分钟。由于 Playwright 使用 `fullyParallel: false`，大型 Spec
  文件不能继续拆分，六个 Shard 实际负载不均。
- CI 对失败测试重试两次可以保留证据，但第一次失败没有立即整理成简洁、可直接行动的诊断结果。

### Release Workflow

- Exact-SHA CI 已经执行 `npm run check`，Linux Artifact 又执行 3 分 58 秒，npm Job 第三次执行
  3 分 23 秒。
- CLI、普通 App Bundle 和 Legacy App Bundle 分别重新构建 Frontend/Runtime 输出。
- npm Smoke 打一份 Tarball，删除后正式发布又重新打另一份。
- 制品准备等待完整 CI，而不是在不公开的前提下与 CI 并行。
- 当前 npm 先于 GitHub Release 公开。
- Agent 反复查询 GitHub 状态，没有一个统一的失败诊断结果。

## 目标端到端流程

```text
收到精确 SHA 和 Version 的发布请求
                 |
                 v
          快速验证发布元数据
                 |
       +---------+-------------------+
       |         |                   |
       v         v                   v
    完整 CI   平台 Build/Verify   只打一次 npm tgz
              与 Smoke           Smoke 同一 tgz
       |         |                   |
       +---------+-------------------+
                 |
                 v
          组装 GitHub Draft Release
                 |
                 v
          正式公开 GitHub Release
                 |
                 v
      验证 Tag、资产、下载和 Checksum
                 |
                 v
          最后发布同一份 npm tgz
                 |
                 v
        验证 npm Version 和 gitHead
```

公开边界之前的制品准备是可逆操作，可以在 CI 成功前运行；但完整 CI 和所有 Artifact-specific
Smoke 没有对同一 SHA 全部成功之前，任何公开操作都不得启动。

场景二和场景三还需要一条 Domain Coordinator：

```text
Changed Files + Failure Signatures
              |
              v
        选择受影响领域
       |       |       |       |
       v       v       v       v
      Core   Browser  Package  Publication
       |       |       |       |
       +-------+-------+-------+
              |
              v
  Domain Ledger + Final Exact-SHA Invalidation
```

一个领域阻塞时，Coordinator 允许其他独立领域继续收敛。任何 Cross-cutting Change 都会让输入或
验收契约可能变化的领域失效。

## 改造 A：发布流水线

### A1. 拆分元数据预检和 CI Gate

- 快速 Metadata Job 验证 Version、Lockfile、Release Notes、Branch、Tag 和 npm Version 冲突。
- Exact-SHA CI Gate 继续等待必需的 CI Run。
- Platform Build 和 npm Preparation 只依赖 Metadata，因此与 CI Gate 同时运行。
- GitHub 和 npm 公开 Job 同时依赖 CI Gate 与全部 Preparation 成功。

### A2. 删除重复仓库检查

- 删除 Linux Artifact 和 npm Publication 中的 `npm run check`。
- Exact-SHA CI 继续作为普通仓库检查的权威门禁。
- 保留全部 Platform、Package、Architecture 和 Runtime Verify/Smoke。

按 2.2.41 实测，这一项直接从 Release 关键路径删除 7 分 21 秒，测试要求不降低。

### A3. 并行独立 Package，并保留精确 Assembly Output

- Linux CLI、标准 App Bundle、Legacy App Bundle 在同一 Metadata Gate 后作为三个并行 Job。
- 每个 macOS Architecture 的 Native CLI 与 App Bundle 作为两个并行 Job。
- 保留精确 App Assembly Directory 直到 Smoke 完成；Archive 继续完整 Verify，但 Smoke 不再先解压
  刚生成的大型 Archive。
- Exact-SHA CI 和全部 Package-specific Gate 变绿前，所有 Job 都保持可逆，不执行公开 Mutation。

### A6. 分开源码安装与正式产品安装

- Source CI 和 Release Build Checkout 设置 `FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1`；它们直接
  Build/Test 源码，不得生成 Package Installation Runtime Seed。
- npm Package Smoke 和 App Bundle Construction 继续保留各自安装形态的 Runtime 要求；该优化
  不降低正式制品的安装契约。
- Browser 下载继续由 Workflow 明确执行，依赖安装阶段不再静默下载第二份 Browser。

### A4. Smoke 和发布同一个 npm Tarball

- 扩展 npm Package Smoke，使其接受或导出明确 Tarball Path。
- Smoke 前和 Workflow Artifact 传输后都计算 SHA-256。
- 正式发布直接使用该 Tarball，不得再次运行 `prepack`、`npm pack` 或生产依赖安装。

### A5. npm 最后发布

- 使用全部已验证资产组装 GitHub Draft Release。
- 正式公开 GitHub Release。
- 验证公开 Tag Target、资产清单、Manifest、Checksum，并至少下载一个公开资产。
- 只有验证成功后才发布 npm，并核对 npm `gitHead`。

## 改造 B：测试与失败反馈

### B1. 更早启动 Browser Test

- 将 Frontend Artifact Production 从仓库 `Check` Job 中拆出。
- Frontend Production、`Check` 和 Node Compatibility 同时启动。
- Browser 和 Mobile Job 只依赖 Frontend Artifact Job。
- 从原 `Check` 删除 Frontend Build，保证日常 CI 不会重复 Build。

### B2. 在不增加 Job 内并发的前提下均衡 Browser Shard

- Chromium 使用 9 个 Shard，与 Release Preparation 同时运行时刚好适配实测 20 Job 远端并发上限。
- 每个 Job 先发现精确 Test Location，再按实测 Duration 分配原子 Location Group；没有 Timing
  Sample 的位置使用有界默认值。通过重分配现有 Job 均衡慢测试，不增加 Worker 或远端 Job。
- 每个 Job 仍然严格单 Worker；共享同一源码位置的 Generated Test 保持原子分组，同一 Backend
  不并发执行测试。

### B3. 第一次失败立即生成诊断包

第一个必需 Job 失败时，生成一份机器可读和人可读的 Failure Bundle：

- Candidate SHA 与修改文件；
- 失败 Workflow、Job、Step、Test 和首个 Error；
- 精确的 Focused Reproduction Command；
- Trace、Screenshot 和相关 Server/Browser Log；
- 用于识别重复问题的稳定 Failure Signature。

Release Watcher 在第一个必需 Job 终止失败时直接返回该 Bundle，不再要求 Agent 反复轮询。

### B4. 使用隔离本地 Lane 运行均衡 Shard

`npm run test:e2e:playwright:isolated -- --project <name> --lanes <count>`
把现有的均衡 Test Location 分配启动为相互隔离的 Lane。Coordinator 默认只 Build 一次；只有明确
传入 `--skip-build` 才跳过 Build，随后强制每条 Lane 的 Server 复用该 Build。脚本不转发任意
Playwright 参数，避免调用方绕过隔离契约。

Lane Execution Copy 完全使用 Node Filesystem API 准备，不依赖 `rsync` 或其他 Host Copy
Utility。Coordinator 读取精确的 NUL 分隔
`git ls-files -co --exclude-standard` Manifest，对普通文件做字节复制、重新创建符号链接、保留
可执行权限，并且绝不把 Tracked 或 Non-ignored WIP Hard Link 回 Source Checkout。所有复制目标
都必须位于 Lane Repository Root 内；遇到不支持的 Manifest Entry Type 时 Fail Closed。

Git Manifest 会有意排除 Ignored Build Output。复制 Manifest 后，Lane Preparation 只从
Canonical Backend Build Output Root 继承 Generated Runtime Artifact：每个 Runtime `.cts`
Source 都必须有相邻的 `.cjs` 和 `.cjs.map`，另外再复制明确归属的 Singleton Runtime Output。
这些文件是隔离副本，不会把 Source 的 `backend/`、`desktop/`、`extensions/` 或 `shared/`
整棵目录链接进 Clone，因此 Plain Node 子进程可以直接从 Lane Clone 启动 Native PTY Host 和
ACP Runtime Host。缺少任何必需 Artifact 时，Preparation 会 Fail Closed，并给出恢复它所需的
Build Command；不会退回 `tsx` Module Resolution。已经 Build 的 `node_modules` 和 `dist` Root
仍作为所有 Lane 共享的只读输入。

每条 Lane 独占 Backend Port、Config Root、临时目录、Playwright Output、HTML Report、
Visual/Audit Directory，以及所有单文件 Screenshot Path。Linux Headed 模式还会独占一个 Xvfb
Display，并实际设置 Playwright `headless: false`。开始工作前必须检查默认 Port 与 Display；已被
占用时 Fail Closed。Xvfb 创建 Display Socket 后才能启动 Playwright，Xvfb 提前退出会使该 Lane
失败。

所有子命令都运行在本次调用拥有的独立 Process Group 中。收到中断或最终清理时只向这些 Group
发信号；需要时从 TERM 升级到 KILL，中断后的父进程返回非零。一条 Lane 失败不会取消其他独立
Lane，Coordinator 会可靠收集全部终态。默认全成功时删除临时 Lane Root；任一失败时保留 Trace、
Report、Screenshot 和 Audit Evidence，并打印精确保留路径。`--retain-evidence` 也会在成功后
保留 Evidence 并打印精确 Root。`--dry-run` 不创建 Server、目录或临时 Root；`--list` 只使用
Balanced Runner 支持的 `--list-selected` 发现模式。

在 Linux Validation Host 的 Checkout 中，完整 703 Test Matrix 使用以下 12 条无冲突 Logical
Lane。Chromium 使用六条 Balanced Lane，较小 Project 使用按规模缩减的 Lane 数；其中 8 条
使用 Chromium、4 条使用 WebKit，只有两个 Auth Project 启用认证。

| Project | Tests | 精确隔离调用 |
| --- | ---: | --- |
| `chromium` | 603 | `FARMING_PLAYWRIGHT_PORT_BASE=43100 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=90 FARMING_PLAYWRIGHT_AUTH=0 node scripts/run-playwright-isolated-lanes.mjs --project chromium --lanes 6 --headed-xvfb --skip-build --retain-evidence` |
| `iphone-webkit` | 45 | `FARMING_PLAYWRIGHT_PORT_BASE=43200 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=110 FARMING_PLAYWRIGHT_AUTH=0 node scripts/run-playwright-isolated-lanes.mjs --project iphone-webkit --lanes 2 --headed-xvfb --skip-build --retain-evidence` |
| `iphone-human-webkit` | 25 | `FARMING_PLAYWRIGHT_PORT_BASE=43300 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=120 FARMING_PLAYWRIGHT_AUTH=0 node scripts/run-playwright-isolated-lanes.mjs --project iphone-human-webkit --lanes 1 --headed-xvfb --skip-build --retain-evidence` |
| `android-human-chromium` | 28 | `FARMING_PLAYWRIGHT_PORT_BASE=43400 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=130 FARMING_PLAYWRIGHT_AUTH=0 node scripts/run-playwright-isolated-lanes.mjs --project android-human-chromium --lanes 1 --headed-xvfb --skip-build --retain-evidence` |
| `mobile-auth-chromium` | 1 | `FARMING_PLAYWRIGHT_PORT_BASE=43500 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=140 FARMING_PLAYWRIGHT_AUTH=1 node scripts/run-playwright-isolated-lanes.mjs --project mobile-auth-chromium --lanes 1 --headed-xvfb --skip-build --retain-evidence` |
| `mobile-auth-webkit` | 1 | `FARMING_PLAYWRIGHT_PORT_BASE=43600 FARMING_PLAYWRIGHT_XVFB_DISPLAY_BASE=150 FARMING_PLAYWRIGHT_AUTH=1 node scripts/run-playwright-isolated-lanes.mjs --project mobile-auth-webkit --lanes 1 --headed-xvfb --skip-build --retain-evidence` |

不要手工把表中命令放入后台；应在该 Checkout 运行
`npm run test:e2e:playwright:isolated:matrix`。Checked-in Coordinator 默认只 Build 一次，把六个
Project 定义展开为 12 个彼此隔离的 Lane 调用，并在所有 Chromium Project 之间全局最多同时放行
六条 Chromium Lane；这不是三个互不知情的 Project 局部上限。所有 WebKit Lane 仍可并行。
`--max-chromium-lanes <1-8>` 允许 Operator 根据已测量 Host 显式覆盖，默认值保持为已经验证的
安全容量。Coordinator 不做自动 Retry，会汇总全部终态；中断时只向自己拥有的 Process Group
发信号。上表的单 Project 命令会保留其请求的 Lane 数，不能替代 Matrix 的全局调度器。只有当
Matrix 所需的全部 Build Output 已针对同一精确 Checkout 完成并验证时，调用方才可运行
`npm run test:e2e:playwright:isolated:matrix -- --skip-build`；验证责任由调用方承担，Coordinator
不会证明已有 Output 仍然 Fresh。Lane Preparation 仍会在预期 Generated Runtime Artifact
缺失时 Fail Closed。`--dry-run` 会打印精确 Lane Command；未传入 `--skip-build` 时还会打印
Build Command，且不产生副作用。

## 改造 C：Agent 三分钟调查协议

### 三分钟首次处置

| 获得失败证据后的时间 | 必须产出的结果 |
| --- | --- |
| 0–30 秒 | 读取 Failure Bundle，确定问题 Owner Boundary |
| 30–90 秒 | 运行一次最小 Focused Reproduction，或直接检查已有 Trace |
| 90–180 秒 | 写出不变量、问题分类；简单问题完成最小修复 |

问题分类固定为：产品逻辑、Test Oracle/Lifecycle、Packaging Manifest、Workflow Dependency、
Environment/Provider，以及已经出现过的 Failure Signature。

Agent 还必须选择当前运行场景和受影响领域。如果问题需要修改 State Machine、Ownership 或
Architecture，而不是有界修复，必须在 3 分钟内从场景二升级到场景三。

### 有界调查规则

1. 从精确 Error 和 Owner Boundary 开始，禁止先做全仓大范围搜索。
2. Focused Test 默认只跑一次；只有明确假设是时序或不确定性时，最多重复三次。
3. 一次只验证一个假设，并写明预期观察结果。
4. 同一假设下两次修复仍失败，立即停止修改；加入一次性状态取证，重建真实事件顺序。
5. 每次小改后不得分别跑 Typecheck、Lint、Build 和完整 CI。先跑 Owner Focused Check，最后只跑
   一次完整门禁。
6. 本地或已有 Trace 能获得的信息，禁止通过再次 Push 等远端 CI 才获取。
7. Monitoring 由脚本负责；只有状态变化、Failure Bundle 或最终结果才唤醒 Agent。

### 生命周期问题必须输出状态轨迹

有状态 UI 和 Runtime 问题必须记录权威状态转换，不能依赖重复截图或最终像素。例如 Persisted
Chat Position：

```text
保存 Anchor
  -> unload/pagehide 边界
  -> 首批 Turns 加载
  -> 历史 Turns 加载
  -> Anchor Element 挂载
  -> Restoration Transaction 执行
  -> Browser/Layout 修正完成
  -> 观察最终语义位置
```

## 目标时间预算

| 关键路径 | 预算 |
| --- | ---: |
| Metadata 验证与调度 | 20 秒 |
| 完整 CI 与全部可逆 Artifact Preparation 并行执行 | 7 分钟 |
| 组装并公开 GitHub Release | 40 秒 |
| 验证公开 Tag 和资产 | 30 秒 |
| 发布预先 Smoke 的 npm Tarball 并验证 `gitHead` | 1 分钟 |
| 波动余量 | 30 秒 |
| 总计 | 10 分钟 |

遇到失败后计时继续。三分钟调查协议用于减少可避免的调查时间，不会重置发布时间。

## 实施顺序

1. 增加 Workflow Timing、Exact-SHA Identity、Artifact Digest 和单一 Failure Bundle Watcher。
2. 删除两处重复 `npm run check`。
3. 导出、传输、Smoke 并发布唯一一份 npm Tarball。
4. 反转公开顺序：GitHub Release 验证成功后才发布 npm。
5. 拆分 Metadata Validation 与 CI Gate，让可逆 Preparation 与 CI 并行。
6. 每个 Runner 只 Build 一次；必要时并行独立 Package。
7. 从 `Check` 中拆出 Frontend Artifact，并均衡大型 Playwright Spec。
8. 实现三分钟诊断命令；流程确认后再固化为仓库 Release Skill。
9. 将 Domain Ledger、Affected-domain Invalidation 和三种运行模式加入仓库 Release Skill。
10. 将强制 Preparation Ledger 和并行 Isolated Desktop Computer Use 调度加入仓库 Release Skill。
11. 使用下一个 Patch Version 做真实计时发布测试。

## 验收标准

- 从接受发布请求开始计时，所有重试、调查、修复、排队、CI、Build 和发布步骤都包含在内。
- 正常端到端发布少于 10 分钟。
- 遇到一个简单阻塞问题时，完整发布少于 15 分钟。
- 遇到较大设计问题时，其他独立领域继续收敛；阻塞领域解决后 10 分钟内完成发布。
- 注入简单 Packaging、Test Oracle 或 Metadata 失败后，3 分钟内得到正确分类和 Focused Reproduction。
- 日常 CI 墙钟时间不回退，并更早提供 Browser Failure。
- 每个产品行为发布在任何公开 Mutation 前完成选中的自动化与 Computer Use Preparation Gate。
- 独立 Computer Use 场景运行在分别归属的 Isolated Desktop 上；一条 Lane 失败时保留其证据，
  不重启无关 Lane。
- 本地均衡 Playwright Lane 使用唯一 Runtime/Evidence 资源，只 Build 一次；Port/Display 占用时
  Fail Closed，只清理本次拥有的 Process Group，并保留失败 Lane 的证据。
- Release 不再重复普通仓库门禁。
- 所有正式资产和 npm `gitHead` 都指向精确 Candidate SHA。
- GitHub Release 和必需资产公开并验证之前，npm Version 不存在。
- npm 正式 Tarball Digest 与 Smoke 接受的 Digest 完全相同。
- Agent 不再反复查询状态；没有明确不确定性假设时，Focused Test 不得重复超过三次。
- 前五次发布记录完整耗时和关键路径归因。

## 失败与恢复

- CI 或 Preparation 失败时，不创建 Tag、公开 GitHub Release 或 npm Version。
- 公开 Mutation 结果不明确时，重试前从 GitHub 或 npm 权威状态对账。
- GitHub Release 已成功但 npm 失败时，下载版本仍然有效；重跑只在核对相同 SHA 和 Artifact Digest
  后继续发布 npm。
- 已有 Tag 或 npm Version 属于其他 SHA 时属于终止冲突，绝不覆盖。
