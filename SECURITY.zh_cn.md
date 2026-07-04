# 安全策略

> English version: [SECURITY.md](./SECURITY.md)

Farming 可以控制目标机器上的真实 terminal 和 AI coding agent 进程。部署 Farming 应被视为向使用者开放这台机器的操作入口。

## 支持版本

当前活跃开发分支和最新发布版本会接收安全修复。

## 部署建议

- 将 Farming 部署在可信开发机和可信网络中。
- 不要在没有 VPN、SSH tunnel、HTTPS 反向代理或网络 ACL 等额外安全层的情况下直接暴露到公网。
- 除可信本地开发外，保持 token auth 开启。
- `FARMING_DISABLE_AUTH=1` 只用于可信本地开发环境。
- Codex / Claude Code 的权限应按它们自己的安全模型配置；Farming 托管它们的 CLI session，但不替代它们的权限系统。
- 不要提交真实 token、私有 `.env` 文件、内部机器地址、个人机器路径或包含隐私信息的截图。

## 上报安全问题

请私下联系维护者报告安全问题，不要在公开 issue 中直接披露利用细节。

维护者：

- [zhuwenzhuang](https://github.com/zhuwenzhuang)
- [l4wei](https://github.com/l4wei)

上报时请尽量包含受影响版本或 commit、部署方式、复现步骤和预期影响。
