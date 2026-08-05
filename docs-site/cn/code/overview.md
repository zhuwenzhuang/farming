# Farming Code

Farming Code 是默认的浏览器工作区。你可以在这里启动或继续 Agent，并在同一个界面中查看 Files、Chat、Terminal 与 History。

<ThemeImage light="/cn/assets/welcome.png" dark="/cn/assets/welcome-dark.png" alt="Farming Code 完整欢迎页" />

第一次接触这些名称时，可以随时查看[术语表](../help/glossary)。

## 工作区组成

- **Project**：一个代码仓库及其工作上下文。
- **Agent**：在某个 Project 中运行的 Coding Agent 或 Shell Session。
- **Files**：浏览、搜索和轻量编辑 Project 文件。
- **Chat**：结构化展示 Agent 的过程、工具调用和最终结果。
- **Terminal**：连接 Farming Host 上的真实 PTY 与 CLI。
- **History**：查找并恢复受支持的历史 Session。

启用插件后，还可以让 Agent 使用 Browser 或其他外部资源；也可以通过 [Agent Homes](../plugins/agent-homes) 管理同一种 Agent 的多套账号与配置。这些能力不会改变 Code、CRT 与 Session 的基本关系。

Agent 的运行状态、Session、Workspace、配置和权限都由 Farming 服务统一保存。短暂断网或切换界面后，重新打开页面即可继续读取当前状态。

## 推荐工作方式

1. 从 **New Agent** 选择正确的 Project 和 Provider。
2. 在 Chat 中描述任务和验收条件。
3. 根据 Agent 的过程打开相关文件或 Terminal 核对证据。
4. 需要调整时发送明确的后续要求。
5. 任务结束后归档不再需要持续显示的 Agent。

## Chat 与 Terminal 怎么选

使用 Chat，当你希望：

- 快速阅读结构化过程；
- 区分工具调用、计划和最终回答；
- 使用模型、推理强度或权限等可见控件；
- 从手机上跟进任务。

使用 Terminal，当你希望：

- 直接操作 CLI 的原生交互；
- 使用 CLI 自己的快捷键和命令；
- 查看未经结构化处理的完整终端输出。

Provider 支持时，同一个 Agent 可以在 Chat 和 Terminal 之间切换。切换界面不会创建第二个 Agent。

## 下一步

- [项目与 Agent](./projects-and-agents)
- [Chat](./chat)
- [Terminal](./terminal)
- [Files](./files)
- [Token 使用](./usage)
