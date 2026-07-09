# Files / Editor 用户故事与类人验收

> English version: [files-editor-user-stories.md](./files-editor-user-stories.md)

本文档沉淀 Project Files section 与右侧 Monaco editor 的完整使用场景。它不是组件设计说明，而是面向真实用户操作路径的验收脚本。

## 目标用户故事

用户正在监督某个具体 Project 下的 agent。Agent 提到一个文件、路径或代码位置时，用户不离开当前 Project 上下文，就能在左侧展开 Files、定位文件，在右侧查看或轻量编辑，并感知 git / 外部变更。

Main Agent 只负责调度和观察，不展示 Files。只有具体 Project agent 才挂载 Files。

Project 侧栏的文件体验应接近紧凑版 VS Code Explorer。具体 agent 行是 Project 展开后的第一个 section；当至少打开过一个文件时，`Open Editors` 出现在 agent 与 `Files` 之间，默认折叠，点击后展开。没有打开文件时不渲染 `Open Editors`。`Files` 只负责目录树；单一路径目录链尽量合并成一行，例如 `tmp/ata2/assets`，避免每一级都额外缩进。

## 核心路径

### 1. 展开 Project Files

前置：
- 已启动 Main Agent。
- 已在某个 workspace 启动一个非 Main agent。

操作：
- 展开具体 Project。
- 点击 `Files` header。

期望：
- Files 和 agent 行属于同一 Project 展开区。
- Project 内顺序是 agent 行、可选的 `Open Editors`、再到 `Files`。
- 用户打开文件之前不显示 `Open Editors`。
- Files 可折叠；折叠后不显示搜索框、目录树和浮层。
- 目录树平铺进外层 Project 滚动流，不出现 Files 内部第二个滚动条。
- 文件类型 icon、目录 chevron、git 状态点和 active file 高亮稳定显示。
- 单一路径目录链合并为一个可见目录行，避免每一级路径都额外缩进。

### 2. 打开和预览文件

操作：
- 双击文本文件。
- 打开 Markdown 文件，并从 editor 工具栏切换 Markdown 预览。
- 双击图片文件。
- 双击普通二进制或过大文本文件。

期望：
- 文本文件在右侧 Monaco editor 打开，并出现 tab 与 breadcrumb。
- Markdown 文件可在同一个 editor tab 内切换源码编辑和渲染预览。
- 打开第一个文件后，`Files` 上方出现默认折叠的 `Open Editors` section。
- 展开 `Open Editors` 后显示当前打开文件列表，点击条目可切回对应文件。
- 图片通过只读 preview 打开。
- 普通二进制显示元数据 preview。
- 过大文本只读打开文件开头内容，不进入保存链路。
- 右侧切到 editor 时，左侧 Project / agent / Files 上下文仍保留。
- editor 或应用分包缺失时不能停留在空白页：Farming 先自动恢复一次，仍失败则显示紧凑的重新加载状态，并直接给出经过长度限制的错误类型、失败请求路径、可用状态和原因；刷新页面不会停止正在运行的 Agent。
- 视觉验收提供固定地址 `/farming/error-preview`。仍可用 `?farming-error-preview=light` 或 `?farming-error-preview=dark` 切换预览，追加 `&farming-error-language=zh` 可查看中文文案；点击重新加载会回到 Farming。

### 3. 搜索和跳转

操作：
- 聚焦 Files 搜索框。
- 输入内容关键词并点击搜索结果。
- 输入 `path:line` / `path:line:column` 并回车。
- 从 editor 中按 `Cmd/Ctrl+P` 回到 Files 搜索框。

期望：
- 搜索框可被鼠标点击、编辑和清空，不被自动 focus/select retry 抢走输入。
- 搜索结果以 listbox / option 语义展示，方向键可移动 active result。
- 点击搜索结果后打开文件并跳到匹配行。
- `path:line` 跳转后 Monaco 光标和状态栏行号正确。
- 若搜索提前停止，结果浮层会显示当前超时时间；可在 **设置 → 文件搜索** 中用即时生效的预设滑杆调整为 3 秒到 3 分钟，默认 3 秒。

### 4. 编辑和保存

操作：
- 在 Monaco 中插入文本。
- 观察 tab / Files tree dirty 状态。
- 点击保存按钮或在 editor 正文右键菜单中点击 `Save`。

期望：
- 文件变 dirty 时 tab 和左侧 Files tree 同步出现轻量状态提示。
- 保存期间显示 `Saving`，保存完成后 dirty 状态消失。
- 文件真实写入 workspace。
- 如果磁盘文件已外部变化，显示 reload / overwrite 入口，不静默覆盖。

### 5. Editor 右键菜单

操作：
- 在 editor 正文区域右键。

期望：
- 出现鼠标用户可用的基础菜单：`Cut`、`Copy`、`Paste`、`Select All`、`Save`。
- preview / readonly 文件中写操作禁用。
- 正文菜单不会直接打开 git blame；blame 和行级变化从左侧非正文 gutter 触发。

### 6. Git Blame

操作：
- 点击 editor 顶部 `Show git blame` 按钮。
- 在 editor 左侧非正文 gutter 区域右键。
- 点击 `Annotate with Blame`。
- 点击某一行左侧 blame 注释。
- 点击顶部 `Hide git blame`，或再次在 gutter 右键并点击 `Hide Blame`。

期望：
- `Show git blame` 是常驻 toolbar 入口，保证手机和触屏设备也能使用 blame。
- gutter 右键入口保留，保证桌面鼠标用户仍有接近 IDE 的 annotate 路径。
- 开启 blame 后，每一行左侧出现类似 JetBrains 的作者 / 日期注释。
- 窄屏下 blame 注释列保持紧凑，不能挤到正文不可读。
- 点击某行 blame 注释后，弹出提交摘要、commit、行号、作者、日期。
- 作者可点击到 Aone 用户入口。
- 未提交的磁盘变更显示为 uncommitted blame 状态。
- Blame 基于磁盘 git 状态，不尝试解释未保存草稿。

