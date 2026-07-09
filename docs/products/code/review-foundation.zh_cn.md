# Farming Code Review 基础能力

> English version: [review-foundation.md](./review-foundation.md)

Farming 的 review 数据分成两层：

- 只读 diff snapshot：描述改了什么，包括 review id、base patchset、patchset、文件、hunk 和行。
- patchset review state：描述阅读者做了什么，包括 reviewed paths、comments 和用于忽略旧响应的本地 revision。

这样同一套基础能力可以同时承载 working copy review、已修改文件 review，以及不同 commit 之间的比对。

前端状态应携带 diff snapshot 返回的 `reviewId`。`HEAD` 或 `Patchset 20` 这类 patchset 名称不是全局唯一；权威 review state 的作用域是 `reviewId + patchset`，这和后端 reviewed-file API 保持一致。

一个 `ReviewState` 表示一个 review identity 及其当前 patch range。`ReviewCatalog` 的 key 是这个状态内部的 patchset key，不是 app 全局缓存 key。任何需要缓存或切换多个 working-copy / commit-range review 的 surface，都必须用 `reviewSnapshotStateKey(snapshot)` 或等价的 snapshot identity 作为外层状态 key，避免同一个右侧 `patchset`、不同 `basePatchset` 的比较互相覆盖。Snapshot 里的展示用 `root` 不是这个 state key 的一部分：后端生成的 `reviewId` 才是 canonical workspace identity，所以真实路径和 symlink 这类等价 workspace 入口不应该把同一个 review 分裂成两个 UI 状态桶。
创建 `ReviewState` 时，右侧 active `patchRange.patchset` 必须存在于 `ReviewCatalog`。Base side 是比较边界，但右侧 patchset 承载 reviewed paths、comments、lazy diff hydration 和文件导航。接受缺失的 active patchset 会让这些操作变成静默 no-op，而不是 Gerrit-like 的 review surface。

## Gerrit 对齐原则

这套基础能力以 Gerrit 为参考模型。Farming 不会完全复制 Gerrit 的 `/changes/...` route 前缀，因为 Farming 还要支持本地 working copy 和任意 git range 的 review，但底层分层应保持 Gerrit-shaped：

- 文件列表先是 metadata，对齐 Gerrit `GET .../files/` 返回的 `FileInfo` map；
- inline diff 按文件加载，对齐 Gerrit `GET .../files/:file/diff` 返回的 `DiffInfo`；
- reviewed state 是独立的 patchset 文件列表，对齐 `GET .../files?reviewed`；
- mark reviewed 是单文件 primitive，对齐 `PUT` / `DELETE .../files/:file/reviewed`；
- UI 上的 mark-all 按钮只是在客户端编排同一个单文件 primitive，不是一个原子的批量 API。

这个拆分是有意的。不要把 reviewed state 合并进 diff snapshot，也不要要求所有 inline diff 全部加载后才能展示文件列表。

API 不是 Gerrit `/changes/...` 路由的逐字节复刻。Farming 保留 Gerrit 的资源语义，但外层包了一层本地 review source：

| Gerrit 概念 | Gerrit API 形态 | Farming foundation |
| --- | --- | --- |
| 文件列表元数据 | `GET revision/files` 返回 path-keyed `FileInfo` map | `GET /api/reviews/working-copy` 和 `GET /api/reviews/git-range` 返回 `ReviewFile[]`，但强制 path 唯一，并用 `metadataOnly=1` 支持 file-list-first 加载 |
| 单文件 inline diff | `GET revision/files/:path/diff` 返回 `DiffInfo` | `GET /api/reviews/{source}/files/:path/diff` 返回一个 loaded `ReviewFile`；真实 Gerrit `DiffInfo` 来源通过 `reviewFileFromGerritFileAndDiffInfo()` 适配 |
| 已 reviewed 文件列表 | `GET revision/files?reviewed` 返回 `string[]` | `GET /api/reviews/:reviewId/revisions/:patchset/files?reviewed` 返回 `string[]` |
| 标记 reviewed | `PUT revision/files/:path/reviewed` | `PUT /api/reviews/:reviewId/revisions/:patchset/files/:path/reviewed` |
| 取消 reviewed | `DELETE revision/files/:path/reviewed` | `DELETE /api/reviews/:reviewId/revisions/:patchset/files/:path/reviewed` |

所以如果问 “Farming 的 API 是否完全 Gerrit-compatible？”答案是否定的。目标契约更窄也更明确：状态机、文件身份模型、reviewed primitive、lazy diff loading 要和 Gerrit 对齐；route prefix 和 snapshot envelope 是 Farming 自己的，因为本地 working copy 和任意 commit range 没有 Gerrit change number。

## CLI 入口

使用 `farming review <git-dir> <old-revision> <new-revision|now>` 可以直接打开一个本地 review target，不必先创建 agent。`--branch <branch>` 可选；未指定时使用所给 Git 目录当前 checkout 的分支。CLI 会先把 `HEAD` 及其相对 revision 按这个分支解析，再生成 URL，因此分支在页面打开后推进也不会改变这次比较。

`now` 只能作为新 revision，表示 old revision 到当前工作区的状态（`git diff <old>`）：包含 old revision 之后已提交的变化、当前已跟踪的 staged / unstaged 变化，以及未跟踪文件。CLI 会启动或复用 Farming 并打开 review 页面；脚本可以传 `--no-open` 只输出 URL。

