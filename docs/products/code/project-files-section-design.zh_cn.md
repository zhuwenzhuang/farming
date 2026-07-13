# Project Files Section 设计说明

> English version: [project-files-section-design.md](./project-files-section-design.md)

本文档描述 Farming 轻量文件浏览/编辑能力在当前 Code-style 工作台中的接入方式。

目标不是把 Farming 做成完整 IDE，而是在当前 Project / Agent 工作流里补一个够用、稳定、低干扰的文件查看与编辑 section。

---

## 1. 设计结论

第一版采用：

```text
Project
  具体 Agent 行
  Open Editors（有打开文件时才出现，默认折叠）
  Files

右侧主区域
  Terminal 或 Monaco Editor
```

也就是说，文件能力不做独立全局页面，也不做三栏复杂 IDE 布局。Project 展开后先展示具体 agent 行；如果用户打开过文件，再在 agent 与 `Files` 之间展示独立的 `Open Editors` section。`Open Editors` 不属于 `Files`，没有打开文件时不渲染，出现后默认折叠。Main Agent 是调度入口，不单独挂载 Files。

这里的“轻量”指功能边界轻，不代表页面展示要像临时列表。Files 的视觉应模仿 VS Code Explorer 的可扫描密度：紧凑树、稳定图标槽、active 左侧条、dirty 状态点、编辑区 tab strip；颜色、圆角和留白则继续贴合现有 Code-style 工作台。

用户在 Project 里可以：

- 点 Agent：右侧显示该 Agent 的 terminal
- 点 Files：展开当前 Project 的目录树
- 点 Open Editors：展开当前 Project 已打开文件列表，并快速切回文件
- 点文件：右侧从 terminal 切到 Monaco editor；图片和普通二进制切到只读 preview，过大文本文件在只读 Monaco 中展示文件开头内容
- 在 Files 搜索内容：点击搜索结果后右侧打开对应文件并跳到匹配行
- 在 Files 输入 `path:line` / `path:line:column`：直接打开文件并定位
- 在 Project 的 `Changes` 中点改动文件：右侧主区域打开整文件 Monaco diff，用更宽的代码区域完成 review
- 在 editor 左侧 gutter 右键：开启/关闭类似 JetBrains 的行级 blame 注释
- 在 editor 左侧 gutter 右键：查看当前行与上一版或工作区文件的局部变化
- 再点 Agent：右侧切回 terminal

`Changes` 是当前 Project 内的轻量 review 入口，属于 Files / editor 能力的一部分；它只汇总当前 workspace 的工作区改动，点击后把右侧主区域让给 Monaco diff。Farming 暂不做全局跨 Project review 工作台，也不把 patch 审阅塞进窄的 Agent / chat 栏。目录树自身继续轻量展示 git 工作区状态：文件行显示 `M`/`U` 等短状态，包含改动的父目录显示低饱和度状态点。

独立的 `/review?agentId=...` 是读取所选 Agent 工作区的 working-copy review 页面；`/review?agentId=...&base=...&head=...` 使用同一个页面查看 Git commit range。它不接入主页面，提供接近 Gerrit 的多文件 diff、逐文件 `Reviewed` 状态和 diff 偏好，但不改变 `Files` / Monaco 的轻量 review 边界。Git diff 要保留字符级修改范围，并在任一侧文件末尾缺少换行时明确提示，避免内容看似相同的替换行无法解释。Patch 生成仍是后端能力；在下载和 final-change 选择器的产品场景明确之前，页面不展示这两个临时入口。持久化 review 状态以稳定的工作区身份和当前结构化 diff 版本为范围，不依赖短暂的 agent id。对于本地 working copy 没有服务端变更元数据支撑的 Rebase、Included In 等操作不展示。`/review-demo` 暂时保留为兼容别名，正式入口使用 `/review`。

目录树实现不应长期依赖手写递归列表。VS Code Explorer 的质感来自一整套 tree control 行为，而不只是文件 icon：可见行模型、展开/折叠状态、键盘焦点、选择态、虚拟滚动、懒加载、拖拽目标、重命名、git decoration、父目录上下文和 hover action 都需要统一处理。

