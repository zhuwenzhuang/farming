# Agent 列表状态协议

> English version: [agent-list-state-protocol.md](./agent-list-state-protocol.md)

Farming 后端拥有 Agent 列表及列表级元数据的权威状态。浏览器界面通过快照加增量协议消费该状态，不能从 Terminal 或 Chat 流量中推测缺失状态。

首次连接、显式重新同步或从传输背压恢复时，客户端接收完整快照。之后的列表变化只携带发生变化的 Agent 完整摘要、被删除的 Agent ID，以及发生变化的列表级元数据。Terminal 输出、Chat transcript、预览和活动状态继续使用各自的 Agent 级数据流。

每个快照和增量都带有后端 generation 与递增 sequence。客户端只应用当前 generation 中紧接着的 sequence。遇到后端重启、序号缺口或不确定传输时，客户端请求新的权威快照，而不是自行猜测、重放 mutation 或引入逐消息确认。