### 7. 行级变化与 Review Diff

操作：
- 在 editor 左侧非正文 gutter 区域右键。
- 点击 `Open Line Changes with Previous Revision`。
- 点击 `Open Line Changes with Working File`。
- 在 Project 的 `Changes` 中点击某个改动文件。

期望：
- gutter 菜单可以打开当前行相对上一版或工作区文件的局部变化。
- 行级变化是当前行的解释面板，不承担完整 review。
- `Changes` 是当前 Project workspace 的轻量 review 入口。
- 点击改动文件后，右侧主区域打开 Monaco 整文件 diff，不把 review 挤在窄的 Agent / chat 栏里。
- 删除文件以只读 diff-only 状态打开，不进入可写 editor。

### 8. 文件树右键和键盘连续操作

操作：
- 在文件或目录行右键。
- 用键盘方向键移动菜单项。
- `Escape` 关闭菜单。
- 使用 `Rename` / `New File` / `New Folder` / `Delete`。

期望：
- 菜单打开后焦点进入第一个可用菜单项。
- `Escape` 关闭后焦点回到 Files tree。
- rename 使用行内输入框，并选中文件名主体。
- 删除目录必须确认。

### 9. 软链接

期望：

- 软链接保留目标类型：目录链接可原地展开，文件链接可原地打开，并像 VS Code Explorer 一样显示轻量链接标记。
- 指向项目内部的链接保持正常编辑能力。
- 指向项目外部、但已进入 Farming 全局 Files 根路径白名单的链接，仍以项目内别名展示，内容只读。
- 损坏链接或超出允许根路径的链接保留可见，但不能打开。
- 重命名和删除只作用于链接条目本身，不能通过项目内别名移动或删除外部目标。
- Git 状态只处理项目里的链接条目，不把外部目标仓库合并进当前项目仓库。

### 10. 刷新后恢复工作区视图

期望：

- 刷新页面后恢复 Projects 中最后使用的界面：要么是选中的 Agent terminal，要么是 editor 中正在查看的文件。
- 文件恢复按 workspace 隔离，重新读取磁盘上最新的已保存内容，恢复可选的光标位置，并在 Files 中展开到该文件的父目录。
- 每个 workspace 独立记住 Files 是否折叠及已展开的目录；即使刷新时正在看 Agent terminal，这些目录状态也不能丢失。
- Agent、workspace 或文件已经不存在时，Farming 清理过期目标并回到仍可用的 Projects 界面，不能卡在损坏的 editor。
- 这是浏览器本地的导航状态，不是 editor hot exit；完整刷新不会保留尚未保存的编辑草稿。

### 11. URL 定位目标

期望：

- Agent、文件和文件夹共用一套 URL target 契约。
- 文件目标打开 editor，并恢复可选的行列位置。
- 文件夹目标优先打开该目录根层的代表文件：`README.md`、其他 Markdown、其余第一个文件。根层没有文件时，Files 才逐级加载祖先目录，把目标目录放到靠上位置并临时强调，用户点击其他区域后消失。
- 全局 `/` 下的文件和文件夹继续使用现有全局 Files 身份和允许根路径校验，不把它当成 terminal agent。
- 软链接位置在 URL 中保留可见别名路径，例如 `reference/lobe-icons`，不暴露解析后的外部路径。
- 文件和文件夹右键菜单提供 `拷贝分享 URL`，复用二维码分享流程生成的同一条带认证完整 URL。

## Computer Use 验收脚本

以下脚本用于类人端到端验收，优先用真实浏览器坐标/鼠标/键盘操作，不只依赖 DOM 断言。

1. 打开 `http://localhost:3124/farming/`。
2. 启动 Main Agent。
3. 启动一个指向临时 git workspace 的 Project agent。
4. 展开 Project 下 `Files`。
5. 双击 `README.md`，确认右侧 editor 打开。
6. 点击 Files 搜索框，输入关键词，确认可编辑；按上下键移动结果并回车。
7. 输入 `README.md:4` 回车，确认 editor 状态栏到 `Ln 4`。
8. 点击 editor 顶部 `Show git blame`，确认 blame 注释出现；再用 gutter 右键路径验证 `Annotate with Blame` / `Hide Blame` 仍可用。
9. 点击第一行左侧 blame 注释，确认详情浮层出现并包含 Aone 作者链接。
10. 在 editor 正文右键，确认基础菜单出现，并用 `Save` 保存一次修改。
11. 在 editor gutter 右键，确认可以打开上一版 / 工作区文件的行级变化。
12. 在 `Changes` 中点击改动文件，确认右侧主区域打开 Monaco diff。
13. 在 Files 目录行右键，确认菜单焦点进入 `New File`，`Escape` 后焦点回到 tree。
14. 创建项目内文件/目录链接和允许的项目外链接，验证原地展开、外部文件只读，以及删除链接后目标仍存在。
15. 展开多层目录并打开一个文件后刷新，确认恢复同一文件和目录层级；回到 Agent terminal 再刷新，确认仍停在 terminal，且 Files 的展开状态不变。

当前自动化覆盖：
- `tests/e2e/display-flows.spec.ts` 中 `keeps project files as a collapsible project-level section` 走通上述主要链路。
- `backend/tests/test-project-files-section.js` 静态约束 UI 保留 toolbar blame、gutter line changes 和主区域 Monaco diff 的产品边界。
