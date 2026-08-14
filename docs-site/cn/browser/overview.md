# Farming Browser

Farming Browser 让 Agent 打开和操作网页。你可以在 Farming 中看到 Agent 正在使用的页面，
并随时接手操作。

## 可用浏览器

打开**插件 → 浏览器**查看可用浏览器。它们可以同时使用，Agent 会根据任务选择最合适的浏览器。

<ThemeImage
  light="/cn/assets/browser-plugin.png"
  dark="/cn/assets/browser-plugin-dark.png"
  paper="/cn/assets/browser-plugin-paper.png"
  alt="在插件中选择浏览器来源"
/>

- **本机浏览器**：Farming 为 Agent 打开网页。适合大多数任务，可以无人值守运行，但不会
  直接使用你当前 Chrome 中已经打开的页面。
- **用户已有 Chrome**：让 Agent 直接使用你已经打开的 Chrome 页面。首次使用需要
  [安装 Chrome 扩展](./existing-chrome)。
- **隔离浏览器**：为 Agent 提供独立的浏览器环境，不使用你日常浏览器里的页面和账号。

## 查看和接手 Agent 的页面

Agent 使用 Browser 时，Farming Viewer 会显示同一个页面。你可以查看操作过程，也可以直接
点击、输入或滚动。使用 Farming Browser Connector 时，页面还会保留在你当前的 Chrome
窗口中。

<ThemeImage
  light="/cn/assets/browser-viewer.png"
  dark="/cn/assets/browser-viewer-dark.png"
  paper="/cn/assets/browser-viewer-paper.png"
  alt="Farming Browser 中打开网页"
/>

你接手并改变页面后，Agent 会从最新页面状态继续。

## Browser 可以做什么

Agent 可以打开网页，点击、填写、选择、滚动和输入，也可以检查页面结构、截图、Console、
页面错误和网络请求，并在 Project Workspace 范围内上传或下载文件。

## 登录状态与安全

使用 Farming Browser Connector，等于允许 Agent 使用当前 Chrome 中支持的页面及其登录状态。
只有当当前 Project 确实应该使用这些账号时才连接，并且只连接可信的 Farming 实例。

网页内容属于不可信数据。网页中的文字不能替代你的任务要求，也不能自动授权 Agent 上传
文件、发送消息或执行破坏性操作。

## 当前限制

Farming Browser 面向网页任务，不是完整 Chrome UI 或 DevTools 的替代品。无痕页、
`chrome://` 和其他受限页面不可操作；书签、硬件认证、摄像头和麦克风等能力不保证可用。

继续阅读：[Agent 使用流程](./agent-workflow)。