生成的 URL 使用 `root=<canonical git root>`，而不是 `agentId`。后端 review API 只接受两种 workspace selector 中的一种；直接 root 会 canonicalize，且必须是存在的目录。这样 CLI review 与 agent review 保持不同 identity，同时继续复用同一套 diff、reviewed-state、comment 和 lazy-load 基础能力。

## 不可变 Review Session

独立的 `/review` 路由不会回退到种子演示数据。Working-copy target（包括 `head=now`）会先被捕获成不可变 review revision，再显示文件列表。`/review-demo` 只保留确定性的视觉 fixture，不与真实路由共享数据生命周期。Review 路由与普通 Farming 应用使用相互独立的懒加载前端 bundle（包括 CSS），因此任一侧都不会加载或应用另一侧的 UI 层。

捕获使用临时 Git index：从 `HEAD` 读取基础树，把 tracked 和 untracked workspace 内容 stage 到临时 index，写出 tree，然后重复一次捕获。只有两次 tree id 一致时 Farming 才接受这个 revision；如果 agent 正在写文件，会明确要求重试，而不是生成混合快照。用户自己的 index 和 worktree 不会被修改。捕获的 tree 保存在 `refs/farming/reviews/` 下，session metadata 存在 Farming config 目录中。

`POST /api/review-sessions` 创建 revision 1；`POST /api/review-sessions/:reviewId/revisions` 在 agent 修复后刷新同一个 review；`GET /api/review-sessions/:reviewId` 返回 revision history。每个 revision 既可以查看相对原始 base 的最终改动，也可以只看相对上一个捕获 tree 的 fixes。未变化文件的 reviewed 状态会继承；变化文件会重置为 unreviewed；变化行上的评论会变成 `outdated`，而不是错误地贴到新代码行上。`agentId` 形式只在捕获时用于解析 workspace，不能被当成作者归因。

## Diff Snapshot

前端 review 基础代码位于 `src/lib/review/`。`ReviewDiffSnapshot` 会用 `source` 标识来源是 `working-copy` 还是 `git-range`，然后携带共享的文件模型。`ReviewFile` 是可复用的文件级 diff 模型。每个文件包含：

- `kind`：Farming 归一化后的文件类型，例如 `modified`、`added`、`deleted`、`renamed`、`copied` 或 `rewritten`；
- `status`：Gerrit-compatible 状态码，例如 `M`、`A`、`D`、`R`、`C` 或 `W`；
- `path` 和可选的 `previousPath`；
- 可选的 Gerrit `FileInfo` 文件身份 metadata，例如 `oldMode`、`newMode`、`oldSha` 和 `newSha`；
- additions / deletions 统计；
- 非行级 diff 的 binary metadata，例如 `binary`、`sizeDelta`、`size`；
- 后端无法提供完整 inline diff 时的 `diffTooExpensive`、文件级 `truncated` 和 `diff.truncated`；`binary` 在 `ReviewFile` 上是 true-only 稀疏 flag，其它 boolean flag（例如 `diffTooExpensive` 和两个 truncated 字段）如果出现都必须是 boolean，Gerrit adapter 输入只有在外部值严格等于 `true` 时才会启用这些 flag；
- `diffLoaded` 表示 inline diff 是否已经加载：Gerrit `FileInfo` / file-list-only 条目为 `false`，拿到 inline rows 后为 `true`；
- 可选的 `diff.diffHeader`，用于保留 rename、copy、mode、binary、new-file、deleted-file 等文件级 patch metadata；
- 可选的 `diff.leftMeta` / `diff.rightMeta`，来自 Gerrit `DiffInfo.meta_a` / `meta_b`，保留左右两侧文件名、content type、行数、语言、web links 和 syntax tree metadata，供未来 binary rendering、代码高亮和左右侧标签使用；
- `diff.hunks`，其中 row 分为 `context`、`added`、`deleted`、成对的 `changed`，以及 Gerrit 风格的 skipped context。每个 hunk 除展示用 header 外，都必须携带 `oldStart`、`oldLines`、`newStart`、`newLines`，这样渲染和导航逻辑不需要反向解析 `@@ ... @@` 文本。
- Gerrit 风格的结构化 diff 通过 `src/lib/review/diff-info.ts` 适配。这个适配层保留 `DiffInfo` 中的 `meta_a` / `meta_b`、`diff_header`、`ab`、`a`、`b`、`edit_a` / `edit_b` 行内修改范围、`intraline_status`、忽略空白后的 `common`、`due_to_rebase`、`move_details`，以及 skipped context，再投影到 Farming 的 hunk/row 模型。由于 `DiffInfo` 是外部输入，DiffInfo 值本身必须是 object；缺失或非数组的 `content` 会被归一化为空的 loaded diff，非对象 chunk 会被忽略，`common` 和 `due_to_rebase` 这类 Gerrit boolean flag 只有在严格等于 `true` 时才生效，`diff_header`、`intraline_status`、`meta_a`、`meta_b` 这类辅助 metadata 也只有通过形状校验后才会保留。纯新增文件必须使用统一 diff 的 old side 空范围 `oldStart: 0, oldLines: 0`；纯删除文件必须使用 new side 空范围 `newStart: 0, newLines: 0`。
当 Gerrit 把 chunk 标成 `common: true` 时，adapter 应保留左右两侧文本并投影成 `whitespaceOnly` 行用于展示，但这类行不能计入 fallback additions/deletions。如果 Gerrit `FileInfo` 已经提供行数统计，则仍以 FileInfo 为权威。

