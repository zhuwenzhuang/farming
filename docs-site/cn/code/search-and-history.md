# 搜索与 History

搜索用于找到当前 Project、Agent 和文件；History 用于查找已经结束或不再显示在当前列表中的 Session。

## 全局搜索

打开 Search，输入 Agent 标题、Project 名称或相关关键词。结果会区分当前 Agent 与 History，帮助你回到正确上下文。

<ThemeImage light="../assets/search.png" dark="../assets/search-dark.png" alt="搜索当前工作" />

打开 Search 时，Farming 会重新读取当前可用的数据。加载失败或超时时，界面会显示明确错误，不会把之前的结果当成最新状态。

## History

History 可以按标题、命令、Provider 或 Workspace 查找历史任务。

<ThemeImage light="../assets/history.png" dark="../assets/history-dark.png" alt="搜索 History" />

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
