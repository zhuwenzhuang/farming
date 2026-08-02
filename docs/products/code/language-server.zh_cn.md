# Language Server

> English version: [language-server.md](./language-server.md)

状态：Farming 托管的面向代码查看 MVP。

## 产品边界

Language Server 是 Farming 内置能力。打开或查询受支持的已保存文件时，拥有该 Project 的后端会定位并通过 stdio 启动对应 Language Server。用户不需要配置命令、参数、Socket 或端口。

```text
Farming Monaco 编辑器
        |
        | Farming 已认证 HTTP API
        v
Project 所在主机的 Farming 后端
        |
        | stdio Language Server Protocol
        v
clangd / JDTLS / PATH 中的其他 Server
```

实现沿用 OpenCode 的语言注册表、向上查找 Root Marker、PATH 优先发现可执行文件，以及按 `server + root` 惰性启动和复用进程的做法。Farming 额外复用已有的权威 Project Root 授权，并把所有返回位置重新过滤到同一个 Project 内。

托管 Server 的失败会明确返回；Farming 不会静默换 Provider 重放请求。

## 发现算法

处理一个文件请求时，Farming：

1. 使用权威 Project Root 校验相对文件路径；
2. 根据扩展名匹配一个语言定义；
3. 从文件目录向上查找到 Project Root，寻找该语言的 Marker；
4. 使用最近的匹配目录；允许回退的语言在没有 Marker 时使用 Project Root；
5. 从 `PATH` 查找启动命令；
6. 按 `Language Server + Root` 启动一个 stdio 进程，并复用后续请求。

C/C++ 查找 `compile_commands.json`、`compile_flags.txt` 或 `.clangd`，启动：

```text
clangd --background-index --clang-tidy
```

每个文件的 Include Path、宏、语言标准和其他编译参数由 clangd 从编译数据库读取，Farming 不解析也不生成这些参数。`PATH` 中没有 clangd 时，Farming 从官方 clangd GitHub 最新 Release 下载当前平台的 Archive 到 Config 独立缓存。

Java 检测 Gradle Settings、Wrapper、Build 文件，经过 `<modules>` 关系验证的 Maven Parent 链，或者 Eclipse Project 文件。优先使用 `PATH` 中的 `jdtls`；否则要求 Java 21 或更高版本，并把官方 Eclipse JDTLS 最新 Snapshot 下载到 Config 独立缓存。JDTLS 的可变 Workspace 数据按 Project Root 隔离。

其他注册语言使用 `PATH` 中的标准命令。命令缺失时明确失败。

## 注册语言

当前托管注册表包括 C/C++、Java、Kotlin、C#、F#、Go、Rust、Python、JavaScript/TypeScript、Deno、Vue、Svelte、Astro、Ruby、PHP、Swift、Objective-C、Dart、Lua、Elixir、Zig、OCaml、Shell、YAML、Terraform、LaTeX、Dockerfile、Prisma、Gleam、Clojure、Nix、Typst、Haskell 和 Julia。

## 能力与已保存文件

当前 UI 提供 Hover、定义、引用、实现、文档/工作区符号、调用/类型层次结构和诊断。托管进程从磁盘上的已保存文件接收 `didOpen` 和全量 `didChange`。Farming 编辑器仍会在 Working Copy 未保存时隐藏语义操作，避免把旧磁盘内容的结果冒充当前 Draft。

只读查询有明确 Deadline。层次结构 Handle 不透明且只在当前进程内有效。Farming 后端关闭时停止托管进程；之后的请求会重新惰性启动。

每个 `Server + Root` 遵循 `absent -> starting -> ready -> stopping -> absent`。启动失败会返回明确请求错误并保持 `absent`，之后的用户请求可以重试。已就绪进程退出后按精确身份移除，下一次请求启动新进程，不会继续写入过期 Transport。同一个 Key 的并发启动共享一个 Promise。

插件信息中的状态来自当前存活且已经完成初始化的托管进程：没有活跃进程时显示“按需待命”，只有至少一个真实的 `Server + Root` 连接时才显示“已连接”。能力快照会列出当前连接的 Project、语言 Server 和语言根目录；它不会把“内置注册表可用”当成项目已经连接。

## 安全与隔离

- 文件输入通过 `WorkspaceRootRegistry` 解析；
- 拒绝 Symlink Escape，并过滤同一 Project 之外的返回结果；
- 进程运行在拥有 Project 的后端，包括 Remote SSH Backend；Desktop 不会为每次语言查询单独执行 SSH 命令；
- 托管缓存和 JDTLS Workspace 数据位于精确 Farming Config 目录下，不同 Config 不共享可变语言状态；
- 下载有大小上限，只能解压到 Config 独立的 Language Server 缓存。

## 来源与验证

采用的 OpenCode 源码 Revision 和 MIT Notice 记录在 `THIRD_PARTY_NOTICES.md` 与 `extensions/language-server/backend/LICENSE.opencode`。

聚焦回归测试使用真实的 Fake stdio Language Server，验证 Root 识别、初始化、打开文档、Hover、定义、诊断、层次结构 Handle、Workspace Symbol、进程复用、有界关闭和 Project 返回结果过滤。
