---
description: 从 Farming Code 分享精确的 Chat 回复、文件阅读位置或当前页面，并理解只读链接、二维码和完整控制口令的权限。
---

# 分享与只读访问

Farming 可以分享一个具体工作位置，而不只是工作区首页。Chat 回复和文件查看器会复制临时只读链接；页面级分享面板还提供可用手机扫描的二维码。

分享依赖 Token 鉴权。关闭鉴权时，Farming 会拒绝生成分享链接，因为接收者可以绕过只读限制直接访问实例。

## 分享 Chat 回复

在已完成回复下方点击分享按钮。Farming 会复制只读链接，并显示“只读分享链接已复制；只能查看，链接会自动过期”。链接记录这条回复的 Turn 标识，接收者打开后会直接定位到该回复。

<ThemeImage light="/cn/assets/share-chat.png" dark="/cn/assets/share-chat-dark.png" paper="/cn/assets/share-chat-paper.png" alt="从 Chat 回复复制精确位置的只读分享链接" />

如果回复位于较早的历史分页中，Farming 会按需向前加载。仍找不到目标时回退到 Chat 最新位置，并报告定位失败；权限始终保持只读。

## 分享文件阅读位置

打开文件后，点击查看器工具栏中的分享按钮。链接记录：

- 当前 Project 与文件；
- Editor 或 Diff 视图；
- 当前阅读行列。

<ThemeImage light="/cn/assets/share-file.png" dark="/cn/assets/share-file-dark.png" paper="/cn/assets/share-file-paper.png" alt="从文件查看器复制当前阅读位置的只读分享链接" />

打开链接时，超出文件边界的行列会被限制到有效范围。如果文件已经移动或删除，Farming 会在有界清单对齐后打开最近的可用父目录并报告回退。Agent 或 Project 无法解析时会保留默认工作区，不会扩大访问权限。

## 用手机扫描二维码

点击侧边栏顶部的“分享当前页面”按钮会同时执行两件事：复制当前页面的只读长链接，并打开二维码面板。使用另一台设备的相机或系统二维码扫描器对准二维码即可打开 Farming；Farming 本身不需要调用当前设备的摄像头。

<ThemeImage light="/cn/assets/share-qr.png" dark="/cn/assets/share-qr-dark.png" paper="/cn/assets/share-qr-paper.png" alt="可用手机扫描的 Farming 页面分享二维码" />

::: warning Owner 二维码会授予完整控制
Owner 打开的二维码包含一次性完整控制票据。只在可信设备上扫描，也不要把二维码放进截图、Issue 或公开聊天。只读访问者再次分享时，二维码仍然只读，而且不会展示 Owner 口令。
:::

二维码票据只能兑换一次，最长五分钟有效。倒计时结束后需要刷新二维码。扫描成功后，服务端把凭证写入 HTTP-only Cookie，并在应用加载前从地址栏移除票据。

## 权限与有效期

| 分享方式 | Owner 创建 | 只读访问者创建 | 有效期 |
| --- | --- | --- | --- |
| Chat 或文件分享按钮 | 只读 | 只读 | 最长五分钟，且不超过父级只读能力 |
| 页面级复制链接 | 只读 | 只读 | 最长五分钟，且不超过父级只读能力 |
| 二维码 | 完整控制 | 只读 | 一次兑换，最长五分钟 |
| 俳句口令链接 | 完整控制 | 不提供 | 持续到实例口令变更或轮换 |

只读接收者可以查看 Chat、Terminal 输出、Files、状态更新和 Browser 画面，但不能发送 Chat 或 Terminal 输入、修改文件、响应权限、控制 Browser，也不能连接当前无法由服务端强制只读的 Computer Viewer。

关闭分享面板不会改变已经复制链接的权限。只有尚未过期的能力才能建立新的 HTTP 请求或 WebSocket 连接；已经建立的 WebSocket 会保持最初的准入结果，直到断开。
