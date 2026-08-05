# Terminal

Terminal 连接 Farming Host 上的真实 PTY。它不是网页中的模拟命令框，而是 Coding CLI、Shell 和开发工具实际运行的地方。

<ThemeImage light="../assets/terminal.png" dark="../assets/terminal-dark.png" alt="Terminal Session" />

## 适合 Terminal 的任务

- 直接使用 Codex、Claude Code、OpenCode 等 CLI；
- 运行交互式 Shell、测试或调试命令；
- 使用 CLI 自己的快捷键、补全和颜色输出；
- 查看未经结构化处理的完整输出。

## Session 与浏览器连接

关闭浏览器不会自动结束 Terminal Session。重新连接后，Farming 会从服务端保存的终端状态恢复可见内容。

短暂断网、标签页隐藏或界面切换都不应被当成进程已经退出。如果结果不明确，先重新打开 Agent 或运行 `farming status`。

## 输入与粘贴

Terminal 输入会发送到真实 PTY：

- 粘贴多行命令前先确认内容；
- 不要把 Token、密码或私钥粘贴进会被日志记录的命令；
- 长时间任务应保留清晰的完成或失败信号；
- 在手机上避免执行依赖复杂快捷键的交互。

## Chat 与 Terminal 切换

Chat 更适合阅读和跟进，Terminal 更适合直接控制。Provider 支持时可以在两者之间切换，而不创建新的 Agent。

切换只改变呈现方式，不会改变 Workspace 权限，也不会让另一个 Project 获得当前 Terminal 的文件访问权。
