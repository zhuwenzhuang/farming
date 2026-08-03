# 真实 Codex 跨界面发布 Case

> English version: [real-codex-release-case.md](./real-codex-release-case.md)

这是 Farming Code 与 Farming CRT 共用的 Codex Terminal / ACP Chat Path 的阻断式真实 Provider
Browser Case。

确定性检查通过后，每个 Release Candidate 运行一次：

```bash
npm run test:pre-release:codex-ui
```

## 契约

Case 使用隔离 Farming Config、Workspace 与本机已登录的 Codex Runtime。Login 缺失、要求的
Capability 不可用、Runtime Error 或 Assertion Failure 都会阻断发布。测试不能为了通过而切换
到另一个 Model、Renderer、Agent Implementation 或 Runtime Path。

用户路径必须依次经过 Code Terminal、Code Chat、CRT Chat 与 CRT Terminal，并始终保留一个
精确 Codex Provider Session。它覆盖真实 Input、Structured Markdown、需要滚动的长 Output、
Model/Profile Change、Appearance Change 与重复 Window Resize。

## 必须证明的 Evidence

- 每次 Chat/Terminal 与 Code/CRT 转换都保留同一 Provider Session Identity；
- Terminal Input 与 Chat Input 都恰好到达一次；
- Chat 保留结构化内容，不压平成普通文字；
- Terminal Checkpoint 在 Resize 与界面切换后保留权威 Buffer 与 Geometry；
- Live Profile Change 真正进入 Real Session；
- 页面没有 Terminal、Renderer、Replay、Checkpoint 或 Protocol Error；
- 失败 Artifact 包含 Trace 与 Last Stable State Screenshot。

## 发布规则

结果必须和精确 Release Revision 与 Environment 一起记录。通过只证明该 Revision、Browser、
Codex Runtime 与 Model Catalog。真实 Capability 变化时，应有意识地修改这一条 Case，并审阅
新的成本与兼容边界；不得增加自动 Fallback Path。
