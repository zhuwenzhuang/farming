# 连接用户已有 Chrome

> English: [chrome-extension-browser.md](./chrome-extension-browser.md)

Farming Browser 是浏览器能力；Farming Browser Connector 是安装在 Chrome 中的连接扩展。
只有需要直接使用用户当前 Chrome 中已有的页面和登录状态时，才需要安装它。
扩展已包含在 Farming 软件包中，不需要下载。

## 首次安装

1. 在 **插件 → 浏览器**选择**用户已有 Chrome**，复制**内置扩展目录**。
2. 打开 `chrome://extensions`，开启**开发者模式**，选择**加载已解压的扩展程序**，然后选择
   Farming 显示的扩展目录。
3. 回到 Farming 页面，从 Chrome 的**扩展程序**菜单点击 **Farming Browser Connector**。

扩展会自动配对并启用 Browser。以后会自动重连，无需再次设置或逐个授权标签页。

## 使用与删除

配对后，Agent 可以查看这个 Chrome 中已经打开的普通页面，根据任务选择一个页面并直接管理。
停止或删除 Farming Browser Resource 不会关闭用户原来的 Chrome 标签页。无痕页、`chrome://`
和其他受限页面不可用。

不再使用时，打开 `chrome://extensions`，找到 **Farming Browser Connector**，点击**删除**并确认。

安装和删除必须由用户在 Chrome 中确认。CLI 的 `extension path` 和 `extension status` 只用于
查看内置目录和连接状态。

只连接可信的 Farming。

## 来源

Connector 基于 MIT 许可的 OpenClaw Browser Extension 和 Relay，固定版本与许可证保存在
`extensions/browser/chrome-extension/upstream/`。Farming 使用独立的扩展 ID、存储、协议、
密钥、Native Host 和标签组，可与 OpenClaw 同时安装。