这里说的“文件目录树展示逻辑”，不是 icon mapping，而是 Explorer 自身的交互和渲染系统：

- 数据模型：稳定 node id、父子路径、目录懒加载、展开状态、文件变化后局部刷新
- 可见行模型：tree engine 继续负责展开/折叠、焦点和键盘模型；但 Project 左栏里的 `Files` 展开后按当前可见行数自然撑高，滚动交给外层 project list，避免出现内外两个滚动条；当前可见行数由打开目录集合和 tree data 推导，不能依赖内部 viewport scrollHeight，否则容易留下空白或隐藏行
- 层级表达：统一 chevron、缩进、低饱和 guide line、目录/文件行高和文本截断规则
- 上下文保留：Project 左栏不在 `Files` 内部隐藏内容；长列表可以使用轻量 sticky ancestor stack 和浅阴影提示，但不能引入内部滚动窗口或固定高度裁切
- 选择模型：active file 和 tree selection 分离，支持键盘焦点和轻量选择态；拖拽移动不是当前 P0 验收重点
- 键盘模型：方向键、Enter/Space、焦点态和打开文件行为交给 tree engine 统一管理
- 移动模型：后端保留同 workspace 内 move 能力；前端当前优先保证搜索、跳转、重命名和删除，不把拖拽移动作为必要能力
- decoration 模型：git `M`/`U` 等文件状态、父目录状态点、外部变化提示统一挂在 row renderer 的 decoration slot；父目录名称保持低饱和提示色，具体 added/deleted/conflict 语义主要由状态点和叶子文件承担，避免整棵树被高警告色染重

因此第一版的正确方向不是“继续手写一个更像 VS Code 的递归组件”，而是复用成熟 tree behavior engine，再把 Farming 的文件后端、watcher、git 状态和清爽视觉接上去。

推荐把 `Files` section 拆成三层：

```text
Tree behavior engine
  负责可见行、展开/折叠、焦点、键盘、选择、虚拟滚动、rename

Farming file adapter
  负责调用 /api/files/tree、watch event、git status、路径安全、读写保存

Farming row renderer
  负责 Code-style 外观、VS Code-like spacing、icon slot、git badge、active/hover
```

其中 tree behavior engine 应优先复用成熟开源组件，而不是继续自己补齐：

| 方案 | 适合度 | 说明 |
|------|--------|------|
| `react-arborist` | 当前采用 | 更像现成 file explorer，内置 virtualization、键盘导航、选择、rename 基础能力，第一版落地快；drag/drop 能力不作为当前验收重点 |
| `@headless-tree/react` | 后续备选 | Headless，适合在需要更强自定义时保留 Farming 自己的视觉；支持 keybindings、search、rename、drag/drop、async/lazy 等复杂树行为 |
| `react-complex-tree` | 备选 | 成熟、accessible、键盘和 drag/drop 能力完整；其作者已把新方向迁到 Headless Tree |
| VS Code workbench 源码 | 不推荐直接搬 | 最接近原版，但和 VS Code 平台耦合重，裁剪成本高，后续维护风险大 |

文件类型 icon 单独复用 VS Code icon theme 生态。当前采用 `material-icon-theme` 的 manifest 做文件名、扩展名、目录名到 icon id 的映射，再只打包 Farming 第一版需要的精选 SVG 资产，避免把 icon 主题当成一套手写 switch。它不决定 tree 行为，只作为 row renderer 的 decoration slot。

结论：当前继续使用 `react-arborist` 是合理的，因为它已经覆盖 Explorer 第一版最关键的行为骨架；后续如果需要 VS Code 更完整的 async tree/search/rename/accessibility 语义，再评估 `@headless-tree/react`。Theia / code-server 更适合作为行为参考或“Open in full IDE”旁路，不适合把它们的 navigator 直接裁进 Farming。

当前实现落点：

