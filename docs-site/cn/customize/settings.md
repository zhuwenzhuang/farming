---
description: 调整 Farming Code 的界面、Agent 行为、搜索、Farming Pet 与更新设置。
---

# 设置

Settings 集中管理界面、Agent 行为、搜索、Farming Pet 和更新。设置项只在当前安装和运行环境支持时显示。

<ThemeImage light="/cn/assets/settings.png" dark="/cn/assets/settings-dark.png" alt="Farming 设置" />

> 文档截图使用英文界面，以便自动生成结果保持稳定。可以在 Settings 顶部随时切换中文或英文。

## 外观与语言

Settings 顶部可以选择跟随系统、浅色或深色主题，并切换中文或英文界面。

## Interface

**Interface skin** 用于在 Farming Code 与 Farming CRT 之间切换。两者连接同一个后端 Session；切换界面不会停止 Agent。

**Content font size** 会影响 Chat、Terminal、Markdown 和文件编辑器中的主要阅读内容，不会同比放大导航与状态控件。Farming Code 与 Farming CRT 分别保存自己的正文显示设置。

## Agent

**Follow-up behavior** 决定 Agent 正在工作时，新消息是排队等待，还是立即用于调整当前工作方向。

完成通知只会在你显式开启后请求浏览器权限。刷新或重连不会补发旧的完成事件。

**Skip permissions by default** 会放宽新 Agent 的默认确认要求。只应在 Workspace 和任务都可信时开启；Provider 自身仍可能有额外的权限模型。

## Search

**Search timeout** 控制一次搜索等待结果的最长时间。大型仓库应优先缩小路径和关键词，而不是不断提高超时。

## Farming Pet

Farming Pet 是可选的番茄钟式休息提醒。可以设置提醒间隔，并选择两种休息画面：

- **柔光**：白色磨砂光感的安静休息界面；
- **黑洞**：全屏动态黑洞界面。

它只计算当前 Farming 标签页的前台使用时间，不会暂停、停止或改变 Agent 的工作。

### 柔光

<ThemeImage
  light="/cn/assets/pet-soft-glow.png"
  dark="/cn/assets/pet-soft-glow-dark.png"
  alt="Farming Pet 柔光休息界面"
/>

### 黑洞

![Farming Pet 黑洞休息界面](/cn/assets/pet-black-hole.png)

## Updates

npm 安装可以在 Updates 中检查并准备新版本。更新区域会显示当前版本、目标版本、安装来源和明确结果。
