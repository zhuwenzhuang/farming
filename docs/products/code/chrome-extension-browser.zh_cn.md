# 连接用户已有 Chrome

> English: [chrome-extension-browser.md](./chrome-extension-browser.md)

Farming Browser 是浏览器能力；Farming Browser Connector 是安装在 Chrome 中的连接扩展。
只有需要直接使用用户当前 Chrome 中已有的页面和登录状态时，才需要安装它。
扩展已包含在 Farming 软件包中，不需要下载。

## 首次安装

1. 在 Farming 的“插件 → 浏览器 → 我的 Chrome”中点击**准备插件目录**。Farming 只在此时准备
   **farming-browser-connector** 目录；重复点击不会创建重复目录。**安装步骤说明**是旁边的独立入口，
   不会自动打开。
2. 打开 `chrome://extensions`，开启**开发者模式**，选择**加载已解压的扩展程序**。
3. 在用户主目录中选择 **farming-browser-connector**。
4. 从 Chrome 的**扩展程序**菜单点击 **Farming Browser Connector**。

扩展会自动配对并启用 Browser。以后会自动重连，无需再次设置或逐个授权标签页。

## 使用与删除

配对后，Agent 可以查看这个 Chrome 中已经打开的普通页面，根据任务选择一个页面并直接管理。
停止或删除 Farming Browser Resource 不会关闭用户原来的 Chrome 标签页。无痕页、`chrome://`
和其他受限页面不可用。

不再使用时，打开 `chrome://extensions`，找到 **Farming Browser Connector**，点击**删除**并确认。
然后返回“插件 → 浏览器 → 我的 Chrome”，点击**删除插件目录**。该操作只删除 Farming 创建的目录链接，
以后仍可再次准备。

Farming 不会在启动时创建这个目录。用户点击**准备插件目录**后，Farming 才会在可见目录建立指向
包内扩展的链接，不会复制第二份代码。CLI 的 `extension path` 和 `extension status` 用于
查看目录和连接状态。准备完成后，“我的 Chrome”行只显示插件目录和简短的下一步提示。
安装和删除必须由用户在 Chrome 中确认。

只连接可信的 Farming。

## 来源

Connector 基于 MIT 许可的 OpenClaw Browser Extension 和 Relay，固定版本与许可证保存在
`extensions/browser/chrome-extension/upstream/`。Farming 使用独立的扩展 ID、存储、协议、
密钥、Native Host 和标签组，可与 OpenClaw 同时安装。
