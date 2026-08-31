# Project Files 设计

> English version: [project-files-section-design.md](./project-files-section-design.md)

Project Files 让用户在监督 Agent 时查看并轻量编辑 Project。它不以替代完整 IDE 为目标。

详细的正确性、resolve、retention、并发与恢复契约由
[Workspace File 状态模型](./workspace-file-state-model.zh_cn.md)定义。
交互请求复用与大内容传输边界由
[Workspace 传输协议](./workspace-transport-protocol.zh_cn.md)定义。

## 产品位置

Files 属于具体 Project，不属于 Main Agent。Project 展开后包含：

```text
Project
  Agents
  Open Editors（存在打开文件时）
  Files
    Working-copy Changes
    Git History
    Directory Tree
```

Project Sidebar 只有一个外层 Scroll Surface。Files、Open Editors、Changes、History 与
Directory Tree 不能创建互相竞争的 Project 级滚动条。深层目录路径可以滚出视口，但不能改变
滚动所有权。

当某个 Project 占据该 Scroll Surface 顶部时，它的 Project Row、Agent Rows、Open Editors 与
Files Header 组成同一个分层 Sticky Summary；后一层 Offset 来自前面各层的实测高度。Project
到达尾部边界后，所有可见层必须以相同 Scroll Delta 一起释放，后层不能先滑过并遮住 Project
名称或 Branch。Directory Row 从这组 Summary Stack 下方滚过，不再增加随滚动联动的祖先摘要行。

Open Editors 的 Sticky 列表最多展示 7 行，高度使用与文件树相同的响应式行高。更长的编辑器
列表在这个有界摘要区内滚动；未填满时不额外预留滚动条空隙，避免操作按钮偏离共同的对齐边界。

Project Agent 行采用渐进展示，避免大型 Agent 分组难以浏览。Project 初始显示 5 个 Agent，
第一次“显示更多”最多再显示 5 个，之后每次最多再显示 10 个；“显示较少”恢复为初始 5 个。
Selection、Search 与 Active Agent 变化可以替换当前容量内的行，但只有“显示更多”和
“显示较少”可以改变这个容量。当 Live Agent 行和可恢复 Session 行都还有更多条目时，
Project 同一时间只显示一个“显示更多”操作，并先展示剩余的 Live Agent，再展示更多 Session。
选择已经可见的 Agent Row 时保持 Project Scroll Surface 位置不变；导航到不可见 Agent 时，
可以在该 Surface 中定位并显示目标。

## Project 与 Workspace 身份

Project 是持久挂载到 Farming 的 Workspace。Agent 创建、文件打开、恢复的 Project Session
与 Git Worktree 选择都引用同一个 Workspace Identity。最后一个 Agent 或 Editor 消失时不能
静默移除 Project；显式 Remove 才是 Unmount Action。在已挂载 Project 内打开其他文件时复用
现有 Membership，不得在文件打开关键路径上重复执行 Project Mount Mutation。并发打开
如果发现同一个 Project 尚未挂载，共用一次 Mount Mutation。取消某个 File-open Waiter
不会取消或重放该 Mutation；其结果仍会更新 Browser 中的权威 Membership，而只有当前
File-open Intent 可以提交 Main Pane。

只有 Project 不再依赖任何资源时，显式移除才会立即执行。如果仍有 Live Agent、Main-page
Session 或已打开的 Editor Tab，Remove 必须先展示确认清单。用户确认后，依次归档 Agent、
移除该 Project 的 Main-page Session Membership、关闭 Editor Tab，最后才卸载 Project
Membership。取消操作不产生任何 Effect。各阶段仍分别由现有 Lifecycle、Session Membership、
Editor 和 Project Membership Controller 持有；任一阶段失败都停止后续阶段并保留 Project。
已经完成的清理不回滚，因此 Retry 必须基于当前权威状态重新生成资源清单。Project Remove
结果不明确时，只能从权威 Membership 对账，不能盲目重放。确认执行期间禁止重复确认和取消；
成功、确定失败或有界的不确定结果对账都会终止本次尝试。

