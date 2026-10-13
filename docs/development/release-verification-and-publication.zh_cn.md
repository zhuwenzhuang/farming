# 发布验证与正式发布

> English version: [release-verification-and-publication.md](./release-verification-and-publication.md)

本文规定发布准备、精确候选验证、正式发布及失败恢复规则。计时从接受发布请求开始，
包含调查、修复、排队和正式发布耗时。

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

Campaign 开始时只运行一次 `npm run release:dependencies:plan -- PLAN_PATH`。不可覆盖的 JSON
Plan 将精确 Direct Pin、全部 Codex Platform Alias、选中 Claude Adapter 的 SDK Platform Pin
集中列出，并保留 Deferred 与不完整发布。一次性应用 Manifest 修改、只解析一次 Lock。
Plan 还自动发现源码和测试中残留的版本引用，但不修改它们，也不把生成的 Runtime Output 当成
权威源。审查变化的 Vendor Patch 和 Hash，先跑聚焦 Fast Screen，再 Push 最终 Candidate。生成的 Runtime Manifest
从根 Override 读取 Codex Pin，从 Adapter 的 Locked Dependency 读取 Claude SDK Pin，不再维护
另一份需要手动更新的版本对。发现和生成 Plan 不能代替上游兼容性审查或最终 Exact-SHA 门禁。

一次干净安装后立即运行 `npm run release:upgrade:screen`。该门禁准备已审查 Adapter 与
Runtime Manifest，验证 Provider-neutral ACP 边界及 Adapter 自身的兼容性，包括冷安装
Patch、打包 Vendor 的选择与完整性。CI 在广泛仓库检查之前运行它，使升级缺陷尽早可诊断。独立、确定性的 Fixture
无需 Provider 凭证或 Registry Mutation；准备或兼容性失败会终止门禁。它不替代完整 CI、
安装包验收或真实 Provider 门禁。

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

### Linux 发布协调机例外

当 Release Coordinator 本身运行在 Linux 上时，iOS Simulator 和真机验收不进入阻塞发布的
Ledger，并记录为 `ios_acceptance=skipped-linux-coordinator-rule`。这是明确的平台规则，不代表
Linux 模拟已经证明 iOS 行为。Mobile Chromium/WebKit 自动化、Responsive Appearance Computer
Use、Exact-SHA CI、Provider 门禁、Candidate Workflow、所有平台制品和发布验证仍然必须完成。
原生 macOS Desktop/LSP 发生变化时仍然需要 Mac Lane。

干净 Candidate 推送到 `main` 后、Release Acceptance 进入 Pending 前，运行
`npm run release:coordinator:linux:check -- VERSION`。该检查确认 Linux 协调机已登录 GitHub 和
Codex CLI、Docker 健康、发布 Workflow 处于 Active，并且固定 Digest 的 Computer 镜像已经存在。
Release Artifact 与 npm Publication 仍由 GitHub Actions 负责，因此协调机不需要 npm 凭据、
Xcode、新版宿主机 glibc 或本地跨平台打包工具。协调机的依赖探测遵循其配置的 HTTPS npm
registry，因此受限 Linux 网络可以使用可信镜像；GitHub Release Preparation 任务仍查询 npm
官方 registry，并作为权威依赖门禁。

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

## 发布流程

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

## 制品与发布契约

### 元数据与 CI 门禁

- 快速 Metadata Job 验证 Version、Lockfile、Release Notes、Branch、Tag 和 npm Version 冲突。
- Exact-SHA CI Gate 继续等待必需的 CI Run。
- Platform Build 和 npm Preparation 只依赖 Metadata，因此与 CI Gate 同时运行。
- GitHub 和 npm 公开 Job 同时依赖 CI Gate 与全部 Preparation 成功。

### 仓库验证

- Linux Artifact 和 npm Publication 不重复执行 `npm run check`。
- Exact-SHA CI 继续作为普通仓库检查的权威门禁。
- 保留全部 Platform、Package、Architecture 和 Runtime Verify/Smoke。

### 并行制品与来源

