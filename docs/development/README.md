# Development Documentation

> Chinese version: [README.zh_cn.md](./README.zh_cn.md)

Start with [Contributing](../../CONTRIBUTING.md), [engineering rules](../../AGENTS.md)
and [security policy](../../SECURITY.md). User instructions live on the
[documentation site](https://zhuwenzhuang.github.io/farming/en/).

Use the document that owns the decision; do not maintain parallel descriptions
of the same behavior.

| Question | Authoritative document |
| --- | --- |
| Chat execution, messages, child Sessions and recovery | [ACP runtime](../products/code/acp-runtime.md); [Codex-specific boundaries](../products/code/codex-runtime.md) |
| Conversation identity and Agent inventory | [Session identity](../products/code/provider-session-identity.md); [Agent state protocol](../products/code/agent-list-state-protocol.md) |
| Native terminal state and reconnection | [Terminal protocol](../products/code/terminal-state-protocol.md) |
| Files product, consistency and transport | [Files design](../products/code/project-files-section-design.md); [file state](../products/code/workspace-file-state-model.md); [transport protocol](../products/code/workspace-transport-protocol.md) |
| Shared visual and interaction language | [UI design](ui-design-protocol.md); [UI interaction](ui-interaction-protocol.md) |
| Config and installation ownership | [Config isolation](config-instance-isolation.md); [installation lifecycle](package-installation-lifecycle.md) |
| Deployment and publication | [Remote deployment](remote-deployment-lifecycle.md); [release contract](release-verification-and-publication.md) |
| Verification and diagnostics | [Acceptance](../products/code/test/acceptance-dogfood-plan.md); [interaction performance](interaction-performance.md); [real Codex case](../products/code/real-codex-release-case.md) |
| Other product boundaries | [Code](../products/code/README.md); [product index](../products/README.md) |
| Public documentation maintenance | [Documentation site](documentation-site.md) |

Keep design documents focused on purpose, ownership, invariants, protocol and
failure/recovery. Code and tests own field inventories, call sequences and
individual regression cases. Research, proposals and execution retrospectives
stay local and untracked; merge established decisions into their existing owner.