Working copy snapshot 来自 `/api/reviews/working-copy`。Commit range snapshot 来自 `/api/reviews/git-range?agentId=&base=&head=`。
两个接口返回同一种文件模型，所以 UI 后续可以用同一个 diff surface 渲染不同来源。对应的原始 patch text 接口是 `/api/reviews/working-copy/patch` 和 `/api/reviews/git-range/patch`，并通过 `X-Farming-Review-Truncated` 暴露 file limit 或单文件 diff cap 是否导致了 partial patch。前端调用方应优先使用 `loadReviewDiffSnapshot(request)`、`reviewSnapshotUrl(request)`、结构化的 `loadReviewPatch(request)`，或用于浏览器下载链接的 `reviewPatchUrl(request)`，不要在 UI 里手动选择 endpoint URL。`loadReviewPatchText(request)` 只作为便利函数保留，适用于只需要原始文本、不判断完整性的场景。
Git-range request helper 会在传输边界用和后端一致的 safe-revision 规则归一化 `base` 和 `head`：先 trim 首尾空白，要求非空且不超过 200 个字符，拒绝以 `-` 开头的 revision，并拒绝 revision 内部出现空白、控制字符或反斜杠。Request label、cache key 和 URL serialization 都必须使用归一化后的 revision，避免 commit-compare surface 因等价用户输入拆出多份状态。
Snapshot 的 `source` 是 review identity 的一部分。为了兼容旧后端，响应可以省略 `source`，由客户端按请求 endpoint 补齐；但如果响应显式带了 `source`，它必须和请求的 endpoint 一致。Working-copy endpoint 的响应不能被接受成 `git-range`，git-range endpoint 的响应也不能被接受成 `working-copy`。
Snapshot identity 字段不是纯展示字符串。客户端接受 snapshot 前，`reviewId`、`root`、`patchset`，以及存在时的 `basePatchset` 都必须是非空字符串；否则 reviewed state、comments 和 lazy diff effect 就没有稳定的 Gerrit-style 边界。

大型 review surface 应该用 `metadataOnly: true` 请求 file-list-first snapshot，对应后端参数 `metadataOnly=1`。Metadata-only 文件会保留 path、status、rename metadata、行数统计、可获得的 mode / blob sha 等文件身份 metadata，以及 binary、too-expensive、truncated 这类 loaded-negative flags，但设置 `diffLoaded: false`，并让 `diff.hunks` 为空。这是未来 CHANGES 接入、working-copy 已修改文件 review、commit-range 对比的推荐入口；inline rows 应只在读者展开某个文件时再加载。
虽然 Farming 用数组传输 snapshot files，但模型语义和 Gerrit `FileInfo` map 一样：同一个 patchset 中每个 review path 最多只能出现一次。后端 snapshot 生成、前端 snapshot loader、snapshot 到 catalog 的模型 helper，以及 `createReviewState()` 都必须拒绝重复 file path，而不是静默去重，因为 reviewed state、comments 和 lazy diff hydration 都用 path 定位文件。调用方需要 Gerrit-style path lookup 时应使用 `reviewFileMapFromFiles()`，不要在 UI 里临时重建一套 map 语义。
Gerrit `FileInfo` map adapter 应 fail fast：map 本身必须是 object，每个 map value 也必须是 object。单个 FileInfo 字段仍然可以缺失或畸形，并由 adapter 逐字段归一化；但 path-keyed map 结构本身不是可选项，因为它是 reviewed state、comments 和 lazy diff hydration 的身份边界。
Gerrit `FileInfo` map key 和 rename `old_path` 也都是 review path identity。Adapter 必须在这些 path 进入 comments、reviewed state、navigation 或 lazy diff hydration 前拒绝非法 path，同时仍允许 `/COMMIT_MSG` 和 `/MERGE_LIST` 这类 Gerrit special review files。
Gerrit `FileInfo` 的数值 metadata 也必须在同一个边界归一化：行数和 size 只接受 integer，负数行数 / size 会变成零，非法 `size_delta` 会变成零。`old_sha` 和 `new_sha` 这类 blob sha metadata 只有在非空字符串时才会进入 `ReviewFile`。
`diffLoaded: false` 是文件列表 metadata 状态，不是“部分加载了 inline diff”。带 `diffLoaded: false` 的文件不能携带 inline hunks。单文件 diff endpoint 必须返回已加载的 inline diff，或者明确的 loaded-negative 结果，例如 `binary`、`diffTooExpensive` 或 `diff.truncated`，不能返回普通 metadata-only 行。
已加载的 JSON diff 响应必须提供结构化 hunk range。API validator 应拒绝只有展示 header、没有 `oldStart`、`oldLines`、`newStart`、`newLines` 的 hunk，也应拒绝和 row 模型不一致的 range，包括 Gerrit 风格 skipped rows 的跨度。原始 header 仍可用于展示和 patch 序列化，但导航、review state 和未来 diff layout 不能把它当成权威数据源。

