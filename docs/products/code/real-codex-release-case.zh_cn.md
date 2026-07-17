# 真实 Codex 跨皮肤发布验收 Case

> English version: [real-codex-release-case.md](./real-codex-release-case.md)

这是 Farming Code 与 Farming CRT 共用 Terminal / 结构化 Chat 路径的阻断式拟人浏览器验收。每个 Release Candidate 在快速源码检查和相关确定性 Playwright 测试通过后，都必须运行一次：

```bash
npm run test:pre-release:codex-ui
```

该命令使用本机已经登录的真实 Codex CLI、单个 Chromium Worker、隔离的 Farming Config Directory 和临时 Workspace。测试专用 Launcher 会在每次 Terminal Start / Resume 时关闭 CLI 启动升级检查，但不修改用户全局 Codex 配置。它不会进入默认 Fake Agent E2E，因为它会消耗真实模型额度，并验证外部 CLI Integration。缺少登录、指定模型不可用、Runtime Error 或任何断言失败都会阻断发布；Case 不会改用其他 Renderer、Model Flow、Agent 实现或测试分支。

## 状态链

测试只有一条有序状态链：

```text
Code Terminal
  -> 切换 Live 低成本模型
  -> xterm 命令行输入
  -> Code Composer 输入
  -> 多页混合格式输出
  -> 缩小与放大窗口拖动
  -> Code Chat
  -> 缩小与放大窗口拖动
  -> Dark Appearance
  -> 缩小与放大窗口拖动
  -> Settings 切换 Farming CRT
  -> CRT MSG
  -> 缩小与放大窗口拖动
  -> CRT Terminal
  -> 缩小与放大窗口拖动
  -> Terminal 输入
  -> CRT MSG
  -> 修改 Live Model
  -> MSG 输入
  -> 缩小与放大窗口拖动
  -> CRT Terminal
  -> 在正常 Viewport 完成最终 Resize
```

每次 Chat / Terminal 转换都必须保留完全相同的 Codex Provider Session ID。所有暂态等待都有明确上限。任何转换失败都会直接结束 Case，不恢复或尝试另一套 Runtime。

## 必须证明的证据

生成的对话包含 Heading、Paragraph、Inline Code、URL、无序 / 有序列表、Task Item、Quote、Table、JSON、YAML、Diff、Shell、中文以及六页编号输出。短且唯一的 Anchor 用来证明 Code 的两种 Terminal 输入方式和 CRT 的两种输入方式都到达同一 Provider Session。

Case 会校验：

- Code 与 CRT 在每次转换和 Resize 前后都保留要求的内容；
- CRT 的原生 xterm Paste 在提交前只插入一次 Terminal Prompt；
- Code Chat 恢复的是预期 Markdown 语义，不只是扁平文本；
- Code Terminal 明确报告 WebGL Renderer，且没有 Terminal Recovery Error；
- Code 连续拖动窗口时多页 Buffer 始终存在，每个拖动方向只提交一次最终 Geometry；
- CRT Terminal 的 Resize 逐帧采样会在提交前保留正常尺寸 Anchor，从紧凑布局展开时保留必需的页尾 Anchor，回到正常尺寸后恢复最终输出 Anchor，不会进入 Checkpoint Recovery 或显示 WebGL Failure；
- 最终 Terminal Geometry 回到正常 Viewport；
- 初始低成本模型切换与后续 CRT Model 设置都真正进入 Live Session，最终 Terminal 会如实展示 Recorded Model 与 Resumed Model 的迁移关系；
- Page Error Stream 中没有 Terminal、WebGL、Checkpoint、Replay 或 Renderer Error。

失败时 Playwright 会保留 Trace。Case 还会附加 Code Terminal、Dark Chat、CRT MSG、CRT Terminal 等关键状态截图，以及一份包含 Provider Session ID、所选模型、Anchor、最终 Agent ID 和最终 Viewport 的 JSON Evidence。

## 发布规则

发布记录必须保存该命令与 Release Candidate Revision 的结果。通过只证明这一 Revision、机器、浏览器、Codex CLI 和 Model Catalog 的组合。如果真实 Catalog 删除 `gpt-5.6-luna` 或 `gpt-5.4-mini`，应有意识地修改这一条 Case，并重新评审成本与能力选择；不要增加第二条自动 Model 路径。