用户在创建 Agent 时显式选择仓库子目录，该目录就是 Project 边界。外层 Git Worktree 仍然
负责仓库操作，但不得因此把 Agent 提升到范围更大的已挂载 Project。从已有 Project 界面启动时，
则可以显式传入该 Project Workspace，同时使用更深层的 Working Directory。

Git 拥有 Repository 与 Worktree Identity。Farming 把每个 Worktree 展示为普通 Project，
只拥有它在 Workspace 中的 Membership 与 Order。
任何绝对文件打开入口（包括 Chat 链接、Terminal 链接与分享 URL）都先通过同一个解析边界，
由 Backend 权威查找最近的上层 Git Worktree；
查找成功后挂载该 Worktree，并按 Repository Relative Path 走普通 Project 文件链路（包括
Git Blame）。找不到 Repository 时，才回退到有界、只读的 Global File Path。Global File
Fallback 只打开精确文件，不尝试在不可能包含它的 Project Tree 中定位。

文件系统路径在内部使用解码后的 Identity。Markdown Link、Preview Resource、Share URL 与
File API 等结构化 URI 边界只编码一次，并在 Workspace Resolution 前只解码一次。自由格式的
Terminal Text 属于另一条词法边界：除非显式 Link 或 Literal 已经确定 Path Identity，否则不能
在全局把空格重新解释为路径的一部分。

Files Identity 来自 Canonical Workspace，不能依赖当前碰巧引用它的 Agent。可选 Source Agent
Association 可以跨 Project 保留，以支持从文件返回来源 Agent，但不属于文件 Ownership。

Global Search 以有界并发、结果数量与取消机制查询当前已挂载且非 Main 的 Project 权威文件索引。
全局条目搜索区分目录和文件，不搜索内容。普通关键词匹配条目名称，命中父目录不隐式返回其
全部子文件；路径查询可以定位对应的目录或文件。空目录也可以被搜索。结果保留 Project 根目录
与相对路径 Identity，在同一根目录内去重，目录排在文件之前。两类结果分别使用有界额度，
文件不能挤掉目录结果。用户发起的全局条目搜索使用有界交互请求队列，不能在后台 Project
元数据刷新队列中等待到搜索超时；原有并发、过载和取消限制保持有效。“全部、文件与目录、当前 Agent、历史会话”筛选显示实际返回条目数量。
即使历史会话有匹配，条目加载、空结果、不完整与失败状态也必须可见。历史会话存在不代表
对应 Project 已挂载。
Project 分组直接显示可区分同名目录的路径；历史行标明类型、更新时间，并在实际工作目录与
Project 根目录不同时显示工作目录。

Workspace 拥有 Query、结果筛选和键盘选择。切换筛选保留 Query 和已完成搜索，取消待完成的
文件打开，并选择第一条可见结果。修改 Query 或关闭 Search 会取消过期工作。渲染与键盘导航
使用同一筛选顺序，Enter 只能打开可见结果。筛选不能挂载 Project 或恢复会话。搜索失败沿用
下述有界重试和取消协议。
文件结果展示 Project、同名冲突时扩展到最短唯一后缀的 Workspace Label，以及完整 Workspace
Relative Path，使同名且相对路径相同的文件仍能明确区分。用户可以输入
Workspace Relative Path，或输入属于其中一个已挂载 Project 的 Absolute Path，并可附带行列位置。
点击结果或按 Enter 后，必须通过普通 Project File-open Transaction 打开该精确 Identity、在
Explorer 中 Reveal，并在来源 Agent 仍存在时保留为移动端 Back Target。Search 不得扩大到全局
文件系统，也不得在用户选择后用 Fuzzy Match 替代精确文件。如果文件在 Search 与 Open 之间移动
或变得不可访问，Search 保持可见并展示明确失败，用户可以修改查询或重新搜索。修改或关闭
Search、启动 Agent、跟随通知、移除目标 Project 都会取消进行中的 Read。Per-project 与 Global
Deadline 必须收敛到可 Retry 的明确 Failed 或 Incomplete 状态；语义未变化的 Project 刷新不得
重启这些 Deadline。