- `react-arborist`：目录树行为层，负责虚拟滚动、展开/折叠、选择、焦点、键盘和 rename 基础能力。
- `useWorkspaceFiles` / `/api/files/*`：Farming 文件 adapter，负责懒加载目录、watch 事件、git 状态、文本读写和冲突校验。
- `src/lib/file-icons.ts`：Material Icon Theme manifest adapter，负责文件类型和目录类型 icon 解析。
- `ProjectFilesSection`：Project 左栏里的 Files 组装层，负责把 Open Editors、Files header、搜索结果、目录树、sticky context、菜单和操作浮层接入同一个外层滚动流。
- `FileSectionBody`：Files 展开后的 body 视图层，负责状态行、搜索结果、目录树视图以及传入 body 的命名 view model。
- `FileSectionOverlays`：Files 浮层视图层，负责文件 context menu 和文件操作弹层。
- `useWorkspaceFileSectionController`：Files / Open Editors section 状态层，负责折叠状态、Agent 切换清理、reveal request、search focus request 和展开时的 tree refresh 调度。
- `useWorkspaceFileTreeController`：目录树控制层，负责 tree refs、row frame 渲染、layout refresh、open-state 同步和最后焦点路径记录。
- `FileTreeView`：目录树视图层，负责 viewport、sticky context、Arborist `Tree` 接线和 `FileTreeRow` node renderer。
- `FileTreeRow`：单行 renderer，负责 VS Code-like 行高、缩进、chevron、active 行、git badge、父目录状态点和文件类型 decoration slot。
- `useWorkspaceFileMenuController` / `useWorkspaceFileOperationController`：文件管理交互状态层，分别负责 context menu 生命周期以及新建、重命名、删除等 inline/dialog 操作。
- `FileEditorPane`：Monaco editor 组装壳，继续负责当前文件、保存 / reload / 冲突流和 blame 接入。
- `FileEditorHeader`：editor header 视图层，负责 tab strip 组合、breadcrumb 和 save / reload / overwrite action bar。
- `useFileEditorWorkingCopyController`：working-copy 控制层，负责保存、reload、冲突响应和关闭前保存/放弃。
- `FileEditorTabs` / `FileEditorTabContextMenu` / `useFileEditorTabsController`：editor tab 层，分别负责 tab strip 视图、tab menu 视图、键盘导航、关闭意图和 active tab 焦点恢复。
- `FileEditorOverlays`：editor 浮层组合层，负责组合 `FileEditorContextMenu`、`FileEditorTabContextMenu`、`FileEditorSaveConfirmDialog` 和 blame 状态提示；`FileEditorPane` 只保留会影响 Monaco 或 open-file 状态的 action handler。
- `FileEditorBlameDetail` / `FileEditorBlameToast`：blame 详情和状态提示视图层；`FileEditorPane` 仍负责 blame 加载、能力探测和 visible-range overlay 定位。
- `FileEditorMarkdownPreview`：Markdown 源文件在 editor 主区域里的渲染 preview，不改变文件 tab、保存和 diff 语义。
- `FileEditorPreviewPanel` / `FileEditorInlineBlameLayer`：preview 和 inline blame annotation 视图层，分别负责图片/二进制 preview 以及可点击 blame 行渲染。

---

## 2. 为什么不做独立文件页

Farming 的主线是监督 Agent，不是管理文件本身。文件浏览/编辑应当服务于：

- 看 Agent 当前工作区里的文件
- 快速打开 Agent 提到的文件
- 对小范围修改进行人工介入
- 感知文件被外部或 Agent 改动

如果做成独立 `Files` 页面，用户会在 “Agent 页面” 和 “文件页面” 之间来回切换，容易丢失当前 Project 和 Agent 上下文。

因此第一版保持一个 Project 工作台：

```text
左侧仍然告诉用户：现在在哪个 Project、有哪些 Agent
右侧负责展示：terminal 或文件 editor
```

---

## 3. 桌面端布局

### 3.1 初始状态

```text
┌──────────────┬──────────────────────────────┬───────────────────────────────┐
│ 主导航        │ Project: farming              │ 右侧主区域                      │
│              │                              │                               │
│ Projects     │ Agents                        │ Terminal                       │
│ Search       │   ● Main Agent                │                               │
│ History      │   ● Agent A                   │ agent output...                │
│ Settings     │   ● Agent B                   │                               │
│              │                              │                               │
│              │ Files                         │                               │
│              │   ▸ src                       │                               │
│              │   ▸ backend                   │                               │
│              │   package.json                │                               │
└──────────────┴──────────────────────────────┴───────────────────────────────┘
```

