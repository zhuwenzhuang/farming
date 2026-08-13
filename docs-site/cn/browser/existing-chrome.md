# 连接用户已有 Chrome

安装 **Farming Browser Connector** 后，Agent 可以直接使用你当前 Chrome 中的页面和登录状态。
不安装也不影响 Farming Browser 使用其他浏览器。

## 安装

1. 打开 Farming 的**插件 → 浏览器**，点击**安装连接扩展**，复制扩展目录。

   ![Farming 浏览器设置](/cn/assets/existing-chrome-plugin.jpg)

2. 打开 `chrome://extensions`，开启**开发者模式**，点击**加载已解压的扩展程序**。
   在文件选择器中按 `⌘⇧G`，粘贴扩展目录，然后点击**选择**。

   ![选择扩展目录](/cn/assets/existing-chrome-select-folder.jpg)

3. 确认扩展已安装，版本为 `0.0.1`。

   ![扩展已安装](/cn/assets/existing-chrome-installed.jpg)

4. 回到 Farming 页面，打开 Chrome 的**扩展程序**菜单，点击 **Farming Browser Connector**。

   ![打开连接扩展](/cn/assets/existing-chrome-menu.jpg)

弹窗显示 **Connected** 即连接成功。以后打开 Farming 时会自动重连。

![连接成功](/cn/assets/existing-chrome-connected.jpg)

## 删除

打开 `chrome://extensions`，找到 **Farming Browser Connector**，点击**删除**并确认。

命令行可查看扩展目录和连接状态：

```bash
farming browser extension path
farming browser extension status
```