当数据源是本地 git 输出时，后端负责把 raw patch header 和 raw diff metadata 解析进共享文件模型。`index old..new mode`、`new file mode`、`deleted file mode`、`old mode`、`new mode`，以及 file-list-first 视图用到的 `git diff --raw` 条目，都应在到达 UI 组件之前填充为 `oldSha`、`newSha`、`oldMode` 和 `newMode`。
本地 synthetic diff（例如还没有 Git patch 的 working-copy untracked 文件）也必须填充结构化 hunk range（`oldStart`、`oldLines`、`newStart`、`newLines`），不能只依赖展示用 header。当 synthetic untracked diff 因 review 行数上限被截断时，full snapshot 和 metadata-only snapshot 都必须标记 `diff.truncated` 和 `diffTooExpensive`，这样 file-list-first UI 不会把它误判成普通可 lazy-load 行。
当数据源是 Gerrit `FileInfo` 时，`old_mode` 和 `new_mode` 可能以 JSON number 形式返回，虽然语义上是 `100644` 这样的 octal mode。Adapter 应同时接受 number 和 string mode，并归一化成 `ReviewFile.oldMode` / `ReviewFile.newMode` 使用的六位字符串形式。
Gerrit `FileInfo.status` 和 `DiffInfo.change_type` 也必须在 adapter 边界归一化。未知 status 或 change-type 不能进入 `ReviewFile.status`；它们会回退为 modified (`M`)，确保 selector、状态机和 API validator 只看到共享的状态码集合。当同时存在 `FileInfo` 和 `DiffInfo` 时，只有合法的 `FileInfo.status` 可以覆盖 `DiffInfo.change_type`；未知外部 status 应回退到由 DiffInfo 推导出的 kind/status，不能被当成权威状态。
对于 `GIT binary patch` 输出，JSON diff snapshot 应把文件标记为 binary，并只保留文件级 header 行。Binary patch payload 属于原始 patch 下载，不应该进入 inline review rows 或 `diff.diffHeader`。
本地 Git adapter 使用和 Gerrit adapter 一样的稀疏 boolean 约定：只有 `binary` 为 true 时才把它写到 `ReviewFile` 上。`git diff --numstat` 这类内部统计 helper 可以保留 `binary: false` 用于计算，但把统计结果合并进 `ReviewFile` 时，普通文本文件不能对外暴露 false-valued binary flag。
来自 `git diff --numstat` 的行数 metadata 必须和权威的 `--name-status` 文件列表合并后再解释 rename 语法。普通文件名本身也可能包含 ` => `，所以 numstat path 解析必须优先精确匹配 changed path，只能通过已知 rename/copy 条目把 `old => new` 映射到新路径。File-list metadata 命令应对 `--name-status`、`--numstat` 和 `--raw` 使用 Git 的 NUL-delimited 输出（`-z`），避免 tab、换行、首尾空格或其它可打印分隔符破坏文件身份。即使在 `--numstat -z` 中，非 rename 条目也会把 `insertions<TAB>deletions<TAB>path` 放在同一个 token 里，所以 parser 只能切前两个 tab 分隔符，并把剩余部分整体视为 path。Review path 是身份标识，不是展示 label；Git 输出后不要再 trim 或做其它 normalize。
当 `--name-status` 产出权威 changed-file 顺序，并且 review limit 已经选出当前可见文件集合后，辅助 git 命令也必须使用这个 selected pathspec。Metadata-only 的 `--numstat` 和 `--raw` 不应该继续扫描整个 commit range；rename/copy 条目应同时包含 previous path 和 current path，这样 Git 仍然可以返回文件身份 metadata。

单文件 diff 懒加载 hydration 必须把 inline diff rows 合并进已有 file-list 条目，而不是整文件替换。这样即使懒加载响应更像 Gerrit `DiffInfo`、只携带内容行，也不会丢掉 Gerrit `FileInfo` 风格的 metadata。Hydration 过程中，path identity、status、change kind、previous path、additions/deletions、file mode、blob sha 和 size 仍以 file-list metadata 为准；懒加载响应只负责提供 inline diff 内容，以及 binary、too-expensive、顶层 `truncated` 或嵌套 `diff.truncated` 这类 diff-load 标志。如果任一侧报告了 `diff.truncated`，hydrate 后的 loaded diff 必须保留它。

评论和检查结果可能指向当前 diff 中未修改的文件。和 Gerrit 的 `addUnmodified()` 一样，Farming 保持原始 changed-file snapshot 不变，并提供 `reviewCatalogWithUnmodifiedPaths()` / `reviewFilesWithUnmodifiedPaths()` 来构造展示用 catalog，给这些 path 补 `status: 'U'` 的 unmodified 文件行。这些 helper 会跳过已经存在的 path、rename 的 old-side path，以及非法 review path。
对于 renamed 或 copied 文件，评论和 draft 查询必须同时考虑当前 path 和 previous path，对齐 Gerrit 的 `getCommentsForFile()` / `computeDraftCountForFile()` / `computeCommentsThreads()` 行为。State hydration 和 catalog reconciliation 必须保留 path 等于文件合法 `previousPath` 的 comments / drafts，即使这个 old path 不是一个单独的 changed-file row。`reviewCommentPathsForFile(file)`、`reviewFileCommentPaths(file)`、`commentsForFilePaths(state, paths)` 和 row model 的 `commentPaths` 字段提供共享 selector 层，避免不同 UI surface 各自实现 rename-aware comment lookup。创建或渲染按 side 区分的行评论时必须使用 `reviewCommentPathForSide(file, side)`：rename/copy 的左侧评论挂到 previous path，右侧评论挂到当前 path，对齐 Gerrit 的 `FileRange.basePath` 行为。