- Linux CLI、标准 App Bundle、Legacy App Bundle 在同一 Metadata Gate 后作为三个并行 Job。
- 每个 macOS Architecture 的 Native CLI 与 App Bundle 作为两个并行 Job。
- macOS App Job 在 Preflight 后直接启动，不等待独立的 Linux/Windows Browser Matrix；独立
  CLI、Linux 和 npm Job 必须等待该 Matrix 与 Native App Job，因为完整 Image 需要全部
  受支持的 Runtime。仅当同仓库已成功的 Preparation Commit 是当前 Candidate 的祖先，且
  Pin、Patch 和 Production Recipe 字节完全一致时，才能复用未变化的 Browser Component。
  必须保留全部平台的 Artifact；过期或不完整的 Origin 要重新编译，产物校验失败则明确拒绝。
  Candidate Assembly 单独记录当前 Farming SHA、Digest 与不可变的 Compilation Provenance。
  每个 macOS App 在自己的 Packaging Runner 上签名并运行 Native Browser，保留完整 App
  校验与 Smoke。未变化组件的源码回归证据绑定已认证 Origin；当前 Candidate 的产品和包
  验收始终重新执行。Browser CI 在完整交互测试前采用相同的已认证组件选择与当前 SHA
  Assembly。源码或 Recipe 变化时走原有 Test/Build 路径。Cargo 中间产物按 Host OS、
  Architecture、Target、固定 Toolchain、Upstream Source、Patch 与 Build Script 隔离缓存；
  从中间产物 Cache Restore 后，源码编译路径始终重新 Test、Build，并生成当前 Identity。
  Source 或 Patch 升级后，仅在相同 Host OS、Architecture、Target 和固定 Toolchain 内
  Restore；由 Cargo Fingerprint 判定哪些中间产物仍有效。回归测试保留 Host Test Profile，
  正式制品保留 Release Profile 和 Target。Release Profile 测试会另外链接一个 Full-LTO
  测试程序，不能省掉正式制品的链接。Linux 制品仍独立进行 Zig Compatibility Build；
  后者的 Compiler/Linker 输入不同，无法复用 Host Test 的依赖编译图。
  独立 Native Browser Producer 对各 Darwin 组件签名、严格校验并运行版本检查后，传递
  当前 SHA 的 Artifact。App Consumer 在匹配的原生 Host 再次校验签名和版本，然后执行
  完整 Browser、App 与 PTY 验收。CLI、Linux 和 npm Packager 无需等待 App 验收即可
  消费组件；正式发布仍要求所有 Package Gate 成功。传递保留不可变编译来源，不增加
  第二次 Rust 编译。
- 固定版本的 ripgrep 下载 Archive 保留在干净源码安装目录之外。Workflow Cache
  按 Producer、Runner OS/Architecture 和经过 Review 的制品清单隔离；每个恢复的
  Archive 都必须在解压前通过固定 SHA-256 校验，缺失的 Archive 使用有界的官方下载路径。
- 保留精确 App Assembly Directory 直到 Smoke 完成；Archive 继续完整 Verify，但 Smoke 不再先解压
  刚生成的大型 Archive。
- Exact-SHA CI 和全部 Package-specific Gate 变绿前，所有 Job 都保持可逆，不执行公开 Mutation。

### 源码与产品安装

- Source CI 和 Release Build Checkout 设置 `FARMING_SKIP_INSTALL_RUNTIME_PREPARE=1`；它们直接
  Build/Test 源码，不得生成 Package Installation Runtime Seed。
- npm Package Smoke 和 App Bundle Construction 继续保留各自安装形态的 Runtime 要求；该优化
  不降低正式制品的安装契约。
- Browser 下载继续由 Workflow 明确执行，依赖安装阶段不再静默下载第二份 Browser。

### 同一份已验证 npm Tarball

- npm Package Smoke 接受或导出明确 Tarball Path。
- Smoke 前和 Workflow Artifact 传输后都计算 SHA-256。
- Smoke 后保存包含字节数、SHA-256、SHA-512 Integrity 和 SHA-1 Shasum 的小型 Exact-SHA
  Receipt，同时放在 Tarball 旁边并独立上传；协调器读取 Receipt，无需再次下载完整 Tarball。
- 正式发布直接使用该 Tarball，不得再次运行 `prepack`、`npm pack` 或生产依赖安装。

每个制品边界只读取一次文件，同时计算 Receipt 所需摘要。Smoke Receipt 是 npm 传输
完整性的权威凭据；同一阶段不再增加 SHA-256 Sidecar，也不重新哈希同一份未变化 Tarball。

### npm 最后发布

- 使用全部已验证资产组装 GitHub Draft Release。
- 正式公开 GitHub Release。
- Publication 校验传输后的字节与 Smoke Receipt 一致，完成公开 GitHub 资产验证后才上传 npm；
  上传后自动核对公开 Name、Version、Source SHA、Integrity 和 Shasum，最长十分钟，单次请求
  最长十秒。成功或失败都保留带时间戳的状态与上传结果。尝试上传后的恢复只读，包括公开
  Registry 返回 404 时；上传步骤尚未执行的恢复可以进行第一次上传。