目录激活复用 Explorer 定位控制器。经过一次新鲜的后端读取确认目录仍可访问、Project 仍已挂载，
才切回 Projects、展开祖先与目标目录并选中它；不得打开任意子文件、创建 Agent 或恢复会话。
等待期间显示打开状态；失败保留查询与 Search 并显示明确错误。修改查询、切换筛选、关闭 Search
或再次激活目标会取消过期请求，迟到的结果不能夺取导航权。Project 根目录结果展开该 Project
的 Files 区域。

Search 拥有主面板内完整的滚动区域，包括滚动条和结果列周围的留白。在该区域内操作鼠标必须
保留 Search 及当前查询；原有的外部点击关闭行为仅适用于该区域和 Search 导航控件之外。
关闭事件的仲裁遵循共享的 [UI 交互协议](../../development/ui-interaction-protocol.zh_cn.md)。

## Directory 与 Navigation State

Directory Loading 只有 Absent、Loading、Loaded、Failed。Workspace Identity 变化会使 Pending
Load 失效；旧 Workspace Generation 的响应不能提交数据，也不能留下阻止 Retry 的 Loading。

Directory Expansion 是按 Workspace 隔离的 Browser-local Navigation State。每次鼠标或键盘
操作只改变一次期望展开状态；迟到 Directory Response 不能重新打开用户已经关闭的目录。
Files 收起时，持久化的展开状态不能启动 Directory I/O。Files 重新可见后，缺失的已恢复目录
以有界并发 Hydrate；Workspace 切换或组件卸载会取消已经失效的 Load。
首次展开如果发现单子目录链，Explorer 可以继续加载并压缩该目录链，再把同一次展开意图
迁移到最终可见目录。该过程必须限制最大深度、检测重复路径、不得自动穿过 Symbolic Link，
并在遇到分叉、文件、空目录、加载失败、Workspace 切换或用户中途折叠时停止。
鼠标或键盘直接展开时，当前行必须锚定在唯一的 Project Scroll Surface 中。Toggle 不能写入
Project Scroll，也不能启动 Reveal Operation；显式导航或编辑器的“在文件树中显示”操作才拥有 Reveal。

编辑器顶部在源码与预览模式下均提供“在文件树中显示”。该操作展开当前文件所属 Project、
Files 区域与父目录，打开已关闭的手机侧边栏，并复用现有 Reveal Owner 定位文件。重复点击
可以重新定位已经滚出视野的文件，不重新打开或读取文件，也不改变草稿、Editor Model 或
源码/预览模式。Exact External File 不属于任何 Project Tree，因此不提供该操作。

Explorer 区分 Active File、Keyboard Focus 与 Selection。从 Chat、Terminal、Search、History、
Plugins 或 URL 打开文件时只有一个 Reveal Owner，避免 Tree 与 Project List 争夺 Focus 或
Scroll。被 Reveal 的文件要锚定在文件可视区中间偏上的位置，而不是仅贴着下边缘露出。从文件
返回 Source Agent 时，需要展开该 Agent 所在的 Project 和 Agent Group，再 Reveal 精确的 Agent
Row；即使文件与 Source Agent 分属不同 Project 也必须成功。文件占用主区域时，来源关联不能把
任何 Agent Row 标为 Active。Explorer 的 Row Selection Surface 只能由 Explorer Selection 唯一
持有：Active Editor Path 可以保留导航状态，但用户选择目录或其他文件后，不能再绘制第二个 Row。
主区域返回 Agent 后，Explorer 可以保留上次 Selection 以便继续键盘操作，但在 Tree 或 Editor
再次拥有交互前，不能继续把该文件绘制成 Selected 或 Active。
Workspace 前进/返回把 Plugins
Location 作为一等 History Entry；打开来源文件后返回时，恢复原来的 Tab、Agent Home、
Extension Kind、Query、Detail 与 Scroll Position。