Unified diff mode 只是展示方式，不是单独的评论 side。Unified 行上新建评论时仍然必须落到 Gerrit 风格的 left/right 存储 side：删除行挂 left，新增行挂 right，context 行在存在 right-side line 时优先挂 right。调用 `reviewCommentPathForSide(file, side)` 前应先用 `reviewCommentSideForUnifiedCell(kind, hasRightSide)` 得到真实存储 side。

Patchset summary 应遵循 Gerrit 的 magic-path 行为。`/COMMIT_MSG` 和 `/MERGE_LIST` 这类特殊文件行是合法的 reviewable row，也可以被标记 reviewed，但它们的 additions / deletions 不应该计入普通 changed-file 行数总计。
文件列表的行条和 binary 汇总应来自 `reviewFileListStats()`。它对齐 Gerrit 的 file-list 行为：排除 magic paths，把普通行级 additions / deletions 和 binary byte deltas 分开，并暴露 size-bar layout 需要的 max added / deleted 计数。

Snapshot identity 不应该依赖是否携带 inline rows，也不应该依赖使用了哪组 diff 展示偏好。同一批 working-copy 改动的 full snapshot、metadata-only snapshot，以及使用不同 context / whitespace 偏好渲染的 working-copy snapshot，都应共享同一个 `reviewId + patchset`，这样 reviewed state 和 comments 才按真实文件集合隔离，而不是按加载策略隔离。Git-range review 也遵循同一规则：`base + head + canonical root` 定义 review identity；metadata-only 加载和 diff 展示偏好不能创建另一个 reviewed-state bucket。
当某个 surface 在同一个 review identity 内刷新 file list 时，必须先用新的 `ReviewCatalog` reconcile 现有 `ReviewState`，再继续渲染行或接收延迟 effect。`reconcileReviewStateWithCatalog()` 会清理 reviewed paths、expanded rows、pending lazy diffs、diff-load errors、auto-review candidates、context expansions、comments、drafts，以及指向已不存在 path 的 pending reviewed-status writes。当刷新后的文件已不再可 lazy-load 时，例如刷新后的 catalog 已经包含 loaded inline diff，或该行变成 binary / too-expensive，pending lazy diff 和 diff-load error 也必须清掉。Pending comment save 只有在 optimistic comment 仍然通过 reconcile 后才保留；pending comment delete 必须保留到匹配的 completion 或 restore 到达，因为 optimistic delete 已经把 comment 从列表里移除了。这样文件消失、rename、loaded refresh 或 working-copy cleanup 不会留下 stale row state，也不会丢掉仍在飞行中的删除边界。

Review identity 也应该使用 canonical workspace identity，而不是原始传入路径。如果同一个 repo 同时通过真实路径和 symlink 路径打开，生成的 working-copy / git-range review id 必须保持一致，避免 reviewed state 在等价 workspace 入口之间分裂。
对于 git-range review，base revision 是 review identity 的一部分。像 `HEAD~2 -> HEAD` 和 `HEAD~1 -> HEAD` 这样的比较可以拥有相同的右侧 patchset label，但不能共享同一个 review id 或 app-level review state key。

会影响 diff 内容的偏好（例如 `context`、`ignoreWhitespace` 和 Gerrit 的 `intraline_difference`）属于 diff 模型。它不应该改变 review id、patchset id、reviewed file list 或 file-list metadata。Farming 将 Gerrit 的数字 context 设置映射为 `git diff --unified=<lines>`，用于 inline diff 和 patch 下载。Farming 将 Gerrit 的 whitespace 模式映射到 git：`ALL` 使用 `--ignore-all-space`，`TRAILING` 使用 `--ignore-space-at-eol`，`LEADING_AND_TRAILING` 使用 git 最接近的原生模式 `--ignore-space-change`。当 full diff 请求用 `--numstat` 覆盖行数统计时，这个 numstat 命令必须使用和 inline diff 相同的 whitespace 模式。当结构化 diff 数据源提供 Gerrit `edit_a` / `edit_b`、`intraline_status`、rebase 标记和 moved-code metadata 时，Farming 会保留这些信息；adapter 接受 Gerrit 的 `OK`、`Error`、`Timeout`，再归一化为 Farming 内部的 `OK`、`ERROR`、`TIMEOUT`。本地 git diff 生成不会凭空制造 intraline ranges、rebase 标记或 moved-code metadata。
Diff view mode 是独立的渲染状态。和 Gerrit 的 `RenderPreferences.view_mode` 类似，Farming 的 `diffMode` 只决定 split / unified 渲染方式，但不能影响 review identity、file-list metadata、reviewed state 或 lazy diff request key。从 hydration 或 URL 进入的 mode 应先通过 `normalizeReviewDiffMode()` 归一化，再进入 `ReviewState`。

为后续懒加载展开，后端也提供单文件 diff 接口：

- `GET /api/reviews/working-copy/files/:path/diff?agentId=...`；
- `GET /api/reviews/git-range/files/:path/diff?agentId=...&base=...&head=...`。