- Registry Preflight 读取必须使用独立、不入池的 HTTPS Socket，读完响应体后再进入阻塞
  Publisher 的同步上传或观察子进程。池化客户端仅设置 `Connection: close` 不足以满足此约束；
  平台发布步骤之间不得复用连接。
- 已接受上传与公开验证是不同状态。上传成功后，若公开版本尚不存在或元数据不完整，
  状态为 `awaiting-public`：Workflow Summary 显示“已上传成功，等待公开可用”，并保留
  `farming/npm-publication/<version>` Commit Status 为 Pending。有界观察 Job 可以完成，
  但发布状态仍然 Pending；仅凭 Workflow 成功不能认定 npm 已公开。受信任的
  `workflow_run` 自动进行一次最长二十分钟的只读续查，绑定原始上传 Run、Attempt、
  Candidate 发布、SHA 与规范 Smoke Receipt。若恢复任务首次上传，其上传身份与
  Exact-SHA Candidate 发布及成功 Preparation 证明分开保存。续查和发布共享按版本
  的并发所有权，无需 npm 凭据。
  恢复验证器可以使用较新的集成代码，但必须保留原始上传身份。显式恢复使用前一次恢复的
  Journal 时，该 Run 须对应精确 Candidate SHA 并证明恢复门禁成功。若验证器 SHA 较新，
  必须额外通过 `candidate_publication_run_id` 指定精确 Candidate 的授权发布 Run，证明
  Preparation、Acceptance、Push Workflow、草稿发布与公开资产门禁成功；
  `failed_publication_run_id` 仍指向最新 Journal Run，后者须证明恢复 Checkout、Preparation、
  Acceptance 与公开资产验证成功。任何上传前，所有 Runtime Intent 均须匹配精确 Preparation
  Receipt，主包 Upload-origin 保留 Candidate 授权锚。未提供新参数时保留原有精确 SHA 限制；
  仅有被跳过的原始发布步骤不足以构成证据。
  每次新恢复重新检查 Candidate 的 Push Workflow 并保留最新 Journal；只读 Observer
  在继续观察后续主包上传前，也须认证同一身份链。正常等待公开时若观察
  结束，记录 `observationStatus=ended`，保留 Pending 发布状态并提供只读恢复指引。
  缺少已认证 Upload-origin Checkpoint 的历史证据使用显式恢复，不自动续查。
  只有公开源码和摘要匹配才标记发布成功；
  公开身份冲突应失败，上传结果不明或观察失败仍应报告不确定。不得把正常等待公开
  归类为上传失败。
- 验证公开 Tag Target、资产清单、Manifest、Checksum，并至少下载一个公开资产。
- 只有验证成功后才发布 npm，并核对 npm `gitHead`。
- 上传成功后，公共 Registry 可能暂时不可见。npm 在公开前执行扫描，通常约五分钟，
  有时十五分钟甚至更久，这些时间不是服务保证。参见
  [npm 发布时扫描说明](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)。
  仅凭 `staged` 响应或冲突，不能判定
  需要维护者批准：npm 暂存既包含自动校验，也包含维护者审阅。保留精确 Tarball，
  在考虑再次发布前，以有界只读查询核对公开版本、源码 SHA 和摘要。
