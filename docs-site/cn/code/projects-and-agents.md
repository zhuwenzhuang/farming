# 项目与 Agent

Farming 以代码仓库为中心组织工作。一个 Project 可以包含当前 Agent、Shell Session 与可恢复的历史任务。

## 创建 Agent

选择 **New Agent** 后，依次确认：

1. **Provider**：例如 Codex、Claude Code、OpenCode 或 Farming 已发现的其他 CLI。
2. **Workspace**：Agent 获准工作的代码仓库。
3. **交互方式**：Chat 或 Terminal。
4. **初始任务**：清楚说明目标、范围和验收方式。

<ThemeImage light="/cn/assets/start-agent.png" dark="/cn/assets/start-agent-dark.png" paper="/cn/assets/start-agent-paper.png" alt="启动 Agent" />

Provider 必须已经在 Farming Host 上完成登录。Farming 只负责发现和启动它，不会替你绕过 Provider 的认证要求。

## Project 分组

左侧栏按 Project 展示 Agent，帮助你回答三个问题：

- 这项工作属于哪个仓库？
- 哪个 Agent 仍在运行或等待输入？
- 当前打开的文件和 Browser 属于哪个工作上下文？

不要把多个无关仓库塞进同一个 Workspace。文件访问、Browser 上传下载和其他资源都以 Project 边界进行授权。

## Agent 状态

Farming 会显示运行、空闲、需要用户输入、停止或失败等状态。这些状态来自 Farming 服务，不依赖终端里最后出现的一行文字。

遇到超时或连接中断时，先刷新或重新打开 Agent，看看当前状态和文件是否已经变化，再决定是否重试操作。

## 整理当前工作

- 为重要 Agent 设置简洁、可辨识的标题。
- 将需要持续关注的 Agent 固定在明显位置。
- 工作完成后归档 Agent，避免当前列表被旧任务占据。
- 删除 Agent 前确认不再需要它正在使用的 Browser 或实验性资源。

Farming 的重点是让有限数量的实际工作保持清晰，而不是用数量本身衡量效率。
