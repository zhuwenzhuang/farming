# 开发文档

> English version: [README.md](./README.md)

先读[贡献指南](../../CONTRIBUTING.zh_cn.md)、[工程规则](../../AGENTS.zh_cn.md)和
[安全策略](../../SECURITY.zh_cn.md)。普通使用说明在
[文档站](https://zhuwenzhuang.github.io/farming/cn/)。

按问题找到唯一权威文档，不为同一行为维护多份说明。

| 问题 | 权威文档 |
| --- | --- |
| Chat 执行、消息、子会话与恢复 | [ACP Runtime](../products/code/acp-runtime.zh_cn.md)；[Codex 特有边界](../products/code/codex-runtime.zh_cn.md) |
| 对话身份与 Agent 清单 | [Session 身份](../products/code/provider-session-identity.zh_cn.md)；[Agent 状态协议](../products/code/agent-list-state-protocol.zh_cn.md) |
| 原生终端状态与重连 | [Terminal 协议](../products/code/terminal-state-protocol.zh_cn.md) |
| Files 产品、一致性与传输 | [Files 设计](../products/code/project-files-section-design.zh_cn.md)；[文件状态](../products/code/workspace-file-state-model.zh_cn.md)；[传输协议](../products/code/workspace-transport-protocol.zh_cn.md) |
| 共享视觉与交互语言 | [UI 设计](ui-design-protocol.zh_cn.md)；[UI 交互](ui-interaction-protocol.zh_cn.md) |
| Config 与安装所有权 | [Config 隔离](config-instance-isolation.zh_cn.md)；[安装生命周期](package-installation-lifecycle.zh_cn.md) |
| 部署与正式发布 | [远端部署](remote-deployment-lifecycle.zh_cn.md)；[发布契约](release-verification-and-publication.zh_cn.md) |
| 验证与诊断 | [验收](../products/code/test/acceptance-dogfood-plan.zh_cn.md)；[交互性能](interaction-performance.zh_cn.md)；[真实 Codex 用例](../products/code/real-codex-release-case.zh_cn.md) |
| 其他产品边界 | [Code](../products/code/README.zh_cn.md)；[产品索引](../products/README.zh_cn.md) |
| 公开文档维护 | [文档站维护](documentation-site.zh_cn.md) |

设计文档聚焦目的、所有权、不变量、协议和失败恢复。字段清单、调用步骤和单个回归案例
由代码与测试维护。研究、提案和执行复盘留在本地、不跟踪；已确定结论合入已有权威文档。
