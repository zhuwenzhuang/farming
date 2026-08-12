# 手机与远程使用

Farming 后端运行在开发机上，电脑或手机浏览器通过带鉴权 URL 连接。Agent、Terminal 和项目文件不会因为你换了一台浏览器就迁移到客户端设备。

<ThemeImage light="/cn/assets/mobile-chat.png" dark="/cn/assets/mobile-chat-dark.png" paper="/cn/assets/mobile-chat-paper.png" alt="手机上的 Agent Chat" />

## 手机使用

手机界面适合：

- 查看 Agent 是否完成或需要输入；
- 阅读结果和验证信息；
- 发送简短的后续要求；
- 在 Chat、Terminal 和 Files 之间切换。

复杂终端快捷键、大范围文件编辑和长时间排障更适合使用较大屏幕。

## 从另一台设备访问

1. 在开发机运行 `farming daemon`。
2. 确认另一台设备能够访问输出地址。
3. 打开带鉴权 URL。

如果只需要重新查看当前地址，在 Host 上运行：

```bash
farming url
```

如果只想让另一台设备查看当前工作区，优先使用[分享与只读访问](./sharing)中的只读链接。也可以打开页面级分享面板，用手机相机或系统二维码扫描器扫描二维码；Owner 创建的二维码会授予完整控制，扫描前必须确认接收设备可信。

## 安全边界

不要把 Farming 直接暴露在没有访问控制的公网。跨不可信网络时使用 VPN、SSH Tunnel、HTTPS Reverse Proxy 或等价保护。

带鉴权 URL 相当于访问凭证：

- 不要公开分享；
- 不要放进截图和 Issue；
- 怀疑泄露时停止服务并更新相关配置；
- Browser 中已登录的网站仍然拥有自己的独立账号和权限边界。

## 断开连接

网络断开或浏览器关闭不会自动停止 Agent。重新连接后先确认当前状态，再决定是否继续发送操作，避免因不确定结果造成重复执行。
