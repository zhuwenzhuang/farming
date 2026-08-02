# Farming Code

> English version: [README.md](./README.md)

Farming Code 是默认的桌面与移动端工作区，用来跟进一个或多个 Coding Agent、阅读工作结果，并在需要时介入。

![Farming Code 工作区](assets/01-code-workspace.png)

## 开始

安装 Farming，打开带鉴权 URL，然后选择 **New Agent**。首次使用流程见[快速开始](../../getting-started.zh_cn.md)。

## 主要工作流

### 桌面端与远程后端

Electron MVP 把 Farming Code 复用为本地桌面界面，并连接已保存的本地或通过 SSH 到达的
Farming 后端。详见 [Farming Desktop MVP](desktop-app.zh_cn.md)。

### Agent、Chat 与 Terminal

在 Chat 中阅读结构化 Agent 结果，或在 Terminal 中直接使用 CLI。

### Files 与 Review

不离开当前任务，就能浏览 Project Files、检查修改、做小范围编辑并打开 Review。

同一个编辑器可以在 Project 所在主机启动托管 Language Server，提供跳转、符号、调用/类型
层次结构和诊断。详见 [Language Server](language-server.zh_cn.md)。

### Search 与 History

查找进行中的工作，或恢复受支持的历史 Agent Session。

### Browser

人和 Agent 可以使用同一个 Project Browser。详见 [Farming Browser](browser-agent-cli.zh_cn.md)。

### Computer

Agent 可以操作一台隔离的 Linux 桌面，用户则在 Farming 中观察或显式接管。详见
[Farming Computer](computer-use.zh_cn.md)。

### 手机

在手机上打开 Farming 的带鉴权 URL。通过抽屉切换 Project 和 Agent；Chat、Terminal
与 Files 会分别使用完整屏幕。手机更适合查看进度和发送简短跟进。

### 正文字号

**设置 → 界面 → 正文字号**会调整 Chat 与输入框、Terminal、Markdown 预览，以及文件
编辑器和 Diff 中供用户阅读的内容。导航、按钮、状态标签等系统界面仍保持固定字号。
Farming Code 与 Farming CRT 分别保存自己的设置。

### Farming Pet

Farming Pet 提供可选的休息提醒，但不会在新用户刚进入界面时要求选择。页面在前台累计使用
30 分钟后才显示邀请。启用后，提醒按当前标签页的前台可见时间计时，离开五分钟会重置本轮。
默认连续使用 50 分钟后休息五分钟；间隔达到 90 分钟及以上时休息十分钟。提醒样式支持预览，
预览不会保存选择。黑洞场景只在进入休息时捕获一次当前可见工作区，之后由 GPU 持续完成
引力透镜与吸积盘动画，不会反复捕获页面。

### Agent 通知

**设置 → Agent → 允许消息通知**可以在接收事件的 Farming 标签页都不在前台时显示浏览器本地
系统通知。Farming 只会在用户显式开启该设置时请求浏览器通知权限。首次加载和重连只建立
attention 基线，不会补发历史事件。通知正文显示 Agent 最后一条用户可见消息的有界纯文本
摘要，而不是笼统的完成提示；点击通知会返回对应 Agent。带鉴权的 Farming URL 需要运行在
支持系统通知的浏览器环境中，通常是 HTTPS 或 localhost。

ACP Session 在 `session/prompt` 以标准的非取消 stop reason 结束时请求通知。Terminal Session
则遵循 Agent TUI 自己的通知时机：Farming 识别其写入 PTY 的 OSC 9、OSC 99、OSC 777
notification 和 BEL。Farming 推断的 Terminal 忙碌→空闲状态仍用于未读完成状态，但不会
自行生成系统通知。

## 更多

- [Farming CRT](../crt/README.zh_cn.md)
- [文档首页](../../README.zh_cn.md)
