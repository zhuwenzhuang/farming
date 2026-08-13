# 在 Farming Browser 中使用用户自己的 Chrome

> English version: [chrome-extension-browser.md](./chrome-extension-browser.md)

Farming Browser Connector 让 Farming 操作用户已经登录的有头 Chrome 中、明确获准的标签页。
页面会同时显示在 Chrome 和正常的 Farming Browser Viewer 中；Agent 继续使用现有
`farming browser` 命令与 Browser Resource Owner 模型。

## 安装与配对

运行：

```bash
farming browser extension install
```

保持输出目录不变。打开 `chrome://extensions`，开启**开发者模式**，点击
**加载已解压的扩展程序**，选择该目录。Chrome 不允许 Farming 静默完成这一步用户授权。

然后打开 **插件 → 浏览器**，选择**用户自己的 Chrome（Farming 插件）**，复制页面展示的
配对字符串。打开 Farming Browser Connector 的 Settings，将字符串粘贴到手动配对区域并保存。
CLI 也可以输出相同信息：

```bash
farming browser extension pair
farming browser extension status
```

完整配对字符串等同密码。首次配对后，扩展把它保存在自身独立的 Chrome Extension Storage
中；Chrome 与 Farming 同时运行时会自动重连。插件页显示已连接后，应用
**用户自己的 Chrome（Farming 插件）**作为浏览器来源。

扩展保留 OpenClaw 上游的两种授权模式：

- **All tabs**：允许普通且符合条件的标签页，但当前浏览器会话中明确 Pause 的标签页除外。
- **Selected tabs**：以 Farming 标签组为授权边界；移入即授权，移出即立即撤销。

无痕标签页、`chrome://`、`chrome-extension://` 等页面不可用。Agent 创建的标签页进入
Farming 标签组。Browser Resource 仍精确拥有自己的标签页；一个 Agent 不会静默继承另一个
Agent 的 Browser Resource。

## OpenClaw 来源与持续同步

Farming Browser Connector 基于 MIT 许可的 OpenClaw Chrome 扩展和 Extension Relay 实现。
固定的上游仓库、Commit、源码目录、保留许可证与确定性的改名范围记录在
`extensions/browser/chrome-extension/upstream/`。Farming 会持续同步上游的安全性与兼容性修复。

维护者从经过审核的 OpenClaw Checkout 更新 Vendored Extension：

```bash
npm run sync:openclaw-browser-extension -- /path/to/openclaw
```

每次同步都必须同时审核上游 Relay 协议与服务端 CDP Bridge 变化，运行 Browser Extension
和 Resource 测试，并在同一变更中更新固定 Revision。Farming 的差异限定为产品名称、协议、
Native Host、Alarm、标签组命名空间、打包方式，以及接入现有 Browser Resource 与 Viewer。

## 与 OpenClaw 同时安装

Farming 不会附加、控制或修改已经安装的 OpenClaw 扩展。两者可以同时安装在同一个 Chrome
Profile，因为 Farming 使用独立的：

- Chrome Extension ID 与 `chrome.storage.local` 命名空间；
- `farming-extension-relay.v2` WebSocket 子协议和 Farming 路由；
- `ai.farming.browser_bootstrap` Native Messaging Host 名称；
- Farming Alarm 名称与 Farming 标签组标题；
- 当前 Config 目录下由 Farming 持有的配对密钥。

OpenClaw 标签组不会授予 Farming 权限，Farming 标签组也不会授予 OpenClaw 权限。两者分别
附加自己获准的标签页时，Chrome 仍可能显示各自的 Debugger 提示。

## 状态与失败语义

Farming 后端是配对密钥、所选浏览器来源、Relay 连接和 Browser Resource 生命周期的权威
Owner；扩展拥有自己保存的配对副本与标签页授权策略。“已配对但未连接”不可运行：插件页会
明确显示 Connector 不可用，也不会回退到其他浏览器来源。

重启 Chrome 或 Farming 会保留配对并自动重连。机器必须保持唤醒、Chrome 必须运行，Farming
WebSocket 路由必须可达。切换浏览器来源会停止正在运行的 Browser Resource，但绝不会终止
用户的 Chrome 进程。

Connector 能访问已登录浏览器状态。只配对可信 Farming 实例；敏感 Profile 建议选择
**Selected tabs**；不再需要时应清除配对或删除扩展。
