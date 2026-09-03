# iOS Simulator PWA 验收

> English version: [ios-simulator-pwa-acceptance.md](./ios-simulator-pwa-acceptance.md)

此 harness 验证真实 iOS standalone Web App 中的 Farming Code。它使用 Apple
XCUITest 打开 Mobile Safari、选择 **Add to Home Screen**、从 SpringBoard
启动已安装图标，并操作由此产生的 `com.apple.webapp` 进程。它不 mock
`navigator.standalone`，不以 Playwright 设备模拟冒充真实 PWA，也不依赖
Computer Use。

发布规则例外：当 Release Coordinator 本身运行在 Linux 上时，该 iOS 验收记录为
`skipped-linux-coordinator-rule`，不作为阻塞发布的门禁。Mobile Browser 自动化和
Responsive Appearance 验收仍然必须完成；完整边界见
[发布流水线方案](../../../development/release-pipeline-acceleration-plan.zh_cn.md)。

## 运行

要求：

- 安装了 Xcode 且有可用 iPhone Simulator 的 macOS；
- 已安装仓库依赖；
- Simulator 已完成 Safari 的常规首次启动提示。

以下单条命令完成当前源码构建、隔离 fake-Agent 服务、安装、验收、产物导出
和清理：

```bash
npm run test:e2e:ios-pwa
```

可通过 `FARMING_IOS_SIMULATOR_UDID` 指定 Simulator。未指定时，runner
优先使用已启动的 iPhone，否则启动一个可用的 iPhone 16 Pro。可通过
`FARMING_IOS_PWA_OUTPUT_DIR` 指定一个尚不存在的新产物目录。

只有四个产品断言全部通过时命令才成功。出现 `IOS_PWA_EVIDENCE` 后返回非零
表示产品回归；在该行之前失败则归类为 harness 或环境阻塞。

## 状态模型

runner 独占一个隔离 Config 目录、一个 loopback 端口、一个 fake ACP Agent
及 workspace、一个名称唯一的 Home Screen Web App，以及 XCUITest
host/runner app。

1. 构建当前源码，以 fake executable 和 fake ACP adapter 启动 backend。
2. 创建 fixture Agent，并等待权威 ACP idle 状态。
3. XCUITest 通过 Safari 的公开分享面板流程安装 manifest。
4. 每个场景都激活 SpringBoard、启动图标并验证真实 standalone 进程。启动
   最多进行三次有界尝试；若全部失败，会在产品证据前以 harness 失败结束，
   不会误报成布局结果。
5. runner 导出 `.xcresult`、具名截图、摘要、日志和运行元数据。
6. `finally` 中删除准确的 fixture Agent，硬杀自己拥有的服务进程组，只卸载
   本轮新增的 WebKit PushBundle ID 和两个已知 harness bundle ID，只删除本轮
   创建的临时目录，并验证所选端口已关闭。

四个场景覆盖：

- standalone 静止态 Composer 下方的异常大片空白；
- Start New Agent 弹层进入 iOS 状态栏/Dynamic Island 区域，或裁切标题和
  首个 provider 行；
- ACP Agent 正忙且存在 queued message 时，聚焦 Composer 后 Add、模型和
  当前轮控制必须位于 iOS 输入 UI 上方并保持可点击。
- 普通 Mobile Safari 标签页中的同一聚焦 Composer；包含浏览器 chrome，且顶部栏
  与输入框必须在 iOS 输入 UI 上方保持可见。

compact 布局只有一个 viewport owner：普通浏览器标签页和已安装的 standalone app
都严格使用 visual viewport，包括键盘打开后低于 240 点的剩余高度。standalone
模式直接依赖该 viewport 已排除的系统区域，不再创建第二套根视口坐标系，也不重复
扣减 safe area。

## 产物和失败分类

默认每次运行都会在 ignored 的 `.tmp/ios-pwa-acceptance/` 下创建新目录，
其中包含：

- `FarmingPWAAcceptance.xcresult`；
- 已到达截图步骤的 `screenshots/01-*.png`、`02-*.png`、`03-*.png`、`04-*.png`；
- `summary.json`、`xcodebuild.log`、`server.log`、`run.json` 和
  `cleanup.json`；
- 完整导出的 XCUITest attachments。

出现 `IOS_PWA_EVIDENCE` 行，表示场景已经到达产品几何或交互断言。此前的
失败属于 harness 或环境阻塞，不能当作产品回归报告。应保留 `.xcresult`
和截图用于诊断，但不得提交生成产物。

## 已知限制

- 当前 checked-in selector 覆盖英文 iOS 18 Safari 和 Farming 文案。
- 这是竖屏 iPhone Simulator gate；真机签名和 iPad 行为不在范围内。
- 全新 Simulator 可能需要先人工关闭一次 Apple 的 Safari 首次启动页面，
  之后才能无人值守重复运行。
