---
description: 在 Farming Code 中浏览、搜索、编辑和检查项目文件与 Git 变化。
---

# Files

Files 让你在 Farming 工作区中浏览、搜索和轻量编辑 Project 文件。它适合快速核对 Agent 提到的代码、配置和测试证据。

<ThemeImage light="/cn/assets/files-relational-operators-20260806.png" dark="/cn/assets/files-relational-operators-20260806-dark.png" alt="Files 中的关系算子 Markdown 预览" />

## 浏览文件

文件树以 Project Workspace 为边界。展开目录时，Farming 从 Project 所在主机读取当前内容，不会把另一个 Project 的路径混入结果。

使用 **Open Editors** 返回已经打开的文件。文件标签页与当前 Agent 可以独立切换，因此检查代码时不会丢失 Chat 或 Terminal Session。

## 搜索

在 Files 区域输入：

- 文件名；
- 相对路径；
- `path:line` 形式的位置；
- 代码中的文本。

搜索和目录读取都有边界。结果过多时应缩小路径或关键词，而不是等待浏览器加载整个仓库。

## 编辑与保存

Files 适合小范围、明确的修改。保存前注意：

- 确认文件仍属于当前 Project；
- 避免覆盖 Agent 同时正在修改的同一区域；
- 保存后让相关测试或检查重新运行；
- 对生成文件应修改权威源文件，而不是直接编辑构建输出。

## 分享当前阅读位置

文件查看器工具栏中的分享按钮复制一个临时只读链接。链接会记录当前文件、Editor 或 Diff 视图，以及阅读行列；详细行为见[分享与只读访问](./sharing)。

## Changes 与 Diff View

有未提交变化时，Files 会按已跟踪和未跟踪内容列出文件。打开单个文件可以先快速查看内容；使用 **Review changes** 可以进入完整 Diff View，逐文件检查变更、上下文和评论。

Diff View 适合在 Agent 完成工作后做一次集中检查。它展示的是当前选定比较范围，不会替你判断修改是否符合任务要求。

## Git History

Git History 可以查看当前分支或所有分支的提交图、提交信息和文件变化。选择一个提交后，可以继续打开该提交的 Diff View。

Git History 与 Agent History 是两件事：前者来自项目的 Git 仓库，后者用于查找和继续 Agent Session。

## Blame 与磁盘状态

Blame 可以帮助理解一行代码来自何时、由谁修改。它是调查线索，不等于当前设计意图；需要结合代码、测试和当前文档判断。

Files 展示的是 Farming Host 上的实际文件。实验性的 Language Server 语义能力另见 [Language Server](../experimental/language-server)。
