---
description: 为同一种 Coding Agent 配置多个 Home，并在创建 Agent 时选择对应账号与配置。
---

# Agent Homes

Agent Home 是 Coding Agent 保存登录状态、配置和扩展的目录。Farming 支持为同一种 Provider 配置多个 Home，让工作账号、个人账号或不同团队环境保持分离，并在启动 Agent 时快速选择。

## 配置多个 Home

打开 **插件 → Agent Homes**，选择 **添加 Agent**，然后填写：

- **Provider**：Codex、Claude Code、OpenCode、Qoder 或 Qwen Code；
- **Home path**：这套配置实际使用的独立目录；
- **Home name**：在 Farming 中显示和选择的稳定名称，例如 `work` 或 `personal`。

不同 Home 必须使用不同目录。调整显示顺序只会改变新建 Agent 时的选择顺序，不会修改已存在 Session 的身份。

## 切换账号

创建新 Agent 时，先选择 Coding Agent，再选择对应的 Agent Home。Farming 会把这次 Session 固定绑定到所选 Provider 和 Home：

- 新 Agent 使用该 Home 中已有的登录状态和配置；
- History 与恢复操作继续使用原来的 Home；
- 删除、重命名或重排配置不会把已有 Session 悄悄切换到另一个账号；
- 需要换账号时，应使用目标 Home 创建或恢复对应 Session，而不是复用错误身份的运行中 Agent。

## 每个 Home 的扩展

插件页面的 **扩展** 标签会按 Home 展示实际发现的 Skill、MCP、Hook、插件和命令。这样可以让工作账号与个人账号使用不同的工具集，也能清楚判断某项能力来自哪套配置。

## 使用建议

- 使用简短、稳定的 Home name，例如 `work`、`personal`、`team-a`；
- 不要让两个 Home 指向同一个目录；
- 不要为了“切换账号”复制或在文档中暴露 Token、Cookie 或私有配置；
- 移除 Home 前，先确认是否仍有需要恢复的历史 Session；
- Provider 显示未安装时，配置仍可保留，但不能用它启动新 Agent。
