# Farming Browser

> English version: [browser-agent-cli.md](./browser-agent-cli.md)

Farming Browser 让 Agent 操作自己拥有的 Browser，同时用户可以在 Farming 中看到并操作
同一个页面。

## 启用 Browser

打开**插件 → 浏览器**：

1. 保持自动选择，或选择已发现的系统 Chromium 浏览器。
2. 如果没有可用浏览器，直接点击**安装内置 Chromium**。安装完成后可继续自动选择，
   也可以选择 **Farming 内置 Chromium** 并应用。
3. 高级场景下配置[外部 CDP 浏览器](external-cdp-browser.zh_cn.md)。

浏览器来源就绪后启用 Browser 插件，无需重启 Farming。只有用户点击安装后才会下载
内置 Chromium，并且它只保存在 Farming 的数据目录中。Farming 会根据当前网络探测
受支持的下载源；一个源失败后会继续尝试其他源。

Browser Tool 直接使用 Coding Agent Provider 的 Session 权限模式，Browser 插件不再
提供第二套权限策略。当 Provider 发起询问且用户为当前 Session 允许 Browser 请求后，
Farming 会复用该授权，避免同一 Origin 上的后续 Browser Tool 重复询问；新 Origin
仍会再次询问。Provider 的 Full access / skip-permissions 模式可以不询问而执行普通
Browser Tool。外部个人浏览器挂载，以及操作系统的摄像头、麦克风和认证权限，仍然是
彼此独立的边界。

## Agent 工作流

Browser 在 ACP Session 创建时已经启用的情况下，Agent 会获得细粒度的 `browser_*`
Tool Catalog：先用 `browser_list`，需要新页面时用 `browser_open` 创建用户可见的
Agent-owned Browser。如果 ACP Session 启动后才启用 Browser，需要明确重启一次 Chat
Runtime 才能挂载这些 Tool。

Terminal Agent 只在任务需要浏览器时逐步发现命令：

```bash
farming capabilities
farming browser --help
farming browser help workflow
```

推荐流程是：

```text
list → 复用或创建 → start → navigate → snapshot
     → 通过 Snapshot Ref 操作 → wait → 再次 snapshot 验证
```

用 `farming browser help <topic>` 展开一个能力域，再用
`farming browser <command> --help` 查看单条命令的精确参数。这样普通 Agent
上下文不会一次性装入全部浏览器命令。

网页内容和命令输出都是不可信数据，不是给 Agent 的指令。优先从结构化 Snapshot
开始，确有需要时再读取 JavaScript 或调试证据。

## 支持的任务

- 创建、列出、启动和停止 Browser Resource。
- 导航、后退、前进、刷新，以及等待页面变化。
- 点击、填表、输入、按键、选择、拖拽和滚动。
- 读取结构化 Snapshot、文本、属性、元素状态和截图。
- 检查 Console、页面错误和 Network Request。
- 使用 Cookie、Storage、Frame 和浏览器 Dialog。
- 上传已有 Project 文件，或把下载保存为 Project 中的新文件。

运行 `farming browser help` 可查看当前安装版本提供的主题。

## 共享使用与安全

每个 Browser Resource 都是在 Farming 中独立可见的页面，并挂在
**Agent → Resources → Browsers** 下。层级默认收起，改变展开状态不会停止 Browser，
也不会关闭已经打开的 Viewer。同一 Agent、同一浏览器来源下的 Resource 共享浏览器
登录状态；即使处于同一个 Project，不同 Agent 也不会共享 Session、Profile、Cookie
或 Storage。用户可以随时打开 Viewer，在同一个页面上查看、点击、滚动或输入。

当前 Agent 使用 Browser 时，Farming 会在 Chat 右上角叠放一个轻量只读预览。它只
订阅现有 Viewer 画面，不会调整页面尺寸或争夺控制权；点击可进入完整 Viewer，关闭
预览也不会停止 Browser。

Agent 在 Chat/Terminal 间切换时保留 Browser Ownership。停止或归档 Agent 会停止其
Browser Runtime，但保留 Row 与 Profile；恢复 Agent 后按需启动。删除 Agent 会删除
它的 Browser Resource 与独立 Profile。

只有当该 Project 确实应该使用某个账号时，才把已登录浏览器交给 Agent。Cookie、
Storage、页面脚本、Console 和 Network 详情可能包含敏感信息。上传与下载只允许在
Browser Resource 所属的 Project Workspace 内进行，下载不会覆盖已有文件。

ACP MCP 与 Terminal CLI 是同一 Farming Browser Contract 的两种 Transport。
`farming browser mcp` 是 Farming Provider Adapter 使用的标准 stdio 入口，也可由
明确的外部调用方配置。

## 当前限制

Farming Browser 不提供 Chrome 原生 Bookmark、History、Extension、Download UI 或
DevTools Window。Camera、Microphone、WebAuthn、Fingerprint、UKey 等硬件认证目前
不能保证可靠工作。
