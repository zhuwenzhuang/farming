# Language Server

<Badge type="warning" text="实验性功能" />

::: warning 实验性功能
Language Server 已具备连接和编辑器集成，但目前缺少足够的真实项目案例。实际可用能力取决于语言、Project 和对应 Server。
:::

Language Server 用于帮助 Farming Files 理解代码，例如跳转定义、查找引用、符号、层次结构和诊断。

## 工作方式

Language Server 运行在 Project 所在的 Farming Host 上。Farming 负责：

- 发现适合当前语言的 Server；
- 选择正确的 Project Root；
- 管理进程启动、停止和失败；
- 为请求设置边界与超时；
- 过滤 Project 外的结果。

浏览器不需要直接连接 Language Server Socket。

## 可用能力

根据实际 Server，可能提供：

- Hover；
- Definition、Reference 与 Implementation；
- Workspace Symbol；
- Call Hierarchy 与 Type Hierarchy；
- Diagnostics。

只有 Server 初始化成功后，Farming 才会显示对应能力可用。支持某种语言并不代表当前 Project 已经连接成功。

## 保存状态

跨文件语义结果通常描述磁盘上已保存的文件。编辑器存在未保存内容时，Farming 可能暂时隐藏容易误导的语义操作。

## 使用建议

- 先在小型、语言工具链明确的 Project 中尝试；
- 确认对应 Language Server 已安装或可以由 Farming 准备；
- 把跳转和诊断当作辅助证据，最终以文件、构建和测试为准；
- 遇到失败时记录语言、Project Root、Server 状态和用户可见错误。
