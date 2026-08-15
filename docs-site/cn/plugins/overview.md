---
description: 了解 Farming 插件页面中的内置能力、Agent Homes、Agent 扩展与实验性功能。
---

# 插件

插件页面集中管理 Farming 和 Coding Agent 可以使用的附加能力。它不是单一的 Browser 设置页，而是由三部分组成：

- **Farming**：Farming 自己提供的 Browser、Computer、Language Server，以及桌面版中的 Connections；
- **Agent Homes**：为 Codex、Claude Code、OpenCode、Qoder、Qwen Code 管理一套或多套 Home；
- **扩展**：按 Agent Home 查看实际发现的 Skill、MCP、Hook、插件和命令。

打开插件页面时，Farming 会重新读取当前能力和配置。依赖缺失或读取失败会直接显示，不会用旧结果假装当前可用。

## Agent Homes

同一种 Coding Agent 可以配置多个 Home，例如工作账号、个人账号或不同团队环境。创建 Agent 时选择对应 Home，就可以使用那套独立的登录状态、配置和扩展目录。

<ThemeImage light="/cn/assets/agent-homes.png" dark="/cn/assets/agent-homes-dark.png" paper="/cn/assets/agent-homes-paper.png" alt="插件页面中的多个 Agent Homes" />

继续阅读：[管理多个 Agent Homes](./agent-homes)。

## Farming 内置能力

<div class="docs-card-grid">
  <a class="docs-card" href="../browser/overview">
    <strong>Farming Browser</strong>
    <span>让用户与 Agent 查看和操作同一个浏览器页面。</span>
  </a>
  <a class="docs-card" href="../experimental/computer-use">
    <strong>Computer Use（实验性）</strong>
    <span>实验性完整桌面操作与控制权交接。</span>
  </a>
  <a class="docs-card" href="../code/language-server">
    <strong>Language Server</strong>
    <span>代码跳转、引用、调用层次、符号与诊断。</span>
  </a>
  <a class="docs-card" href="../experimental/desktop">
    <strong>Farming Desktop</strong>
    <span>实验性连接并切换多个受信任的 Farming 后端。</span>
  </a>
</div>

Computer Use 与 Farming Desktop 仍会明确标出实验状态。Language Server 默认启用，并在受支持的代码文件需要语义能力时按需启动。

## Agent 扩展

扩展列表按精确的 Agent Home 分组。切换 Home 后，可以分别查看该目录中发现的 Skill、MCP、Hook、插件和命令；Farming 不会把多个 Home 合并成一个看似共享的账号环境。