### 3.2 点击文件后

```text
┌──────────────┬──────────────────────────────┬───────────────────────────────┐
│ 主导航        │ Project: farming              │ 右侧主区域                      │
│              │                              │                               │
│ Projects     │ Agents                        │ Monaco Editor: src/App.tsx      │
│ Search       │   ● Main Agent                │                               │
│ History      │   ● Agent A                   │  1 import ...                   │
│ Settings     │   ● Agent B                   │  2 export function App() {      │
│              │                              │  3   ...                        │
│              │ Files                         │                               │
│              │   ▾ src                       │ 状态只在 Unsaved / Changed 时显示 │
│              │     App.tsx                   │                               │
│              │   ▸ backend                   │                               │
└──────────────┴──────────────────────────────┴───────────────────────────────┘
```

右侧只切换内容，不改变左侧 Project 上下文。

---

## 4. Files Section 内容

第一版 `Files` section 包含一个轻量搜索/跳转入口和目录树。

```text
Files
  Search or path:line
  ▾ src
    App.tsx
    main.tsx
  ▾ backend
    server.js
    agent-manager.js
  package.json
  README.md
```

行为：

- 默认只加载 Project 根目录
- 展开目录时懒加载子目录
- 隐藏 `.git`、`.farming`、`node_modules`、`dist`、`build`、`coverage` 等目录
- 当前打开文件高亮
- 当前打开文件应在 Explorer 中自动 reveal，避免从 terminal/path 跳转打开后左侧只高亮但不可见
- 打开文件的 working copy 身份按 `workspaceRoot + path` 去重；多个 agent 指向同一 workspace 的同一路径时只保留一个 editor tab，同时保留最近来源 agent 用于返回终端
- 当前打开文件的 active 高亮和 tree selection 要分离：active file 用左侧细条 + 很浅背景表示右侧 editor 对应关系，tree selection 用浅底色交给 tree engine 维护键盘焦点和轻量选择态
- 搜索入口复用 `/api/files/search`，结果点击直接打开对应文件并定位 Monaco 到匹配行；搜索结果列表只在有输入时出现，不变成独立页面
- 搜索入口同时支持 `path:line` / `path:line:column` / `path#Lline`，用于从 agent 输出或用户手动复制路径后快速跳转
- 点击 terminal output 中的 `path:line` 也应走同一套打开逻辑；workspace 内绝对路径先转成相对路径再请求 `/api/files/file`，workspace 外绝对路径不处理，避免越过当前 Project 文件边界
- 搜索结果的键盘选中态需要暴露给 DOM：输入框用 `aria-activedescendant` 指向当前结果，结果列表用 `listbox/option` 语义，保证视觉 active、上下键选择和辅助语义一致
- 右侧 editor breadcrumb 是轻量上下文入口：点击目录段会在左侧 Explorer 展开并 reveal 对应目录，点击文件段 reveal 当前文件，避免用户滚动远离 active file 后丢上下文
- 文件被外部修改或 git 工作区未提交时，在对应文件行显示轻量状态
- 右侧 editor 的 dirty / external changed 状态应同步回左侧 Explorer：叶子文件显示轻量状态点，父目录显示低饱和 descendant 点，帮助用户在深层目录中感知未保存修改
- 关闭 dirty tab 后，轻量 hot-exit 缓存里的草稿仍应同步给左侧 Explorer decoration；重新打开文件会恢复草稿，保存干净后清除该 decoration
- 包含未提交改动的父目录显示低饱和度状态点，避免把整棵树染成强提醒
- 父目录只有 descendant 状态时不改变目录名颜色或字重；右侧状态点承担提示，避免深层目录被一串橙色父节点淹没
- Project 展开内容的顺序是具体 Agent 行、可选 `Open Editors`、`Files`；`Open Editors` 是和 Files 同级的独立 section，不塞进 Files 内部
- `Open Editors` 只有在当前 Project 至少打开一个文件后才出现，出现时默认折叠；展开后显示打开文件列表，点击条目切回对应文件
- `Files` 只承载搜索/跳转入口和目录树，不承载打开文件列表
- Files 是 Project 展开内容下的独立 section，和 Agent 行处于同一层级缩进；Files 标题和树用 section 自身缩进表达 project 内部层级，桌面和窄屏都避免靠负 margin 补偿导致“FILES 像跳出 Project / 比 Project 更靠左”
- Files section 标题可点击折叠/展开；折叠后只保留一行 section header，隐藏搜索、目录树、菜单和操作浮层，避免文件列表长期占据注意力
- Main Agent 不展示对应 Files；只有 Project 下存在具体非 Main agent 时，才在该 Project 展开区展示 Files
- 窄侧栏下 Files header 使用两行布局：标题一行、搜索/跳转入口一行；搜索图标可隐藏，但 `path:line` 搜索入口必须保持可输入宽度
- Project 文件列表使用外层侧栏的单一滚动流和稳定 lazy-load；深层展开时 `Files` section 必须完整平铺，不在内部再出现第二个滚动条
- Project 左栏不启用内部滚动窗口；被展开的文件行就是完整内容，不能用固定高度窗口把一部分文件藏在 section 内部。深层滚动时允许用 zero-height overlay 的 sticky ancestor stack 展示当前父目录上下文，浅阴影只表达“上方还有被滚走的父目录”，不改变滚动模型
- 深层目录用低饱和缩进引导线辅助扫描，但不把 tree 做成重边框或高对比网格
- 缩进引导线必须弱于文件名、selection、dirty/git decoration，深层目录不能因为多条竖线显得拥挤或脏
- 单一路径目录链应合并成一个可见目录行，例如 `tmp/ata2/assets`；只有出现真实分支时才继续展开层级，避免无信息增量的过度缩进
- 展开某个目录时，应在同一次交互里预加载其直接子目录下面可合并的单子目录链；例如点击 `src` 后应直接得到稳定的 `main/java` 可见行，而不是先出现 `main`，再由下一次点击或懒加载把它变成 `main/java`
- 目录 icon 应优先使用已加载子树里的文件扩展名内容信号；没有内容信号时，兜底 icon 也必须绑定到该可见行的稳定路径起点，不能随着 compact 后 basename 从 `main` 变成 `java` 而来回跳
- Explorer row 文字截断时仍要能 hover 看到完整相对路径；第一版用原生 `title` 暴露完整路径，避免为 tooltip 额外引入重浮层
- 目录树行为使用 `react-arborist`，Farming 只负责后端文件 adapter 和 Code-style row renderer
- 拖拽移动不是当前需要投入的 P0 能力；如果未来重新打开，需要保持 drop cursor 低饱和，并继续同步已打开 tab 与 watcher 噪声过滤
- 支持轻量文件管理 P0：右键或键盘打开上下文菜单，创建文件/目录、重命名、删除、复制相对路径和刷新当前目录；这些操作不常驻在 Files header，避免把可选文件浏览区做成重工具栏
- 文件上下文菜单打开后焦点进入菜单项，支持 `↑` / `↓` / `Home` / `End` 在菜单内移动；`Escape` 关闭后焦点回到 Explorer tree，并保留触发 row 的选中态，保持全键盘连续操作
- 删除目录必须走确认弹层；删除或重命名后刷新受影响父目录，并同步关闭或更新已打开 editor tab
- 行级变化入口用于局部解释：在 editor 右键菜单里查看当前行与上一版的变化，或查看当前行与工作区文件的变化。
- Review 场景允许打开整文件 Monaco diff surface：当用户需要检查 patch 时，主区域应优先让给左右对比，而不是把 review 挤在窄的 Agent / chat 栏里。
- 支持轻量 git blame：在 editor 左侧非正文 gutter 区域右键打开 Blame；开启后每行左侧展示作者和日期，点击某一行左侧 blame 注释弹出提交摘要、commit、作者和可点击的 Aone 用户入口。Blame 基于磁盘中的 git 状态，不包含未保存草稿。
- 行级变化遵循 VS Code dirty diff 的概念边界：Farming 只向 Git 查询原始 / 历史资源，定位覆盖当前行的 hunk，并用临时面板展示；不维护自己的复杂版本历史模型。整文件 review diff 也保持 thin adapter 边界：后端提供 Git diff 与文件快照，前端交给 Monaco DiffEditor 渲染，不自研 diff 引擎。

