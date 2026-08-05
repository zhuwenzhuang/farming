# Agent 使用 Browser 的流程

受支持且能够执行命令的 Agent，通过当前 Farming 实例的 CLI 发现和操作 Browser Resource。

## 检查能力

```bash
farming capabilities
farming browser capability
farming browser help workflow
```

先检查能力，再创建资源。不要根据命令是否存在就假设 Browser Runtime 已经可用。

## 推荐顺序

```text
list → 复用或创建 → start → navigate → snapshot
     → 基于 Snapshot 操作 → wait → verify
```

关键原则是“观察后操作，操作后验证”。页面变化后，旧的元素引用和旧 Screenshot 都可能失效。

## 发现资源

```bash
farming browser list
```

优先复用当前 Agent 已经拥有、且用途匹配的 Browser。需要独立页面或独立 Profile 时，再显式创建新资源。

## 逐步披露命令

Browser CLI 不要求 Agent 一次读取全部命令。先选择主题：

```bash
farming browser help navigation
farming browser help interaction
farming browser help inspection
farming browser help debugging
farming browser help files
```

只有需要精确参数时，再运行具体命令的 `--help`，或通过 `describe <command> --json` 读取机器可用契约。

## 操作与验证

- 导航后等待明确的页面状态，不使用任意长时间睡眠代替验证。
- 优先使用结构化 Snapshot 定位元素。
- 点击或填写前确认目标唯一。
- 页面更新后重新观察，再继续下一步。
- 超时意味着结果不确定时，不自动重放提交、发送或删除操作。

## 文件边界

上传和下载只允许发生在 Browser 所属的 Project Workspace 中。不要尝试通过路径跳转访问 Project 外文件，也不要静默覆盖已经存在的下载目标。

## 用户介入

如果页面需要登录、验证码、支付、敏感信息或不可逆确认，Agent 应停在清楚的位置，让用户接管或给出明确授权。用户操作完成后，Agent 需要重新观察最新页面状态。