这些接口返回单个已加载的 `ReviewFile`，完成 Gerrit-like 的 file-list-first 加载路径：文件表可以先展示出来，不必等所有 inline diff 都计算完成。
前端调用方应使用 `loadReviewFileDiff(request, path)` 或 `reviewFileDiffUrl(request, path)`，不要在组件里按 diff source 手写分支。`reviewSnapshotFileRequestKey(request, path)` 提供对应的稳定 lazy expansion cache key。
当 source request 带有 `context` 或 `ignoreWhitespace` 时，`loadReviewFileDiff(request, path)` 和 `loadReviewPatch(request)` 会继续传给后端，保证展开行、下载 patch 和 cache key 处于同一种 diff 模式。
Request key 必须用和传输层完全一致的方式归一化 diff-only query 字段：非法 `context` 折叠为省略/默认 context，非法或 `NONE` whitespace 模式折叠为不发送 `ignoreWhitespace` 参数。这样 lazy diff cache 才会和真实后端请求对齐，不会产生只有 UI cache 里存在的伪 bucket。
Snapshot 和 patch request key 对 `limit` 也使用同一规则：只有正整数 limit 会被序列化进 URL 或 cache key，非法 limit 视为省略。后端在应用最大文件数上限前也使用同一个归一化规则，所以直接 API 调用方和前端 cache 共享同一条 limit 边界。
Review diff service 必须在 review 边界同时为 git-range 和 working-copy source 强制应用归一化后的 limit。底层 workspace file API 可以接受 limit hint，但 review snapshot 和 patch download 仍要自己截取最终 changed-file list，并在源列表超过选中 limit 时设置 `truncated`。单文件 lazy diff hydrate 和 whitespace-aware line-stat refresh 也应限定到被请求的文件，不能为了一个文件重新计算整个 range 的 metadata。
完成 lazy file-diff load 时仍必须绑定当前 review identity 和 catalog。只有原始 `load-file-diff` effect 携带的 `reviewId` 仍和当前 `ReviewState` 一致、响应 path 和 effect 相同，并且这个 path 仍存在于同一个 patchset catalog 中，completion 才有效。生成的 `commit-file-diff-load` / `fail-file-diff-load` action 会携带同一个 `reviewId`，状态机会拒绝 reviewId 不匹配的 stale action。如果用户已经切换 range、刷新文件列表，或该行已经被移除，这个 completion 就是 stale，不能假装当前 file list 已经 hydrate 完成，也不能清掉对应 pending diff-load 状态。
Completion helper 必须拒绝把 metadata-only 行当成已加载 diff 结果。带 `diffLoaded: false` 的 `ReviewFile` 是文件列表条目，除非它是 `binary`、`diffTooExpensive` 或 `diff.truncated` 这类明确的 loaded-negative 结果；状态层不能静默把它升级成 loaded inline diff。
单文件 diff API helper 也必须在传输边界校验 path。请求 `src/a.ts` 就必须返回 `path` 正好等于 `src/a.ts` 的已加载 `ReviewFile`；即使响应 payload 其它部分看起来像合法 diff，只要 path 不一致就无效。这对应 Gerrit 以 path 定位文件资源的模型，避免未来多行 lazy expansion 时把 diff hydrate 到错误行上。

## Review State

Reviewed 状态按 patchset 隔离，和 Gerrit 语义一致。某个文件是否 reviewed，只取决于它的 path 是否在该 patchset 的 reviewed file list 中。Farming 的 patchset id 不一定是简单数字：working-copy snapshot 会使用稳定生成的 label，git-range snapshot 可能直接使用 `origin/master` 或 `refs/heads/topic` 这类 Git ref。Review-state 存储、API 路由和前端 API helper 都必须把 review id 与 patchset id 当成 opaque safe key，而不是文件系统路径或纯数字。Safe key 非空、以 ASCII 字母或数字开头、排除反斜杠和控制字符，并允许 Git ref 所需的 `/`。Safe key 的长度上限应和 diff API 接受的 git revision 长度保持一致，保证能查看的 git-range diff 也能持久化 reviewed 状态。

客户端状态必须区分 “reviewed files 还没加载” 和 “已经加载且为空”。这和 Gerrit 的 `reviewedFiles?: string[]` 模型一致：`undefined` 表示 reviewed-file list 尚未获取，`[]` 表示已经获取且没有文件 reviewed。文件行按钮和 mark-all UI action 应在 reviewed-file list 加载前保持 disabled 或隐藏，避免 UI 因缺失状态误渲染 `MARK REVIEWED`。

自动 review 遵循 Gerrit 的单文件规则。如果用户偏好允许 auto review，单独打开一个文件可以把这个文件标成 reviewed，但必须等 reviewed-file list 加载后才能执行。如果用户在 list 加载前打开文件，状态机会记录一个 pending auto-review candidate，并在 `hydrate-reviewed-status` 到达时处理。`EXPAND ALL` 不能创建 auto-review candidate；文件在 hydration 前被收起时也要取消这个 candidate。

主 reviewed-file API 采用 Gerrit 风格：

- `GET /api/reviews/:reviewId/revisions/:patchset/files?reviewed` 返回 `string[]`；
- `PUT /api/reviews/:reviewId/revisions/:patchset/files/:path/reviewed` 将单个文件标成 reviewed；
- `DELETE /api/reviews/:reviewId/revisions/:patchset/files/:path/reviewed` 将单个文件标成 unreviewed。

