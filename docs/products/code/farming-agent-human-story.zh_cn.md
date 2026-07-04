# Farming Agent 类人验收故事

> English version: [farming-agent-human-story.md](./farming-agent-human-story.md)

本文档是 Farming 作为 Agent workspace 的类人验收故事。它关注用户从冷启动进入 Farming、启动 agent、继续工作，以及重新打开页面后是否还能顺畅接上。

## 故事 1：从零开始

目标：使用 Farming 启动 Main Agent，并让它处理一个很小的功能请求。

1. 打开 `/farming/`。
2. 首屏应提供 `Start Main Agent`，不要求用户先理解 Main Agent 工作目录。
3. 选择 `Codex`。
4. 左侧 sidebar 应出现一个 live Main Agent。
5. 在 composer 输入一个小需求，例如：

   ```text
   add greeting to app.js
   ```

6. 如果 Codex 正在工作，消息应进入 queued follow-up，而不是直接发送。
7. 点击 `Steer` 把 queued follow-up 送入当前 agent terminal。
8. terminal 应收到消息并继续输出。

期望：

- 页面打开后 WebSocket 已连接，agent 选项可用。
- 真正发送时 composer 会向 terminal 写入 `\r`。
- busy agent 的消息会排队并可见。
- 点击 `Steer` 会 flush queued message。
- 重新打开或重复点击已 resume 的 session 不应产生重复 agent。

## 故事 2：重新打开并继续

目标：关闭或刷新浏览器后，仍能继续观察和介入同一个 agent。

1. 启动 Codex agent。
2. 发送或排队一个 follow-up。
3. 刷新页面。
4. 同一个 agent row 仍然存在并被选中。
5. 再输入一个 follow-up。

期望：

- 只要 Farming server 仍在运行，active agent 不因浏览器刷新而丢失。
- 选中 agent 后 composer controls 仍可用。
- busy Code-style agent 继续排队 follow-up，直到用户点击 `Steer`。

## 故事 3：已有项目开发

目标：打开一个已有项目，并完成一次真实 terminal-backed 的小修改。

1. 启动 Main Agent。
2. 点击 `New Agent`。
3. 选择 `bash`。
4. 选择一个已有项目目录。
5. 在 composer 中运行一个小的项目修改命令，例如向 `app.js` 追加 smoke 行。
6. 确认文件确实变化。

期望：

- 新 project agent 在用户选择的目录启动。
- Shell terminal 输出保留可控 prompt 形式：

  ```text
  [user@host ~/project]
  $
  ```

- ANSI color escape sequences 保留给 terminal renderer 渲染颜色。

## 故事 4：读取旧 terminal 输出

目标：agent 继续输出时，用户仍能稳定阅读旧输出。

1. 打开一个 running agent terminal。
2. 向上滚动阅读旧输出。
3. 让 agent 继续打印更多内容。
4. 准备回到底部时，点击小的 down-arrow。

期望：

- 用户阅读旧输出时视口不被强行拉到底部。
- jump-to-latest 只在用户主动点击时发生。
