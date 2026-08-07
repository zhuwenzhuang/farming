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

Project Agent 行采用渐进展示，避免大型 Agent 分组难以浏览。Project 初始显示 5 个 Agent，
第一次“显示更多”最多再显示 5 个，之后每次最多再显示 10 个；“显示较少”恢复为初始 5 个。

## Project 与 Workspace 身份

Project 是持久挂载到 Farming 的 Workspace。Agent 创建、文件打开、恢复的 Project Session
与 Git Worktree 选择都引用同一个 Workspace Identity。最后一个 Agent 或 Editor 消失时不能
静默移除 Project；显式 Remove 才是 Unmount Action。

Git 拥有 Repository 与 Worktree Identity。Farming 把每个 Worktree 展示为普通 Project，
只拥有它在 Workspace 中的 Membership 与 Order。

Files Identity 来自 Canonical Workspace，不能依赖当前碰巧引用它的 Agent。可选 Source Agent
Association 可以支持从文件返回 Agent，但不属于文件 Ownership。

## Directory 与 Navigation State

Directory Loading 只有 Absent、Loading、Loaded、Failed。Workspace Identity 变化会使 Pending
Load 失效；旧 Workspace Generation 的响应不能提交数据，也不能留下阻止 Retry 的 Loading。

Directory Expansion 是按 Workspace 隔离的 Browser-local Navigation State。每次鼠标或键盘
操作只改变一次期望展开状态；迟到 Directory Response 不能重新打开用户已经关闭的目录。

Explorer 区分 Active File、Keyboard Focus 与 Selection。从 Chat、Terminal、Search、History
或 URL 打开文件时只有一个 Reveal Owner，避免 Tree 与 Project List 争夺 Focus 或 Scroll。

## Working Copy 与 Mutation

文件系统是权威来源。Browser Working Copy 保留 Disk Baseline、Draft 与 Revision。保存某个
Revision 完成时，不能把更新 Draft 错误标成 Clean。Unsaved Draft 可以有界地在 Browser Local
恢复，但不能成为第二套文件系统权威。

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

文本使用轻量 Editor。Markdown 与静态 HTML 可以在同一 File Identity 中切换 Source 与有界
Preview。Image、PDF、Binary 与 Oversized Text 使用 Read-only Viewer。所有 Viewer 共用同一
Project Authorization，不能形成独立 File Access Path。

保留 Monaco 的语法诊断，但关闭 Monaco 隔离环境中的 Semantic 和 Suggestion Diagnostics。
项目级诊断通过托管 Language Server 路径提供，并以已保存文件为准。

代码语义导航由 Managed Language Server 处理且只针对已保存文件。Dirty Draft 不能收到把旧
磁盘版本冒充当前内容的 Cross-file Result。

## Git 与 Review

Working-copy Changes 与 Committed Git History 位于 Files 内。History 属于 Project，并按有界
Page 加载；展开 Commit 后显示 Changed File 与 Parent Comparison，不实现第二套 Diff Viewer。

Line Changes 用于解释当前行附近的局部 Hunk；Full Review 使用主 Comparison Surface 与稳定
Review Identity。这是两种不同交互层级，不能挤进同一个狭窄 Sidebar Panel。

Git Operation 使用确定、Path-safe Input；Truncation 或 Timeout 作为可见 Partial Result，
不能被解释成 Clean Workspace。

Blame Annotation 使用有界 Git Porcelain Output，并保持 Commit Detail 可交互。能够安全映射
Remote 时，Commit Hash 链接到 Repository Web View；符合账号形式的 GitLab Author 链接到
同一 Remote Host 上的 Profile，含义不明确的 Display Name 保持普通文本；Commit Message 中的
Issue Reference 遵循 Workspace `.idea/vcs.xml` 内的 IntelliJ
`IssueNavigationConfiguration`。不支持、过大、非 HTTP(S) 或无效的规则继续按普通文本显示。

## 视觉与交互规则

- Row 保持紧凑、稳定、支持键盘且单行展示。
- 在 Pointer Layout 中，Files Search 与 Refresh Control 在 Header Hover 时渐进显示；
  Search 获得焦点或内容非空时继续保持可见，Compact Touch Layout 不依赖 Hover 并常显 Search。
- Open Editors 只在需要时出现，并与 Tree 分离。
- 单子目录链可以合并成一个稳定 Row。
- Dirty、External Change 与 Git State 保持可见，但不把整棵 Tree 变成高噪音警告面。
- Preview 与 Pinned Tab 保留各自 Editor Position，并区分临时查看与有意多文件工作。
- 窄屏优先查看与短编辑；长时间手机编码不是目标。

## 性能边界

File Read、Preview、Search、Git Output、Directory Load、History Page、Editor Model 与 Cache 都
必须有界。Tree 和昂贵 Detail 按需加载。Background Preparation 可以改善首次打开，但失败时
必须回退到同一权威路径，不能 Reload Page 或阻塞 Agent Work。

## 验收标准

验证必须覆盖：Empty Project、多个 Agent 共享 Workspace、Git Worktree、Deep Tree、Keyboard
Navigation、Reload Restore、Symlink、Search 与 Location Link、Dirty/External Change、结果
不确定的 Mutation、Read-only Viewer、Git History、Review、Mobile Viewing 与 Large Workspace。
