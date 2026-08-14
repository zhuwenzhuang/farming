---
pageClass: quickstart-page
description: 用五个步骤安装 Farming、启动第一个 Coding Agent，并完成一次可验证的任务。
---

# 快速开始

按下面五个步骤安装 Farming、启动第一个 Coding Agent，并完成一次可验证的任务。

## 准备运行主机

你需要：

- macOS 或 Linux；
- Node.js 22.13 LTS（22.x）或 Node.js 24+；
- 至少一个已经可以正常启动的 Coding Agent，例如 Codex、Claude Code、Pi 或 OpenCode。

Farming 不代替 Provider 登录。请先在运行 Farming 的 Mac 或 Linux 主机上完成相应 CLI 的登录，并确认它能独立启动。

::: tip 完成标志
在运行 Farming 的同一台 Mac 或 Linux 主机上，目标 Coding Agent 的 CLI 可以正常启动，不会卡在登录或初始配置。
:::

## 安装并打开 Farming

```bash
npm install --global farming-code@latest
farming daemon
```

`farming daemon` 会启动后台服务，并输出一个或多个带鉴权的 URL。在同一台机器上使用时，打开本机地址即可。

::: warning 保管鉴权 URL
URL 中的 Token 可以访问 Farming。不要把它放进公开日志、截图、Issue 或聊天记录。
:::

::: tip 完成标志
浏览器显示 Farming Code，左上角可以看到 **New Agent**。
:::

## 启动第一个 Agent

1. 选择左上角的 **New Agent**。
2. 选择 Coding Agent。
3. 选择代码仓库所在的 Workspace。
4. 选择 Chat 或 Terminal，然后创建 Agent。

<ThemeImage light="/cn/assets/start-agent.png" dark="/cn/assets/start-agent-dark.png" paper="/cn/assets/start-agent-paper.png" alt="选择 Coding Agent" />

Chat 适合阅读结构化过程和结果；Terminal 适合直接使用原生 CLI。二者都运行在 Farming Host 上，而不是浏览器里。

::: tip 完成标志
页面已打开新 Agent，并显示正确的 Workspace 和 Chat 或 Terminal 界面。
:::

## 完成一次只读任务

第一次使用建议选择一个小而可验证的任务：

```text
请先说明这个仓库如何启动测试，然后找到一个适合新贡献者理解的小模块。
不要修改文件。给出关键入口、相关测试和你实际检查过的命令。
```

发送后按下面的顺序跟进：

1. 在 Chat 中查看 Agent 的阶段性过程和最终结论。
2. 打开 Agent 提到的关键文件，确认路径和代码确实存在。
3. 需要原生命令输出时切换到 Terminal，或让 Agent 运行一个聚焦检查。
4. 如果结论缺少证据，发送后续要求，例如“请运行你提到的测试，并报告精确命令和结果”。
5. 确认结果后，为 Agent 设置容易搜索的标题，并归档已经结束的任务。

::: tip 完成标志
Agent 的结论包含你可以独立核对的文件路径、测试位置和命令结果。
:::

## 尝试一个小修改

熟悉只读流程后，可以尝试范围明确的修改：

```text
修复 README 中一处明确的过期命令。只修改相关段落，保持现有文风，
并检查所有相邻链接。完成后说明修改内容和验证方式。
```

检查 Agent 是否：

- 只修改了要求的范围；
- 打开或搜索了权威文件；
- 运行了与风险相匹配的验证；
- 清楚说明仍未验证的内容。

完整方法见[检查、验证与收尾](../workflows/verify-and-finish)。

::: tip 完成标志
你已检查实际文件变更，并能分清 Agent 已经验证和尚未验证的内容。
:::

## 关闭浏览器后会怎样

关闭标签页不会自动停止正在运行的 Agent。重新打开同一个 Farming 地址后，可以继续查看当前工作。

需要再次输出地址时运行：

```bash
farming url
```

如果服务没有运行，使用 `farming daemon` 重新启动。

## 接下来

- [了解 Farming Code](../code/overview)
- [理解一个代码库](../workflows/understand-a-codebase)
- [定位并修复问题](../workflows/fix-a-problem)
- [在手机或另一台电脑上访问](../code/mobile-and-remote)
- [排查启动问题](../help/troubleshooting)