在目录树空白区域打开的上下文菜单会继承当前目录树选择，创建操作以该选择为目标；只有目录树
没有当前选择或焦点时，才以 Project 根目录为目标。

共享 Project Scroll Surface 上的每个程序化 Reveal 只持有一个 Generation Lease。更新的文件或
Agent Reveal，以及直接的 Pointer、Wheel 或 Keyboard 意图，会在旧 Owner 再次写入滚动位置前
撤销其 Lease。目标实测位置满足后 Reveal 立即停止；固定延迟的重复回放不能覆盖后续导航或用户输入。

## Workspace View Memory

记住能帮助用户继续上次工作的稳定选择，不记住交互过程、加载、错误和响应式临时状态。

先恢复权威的 Project 与 Agent 状态。有效的当前 Agent 或文件拥有最终定位权；失效的记忆目标
直接忽略。

## Working Copy 与 Mutation

文件系统是权威来源。Browser Working Copy 保留 Disk Baseline、Draft 与 Revision。保存某个
Revision 完成时，不能把更新 Draft 错误标成 Clean。Unsaved Draft 可以有界地在 Browser Local
恢复，但不能成为第二套文件系统权威。

窄屏触控布局下，冲突操作在必要时换行，让 Reload 与 Overwrite 保持直接可见，
不缩小触控区域。

已打开文件只监听其精确的 Workspace Relative Path，并由文件系统事件触发权威重读；打开文件
不能引入递归 Project Watcher。精确路径在每个 Workspace 内共享一个增量更新的 Watcher，重读
使用有界并发和超时。Clean Working Copy 自动采用最新磁盘内容，使 Source 与所有 Viewer 一起
刷新；Dirty Working Copy 保留 Draft，并进入明确的 External Change Conflict。事件突发需要
合并，迟到读取不能覆盖更新的已接受 Baseline。Markdown、HTML 或 SVG 引用的资源，以及
External 或 Symbolic-link 文件不会加入监听集合；这些文件和 Preview Dependency 由显式
Reload 操作刷新。

Save、Create、Rename、Move 与 Delete 都校验精确 Workspace 和预期 Object/Content Version。
发生冲突时保留用户 Draft，并展示 Reload 或 Overwrite 选择，不能静默覆盖外部变化。

Timeout 或 Transport Failure 结果不明确时，Farming 重读权威文件或父目录；只有能证明请求的
最终状态时才收敛，绝不自动重放 Mutation。

迟到 Browser Response 可以刷新权威数据，但不能关闭更新 Dialog、移动 Focus、打开替代文件，
或覆盖更新 Error。

File-open Transaction 依次处于 Selected、Reading、可选 Project Mounting、Committed、Cancelled
或 Failed。Project Composition 在所有 Project Files Section 之上拥有唯一的 Browser-side
Open-intent Generation；Section-local Request 可以拥有自己的 Loading Feedback，但不能独立
抢占 Main Pane。同一个 In-flight File 的重复打开共用同一次 Read 与 Transaction：最新
Intent 替换 View、Cursor、Focus 与 Reveal Field，而 Pin 只能单调升级。更新的不同文件
Intent 会撤销旧 Transaction，即使它来自另一个 Project。Transport Abort 只是 Best Effort；
当前 Intent Lease 才是可选 Mount 前后以及提交 Editor State 前的最终准入检查。

Farming 不宣称与任意 External Writer 组成 Transaction。Shell、Agent、Git、Editor 与其它
Farming Instance 都是同一文件系统的独立客户端。

## Explorer 与 Editor 边界

四类职责保持分离：

- **Project Composition**：拥有 Files、Open Editors、Changes、History 与单一 Sidebar Scroll。
- **Explorer Behavior**：拥有 Row、Focus、Selection、Keyboard Navigation、Virtualization 与
  Expansion State 投影。
