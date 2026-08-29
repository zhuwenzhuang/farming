# 搜索与 History

搜索用于找到当前 Project、Agent 和文件；History 用于查找已经结束或不再显示在当前列表中的 Session。

## 全局搜索

打开 Search，输入 Agent 标题、Project 名称、文件名或文件路径。文件结果会同时显示所属 Project、
同名 Project 的可区分 Workspace Label 与完整相对路径，因此同名文件不会混淆。选择结果或按 Enter 会精确打开文件，并在 Project Tree
中定位。已挂载 Project 内的绝对路径还可以附带 `:行:列` 或 `#L行C列`，直接跳转到目标位置。

<ThemeImage light="/cn/assets/search.png" dark="/cn/assets/search-dark.png" paper="/cn/assets/search-paper.png" alt="搜索当前工作" />

打开 Search 时，Farming 会重新读取当前可用的数据。加载失败或超时时，界面会显示明确错误，不会把之前的结果当成最新状态。
如果文件在搜索后、打开前被移动，Farming 会保留 Search 并显示失败路径，不会改开另一个匹配项。
关闭或修改 Search 会取消正在进行的文件打开；超时会收敛到可重试的明确未完成或失败状态，
不会一直停在加载中。

## History

History 可以按标题、命令、Provider 或 Workspace 查找历史任务。

<ThemeImage light="/cn/assets/history.png" dark="/cn/assets/history-dark.png" paper="/cn/assets/history-paper.png" alt="搜索 History" />

打开历史记录后，Farming 会根据 Provider 和 Session 类型决定是否能够恢复：

- 支持恢复的 Coding Agent 会继续原 Session；
- 只有历史输出的记录可以查看，但不一定能继续；
- 普通 Shell Session 通常只能查看已有记录，不能像 Coding Agent Session 一样继续。

## 给任务起好标题

标题应描述结果或问题，例如“修复分页重复数据”，而不是“任务 3”或“继续”。清晰标题会直接提高搜索和 History 的可用性。

## 恢复前检查

恢复较早的 Session 前确认：

- Workspace 仍然存在；
- 当前分支和文件状态与 Session 预期一致；
- Provider 登录仍然有效；
- 不会与另一个正在修改同一工作树的 Agent 冲突。
