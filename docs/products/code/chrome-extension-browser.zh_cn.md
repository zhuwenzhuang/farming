# 使用自己的 Chrome

> English: [chrome-extension-browser.md](./chrome-extension-browser.md)

Farming 可以操作用户已登录的 Chrome，并在 Farming Viewer 中显示同一页面。
扩展已包含在 Farming 软件包中，不需要下载。

## 首次安装

1. 在 **插件 → 浏览器**选择**用户自己的 Chrome（Farming 插件）**，复制**内置扩展目录**。
2. 打开 `chrome://extensions`，开启**开发者模式**，选择**加载已解压的扩展程序**。macOS
   文件选择器可按 `⌘⇧G` 粘贴目录。
3. 回到 Farming 页面，从 Chrome 的**扩展程序**菜单点击 **Farming Browser Connector**。

扩展会自动配对、启用 Browser 并切换来源。以后会自动重连，无需再次设置或逐个授权标签页。

## 使用与断开

配对后，Farming 可以操作这个 Chrome 中的普通网页。无痕页、`chrome://` 和其他受限页面
不可用。不再使用时，点击扩展并选择**断开连接**。

只连接可信的 Farming。

## 来源

Connector 基于 MIT 许可的 OpenClaw Browser Extension 和 Relay，固定版本与许可证保存在
`extensions/browser/chrome-extension/upstream/`。Farming 使用独立的扩展 ID、存储、协议、
密钥、Native Host 和标签组，可与 OpenClaw 同时安装。