不做：

- 不做完整文件管理器
- 不做跨 workspace 复制/移动
- 不做拖拽移动作为当前验收重点
- 不做批量复制/删除
- 不做跨 Project 的复杂 git review 聚合页
- 不做 VS Code 式 Explorer 全套右键菜单

---

## 5. 右侧主区域模式

右侧主区域只有两个第一版核心模式。

### 5.1 Terminal Mode

触发：

- 点击 Agent 行
- 启动新 Agent 后自动打开

展示：

- 当前 Agent terminal
- composer / input 保持现有行为

### 5.2 Editor Mode

触发：

- 点击 Files section 中的文本文件
- 点击 Files 搜索结果
- 在 Files 搜索框输入 `path:line` / `path:line:column`
- 后续点击 terminal output 中的 `path:line`

展示：

- Monaco editor
- Markdown 源文件可在同一 editor tab 内切换源码 / 渲染预览
- 图片 / 二进制只读 preview；大文本用只读 Monaco 展示文件开头内容
- VS Code 风格 tab strip
- 轻量多文件 tabs：打开过的文件保留 tab，可切换、关闭，并保留各自 dirty / external changed 状态；从目录树鼠标单击打开的是 transient preview tab，再单击另一个干净文件会复用该 tab；搜索结果、`path:line`、键盘 Enter、diff/review 打开是正式 tab；编辑后 transient tab 固定为正式 tab；tab strip 支持键盘切换和关闭，active tab 应自动滚入可见区域；editor 区域支持 `Ctrl/Cmd+PageUp` / `Ctrl/Cmd+PageDown` 切换 tab、`Ctrl/Cmd+W` 关闭当前 tab
- editor tab 使用成熟 tablist 语义：只有 active tab 进入正常 Tab 顺序，左右方向键切换；tab 通过 `aria-controls` 关联 Monaco `tabpanel`，避免视觉 tab strip 和 DOM 语义脱节
- editor tab 的可访问名称需要包含 basename、完整相对路径和 dirty / external changed 状态；close 按钮也使用完整相对路径，避免同名文件 tab 难以区分
- tab strip 可水平滚动但不显示浏览器原生 scrollbar；大量文件时靠 active tab reveal、滚轮/触控板滚动和键盘切换保持可达性
- editor 在文件 tab 之间切换时保留每个 Monaco model 的 view state，用户回到文件时应恢复原来的光标、selection 和滚动位置
- dirty tab 使用状态点表达未保存，不额外加粗文件名；避免 tab strip 同时靠颜色、点、字重重复提醒而变重
- editor dirty / external changed 状态同步给左侧 Files tree，避免用户只从 tab strip 才能发现未保存文件
- 关闭 dirty tab 不应在同一会话内直接丢失草稿；第一版采用轻量 hot-exit 缓存，重新打开同一文件时恢复未保存草稿，并在保存干净后清除缓存
- 文件路径标题使用轻量 breadcrumb 展示，长路径保留最后文件名的可读性，不引入完整 command palette / breadcrumb menu
- 保存状态默认不常驻显示 `Saved`；只在 `Unsaved` / `Saving` / `Changed on disk` 这类需要注意的状态出现时显示，避免 editor 顶部变重
- 外部修改提示
- 保存、刷新、覆盖等 editor action 使用紧凑图标按钮并保留 aria/title；状态文本独立显示，避免顶部 bar 堆满操作文案；Save action 只在 dirty/saving 时显示，clean 状态不常驻 disabled 保存按钮；Reload action 只在 external changed / error 时显示，避免 dirty 编辑时提供容易丢草稿的常驻刷新入口
- 新建 / 重命名输入框打开后必须自动聚焦并选中文件名；重命名文件时默认只选中扩展名前的 stem，避免覆盖 `.ts` / `.tsx` 等扩展名