- **Workspace Access**：拥有 Authorization、有界 Filesystem/Git Read、Version Check、Mutation
  Reconciliation 与 Refresh。
- **Editor And Viewer**：拥有 Working Copy、Tab、Editor State、Conflict 与有界 Preview。

即使有许多目录保持展开，Explorer 也只保留一个 Project Sidebar 滚动面。完整 Row Projection
用于稳定 Keyboard Navigation 与持久化 Expansion，但只挂载有界的 Viewport
邻域。外层 Project Scroller 拥有完整逻辑树高度及所有 Row 的实际位移。Virtualizer 只按
该 Offset 选择挂载范围；其 DOM 不得创建第二个滚动面，也不能用跟随 Scroll 的 Transform
补偿。否则内层滚动与 Transform 分别提交时，会让 Row 重复移动或落后原生触摸手势一帧。
因此大型恢复树的成本由可见邻域而不是完整 Projection 决定。单个
滚动帧不得遍历完整展开树，也不得读取每个已挂载文件 Row 的布局。

Directory Tree 不渲染屏外祖先的随滚动联动副本；真实的 Virtualized Tree Row 是唯一的目录行和
文件行。逻辑 Depth 仍决定 Keyboard Navigation、Expansion、可访问层级和完整路径身份，但视觉
缩进由当前行宽限制：缩进和 Guide Rail 最多占行宽四分之一，Trailing Status 之前的文件名列至少
保留 48 CSS Pixel。更深层级可以共用达到上限后的缩进，长文件名可以省略显示，但文件名本身必须
保留可见空间；Row 的 Accessible Label 继续提供完整路径。

文本使用轻量 Editor。Markdown 与静态 HTML 可以在同一 File Identity 中切换 Source 与有界
Preview。Image、PDF、Binary 与 Oversized Text 使用 Read-only Viewer。所有 Viewer 共用同一
Project Authorization，不能形成独立 File Access Path。
Markdown Preview 在切换 Source 或文件时按文件记住 Scroll Position。PDF Preview 保留有界数量的
Browser Viewer Context，使页码、Zoom 与 Scroll State 在普通文件切换后保持不变。

Markdown Preview 支持 GFM 与数学公式，并对 Pandoc 空锚点、保留源码列对齐且支持无表头闭合线
形式的定宽简单表格、紧凑 Display-math Fence 和 Pandoc 数学间距提供有界兼容。兼容转换只作用于
渲染 Preview，绝不改写文件源码。不受支持的公式保留为可读源码而不是生成破损输出，任意 Raw
HTML 仍保持禁用。

Display 公式保留正常字号，超出阅读栏时只在公式内部横向滚动。公式两端与编号都必须可达，
不能撑宽正文；编号占据独立空间，不覆盖公式内容。所有 Appearance 下的 Inline 公式、
对齐公式与显式数学换行均保留渲染器原有布局。

大型 Markdown Preview 按主要 Heading 与有界 Block 数分段，保留普通连续滚动，同时只挂载
Viewport 附近的 Section，并用已测量或估算的空间表示远处 Section。大型文档不执行语法高亮，
滚动到远处时不会挂载或高亮整篇文档；Source View 仍然可用。

保留 Monaco 的语法诊断，但关闭 Monaco 隔离环境中的 Semantic 和 Suggestion Diagnostics。
项目级诊断通过托管 Language Server 路径提供，并以已保存文件为准。

代码语义导航由 Managed Language Server 处理且只针对已保存文件。Dirty Draft 不能收到把旧
磁盘版本冒充当前内容的 Cross-file Result。

仅当当前 Model 至少存在一个已发布的 Error 或 Warning Marker 时，才展示源码 Editor Status
Bar。展示时包含当前 Monaco Language、非零 Marker Count 与源码 Cursor Position。Marker Count
只描述当前 Editor 已有的证据；未显示 Status Bar 不能被解释为 Project 分析已经完成且没有问题。
Language Server 的共享结果使用自适应 Dock，通过缩小 Editor Viewport 避免遮盖代码：Editor
足够宽时停靠右侧，窄容器中停靠在 Editor 下方。