Review-state router 有意不实现裸 `GET .../files`。在 Gerrit 里这个 route 返回 `FileInfo` map，而这个 router 只负责 reviewed state。文件列表 metadata 应留在 diff snapshot / 未来 FileInfo API 中，不要从 review-state storage 返回一个假的文件列表。
`reviewed` query 是 Gerrit 风格的 reviewed-file list selector。Farming 接受裸 query 形式（`?reviewed`）和显式 true 值以保持兼容，但会拒绝显式 false 值，避免把 `?reviewed=false` 也解释成 reviewed list。
返回的 reviewed-file list 语义是集合。API 为了兼容 Gerrit 用 `string[]` 传输，但客户端必须拒绝非法 path 和重复条目，不能把这个响应当成有序 bag。
客户端写入 helper 也必须在发请求前校验 `reviewId`、`patchset` 和每个被定位的文件 path。多文件 UI convenience action 仍然只是按顺序执行 Gerrit 风格的单文件写入，不是后端批量操作；但 desired change list 本身是集合语义，必须在任何网络请求发生前拒绝重复 path。Comment helper 使用同一套 review identity safe-key 校验，并且必须在发请求前拒绝非法 comment id 或 comment path。

Farming 会额外在响应 header 里带 `X-Farming-Review-Revision`，用于本地防止旧响应覆盖新状态，但 body 保持 Gerrit-like。`PUT` 新建 reviewed flag 时返回 `201 Created`，文件已经 reviewed 时返回 `200 OK`；`DELETE` 返回 `204 No Content`。客户端可以先乐观更新 reviewed paths，写入成功后重新读取权威 reviewed file list。

Mark-all 变更是前端 convenience，不是服务端第二套事实：

```ts
{ changes: [{ path: 'src/file.ts', reviewed: true }], revision: 4 }
```

未来的 “mark all visible reviewed” 应该在 UI 层派生 desired changes，然后对每个 path 执行同一个单文件 primitive，最后重新读取权威 reviewed file list。
如果一个多文件 convenience action 在部分单文件写入已经到达后端后失败，共享 API 层应尽量重新读取权威 reviewed-file list，并把它挂到抛出的 `ReviewApiError.state` 上。Review UI 应从这个权威状态恢复，而不是假设整个 action 具备原子性。
Review-state hydration 和 save completion 都是异步的，也必须绑定 review identity。如果一个带 `reviewId` 的 `ReviewState` 发出 `save-reviewed-status`、`save-comment` 或 `delete-comment` effect，这个 effect 会携带该 id；`hydrate-reviewed-status`、`commit-reviewed-status`、`restore-reviewed-status`、`hydrate-comments`、`commit-comment`、`restore-comments` action 如果携带了不同 id，就必须被忽略。这对应 Gerrit 的 `changeNum + patchNum + file` 边界，避免用户切换 working-copy 或 commit range 后，旧响应写入当前 review。
因为 Farming 会 optimistic 地应用 reviewed 变化，`restore-reviewed-status` 只能作为当前 pending save 的失败回滚。Stale restore action 不能回滚已经完成的 mutation，也不能替换更新的 reviewed revision。
评论保存和删除遵循同样规则：`commit-comment` 和 `restore-comments` 只能在同一个 comment mutation 仍然 pending 时作为完成或失败事件。Pending mutation 由 comment id 和操作类型（`save` 或 `delete`）共同标识。一旦 `commit-comment` 清掉 pending mutation，或者更新的 pending mutation 已经是另一个 id 或另一种操作类型，迟到的 commit / restore 响应必须被忽略，不能清掉 pending state，也不能替换权威 patchset comment list。
Comment id 的作用域是所属 patchset。Client model 应按 `patchset + id` 做去重、保存和删除，对齐后端按 patchset 存储 comments 的边界，避免上游复用 id 时两个 patchset 的评论互相隐藏或误删。

## UI Contract

文件行展示状态应通过 selector 派生，不要直接读取原始数组：

