---
description: Farming 的键盘优先界面，用于巡视 Agent、使用 Chat 和 Terminal，并查看 Token 活动。
---

# Farming CRT

Farming CRT 是键盘优先的第二界面，用来快速巡视 Agent、Chat、Terminal、Search 与 History。它和 Farming Code 连接同一个后端，不会创建第二套 Session。

![Farming CRT 控制室](/cn/assets/crt-dashboard.png)

## 主控制屏

主屏把 Project 和 Agent 状态组织成紧凑的控制室。你可以先巡视运行状态、未读活动和当前任务，再打开需要介入的 Agent。

## Chat

![Farming CRT 结构化 Chat](/cn/assets/crt-chat.png)

支持结构化 Chat 的 Agent 会显示消息、过程和 Composer，同时保留 CRT 的键盘优先导航。

## Terminal

![Farming CRT Terminal](/cn/assets/crt-terminal.png)

Terminal 连接同一个原生 PTY Session，适合查看完整输出并使用 Coding CLI 自己的交互方式。

## Token 使用

![Farming CRT Token 使用界面](/cn/assets/crt-usage-20260806.png)

Token 使用界面汇总当前 Provider 活动和历史用量，帮助判断活跃时段、使用趋势和异常峰值。

## 适合的场景

当你主要关注实时输出、任务状态和键盘切换效率时，可以使用 CRT。需要浏览或编辑项目文件时，返回 Farming Code。

CRT 适合同时关注几项明确的工作，但仍应保持列表可理解，并及时归档已经结束的 Agent。

## 打开 CRT

在 Farming Code 中打开 **Settings → Interface**，选择 **Farming CRT**。

CRT 和 Farming Code 分别保存界面设置。切换界面不会停止 Agent，也不会改变其 Project、Provider 或权限。

## 常用按键

| 按键 | 操作 |
| --- | --- |
| 方向键 / `Enter` | 选择并打开 Agent |
| `0` | 打开 Main Agent |
| `N` | 启动 Agent |
| `F` | 打开 Search |
| `H` | 打开 History |
| `$`（`Shift+4`） | 打开 Billing（Token 使用） |
| `E` | 打开 Extensions |
| `Ctrl+Escape` | 关闭当前 Chat 或 Terminal |
| `Alt+M` | 在支持的 Agent 上切换 Chat 与 Terminal |
| `S` | 打开设置 |

CRT 主屏也会显示当前版本可用的快捷键提示。

## 使用建议

- 为 Agent 使用能表达目标的短标题。
- 先扫描状态，再打开具体输出。
- 对需要长篇阅读的结果切回 Farming Code。
- 结束的工作及时归档，保持控制室稳定。