- 只有权威证据明确要求时，才请求维护者批准或 2FA。若无法读取需要认证的暂存
  详情，应报告结果尚不确定，不得断言必须人工批准。参见
  [npm 暂存 API](https://api-docs.npmjs.com/#tag/Stage)。

## 测试与失败反馈

### 浏览器构建依赖

- Frontend Artifact Production 独立于仓库 `Check` Job。
- Frontend Production、`Check` 和 Node Compatibility 同时启动。
- Browser 和 Mobile Job 只依赖 Frontend Artifact Job。
- `Check` 不重复执行 Frontend Artifact Production。

### 浏览器分片均衡

- Chromium 使用 9 个 Shard，与 Release Preparation 同时运行时刚好适配实测 20 Job 远端并发上限。
- 每个 Job 先发现精确 Test Location，再按实测 Duration 分配原子 Location Group；没有 Timing
  Sample 的位置使用有界默认值。通过重分配现有 Job 均衡慢测试，不增加 Worker 或远端 Job。
- 每个 Job 仍然严格单 Worker；共享同一源码位置的 Generated Test 保持原子分组，同一 Backend
  不并发执行测试。
- Mobile CI 使用五个隔离的单 Worker Job：两个均衡的 iPhone Layout Shard、各自完整的
  iPhone 和 Android Human Journey Suite，以及使用独立鉴权 Server 的 Authenticated Share
  Suite。原有 Project 和测试位置全部保留，完整 Mobile Fast Screen 仅在 iPhone Human Lane
  执行一次。衡量完整发布时须计入共享并发上限导致的排队，不能假定耗时线性下降。

### 失败诊断包

Run Watcher 为每次成功观察原子保存带时间戳的状态、活动 Job 和 Step，只在进展变化时输出。
Transport 观察失败时重新读取同一个 Run，不能据此启动新的 Run。

第一个必需 Job 失败时，生成一份机器可读和人可读的 Failure Bundle：

- Candidate SHA 与修改文件；
- 失败 Workflow、Job、Step、Test 和首个 Error；
- 精确的 Focused Reproduction Command；
- Trace、Screenshot 和相关 Server/Browser Log；
- 用于识别重复问题的稳定 Failure Signature。

Release Watcher 默认使用 `fail-fast`：返回第一个必需 Job 的失败包，单独记录监控已停止
及退出码，同时保留可能仍为 `in_progress` 的权威 Run 状态。调用方不得把这个快照当作
监控仍在运行而继续等待。`wait-terminal` 只保留一次首错，继续观察同一个 Run 直到真实
终态。首错提取排除回显脚本源码，优先使用实际运行诊断。每次 GitHub 读取仍限制为
三十秒，取消时清理精确归属的进程组。确定性超时测试独立同步 Fixture 就绪，不改变
生产期限。无需 Agent 反复轮询。

### 隔离本地 Lane

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

默认 Playwright Server 只删除自己创建的 Config Root。Lane 提供 Config Root 时，由该
Lane 负责清理与证据保留。Teardown 不得扫描或删除其它运行的临时配置目录。

Agent 清理必须观察到权威列表为空，才允许开始下一个测试。删除或归档请求被受理后，
通过查询等待完成，不重放修改请求。读取失败、修改被拒绝或结果不确定、列表格式错误、
以及超过截止时间都必须阻断 Setup；Teardown 在原始测试错误之外附加报告清理失败。

所有子命令都运行在本次调用拥有的独立 Process Group 中。收到中断或最终清理时只向这些 Group
发信号；需要时从 TERM 升级到 KILL，中断后的父进程返回非零。一条 Lane 失败不会取消其他独立
Lane，Coordinator 会可靠收集全部终态。默认全成功时删除临时 Lane Root；任一失败时保留 Trace、
Report、Screenshot 和 Audit Evidence，并打印精确保留路径。`--retain-evidence` 也会在成功后
保留 Evidence 并打印精确 Root。`--dry-run` 不创建 Server、目录或临时 Root；`--list` 只使用
Balanced Runner 支持的 `--list-selected` 发现模式。

运行
`npm run test:e2e:playwright:isolated:matrix`。Checked-in Coordinator 默认只 Build 一次，把六个
Project 定义展开为 12 个彼此隔离的 Lane 调用，并在所有 Chromium Project 之间全局最多同时放行
六条 Chromium Lane；这不是三个互不知情的 Project 局部上限。所有 WebKit Lane 仍可并行。
`--max-chromium-lanes <1-8>` 允许 Operator 根据已测量 Host 显式覆盖，默认值保持为已经验证的
安全容量。Coordinator 不做自动 Retry，会汇总全部终态；中断时只向自己拥有的 Process Group
发信号。单 Project 命令会保留其请求的 Lane 数，不能替代 Matrix 的全局调度器。只有当
Matrix 所需的全部 Build Output 已针对同一精确 Checkout 完成并验证时，调用方才可运行
`npm run test:e2e:playwright:isolated:matrix -- --skip-build`；验证责任由调用方承担，Coordinator
不会证明已有 Output 仍然 Fresh。Lane Preparation 仍会在预期 Generated Runtime Artifact
缺失时 Fail Closed。`--dry-run` 会打印精确 Lane Command；未传入 `--skip-build` 时还会打印
Build Command，且不产生副作用。

## 调查协议

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

## 失败与恢复

- CI 或 Preparation 失败时，不创建 Tag、公开 GitHub Release 或 npm Version。
- 公开 Mutation 结果不明确时，重试前从 GitHub 或 npm 权威状态对账。
- GitHub Release 已成功但 npm 失败时，下载版本仍然有效；重跑只在核对相同 SHA 和 Artifact Digest
  后继续发布 npm。
- 已有 Tag 或 npm Version 属于其他 SHA 时属于终止冲突，绝不覆盖。
