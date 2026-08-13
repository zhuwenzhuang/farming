# Project Files 设计

> English version: [project-files-section-design.md](./project-files-section-design.md)

Project Files 让用户在监督 Agent 时查看并轻量编辑 Project。它不以替代完整 IDE 为目标。

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
Directory Tree 不能创建互相竞争的 Project 级滚动条。深层目录可以显示紧凑 Ancestor Context，
但不能改变滚动所有权。

当某个 Project 占据该 Scroll Surface 顶部时，它的 Project Row、Agent Rows、Open Editors 与
Files Header 组成同一个分层 Sticky Summary；后一层 Offset 来自前面各层的实测高度。Project
到达尾部边界后，所有可见层必须以相同 Scroll Delta 一起释放，后层不能先滑过并遮住 Project
名称或 Branch。Directory Ancestor Context 始终位于这组 Summary Stack 下方。

Project Agent 行采用渐进展示，避免大型 Agent 分组难以浏览。Project 初始显示 5 个 Agent，
第一次“显示更多”最多再显示 5 个，之后每次最多再显示 10 个；“显示较少”恢复为初始 5 个。
Selection、Search 与 Active Agent 变化可以替换当前容量内的行，但只有“显示更多”和
“显示较少”可以改变这个容量。

## Project 与 Workspace 身份

Project 是持久挂载到 Farming 的 Workspace。Agent 创建、文件打开、恢复的 Project Session
与 Git Worktree 选择都引用同一个 Workspace Identity。最后一个 Agent 或 Editor 消失时不能
静默移除 Project；显式 Remove 才是 Unmount Action。

用户在创建 Agent 时显式选择仓库子目录，该目录就是 Project 边界。外层 Git Worktree 仍然
负责仓库操作，但不得因此把 Agent 提升到范围更大的已挂载 Project。从已有 Project 界面启动时，
则可以显式传入该 Project Workspace，同时使用更深层的 Working Directory。

Git 拥有 Repository 与 Worktree Identity。Farming 把每个 Worktree 展示为普通 Project，
只拥有它在 Workspace 中的 Membership 与 Order。
任何绝对文件打开入口（包括 Chat 链接、Terminal 链接与分享 URL）都先通过同一个解析边界，
由 Backend 权威查找最近的上层 Git Worktree；
查找成功后挂载该 Worktree，并按 Repository Relative Path 走普通 Project 文件链路（包括
Git Blame）。找不到 Repository 时，才回退到有界、只读的 Global File Path。

Files Identity 来自 Canonical Workspace，不能依赖当前碰巧引用它的 Agent。可选 Source Agent
Association 可以跨 Project 保留，以支持从文件返回来源 Agent，但不属于文件 Ownership。

## Directory 与 Navigation State

Directory Loading 只有 Absent、Loading、Loaded、Failed。Workspace Identity 变化会使 Pending
Load 失效；旧 Workspace Generation 的响应不能提交数据，也不能留下阻止 Retry 的 Loading。

Directory Expansion 是按 Workspace 隔离的 Browser-local Navigation State。每次鼠标或键盘
操作只改变一次期望展开状态；迟到 Directory Response 不能重新打开用户已经关闭的目录。
首次展开如果发现单子目录链，Explorer 可以继续加载并压缩该目录链，再把同一次展开意图
迁移到最终可见目录。该过程必须限制最大深度、检测重复路径、不得自动穿过 Symbolic Link，
并在遇到分叉、文件、空目录、加载失败、Workspace 切换或用户中途折叠时停止。
鼠标或键盘直接展开时，当前行必须锚定在唯一的 Project Scroll Surface 中。Toggle 不能写入
Project Scroll，也不能启动 Reveal Operation；只有导航到其它 Target 时才拥有 Reveal。

Explorer 区分 Active File、Keyboard Focus 与 Selection。从 Chat、Terminal、Search、History、
Plugins 或 URL 打开文件时只有一个 Reveal Owner，避免 Tree 与 Project List 争夺 Focus 或
Scroll。Workspace 前进/返回把 Plugins Location 作为一等 History Entry；打开来源文件后返回时，
恢复原来的 Tab、Agent Home、Extension Kind、Query、Detail 与 Scroll Position。

## Working Copy 与 Mutation

文件系统是权威来源。Browser Working Copy 保留 Disk Baseline、Draft 与 Revision。保存某个
Revision 完成时，不能把更新 Draft 错误标成 Clean。Unsaved Draft 可以有界地在 Browser Local
恢复，但不能成为第二套文件系统权威。

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

单个粘性目录上下文是固定单行高度、显示紧凑路径的导航控件。只有首个未被遮挡的可见行存在
已展开且滚过粘性边界的真实祖先时才展示；已折叠目录和前置同级目录永远不能成为粘性上下文。
该控件用于在树中重新定位祖先，不显示展开箭头，也不伪装成第二个 Tree Row。

当可见行共享一个已由该粘性上下文展示的深层屏外祖先时，Explorer 可以用一个统一且随滚动
连续变化的横向偏移回收祖先缩进。该偏移来自固定行高几何，在视口边界连续变化，并且绝不改变
权威树深度或垂直滚动位置。粘性上下文进入或离开时，它和下方文件树可以作为一个整体连续回收
或恢复 Files 外层缩进；粘性路径切换不能重置这个整体偏移。

文本使用轻量 Editor。Markdown 与静态 HTML 可以在同一 File Identity 中切换 Source 与有界
Preview。Image、PDF、Binary 与 Oversized Text 使用 Read-only Viewer。所有 Viewer 共用同一
Project Authorization，不能形成独立 File Access Path。

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
- Preview 与 Pinned Tab 保留各自 Editor Position，并区分临时查看与有意多文件工作。
- 纸张外观让 Tab Strip、Breadcrumb 与 Editor 共用一张连续纸面；只有 Active Tab 使用局部
  色块，选中态不增加整条 Chrome 色带、边框、阴影或接缝线。
- 窄屏优先查看与短编辑；长时间手机编码不是目标。

## 性能边界

File Read、Preview、Search、Git Output、Directory Load、History Page、Editor Model 与 Cache 都
必须有界。Tree 和昂贵 Detail 按需加载。Background Preparation 可以改善首次打开，但失败时
必须回退到同一权威路径，不能 Reload Page 或阻塞 Agent Work。

## 验收标准

验证必须覆盖：Empty Project、多个 Agent 共享 Workspace、Git Worktree、Deep Tree、Keyboard
Navigation、Reload Restore、Symlink、Search 与 Location Link、Dirty/External Change、结果
不确定的 Mutation、Read-only Viewer、Git History、Review、Mobile Viewing 与 Large Workspace。