## Git 与 Review

Working-copy Changes 与 Committed Git History 位于 Files 内。History 属于 Project，并按有界
Page 加载；展开 Commit 后显示 Changed File 与 Parent Comparison，不实现第二套 Diff Viewer。

Line Changes 用于解释当前行附近的局部 Hunk；Full Review 使用主 Comparison Surface 与稳定
Review Identity。这是两种不同交互层级，不能挤进同一个狭窄 Sidebar Panel。

Git Operation 使用确定、Path-safe Input；Truncation 或 Timeout 作为可见 Partial Result，
不能被解释成 Clean Workspace。

现有 Project Worktree Control 保持 Project Row 紧凑，并在 Popover 内承载两个明确操作：
打开一个已注册 Worktree，以及把当前仓库主 Worktree 切换到已有 Local Branch。Worktree Row
绝不暗示 Branch Switch。切换分支前，Server 必须 Fresh Read 并证明目标是同一个主
Worktree、Workspace 为 Clean、目标 Branch 没有被其他 Worktree 检出，且该 Workspace
没有 Live Farming Agent。该操作不会自动 Fetch、创建 Tracking Branch、Stash 或 Force。
Server 将 Mutation 与其他 Project Operation 串行化，用 Expected Branch 与 HEAD 防止并发
变化，并在 Timeout 或 Command Failure 后读取权威 Branch 对账，绝不自动重放切换。Blocked
与 Uncertain Outcome 在 Popover 中保持可见；成功后刷新 Worktree、Files、Changes 与 History。

Blame Annotation 使用有界 Git Porcelain Output，并保持 Commit Detail 可交互。能够安全映射
Remote 时，Commit Hash 链接到 Repository Web View；符合账号形式的 GitLab Author 链接到
同一 Remote Host 上的 Profile，含义不明确的 Display Name 保持普通文本；Commit Message 中的
Issue Reference 遵循 Workspace `.idea/vcs.xml` 内的 IntelliJ
`IssueNavigationConfiguration`。不支持、过大、非 HTTP(S) 或无效的规则继续按普通文本显示。

## 视觉与交互规则

- Row 保持紧凑、稳定、支持键盘且单行展示。
- Open Editors、Changes 和 Directory Tree 的文件条目共享桌面 24px、紧凑布局 28px
  行高，不按 Pointer 类型另分密度。紧凑布局的 Project 和 Agent 主导航行保持 44px。
  文件分组操作在行内布局，不与相邻点击目标重叠；主导航操作保留更大目标并沿行中心对齐。
  Open Editors 与 Files 标题使用同一前导列。两种文件树统一采用 8px 层级步长及单一
  Icon/Chevron 槽；深层缩进按可用标签空间限制，不再固定截断于紧凑布局的两次缩进。
- 响应式密度是浏览器拥有的展示状态。宽度跨越断点时更新单一 CSS 行高，文件样式及
  Virtual List 几何共同读取它，不改变 Selection、Expansion 或请求所有权。Resize、
  Scroll 和目录展开后 Virtual Row 必须保持对齐并继续使用唯一 Project Scroll Surface。
  密度改变时保留可见 Row 及行内偏移比例，不沿用旧的像素 Scroll Offset。
  打开、关闭行操作不得改变行高。
- 每个 Tree Row 固定使用三个显式 Layout Slot：前导 Icon 或 Chevron、Label 与 Label
  Decoration、尾部 State。可选 Decoration 不能创建隐式 Grid Row；Inline Rename 占用
  Label 与 State Slot，但不能移动 Label Origin。
- 在所有 Layout Width 下，同一 Tree Depth 中的 File Icon 与 Directory Chevron 使用同一个
  前导 Slot；文件不能额外保留一列空 Chevron。