编辑能力：

- 打开文本文件
- 修改内容
- `Cmd/Ctrl+S` 保存
- 保存前带 `sha1` 版本校验
- 如果文件已被 Agent 或外部进程修改，提示冲突，不直接覆盖

---

## 6. 后端接口使用

当前轻量编辑后端已经提供基础能力：

| 能力 | 接口 |
|------|------|
| 目录树 | `GET /api/files/tree?agentId=...&path=...` |
| 读取文件 | `GET /api/files/file?agentId=...&path=...` |
| 保存文件 | `PUT /api/files/file` |
| 新建文件/目录 | `POST /api/files/entry` |
| 重命名文件/目录 | `PATCH /api/files/entry` |
| 删除文件/目录 | `DELETE /api/files/entry` |
| 移动文件/目录 | `POST /api/files/move` |
| 搜索 | `GET /api/files/search?agentId=...&q=...` |
| blame | `GET /api/files/blame?agentId=...&path=...` |
| 行级变化 | `GET /api/files/line-changes?agentId=...&path=...&lineNumber=...&mode=working\|previous` |
| 文件变化 | WebSocket `watch-workspace-files` / `workspace-file-event` |

第一版前端只必须使用：

- `tree`
- `file read`
- `file raw preview`
- `file save`
- `move`
- `workspace-file-event`

