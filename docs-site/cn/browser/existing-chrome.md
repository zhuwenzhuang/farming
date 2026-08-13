# 连接用户已有 Chrome

**Farming Browser** 是浏览器能力；**Farming Browser Connector** 是安装在 Chrome 中的
连接扩展。只有需要 Agent 直接操作你已经打开的 Chrome 页面和现有登录状态时，才需要安装它。

## 安装

1. 在 Farming 的**插件 → 浏览器**中选择**用户已有 Chrome**，复制**内置扩展目录**。
2. 打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**并选择该
   目录。macOS 文件选择器可按 `⌘⇧G` 粘贴目录。
3. 回到 Farming 页面，从 Chrome 的**扩展程序**菜单点击 **Farming Browser Connector**。

弹窗显示 **Connected** 即连接成功。以后会自动重连，不需要重复设置或逐个授权页面。

## 断开或删除

- 暂时断开：点击 Farming Browser Connector，选择**断开连接**。
- 从 Chrome 删除：打开 `chrome://extensions`，找到 Farming Browser Connector，点击
  **删除**并确认。

安装和删除必须由用户在 Chrome 中确认。`farming browser extension path` 可查看内置扩展
目录，`farming browser extension status` 可查看连接状态。

只连接可信的 Farming 实例。
