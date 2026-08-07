# Language Server

> English version: [language-server.md](./language-server.md)

用户指南：[Language Server（实验性）](https://zhuwenzhuang.github.io/farming/cn/experimental/language-server)。
本文继续作为后端权威性、生命周期和验收契约。

状态：Farming 托管、面向代码查看的能力。

## 产品边界

Farming 可以在拥有 Project 的 Backend 上启动匹配的 Language Server。Editor 使用它理解
代码；用户不需要配置 Transport Socket，也不需要在 Farming 内维护另一套 Language Server
Workspace。

```text
Farming Editor
      |
      | 带鉴权、Project-scoped Request
      v
Project 所在主机的 Farming Backend
      |
      | Language Server Protocol
      v
受管或系统 Language Server
```

Backend 拥有 Server Discovery、Project Root 选择、进程生命周期、Request Deadline 与 Result
Authorization。同一 Config、Language 与 Project Root 边界内可以复用一份兼容 Server；不同
Config Instance 不共享可变 Language Server 状态。

## 文件与结果权威

Request 必须按精确 Project Root 授权；Symlink Escape 和 Project 外 Result Location 必须拒绝。

Semantic Result 描述磁盘上已保存文件。Farming Editor 存在未保存 Draft 时，可能展示陈旧
跨文件语义的操作应暂时隐藏，而不是假装磁盘结果描述当前 Draft。

## 能力

面向查看的 Surface 可以提供 Hover、Definition、Reference、Implementation、Document
Highlight、Semantic Tokens、Inlay Hints、Symbol、Call/Type Hierarchy 与 Diagnostics，具体
取决于 Active Server 实际支持的能力。Availability 来自真实初始化完成的 Connection，不能把
内置 Registry 本身当作已经连接。

Document Highlight 使用 Server 返回的符号语义区分文本、读取与写入位置，不退化成纯文本搜索。
Semantic Tokens 使用 LSP 静态或动态 Capability Registration 返回的 Legend；Frontend 在应用
Token Stream 前将该 Legend 映射到稳定的 Monaco Legend。Server 私有且未知的 Token Type 使用
中性的 Variable 样式，未知 Modifier 则忽略。Inlay Hints 只按 Editor 可见 Range 请求，并保留
Parameter/Type Kind、分段 Label、Tooltip 与 Padding；Server 返回的 Command 或 Edit 不会被当作
已经授权的操作执行。

这三项阅读辅助只描述已保存 Model。编辑、替换、销毁或切换 Model 都会隔离 Pending Response，
并清除陈旧展示；保存当前 Draft 后 Provider 会重新启用。Highlight 与 Inlay Result Count、整篇
Semantic Token Payload 都有上限；超限或格式错误时显式失败，不静默截断成可能误导的代码语义。

当 Server 发送 `workspace/semanticTokens/refresh` 或 `workspace/inlayHint/refresh`
时，Managed Client 会确认该请求，并向已连接的 Farming 页面发布带顺序号的 Project 范围
刷新事件。新的 `textDocument/publishDiagnostics` Snapshot 同样是 Server 已重新分析打开文档的
权威信号；即使某个 Server 不发送可选的 Workspace Refresh Request，也会据此让这些 Saved-file
Provider 失效。JDTLS 在项目导入完成后还会发送一次 `language/status` 的 `ServiceReady`；由于文档
Diagnostics 可能早于项目级语义结果到达，Managed Client 会用这个一次性的权威里程碑再次让
Provider 失效。页面只接受当前 Backend Epoch 中更大的 Revision，且该 Project 仍拥有干净的已绑定
Model 时才刷新。Manager 会保留每个 Active Project、每种 Provider 的最新 Revision，并在
WebSocket Protocol 协商后向重载或重连页面重放 Snapshot，因此页面不会错过一次性的就绪里程碑；
如果对应 Editor Model 尚未绑定，页面会保留该 Revision，直到干净 Model 出现后再消费。未保存或
不相关 Model 不会发起基于磁盘内容的语义请求。这条事件链也是冷启动恢复的权威机制；Frontend
不能用轮询或切换文件代替 Language Server 的真实状态信号。

如果 Inlay Hints 请求在 Server 就绪前超时，Frontend 会向 Monaco 返回一次暂时的空结果，使
Provider 继续订阅后续 Refresh Event；下一次权威刷新会重新请求。格式错误、超限或其他非暂时性
结果仍然显式失败。

Call 与 Type Hierarchy 先准备 Root，再按每个展开节点懒加载 Children。节点必须区分尚未请求、
加载中、已加载为空、已加载和失败。用户在加载中折叠节点后，迟到响应不能重新展开该节点；已加载
Children 在再次展开时继续复用。切换 Hierarchy Direction 会隔离旧响应；单个节点失败保持局部
可见并允许重试，不要求重建整棵树。打开 Hierarchy Result 后，原有树和已经加载的分支在同一
Project 内跨文件导航时继续保留；无关的文件或 Project 切换会关闭旧上下文。Tree 遵循标准键盘
导航：Up/Down 在可见节点间移动，Left/Right 折叠或展开，Enter 打开选中位置。

Document Symbols 保留 Server 返回的层次。首层初始可见，嵌套容器可以在本地展开或折叠；这些
交互不再发起 Language Server Request。

Definition 与 Implementation 只返回一个 Location 时直接跳转；多个 Location 与 References
保留在共享 Navigation Panel 中，并显示压缩的父目录上下文、文件名与行号。这些操作使用当前
已保存的 Model Binding 发起请求；Active File 变化后，迟到结果不能继续导航。

Workspace Symbol Search 要求非空 Query。从已保存文件发起搜索时，如有必要会先启动与该文件
匹配的 Managed Server，并在导航前规范化 LSP Workspace Symbol Location。一次最多渲染 500
个结果，超过时明确提示用户缩小搜索范围。

Diagnostics 只有在发起请求的 Model、已保存 Revision 与 Binding 仍为 Current 时才会应用。
编辑、替换或销毁 Model 会使 Pending Diagnostic Response 失效，迟到响应不能把较新 Editor
State 已清除的 Marker 再写回来。

## 生命周期与失败

受管 Server 处于 Absent、Starting、Ready、Stopping 或 Failed。相同 Ownership Boundary 的
并发启动加入同一转换。退出或失败的 Server 会从 Active State 移除；之后用户显式请求可以
重新启动。Request 与 Shutdown 都必须有界；失败保持可见，不静默切换到另一 Provider。

Backend 优先启动 Project Host 上已经存在的匹配 Language Server Executable。clangd 或
JDTLS 不可用时，Farming 可以按需安装仓库固定的 Runtime Version，但不会解析可变的
`latest` Archive：每个 Managed Download 都有仓库固定的 URL 与 SHA-256，并在解压或执行前
验证。摘要缺失或不匹配时返回可操作的显式错误。

## 验收标准

验证必须覆盖：Project Root Discovery、Saved-file Semantics、Result Filtering、Process Reuse
与 Restart、Concurrent Request、显式失败、Remote SSH Ownership、静态与动态 Capability
Registration、Semantic Legend Mapping、Visible-range Inlay Request、按 Project 有序的 Provider
Refresh、Dirty Model Refresh Rejection、Stale-result Fencing，以及代表性真实 Language Server。