- 在 Pointer Layout 中，Files Search 与 Refresh Control 在 Header Hover 时渐进显示；
  Search 获得焦点或内容非空时继续保持可见，Compact Touch Layout 不依赖 Hover 并常显 Search。
- Open Editors 只在需要时出现，并与 Tree 分离。
- 单子目录链可以合并成一个稳定 Row。
- Dirty、External Change 与 Git State 保持可见，但不把整棵 Tree 变成高噪音警告面。
- Preview 与 Pinned Tab 保留各自 Editor Position，并区分临时查看与有意多文件工作。单击可以
  为新的 Clean File 创建 Preview，但选择已有 Pinned Tab 时不得把它降级成 Preview；双击执行
  Pin。同一个 Pending File 的重复打开共用一次读取并合并最新 Intent；更新的不同文件 Intent
  取消已被取代的打开操作，并让有界 Loading Feedback 保持到事务完成。
- 纸张外观让 Tab Strip、Breadcrumb 与 Editor 共用一张连续纸面；只有 Active Tab 使用局部
  色块，选中态不增加整条 Chrome 色带、边框、阴影或接缝线。
- 窄屏优先查看与短编辑；长时间手机编码不是目标。

## 性能边界

File Read、Preview、Search、Git Output、Directory Load、History Page、Editor Model 与 Cache 都
必须有界。Tree 和昂贵 Detail 按需加载。Background Preparation 可以改善首次打开，但失败时
必须回退到同一权威路径，不能 Reload Page 或阻塞 Agent Work。

Project Files Search 只有一条 Production Execution Path：Farming 自带、版本固定的原生 ripgrep
Artifact。Path Enumeration、Directory-name Matching 与 Content Matching 共用一个绝对 Deadline，
不能各自重新获得一份 Timeout Budget。Browser 或 WebSocket Cancel 会传播到 Active Search 并终止其
ripgrep Subprocess；Browser 侧的最终 Watchdog 保证可见 Loading 一定结束。Managed Artifact 缺失、
损坏或不支持时必须明确且有界地失败，不能自动切换到系统 `rg`、WebAssembly、Git 或其它 Fallback。

Directory `tree` Request 是 Interactive Structure Path，不等待 Git Status、Ignore Check 或
Descendant Decoration。Git 与 Ignored State 通过独立的 Background `tree-decorations` Operation
加载，并且只发布发生变化的 Path；Decoration 到达时不能替换 Directory Snapshot 或重建未变化
的 Tree Projection。结构未变化的 Refresh 复用 Node Identity；单 Path 变化只替换该 Node 与
到达它所必需的 Ancestor。大目录的 Decoration Read 同时按 Protocol Message 与 Subprocess
Argument 边界分批；目录大小不能使 Background Decoration 变成非法或无限挂起的 Request。

Large-workspace 自动化门禁使用 Production-shaped Tree，而不是只测一次合成点击。2,000 Row
Projection 必须保持少于 100 个已挂载 File Row，并保留 Home/End Navigation。跨多个目录的
Cold Expansion 同时记录 Request 与 Visible Paint 的 p50/p95，要求 Request p95 小于 750 ms、
Paint p95 小于 1,000 ms，并同时限制 Mounted Row 与 Row Render。这些数值是回归上限，不表示
日常交互可以接近该上限。

在现有 Workspace 归属与只读约束之上，2 MiB 以内的文本文件完整打开且可编辑。2 MiB 到
10 MiB 的文本文件在只读查看器中完整打开。更大的文本文件只显示前 10 MiB。界面必须明确区分
完整的只读文件和被截断的文件前缀；不得将局部内容呈现为完整文件。

## 验收标准

验证必须覆盖：Empty Project、多个 Agent 共享 Workspace、Git Worktree、Deep Tree、Keyboard
Navigation、Reload Restore、Symlink、Search 与 Location Link、Dirty/External Change、结果
不确定的 Mutation、Read-only Viewer、Git History、Review、Mobile Viewing 与 Large Workspace。