- `src/lib/review/state.ts` 导出 `reviewFileState(state, path)`，返回 `{ status, pending }`；
- 展开 `diffLoaded: false` 的文件会产生 `load-file-diff` effect，并记录到 `pendingDiffPaths`；调用方加载并回填 catalog 后用 `commit-file-diff-load` 清掉 pending，失败时用 `fail-file-diff-load` 记录 path-scoped error；
- `src/lib/review/state.ts` 导出 `reviewPatchsetSummary(state, catalog)`，返回文件数、additions、deletions、reviewed 数和 unreviewed 数；
- `src/lib/review/api.ts` 导出 `loadReviewDiffSnapshot(request)`、`reviewSnapshotUrl(request)`、`loadReviewFileDiff(request, path)`、`reviewFileDiffUrl(request, path)`、`loadReviewPatch(request)`、`reviewPatchUrl(request)`、`loadReviewPatchText(request)`、Gerrit-style `loadReviewedFiles()`、review comment helper 和单文件 reviewed 写入 helper；snapshot loader 会拒绝显式 source 与 endpoint 不一致的响应，review-state helper 会在 fetch 前拒绝非法 safe key，避免 review identity 在 working-copy 和 git-range surface 之间漂移；
- `src/lib/review/route-target.ts` 将 `?agentId=...`、`?agentId=...&base=...&head=...` 这类 route query 转成 REST API helper 使用的同一个 `ReviewDiffSnapshotRequest` 模型，也会归一化 `limit`、`context`、`ignoreWhitespace`、`metadataOnly` 这类 request option。非法 option 会被省略；非法或不完整的 range 会返回显式错误，不能 fallback 成 working-copy review；
- `src/lib/review/diff-info.ts` 将 Gerrit 的 `DiffInfo` / `DiffContent` 映射到 Farming diff rows 和左右侧 metadata，供未来 Gerrit-like 数据源和后端结构化 diff 共用；
- 当同时有 Gerrit `FileInfo` 和 `DiffInfo` 时，优先使用 `reviewFileFromGerritFileAndDiffInfo()`：显式存在的文件列表统计和状态来自 `FileInfo`；缺失的统计/status 要回退到 `DiffInfo`，避免 FileInfo 默认值覆盖真实 `change_type` 或行数；inline diff 行始终来自 `DiffInfo`；
- `src/lib/review/effects.ts` 负责 effect completion helper，例如 `completeReviewFileDiffLoad()` 和 `failReviewFileDiffLoad()`，保证调用方用一致方式收尾 lazy file-diff effect，并拒绝 review id 或 patchset/path 已经不属于当前 catalog 的 stale completion；
- `src/lib/review/file-info.ts` 将 Gerrit-style `FileInfo` map 归一化为 `ReviewFile[]`，包括 `/COMMIT_MSG` 这类 special path；
- `src/lib/review/file-list.ts` 派生 Gerrit 风格的文件行 label、按钮、toolbar actions、diff loading state、二进制/文件大小 metadata、文件列表 stats 和 mark-all UI changes；
- `reconcileReviewStateWithCatalog()` 是同一 review identity 内 file-list 更新的共享 refresh hook。UI 替换 catalog 时应调用它，而不是手写 path-scoped state 清理逻辑；
- 文件列表展示顺序是 selector，不是 catalog mutation：`reviewFileListSections()` 将 modified files 和 Gerrit-style unmodified/comment-only files 分段，暴露 `showUnmodifiedSeparator`，并保持各组内顺序。`reviewFileListDisplayFiles()` 和 `reviewFileListReviewableFiles()` 都使用同一个 section model。Binary 文件、too-expensive inline diff，以及 unmodified/comment-only 文件仍然都是 reviewable path，这和 Gerrit 的 path-set reviewed model 一致。`reviewAdjacentFilePath()` 从这个展示顺序派生普通上一文件/下一文件导航，对齐 Gerrit 的 `sortedPaths` 导航，避免 UI 直接读取原始 file array。`reviewUnreviewedFilePaths()` 生成未来 “next unreviewed file” 控件使用的导航列表，并可按需保留当前文件，和 Gerrit 的导航行为一致。`reviewAdjacentUnreviewedFilePath()` 和 `reviewMarkReviewedAndNavigateIntent()` 为 Gerrit 风格的 “mark current reviewed and go to next unreviewed” 交互提供共享 selector 层。Mark-and-navigate intent 只有在当前文件能在同一次 action 中实际标记为 reviewed 时才返回 `nextPath`；普通上一/下一文件导航应直接使用 `reviewAdjacentFilePath()` 或 `reviewAdjacentUnreviewedFilePath()`。Intent 会显式暴露 `reviewedStatusLoaded` 和 `mutationPending`，避免 UI 把空 `changes` 混淆成 “已经 reviewed”、“还没加载”、“行不存在” 或 “保存中”；
- `reviewFileRowModel()` 对齐 Gerrit 文件列表 reviewed cell：同一个 reviewed-file source 同时派生 `Reviewed` label 和 `MARK REVIEWED` / `MARK UNREVIEWED` switch，但 switch action 会声明 `visibility: "on-row-interaction"`，只有在 row hover、focus 或 expanded 状态下才应该视觉浮现。已阅行不能看起来像同时有两个常驻状态；
- 展开文件行时必须显式渲染 diff status：loaded 行展示代码，`not-loaded` 行在 lazy request 期间展示 loading 或 error，`binary` 行展示 binary-file message，`too-expensive` 行说明 inline diff 不可用，不能静默渲染成空 diff；
- `src/lib/review/preferences.ts` 将 Gerrit 的 `DiffPreferencesInfo` 映射为 Farming preferences，并显式处理 `context`、`ignore_whitespace` 和 `intraline_difference`；Farming 单独展开文件时始终标记为 reviewed，而展开全部仅改变展示状态；
- `src/lib/review/snapshot.ts` 负责 source/range helper、稳定 request key、label，以及从 snapshot 到 review catalog/state 的转换；
- metadata-only snapshot request key 有意忽略 `context` 和 `ignoreWhitespace`，因为 file-list metadata 与 diff 内容偏好无关；单文件 diff request key 和 patch-text request key 仍然包含这些偏好。Patch 下载应使用 `reviewSnapshotPatchRequestKey()`，不要复用 snapshot key，因为 patch text 会忽略 `metadataOnly` 但依赖 diff 展示偏好；
- request key 和 API query serialization 对 diff-only options 共享同一个归一化边界：只有非负整数 `context` 和 Gerrit-compatible whitespace modes 才会真正进入 key 或 URL；
- `reviewCatalogWithFile()` 可以在保持文件顺序和 file-list metadata 的前提下，把 inline diff rows hydrate 到 patchset catalog 中的单个文件，供未来 lazy-expand UI 加载 `DiffInfo` 风格内容，同时避免污染 `FileInfo` 风格统计；
- `src/lib/review/diff-text.ts` 将 `ReviewFile[]` 序列化回 patch text，供 download 和后续多文件 diff 流程复用。它会优先保留源 `diffHeader`；没有源 header 时，fallback header 会包含模型里的 file mode 和 blob sha metadata，避免 mode-only 或类似二进制 metadata 的变化被抹平。

这样可以避免同一行同时出现 `Reviewed` 和 `MARK REVIEWED` 这类互相冲突的 Gerrit 操作状态。
