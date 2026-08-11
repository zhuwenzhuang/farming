# Farming Code Review Foundation

> English version: [review-foundation.md](./review-foundation.md)

Farming Review 把“正在审阅的不可变变化”与“阅读者可变的 Review State”分离。模型参考
Gerrit，但同时支持 Local Working Copy、任意 Git Range 与 Agent 创建的历史变化。

## Identity 与 Ownership

一个 Review 有稳定 Identity 和一个或多个不可变 Revision。Revision 定义 Base、Candidate
Patchset 与有序 File Identity 集合。Review Identity 包含 Canonical Workspace 与 Comparison
Range；`HEAD` 这类展示 Label 不能单独作为身份。

存在两层相互独立的数据：

- **Diff Snapshot** 是“改了什么”的只读证据；
- **Review State** 记录一个精确 Review Revision 的 Reviewed File、Comment、Draft 与本地导航。

切换 Comparison Source 或 Base 会创建不同 Identity。Loading Strategy、Diff Mode、Whitespace
Preference 与 Context Size 不会改变 Identity。

## Comparison Source

Review 可以比较 Working Tree、Staged Change、Commit、Branch Merge Base、显式 Git Range，或
不可变的 Agent File Changes Capture。Source Selection 表达真实语义，页面出现前必须解析成
精确 Comparison。

历史 Agent Change 从 Agent 当时产生的结构化变更证据捕获。之后的 Filesystem Edit 不能改变
这份历史 Review。

CLI 可以直接打开本地 Review：

```bash
farming review <git-dir> <old-revision> <new-revision|now>
```

它与 Farming 内打开的 Review 共用 Identity、Comment、Reviewed State 与 Loading Contract。

## 不可变 Revision

Working-copy Review 必须先捕获为不可变 Revision，再展示文件列表。Capture 不能修改用户的
Index 或 Worktree。捕获期间 Workspace 变化、无法证明结果一致时，应显式失败并允许 Retry。

Agent 修复后 Refresh 会在同一 Review Lineage 中创建新 Revision。未变化文件可以继承
Reviewed State；变化文件回到 Unreviewed；Comment Anchor 不再匹配时标为 Outdated，不能
静默移动到无关代码行。

## File-list-first Loading

有序 File List 是主要 Review Navigation。Metadata 先于昂贵 Inline Diff 加载。展开文件只
读取该文件内容，并合并进已有 File Identity，不能替换或重排 Catalog。

一个 Revision 内每个 Path 唯一。Rename/Copy Metadata 保留 Current 与 Previous Path Identity。
Binary、Truncated 或 Too-expensive File 仍可 Review，并显示明确的非 Inline State，而不是空 Diff。

Hunk 携带结构化 Old/New Range。展示 Header 不是 Navigation 或 Comment 的权威来源。Special
Review File 可以展示，但不计入普通源码行数总计。

## Reviewed State 与 Comment

Reviewed State 按精确 Review Revision 隔离，并使用集合语义。“尚未加载”与“已加载且为空”
必须区分。Mark-all 只是编排同一个单文件 Reviewed Primitive，不是后端原子 Batch。

Comment 按 Review Revision 与稳定 Comment Identity 隔离。Rename-aware Comment 保留正确的
Previous 或 Current Path；Anchor 变化时保留为 Outdated Evidence，而不是贴到新代码上。

可以使用 Optimistic Update，但每个异步完成都必须绑定 Review Identity、Revision、Path、
Comment ID 与 Operation Type。Stale Response 不能修改更新 Review，也不能回滚更新 Mutation。
多文件操作部分失败后，UI 从权威 Reviewed State 对账。

## UI Contract

Review 使用一套 File-list-first Workspace。File Row 展示 Change Type、Summary、Reviewed State、
Comment 与可展开 Inline Diff，不在其它 Panel 重复同一 Catalog。

Review 跟随 Farming Code 的权威外观偏好。画布、控件、语法、评论与 Diff State 统一消费
共享语义主题角色；该 Route 不得再退化为固定的 Light 皮肤。

Reviewed Action 只在 Row Hover、Keyboard Focus 或 Expanded 时视觉浮现。Loaded、Loading、Failed、
Binary、Truncated 与 Unavailable Diff State 都明确展示。Common-line Gap 按有界 Range 展开，
不能移动另一侧边界，也不能因失败丢失 Control。

Final Change 与 Previous Revision 之后的 Fixes 服务不同注意力需求。完整 Base-to-current 结果
始终权威；Incremental View 是理解上次 Review 后真实变化的默认入口。

## 失败与恢复

Malformed Identity、Duplicate Path、Inconsistent Range 与 Source Mismatch 在边界失败。File Load、
Comment Save、Reviewed Write 或 Refresh 的迟到结果如果不再属于 Active Review，就必须忽略。

Refresh 会让所有 Path-scoped UI State 与新 Catalog 对账。Removed 或 Renamed File 不能把旧
Pending Load、Selection、Comment 或 Reviewed Write 留在无关 Row 上。

## 验收标准

验证必须覆盖：Working-copy/Git-range Identity、Symlink 等价 Workspace、Concurrent Write 下的
Immutable Capture、Revision Refresh、File-list-first Loading、Rename/Copy Comment、Reviewed
State Reconciliation、Partial Failure、Stale Async Completion、Binary/Truncated File、Split/
Unified Presentation、Keyboard Navigation 与 Large Review。
