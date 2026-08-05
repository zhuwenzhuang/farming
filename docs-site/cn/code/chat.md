# Chat

Chat 把 Coding Agent 的消息、过程和工具活动整理成可阅读的时间线。它适合跟进任务、检查证据，并在不离开上下文的情况下继续追问。

<ThemeImage light="../assets/chat.png" dark="../assets/chat-dark.png" alt="结构化 Chat" />

## 阅读 Agent 过程

一个 Turn 通常包含：

- 你的任务或后续要求；
- Agent 的计划或阶段性说明；
- 文件读取、编辑与命令执行等活动；
- 最终结果、验证和仍需注意的风险。

过程区域可以折叠。日常跟进先看结论和验证，需要审计时再展开具体活动。

## 写清楚任务

好的首次消息通常包含：

1. 想达到的结果；
2. 允许修改的范围；
3. 不能破坏的现有行为；
4. 需要运行的验证；
5. 何时必须停下来询问。

后续消息尽量引用当前结果中的具体问题，例如“补上取消场景的测试”，而不是只说“继续优化”。

## 模型与权限

不同 Provider 会暴露不同的模型、推理强度、服务层级与权限控制。Farming 只显示当前 Provider 和 Session 实际支持的选项。

<ThemeImage light="../assets/model-controls.png" dark="../assets/model-controls-dark.png" alt="模型与运行控制" />

放宽权限会减少确认步骤，也会扩大 Agent 能执行的操作范围。只在可信仓库和明确任务中使用，并优先采用能够满足任务的最小权限。

## 中断与跟进

如果任务方向明显错误，可以停止当前 Turn，再发送更精确的要求。网络超时不等于操作一定失败；重新发送可能导致重复修改，因此应先检查文件、Git 状态和 Agent 当前显示的结果。

## 切换到 Terminal

需要原生 CLI 交互或完整 PTY 输出时，可以切换到 [Terminal](./terminal)。Provider 支持的 Session 会继续使用同一个 Agent 身份和 Workspace。