`search` 已作为 Files section 的内容搜索和行跳转入口接入。图片 preview 走受 workspace 边界保护的只读 raw 路由；普通二进制只打开元数据 viewer；过大文本在只读 Monaco 中展示文件开头内容，保留行号和编辑器滚动手感，但不进入文本保存链路。

实现约束：

- 文件根目录使用具体项目 agent 状态中的 `projectWorkspace` / `cwd`；Main Agent 即使实际运行在 `.farming` 身份目录，也不作为 Files 的载体。
- WebSocket 文件监听按 `agentId` 维度维护，避免同一页面展开多个 Project 时 watcher 互相覆盖。

---

## 6.1 性能边界

大型 workspace 和长历史场景下，文件与终端链路必须保持有界：

- 文件读写保留大小上限。
- 目录树按目录懒加载，不一次性展开整棵仓库。
- 搜索、diff、blame 等 git / rg 操作使用 limit、timeout 或截断结果，避免无界输出。
- terminal 实时输出按有界块读取，并在 WebSocket fanout 前做短窗口合并。
- terminal session 退出前先 flush 最后一段输出，随后释放 screen worker 并清理 session 状态。
- Codex / Claude 大历史按最近文件和目录预算扫描，必要时用 index 数据兜底。

---

## 7. 状态模型

前端可以按 Project workspace 维护一个轻量状态：

```text
activeProjectWorkspace
treeEngineOpenState
openFiles
activeOpenFile
openFileContent
openFileSha1
dirty
externalChanged
```

状态含义：

| 字段 | 含义 |
|------|------|
| `treeEngineOpenState` | 由 tree engine 维护的展开/焦点/选择状态；Farming adapter 只负责懒加载目录数据 |
| `openFiles` | 当前 Project / Agent 已打开的轻量文件 tab 列表 |
| `activeOpenFile` | 当前右侧 editor 激活的文件 |
| `openFileSha1` | 打开时后端返回的版本 |
| `dirty` | 用户本地是否改动未保存 |
| `externalChanged` | 后端 watcher 发现文件被外部修改 |

---

## 8. 移动端原则

移动端第一版不追求完整编辑体验。

建议：

- Files section 可折叠
- 默认以只读查看为主
- 编辑入口可以隐藏到二级操作
- Monaco 移动端体验不作为第一版可靠目标

移动端核心价值是“查看 Agent 提到的文件”，不是在手机上长时间写代码。

---

## 9. 后续阶段

第一版稳定后，再考虑：

1. 更完整的 terminal output 链接识别：支持更多编译器输出格式
2. 更完整的 review 列表筛选：按状态、路径或最近 agent turn 聚合 changed files
3. `Open in full IDE`：旁路打开 code-server / OpenVSCode

这些都是增量能力，不应阻塞第一版 `Files` section。

---

## 10. 第一版验收标准

- Project 下能看到 `Files` section
- 能展开目录并懒加载子目录
- 能打开 workspace 内文本文件
- 能编辑并保存文件
- 文件被外部修改时，不静默覆盖
- 点击 Agent 能回到 terminal
- 不影响现有 Agent 启动、terminal 输入和快捷键
