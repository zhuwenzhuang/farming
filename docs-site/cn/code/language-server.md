---
description: 在 Farming Files 中使用代码跳转、引用、调用层次、类型层次和诊断。
---

# Language Server

Files 会按当前语言和 Project 连接可用的 Language Server。打开代码文件后，可以直接跳到定义、查找引用和实现，也可以查看调用层次、类型层次、诊断、语义高亮与参数提示。

## 查看代码关系

在已保存的代码上打开右键菜单，选择 **调用层次结构** 或 **类型层次结构**。结果会停靠在编辑器右侧；展开节点后，可以继续打开对应文件和位置，原来的关系树会保留。

<ThemeImage
  light="/cn/assets/language-server-call-hierarchy.png"
  dark="/cn/assets/language-server-call-hierarchy-dark.png"
  paper="/cn/assets/language-server-call-hierarchy-paper.png"
  alt="Files 编辑器右侧展开 Language Server 调用层次结构"
/>

同一个右键菜单还提供定义、引用、实现、文档符号和工作区符号。具体项目中显示哪些操作，以当前 Language Server 初始化后报告的能力为准。

## 查看与管理 Language Server

Language Server 默认启用，并在打开受支持的代码文件、使用语义能力时按需启动。打开 **插件 → Farming** 可以查看当前正在运行、系统中可用、可以自动安装或尚未安装的 Server。

<ThemeImage
  light="/cn/assets/language-server-settings.png"
  dark="/cn/assets/language-server-settings-dark.png"
  paper="/cn/assets/language-server-settings-paper.png"
  alt="插件页面中的 Language Server 状态和语言列表"
/>

Farming 优先使用 Project 主机上已经安装的 Language Server；受支持的 Server 也可以由 Farming 按需准备。远程 Project 的 Server 运行在远程主机上，不占用浏览器所在电脑的语言工具链。

## 保存状态

跨文件结果以磁盘上已保存的代码为准。文件存在未保存修改时，Farming 会暂时隐藏可能过期的语义操作；保存后会重新请求当前结果。

如果某项能力没有出现，先在插件页确认对应语言的 Server 状态，再检查 Project Root 和该 Server 实际支持的能力。
