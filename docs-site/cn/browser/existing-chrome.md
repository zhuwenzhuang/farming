# 连接用户已有 Chrome

安装 **Farming Browser Connector** 后，Agent 可以直接使用你当前 Chrome 中的页面和登录状态。
不安装也不影响 Farming Browser 使用其他浏览器。

## 安装

先在 Farming 的“插件 → 浏览器 → 我的 Chrome”中点击**准备 Chrome 扩展目录**。
准备后，这里会显示 Chrome 扩展程序页地址、插件目录、大小和完整性。点击地址即可复制，再粘贴到 Chrome 地址栏打开。

![在 Farming 中准备连接扩展](/cn/assets/existing-chrome-install.png)

1. 打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**。
2. 在文件选择器中打开你的主目录，选择 **farming-browser-connector**，然后点击**选择**。

   ![选择 farming-browser-connector](/cn/assets/existing-chrome-select-folder.png)

3. 打开 Chrome 的**扩展程序**菜单，点击 **Farming Browser Connector**。

   ![打开连接扩展](/cn/assets/existing-chrome-menu.png)

连接后，Agent 可以查找并直接使用这个 Chrome 中任意已经打开的普通页面，无需逐页点击。
停止 Farming Browser 不会关闭 Chrome 原页面。
保持 Farming 插件页可见时，“我的 Chrome”会自动显示**可用**或**当前不可用**，不需要手动测试。

## 删除

打开 `chrome://extensions`，找到 **Farming Browser Connector**，点击**删除**，然后在确认框中再次点击**删除**。

![删除 Farming Browser Connector](/cn/assets/existing-chrome-remove.png)

返回 Farming 的“插件 → 浏览器 → 我的 Chrome”，点击**删除 Chrome 扩展目录**，即可清理准备好的目录入口。
这个目录不是临时目录；Chrome 会持续从中加载扩展文件。请先从 Chrome 删除扩展，再删除目录。
